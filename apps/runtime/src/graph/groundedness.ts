// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Groundedness / citation gate (`src/graph/groundedness.ts`)
 *
 * Anti-hallucination stage. After an LLM node has produced an answer *and* the
 * flow gathered retrieval context (tool/RAG results or citations), this gate
 * checks how much of the answer is actually supported by that context. Every
 * declarative sentence is scored against the retrieved sources; sentences whose
 * support falls below a threshold are flagged as ungrounded.
 *
 * Why this matters for the platform's domain: in legal / debt-collection /
 * client-document answering, a fluent but unsupported claim is the existential
 * risk. The gate turns "the model said so" into "the model said so AND it is
 * traceable to a source" — and surfaces the gap when it is not.
 *
 * Three modes:
 *   - "off"      — never used (the gate is simply not constructed).
 *   - "annotate" — compute the score, emit it, never alter the answer.
 *   - "block"    — additionally append a visible warning footer listing the
 *                  unsupported claims so the reader is told not to trust them.
 *
 * The detection logic ({@link checkGroundedness}) is pure and exported, so the
 * scoring/thresholding is fully unit-testable without any model calls. The gate
 * is deliberately heuristic (lexical containment, no embeddings) so it adds
 * negligible latency and never makes its own provider call; an embedding- or
 * judge-based scorer can be layered on later behind the same interface.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import { cosineSimilarity, type Embedder } from "./semantic-cache.js";

// ---------------------------------------------------------------------------
// Tokenisation helpers (pure)
// ---------------------------------------------------------------------------

/** Common words that carry no grounding signal — excluded from support scoring. */
const STOPWORDS = new Set<string>([
  // English
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "as",
  "at",
  "by",
  "from",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their",
  "he",
  "she",
  "his",
  "her",
  "i",
  "can",
  "will",
  "would",
  "should",
  "could",
  "may",
  "might",
  "do",
  "does",
  "did",
  "not",
  "no",
  "yes",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  // German
  "der",
  "die",
  "das",
  "und",
  "oder",
  "aber",
  "wenn",
  "dann",
  "ist",
  "sind",
  "war",
  "waren",
  "sein",
  "zu",
  "von",
  "im",
  "in",
  "auf",
  "für",
  "mit",
  "als",
  "an",
  "bei",
  "aus",
  "dass",
  "dies",
  "diese",
  "dieser",
  "es",
  "sie",
  "wir",
  "ihr",
  "ich",
  "kann",
  "wird",
  "nicht",
  "kein",
  "keine",
  "auch",
  "noch",
  "schon",
  "sehr",
  "nur",
  "über",
  "ein",
  "eine",
  "einen",
  "dem",
  "den",
]);

/** Lowercased alphanumeric word tokens (Unicode letters/digits). */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

/** Content tokens only (length ≥ 2, not a stopword). */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Splits text into sentences on terminal punctuation and newlines. Markdown
 * list items and headings count as their own sentences. Pure.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Scoring (pure)
// ---------------------------------------------------------------------------

export interface SentenceVerdict {
  sentence: string;
  /** Fraction of the sentence's content tokens found in the best source [0,1]. */
  support: number;
  grounded: boolean;
}

export interface GroundednessResult {
  /** Overall groundedness score in [0,1] (supported / checkable sentences). */
  score: number;
  /** Sentences that were actually scored (non-trivial, enough content tokens). */
  checkedSentences: number;
  /** Count of grounded sentences among the checked ones. */
  groundedSentences: number;
  /** The sentences that failed the support threshold. */
  unsupported: SentenceVerdict[];
  /** True when no source context was available, so grounding cannot be judged. */
  noSources: boolean;
  /** True when score >= the configured pass threshold (or grounding is N/A). */
  passed: boolean;
}

export interface GroundednessOptions {
  /** A sentence is "grounded" when its support fraction ≥ this. Default 0.6. */
  sentenceSupportThreshold: number;
  /** The overall answer passes when its score ≥ this. Default 0.7. */
  passThreshold: number;
  /** Sentences with fewer content tokens than this are skipped (greetings, etc.). Default 4. */
  minContentTokens: number;
  groundednessType: "lexical" | "semantic" | "llm";
  semanticThreshold: number;
  embedder?: Embedder;
  llmModel?: LanguageModel;
  /**
   * Maximum number of source *chunks* (sentences) to embed when using the
   * semantic scorer. Long source collections are capped here to keep embedding
   * costs proportional. Default 200.
   */
  maxSourceChunks: number;
}

export const DEFAULT_GROUNDEDNESS_OPTIONS: GroundednessOptions = {
  sentenceSupportThreshold: 0.6,
  passThreshold: 0.7,
  minContentTokens: 4,
  groundednessType: "lexical",
  semanticThreshold: 0.8,
  maxSourceChunks: 200,
};

/**
 * Scores how well `answer` is supported by `sources`. Pure — no I/O.
 *
 * For each non-trivial sentence we compute the fraction of its content tokens
 * that appear anywhere in the combined source token set (lexical containment).
 * The overall score is the share of checked sentences that clear the per-
 * sentence support threshold. When there are no sources, grounding cannot be
 * assessed and the result is marked {@link GroundednessResult.noSources}
 * (treated as a pass so the gate never blocks pure-chat flows).
 */
export function checkGroundedness(
  answer: string,
  sources: string[],
  options: Partial<GroundednessOptions> = {},
): GroundednessResult {
  const opts = { ...DEFAULT_GROUNDEDNESS_OPTIONS, ...options };

  const sourceTokens = new Set<string>();
  for (const src of sources) {
    for (const t of contentTokens(src)) sourceTokens.add(t);
  }

  if (sourceTokens.size === 0) {
    return {
      score: 1,
      checkedSentences: 0,
      groundedSentences: 0,
      unsupported: [],
      noSources: true,
      passed: true,
    };
  }

  const verdicts: SentenceVerdict[] = [];
  for (const sentence of splitSentences(answer)) {
    const toks = contentTokens(sentence);
    if (toks.length < opts.minContentTokens) continue; // trivial — skip

    let hits = 0;
    for (const t of toks) if (sourceTokens.has(t)) hits++;
    const support = hits / toks.length;
    verdicts.push({
      sentence,
      support: Math.round(support * 1000) / 1000,
      grounded: support >= opts.sentenceSupportThreshold,
    });
  }

  const checkedSentences = verdicts.length;
  if (checkedSentences === 0) {
    // Nothing substantive to verify (e.g. "Sure, here you go.") — pass.
    return {
      score: 1,
      checkedSentences: 0,
      groundedSentences: 0,
      unsupported: [],
      noSources: false,
      passed: true,
    };
  }

  const groundedSentences = verdicts.filter((v) => v.grounded).length;
  const score = groundedSentences / checkedSentences;
  return {
    score: Math.round(score * 1000) / 1000,
    checkedSentences,
    groundedSentences,
    unsupported: verdicts.filter((v) => !v.grounded),
    noSources: false,
    passed: score >= opts.passThreshold,
  };
}

/**
 * Scores how well `answer` is supported by `sources` using sentence embeddings cosine similarity.
 *
 * Enhancement over the naive "embed whole source" approach: long sources are
 * split into sentences and each answer sentence is compared against every source
 * *chunk* (sentence), not just the full source string. This is crucial for
 * retrieval contexts that are multi-sentence paragraphs — the whole-document
 * embedding vector points toward the paragraph centroid, which can be far from
 * the specific claim being verified. Chunk-level matching is both more precise
 * and more generous (a relevant sentence buried in a long document can ground a
 * claim that the whole-paragraph vector would have missed).
 *
 * To keep embedding costs proportional, source chunks are deduplicated and
 * capped at `maxSourceChunks` (default 200). All source and sentence embeddings
 * are requested in one `Promise.all` fan-out.
 */
export async function checkGroundednessSemantic(
  answer: string,
  sources: string[],
  embedder: Embedder,
  options: Partial<GroundednessOptions> = {},
): Promise<GroundednessResult> {
  const minContentTokens =
    options.minContentTokens ?? DEFAULT_GROUNDEDNESS_OPTIONS.minContentTokens;
  const semanticThreshold =
    options.semanticThreshold ?? DEFAULT_GROUNDEDNESS_OPTIONS.semanticThreshold;
  const passThreshold =
    options.passThreshold ?? DEFAULT_GROUNDEDNESS_OPTIONS.passThreshold;
  const maxSourceChunks =
    options.maxSourceChunks ?? DEFAULT_GROUNDEDNESS_OPTIONS.maxSourceChunks;

  if (sources.length === 0 || sources.every((s) => s.trim().length === 0)) {
    return {
      score: 1,
      checkedSentences: 0,
      groundedSentences: 0,
      unsupported: [],
      noSources: true,
      passed: true,
    };
  }

  // Split answer into scoreable sentences.
  const sentences = splitSentences(answer).filter(
    (s) => contentTokens(s).length >= minContentTokens,
  );
  if (sentences.length === 0) {
    return {
      score: 1,
      checkedSentences: 0,
      groundedSentences: 0,
      unsupported: [],
      noSources: false,
      passed: true,
    };
  }

  // Chunk sources into sentences so each answer sentence is compared against
  // the most relevant fragment of the source, not the blurred centroid of the
  // whole paragraph. Deduplicate and cap to limit embedding fan-out.
  const sourceChunks: string[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    const chunks = splitSentences(src).filter((c) => c.trim().length > 0);
    // Fall back to the whole source when it has no sentence breaks (e.g. a
    // single-sentence snippet or a structured string like a JSON excerpt).
    const candidates = chunks.length > 0 ? chunks : [src];
    for (const chunk of candidates) {
      const key = chunk.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        sourceChunks.push(chunk);
        if (sourceChunks.length >= maxSourceChunks) break;
      }
    }
    if (sourceChunks.length >= maxSourceChunks) break;
  }

  // Guard: if no usable source chunks remain after filtering/chunking, treat
  // as no-sources (can happen when all sources are whitespace-only strings that
  // passed the early guard but produce no sentence splits).
  if (sourceChunks.length === 0) {
    return {
      score: 1,
      checkedSentences: 0,
      groundedSentences: 0,
      unsupported: [],
      noSources: true,
      passed: true,
    };
  }

  // Fan out all embedding calls in one batch.
  const [sourceVectors, sentenceVectors] = await Promise.all([
    Promise.all(sourceChunks.map((src) => embedder.embed(src))),
    Promise.all(sentences.map((sent) => embedder.embed(sent))),
  ]);

  const verdicts: SentenceVerdict[] = [];
  for (const [i, sentence] of sentences.entries()) {
    const sVec = sentenceVectors[i];
    if (sVec === undefined) continue; // unreachable: sentenceVectors is a 1:1 map of sentences

    // Best similarity over all source chunks (not just the top-level sources).
    let maxSim = -1;
    for (const srcVec of sourceVectors) {
      const sim = cosineSimilarity(sVec, srcVec);
      if (sim > maxSim) maxSim = sim;
    }

    verdicts.push({
      sentence,
      support: Math.round(maxSim * 1000) / 1000,
      grounded: maxSim >= semanticThreshold,
    });
  }

  const checkedSentences = verdicts.length;
  const groundedSentences = verdicts.filter((v) => v.grounded).length;
  const score = groundedSentences / checkedSentences;

  return {
    score: Math.round(score * 1000) / 1000,
    checkedSentences,
    groundedSentences,
    unsupported: verdicts.filter((v) => !v.grounded),
    noSources: false,
    passed: score >= passThreshold,
  };
}

/**
 * Scores how well `answer` is supported by `sources` using an LLM as judge.
 */
export async function checkGroundednessLlm(
  answer: string,
  sources: string[],
  llmModel: LanguageModel,
  options: Partial<GroundednessOptions> = {},
  signal?: AbortSignal,
): Promise<GroundednessResult> {
  const passThreshold =
    options.passThreshold ?? DEFAULT_GROUNDEDNESS_OPTIONS.passThreshold;

  if (sources.length === 0 || sources.every((s) => s.trim().length === 0)) {
    return {
      score: 1,
      checkedSentences: 0,
      groundedSentences: 0,
      unsupported: [],
      noSources: true,
      passed: true,
    };
  }

  const { object } = await generateObject({
    model: llmModel,
    schema: z.object({
      score: z.number().min(0).max(1),
      unsupportedClaims: z.array(z.string()),
      reasoning: z.string(),
    }),
    system:
      "You are a strict groundedness evaluation judge. Grade whether the answer is fully supported by the provided context. Return a score from 0 (completely ungrounded/hallucinated) to 1 (fully grounded/traceable to context), along with any unsupported claims.",
    prompt: `Context/Sources:\n${sources.join("\n\n")}\n\nAnswer:\n${answer}`,
    temperature: 0,
    ...(signal !== undefined ? { abortSignal: signal } : {}),
  });

  const passed = object.score >= passThreshold;
  const unsupportedVerdicts = object.unsupportedClaims.map((claim) => ({
    sentence: claim,
    support: 0,
    grounded: false,
  }));

  return {
    score: object.score,
    checkedSentences: 1,
    groundedSentences: passed ? 1 : 0,
    unsupported: unsupportedVerdicts,
    noSources: false,
    passed,
  };
}

// ---------------------------------------------------------------------------
// Gate facade + factory
// ---------------------------------------------------------------------------

export type GroundednessMode = "annotate" | "block";

export interface GroundednessReport extends GroundednessResult {
  /** Optional footer text to append to the answer (block mode, on failure). */
  warningFooter?: string;
}

export interface GroundednessGate {
  enabled: boolean;
  mode: GroundednessMode;
  /**
   * Scores an answer against sources and builds a report (with optional
   * footer). `signal` — normally the flow's execution deadline
   * (`ExecRuntime.signal`) — bounds the LLM-judge call in "llm" mode; the
   * gate runs AFTER the last token is streamed and BEFORE `sendFinish`, so an
   * unbounded judge call here is a real user-visible stall past the timeout,
   * not just a background cost leak.
   */
  evaluate(
    answer: string,
    sources: string[],
    signal?: AbortSignal,
  ): Promise<GroundednessReport>;
}

class GroundednessGateImpl implements GroundednessGate {
  readonly enabled = true;
  constructor(
    readonly mode: GroundednessMode,
    private readonly options: GroundednessOptions,
    private readonly logger?: Logger,
  ) {}

  async evaluate(
    answer: string,
    sources: string[],
    signal?: AbortSignal,
  ): Promise<GroundednessReport> {
    let result: GroundednessResult;
    if (this.options.groundednessType === "semantic") {
      if (this.options.embedder === undefined) {
        this.logger?.warn(
          "Semantic groundedness check requested but no embedder available. Falling back to lexical.",
        );
        result = checkGroundedness(answer, sources, this.options);
      } else {
        result = await checkGroundednessSemantic(
          answer,
          sources,
          this.options.embedder,
          this.options,
        );
      }
    } else if (this.options.groundednessType === "llm") {
      if (this.options.llmModel === undefined) {
        this.logger?.warn(
          "LLM groundedness check requested but no LLM model available. Falling back to lexical.",
        );
        result = checkGroundedness(answer, sources, this.options);
      } else {
        result = await checkGroundednessLlm(
          answer,
          sources,
          this.options.llmModel,
          this.options,
          signal,
        );
      }
    } else {
      result = checkGroundedness(answer, sources, this.options);
    }

    if (result.passed || result.noSources) return result;

    this.logger?.warn("Ungrounded answer detected", {
      score: result.score,
      checked: result.checkedSentences,
      unsupported: result.unsupported.length,
    });

    if (this.mode === "block") {
      const claims = result.unsupported
        .slice(0, 5)
        .map((u) => `• ${u.sentence}`)
        .join("\n");
      const footer =
        `\n\n---\n⚠️ **Note:** parts of this answer ` +
        `(${result.unsupported.length} statement(s), score ${(result.score * 100).toFixed(0)}%) ` +
        `could not be supported by the retrieved sources and may be unreliable:\n${claims}`;
      return { ...result, warningFooter: footer };
    }
    return result;
  }
}

export interface GroundednessConfig {
  enabled?: boolean;
  mode?: GroundednessMode;
  sentenceSupportThreshold?: number;
  passThreshold?: number;
  minContentTokens?: number;
  groundednessType?: "lexical" | "semantic" | "llm";
  semanticThreshold?: number;
  /**
   * Maximum number of source sentences to embed when using semantic mode.
   * Caps embedding fan-out for large retrieval contexts. Default 200.
   */
  maxSourceChunks?: number;
  embedder?: Embedder;
  llmModel?: LanguageModel;
}

/**
 * Builds a {@link GroundednessGate}, or undefined when disabled. Off by default
 * (zero overhead when not constructed).
 */
export function createGroundednessGate(
  config: GroundednessConfig,
  logger?: Logger,
): GroundednessGate | undefined {
  if (config.enabled !== true) return undefined;
  const options: GroundednessOptions = {
    sentenceSupportThreshold:
      config.sentenceSupportThreshold ??
      DEFAULT_GROUNDEDNESS_OPTIONS.sentenceSupportThreshold,
    passThreshold:
      config.passThreshold ?? DEFAULT_GROUNDEDNESS_OPTIONS.passThreshold,
    minContentTokens:
      config.minContentTokens ?? DEFAULT_GROUNDEDNESS_OPTIONS.minContentTokens,
    groundednessType: config.groundednessType ?? "lexical",
    semanticThreshold: config.semanticThreshold ?? 0.8,
    maxSourceChunks:
      config.maxSourceChunks ?? DEFAULT_GROUNDEDNESS_OPTIONS.maxSourceChunks,
    embedder: config.embedder,
    llmModel: config.llmModel,
  };
  logger?.info("Groundedness gate enabled", {
    mode: config.mode ?? "annotate",
    type: options.groundednessType,
    passThreshold: options.passThreshold,
  });
  return new GroundednessGateImpl(config.mode ?? "annotate", options, logger);
}

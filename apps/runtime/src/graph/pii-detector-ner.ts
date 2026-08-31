// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * BERT-NER PII detector (`src/graph/pii-detector-ner.ts`)
 *
 * In-process Named Entity Recognition using ONNX Runtime via the
 * `@huggingface/transformers` (transformers.js v4) library. Detects unstructured
 * PII that regex cannot catch:
 *   - Person names (PER)
 *   - Locations / addresses (LOC)
 *   - Organizations (ORG)
 *
 * The default model (`Xenova/bert-base-multilingual-cased-ner-hrl`, the
 * ONNX-converted build — transformers.js cannot load raw PyTorch weights) is
 * multilingual and covers German and English with a single model.
 *
 * ── transformers.js token-classification specifics (why this file is not
 *    a thin wrapper) ─────────────────────────────────────────────────────────
 * The pipeline returns ONE result per (sub)word token, labelled with raw BIO
 * tags (`B-PER`, `I-PER`, `B-LOC`, …) — it does NOT aggregate multi-token
 * entities, and it returns `start`/`end` as `null` (no character offsets). So
 * this detector must, from that raw token stream:
 *   1. aggregate consecutive `B-`/`I-` tokens of the same type (and subword
 *      `##` continuations) into whole entities, and
 *   2. reconstruct character offsets by locating each entity's word pieces in
 *      the source text with a forward cursor scan.
 * Entities whose words cannot be located are dropped rather than emitted with
 * a bogus span (a wrong span could leave real PII untokenized).
 *
 * `@huggingface/transformers` is a heavy dependency with native components
 * (`sharp`, `onnxruntime-node`) whose install scripts must be trusted (see
 * `trustedDependencies` in package.json). It is lazy-loaded on first `detect()`;
 * a load failure makes `detect()` throw so the registry fail-mode governs the
 * outcome (fail-open skips NER; fail-closed blocks). Note: the Node backend is
 * native onnxruntime-node — it works in the plain runtime (production) but
 * crashes Bun's TEST runner, so real-model validation lives in `scripts/ner-smoke.ts`.
 *
 * Priority: 20 (below regex — regex is deterministic and check-digit validated;
 * NER is probabilistic and used for the entity types regex cannot cover).
 *
 * No `any` at module boundaries.
 */

import type { PiiDetector } from "./pii-detector.js";
import type { PiiMatch, PiiType } from "./output-guardrails.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// transformers.js token-classification output shape (empirically verified)
// ---------------------------------------------------------------------------

/** One token from a transformers.js token-classification pipeline. */
interface NerToken {
  /** Raw BIO label, e.g. "B-PER", "I-LOC", or "O". */
  entity: string;
  /** Confidence in [0,1]. */
  score: number;
  /** Token index in the sentence. */
  index: number;
  /** Decoded (sub)word; wordpiece continuations are prefixed with "##". */
  word: string;
  /** Character start — transformers.js returns null (offsets reconstructed here). */
  start: number | null;
  /** Character end — transformers.js returns null. */
  end: number | null;
}

/** Callable NER pipeline (single-string input → per-token results). */
type NerPipeline = (
  text: string,
  options?: { ignore_labels?: string[] },
) => Promise<NerToken[]>;

/** Bare entity type (after stripping any B-/I- prefix) → PII type. */
const ENTITY_TYPE_TO_PII: Record<string, PiiType | undefined> = {
  PER: "person",
  PERSON: "person",
  LOC: "location",
  GPE: "location",
  ORG: "organization",
  ORGANIZATION: "organization",
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface BertNerDetectorConfig {
  /**
   * Model identifier (HuggingFace hub ID or local path). Defaults to a
   * multilingual model that covers German + English.
   */
  model?: string;
  /** Minimum confidence score (0–1) to accept a detected token. Default: 0.75. */
  confidenceThreshold?: number;
  /** Optional logger for diagnostics. */
  logger?: Logger;
  /** Optional cache directory for downloaded models. */
  cacheDir?: string;
}

// Must be an ONNX-converted model (transformers.js cannot load raw PyTorch
// weights). The Xenova/ conversion of Davlan's multilingual NER model covers
// German + English (PER/LOC/ORG) and is verified to load + detect correctly.
const DEFAULT_MODEL = "Xenova/bert-base-multilingual-cased-ner-hrl";
const DEFAULT_CONFIDENCE = 0.75;

// ---------------------------------------------------------------------------
// Aggregation + offset reconstruction (pure)
// ---------------------------------------------------------------------------

interface EntityGroup {
  type: PiiType;
  /** Word pieces (with "##" stripped), in order. */
  words: string[];
}

/** Splits a BIO label into its prefix ("B"/"I"/"") and bare type ("PER"). */
function splitBioLabel(label: string): { prefix: string; type: string } {
  const dash = label.indexOf("-");
  if (dash === -1) return { prefix: "", type: label };
  return { prefix: label.slice(0, dash), type: label.slice(dash + 1) };
}

/**
 * Aggregates the raw per-token NER stream into whole entities. A `B-` token (or
 * a type change, or a first `I-`) starts a new group; a same-type `I-` token,
 * or any `##` subword continuation, extends the current group. Tokens below the
 * confidence threshold, or whose type is not a PII type, end the current group.
 */
function aggregateEntities(
  tokens: readonly NerToken[],
  confidence: number,
): EntityGroup[] {
  const groups: EntityGroup[] = [];
  let current: EntityGroup | undefined;

  for (const tok of tokens) {
    const isContinuation = tok.word.startsWith("##");
    const cleanWord = isContinuation ? tok.word.slice(2) : tok.word;

    if (tok.score < confidence) {
      current = undefined;
      continue;
    }
    const { prefix, type } = splitBioLabel(tok.entity);
    const piiType = ENTITY_TYPE_TO_PII[type.toUpperCase()];
    if (piiType === undefined) {
      current = undefined;
      continue;
    }

    const extendsCurrent =
      current !== undefined &&
      current.type === piiType &&
      (prefix === "I" || isContinuation);

    if (extendsCurrent && current !== undefined) {
      current.words.push(cleanWord);
    } else {
      current = { type: piiType, words: [cleanWord] };
      groups.push(current);
    }
  }

  return groups;
}

/**
 * Reconstructs the character span of an entity by locating its word pieces in
 * `text` sequentially from `fromIndex` (case-sensitive first, then
 * case-insensitive). Returns the [start, end) covering the first word's start
 * to the last word's end, or null when any piece cannot be located.
 */
function locateEntity(
  text: string,
  words: readonly string[],
  fromIndex: number,
): { start: number; end: number } | null {
  const lowerText = text.toLowerCase();
  let cursor = fromIndex;
  let start = -1;
  let end = -1;

  for (const word of words) {
    if (word.length === 0) continue;
    let idx = text.indexOf(word, cursor);
    if (idx === -1) idx = lowerText.indexOf(word.toLowerCase(), cursor);
    if (idx === -1) return null;
    if (start === -1) start = idx;
    end = idx + word.length;
    cursor = end;
  }

  return start === -1 ? null : { start, end };
}

/**
 * Pure transform: raw NER tokens → PII spans with reconstructed offsets.
 * Exported for unit testing without a live model.
 */
export function nerTokensToMatches(
  tokens: readonly NerToken[],
  text: string,
  confidence: number,
  types?: readonly PiiType[],
): PiiMatch[] {
  const typeFilter =
    types !== undefined && types.length > 0 ? new Set(types) : undefined;

  const groups = aggregateEntities(tokens, confidence);
  const matches: PiiMatch[] = [];
  let searchFrom = 0;

  for (const group of groups) {
    if (typeFilter !== undefined && !typeFilter.has(group.type)) continue;
    const span = locateEntity(text, group.words, searchFrom);
    if (span === null) continue; // could not map back to text → drop
    matches.push({
      type: group.type,
      value: text.slice(span.start, span.end),
      start: span.start,
      end: span.end,
    });
    searchFrom = span.end;
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Detector implementation
// ---------------------------------------------------------------------------

/**
 * In-process BERT-NER detector using transformers.js (ONNX Runtime).
 * Lazy-loads the model on first invocation; a load failure throws so the
 * registry's fail-mode governs the outcome.
 */
export class BertNerDetector implements PiiDetector {
  readonly name: string;
  readonly priority = 20;

  private pipe: NerPipeline | undefined;
  private loadPromise: Promise<NerPipeline | undefined> | undefined;
  private readonly modelId: string;
  private readonly confidence: number;
  private readonly logger?: Logger;
  private readonly cacheDir?: string;

  constructor(config?: BertNerDetectorConfig) {
    this.modelId = config?.model ?? DEFAULT_MODEL;
    this.confidence = config?.confidenceThreshold ?? DEFAULT_CONFIDENCE;
    this.logger = config?.logger;
    this.cacheDir = config?.cacheDir;
    this.name = `ner:${this.modelId.split("/").pop() ?? "bert"}`;
  }

  async detect(text: string, types?: readonly PiiType[]): Promise<PiiMatch[]> {
    const pipe = await this.getPipeline();
    if (pipe === undefined) {
      throw new Error(`BERT-NER pipeline unavailable (model: ${this.modelId})`);
    }
    const tokens = await pipe(text, { ignore_labels: ["O"] });
    return nerTokensToMatches(tokens, text, this.confidence, types);
  }

  // ── Pipeline lifecycle ────────────────────────────────────────────────────

  private async getPipeline(): Promise<NerPipeline | undefined> {
    if (this.pipe !== undefined) return this.pipe;
    if (this.loadPromise !== undefined) return this.loadPromise;
    this.loadPromise = this.loadPipeline();
    this.pipe = await this.loadPromise;
    return this.pipe;
  }

  private async loadPipeline(): Promise<NerPipeline | undefined> {
    try {
      this.logger?.info("Loading BERT-NER model (first use — may take a moment)", {
        model: this.modelId,
      });

      // Dynamically imported HERE rather than statically at module top-level.
      // `@huggingface/transformers` pulls in native components (onnxruntime-node,
      // sharp) that were previously loaded into EVERY process at startup — via
      // `PiiDetectorFactory` (bootstrap/persistence.ts) importing this module
      // even when NER-based PII detection is never enabled — adding measurable
      // startup latency and RSS to every replica/pod. The header comment above
      // already claimed this was "lazy-loaded on first detect()", which was true
      // only for the model PIPELINE, not for the module/native bindings; this
      // makes the claim actually correct.
      const { pipeline, env } = await import("@huggingface/transformers");

      // Allow local model paths in addition to the remote hub.
      env.allowLocalModels = true;

      const built = await pipeline("token-classification", this.modelId, {
        ...(this.cacheDir !== undefined ? { cache_dir: this.cacheDir } : {}),
      });

      this.logger?.info("BERT-NER model loaded successfully", { model: this.modelId });
      // The pipeline instance is callable; narrow it to the token-classification
      // shape we verified at runtime (single string in → NerToken[] out).
      return built as unknown as NerPipeline;
    } catch (err) {
      this.logger?.error(
        "Failed to load BERT-NER model — NER detection unavailable for this replica",
        {
          model: this.modelId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return undefined;
    }
  }
}

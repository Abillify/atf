// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * retrieve-for-answer.ts
 *
 * Answer-ready retrieval: one call turns a question into the evidence that
 * fits a model's context. No model is involved in the steps below — they are
 * rules, so the same question over the same index gives the same answer.
 *
 *   1. {@link decomposeQuestion}: the question plus its parts. A question is cut
 *      at `?`, `;` and the conjunctions " und ", " sowie ", " and ",
 *      " as well as ", but only where both sides have at least three words.
 *   2. Each sub-question is searched (injected `search`, concurrency 4).
 *   3. {@link fuseRrf}: the ranked lists are fused by reciprocal rank,
 *      `score(chunk) = Σ 1 / (60 + rank)`, ranks counted from 1.
 *   4. {@link dedupe}: a repeated chunk id and a near-duplicate text (equal
 *      first 512 characters after case and whitespace folding) collapse to the
 *      higher-fused chunk.
 *   5. Optional rerank of the top 50 against the ORIGINAL question.
 *   6. {@link packEvidence}: chunks go into the token budget greedily, at most
 *      three per document; a chunk that does not fit is skipped, never cut.
 *
 * The orchestration takes its collaborators as functions, so it is tested
 * without a database.
 */

import { createHash } from "node:crypto";
import { mapWithConcurrency } from "./concurrency.js";
import type { SearchResult } from "./pg-types.js";

/** Reciprocal-rank-fusion constant. */
export const RRF_K = 60;
/** Chunks fetched per sub-question. */
export const SUBQUERY_LIMIT = 20;
/** Sub-questions searched at the same time. */
export const SUBQUERY_CONCURRENCY = 4;
/** Fused chunks sent to the reranker. */
export const RERANK_TOP_N = 50;
/** At most this many chunks of one document go into a pack. */
export const MAX_CHUNKS_PER_DOCUMENT_IN_PACK = 3;
/** Packing stops when less than this many tokens are left. */
export const MIN_REMAINING_TOKENS = 64;
/** Characters of normalised content that identify a near-duplicate. */
const NEAR_DUPLICATE_CHARS = 512;
/** Minimum words on each side of a cut. */
const MIN_WORDS_PER_PART = 3;

export const DEFAULT_BUDGET_TOKENS = 4000;
export const DEFAULT_MAX_SUBQUERIES = 4;

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const foldKey = (text: string): string => text.toLowerCase().replace(/[\s?.!;]+$/u, "").replace(/\s+/g, " ").trim();

/** Conjunctions a question may be cut at, with their surrounding blanks. */
const CONJUNCTION = / (?:und|sowie|and|as well as) /i;

/** Cut `text` at the first conjunction whose both sides have enough words; recurse into both halves. */
function splitAtConjunctions(text: string): string[] {
  const pattern = new RegExp(CONJUNCTION.source, "gi");
  let match = pattern.exec(text);
  while (match !== null) {
    const left = text.slice(0, match.index).trim();
    const right = text.slice(match.index + match[0].length).trim();
    if (wordCount(left) >= MIN_WORDS_PER_PART && wordCount(right) >= MIN_WORDS_PER_PART) {
      return [...splitAtConjunctions(left), ...splitAtConjunctions(right)];
    }
    match = pattern.exec(text);
  }
  return [text.trim()];
}

/** Cut at `?` / `;` where both neighbouring segments have enough words. */
function splitAtSentenceMarks(text: string): string[] {
  const segments = text.split(/([?;])/u);
  // segments alternates text, mark, text, mark, …
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < segments.length; i += 2) {
    const piece = (segments[i] ?? "").trim();
    const mark = segments[i + 1] ?? "";
    if (piece === "") continue;
    if (current !== "" && wordCount(current) >= MIN_WORDS_PER_PART && wordCount(piece) >= MIN_WORDS_PER_PART) {
      parts.push(current);
      current = "";
    }
    current = current === "" ? `${piece}${mark}` : `${current} ${piece}${mark}`;
  }
  if (current !== "") parts.push(current);
  return parts;
}

/**
 * The question and its parts: `[question, …parts]`, duplicates removed (case,
 * trailing punctuation and whitespace folded), at most `maxSubqueries` long.
 * The original always comes first. A question that does not split yields just
 * itself.
 */
export function decomposeQuestion(question: string, maxSubqueries = DEFAULT_MAX_SUBQUERIES): string[] {
  const original = question.trim();
  const out: string[] = [original];
  const seen = new Set<string>([foldKey(original)]);
  const parts = splitAtSentenceMarks(original).flatMap(splitAtConjunctions);
  for (const part of parts) {
    const text = part.trim();
    const key = foldKey(text);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, Math.max(1, maxSubqueries));
}

export interface FusedChunk {
  result: SearchResult;
  /** Σ 1 / (RRF_K + rank) over the lists that contain the chunk. */
  score: number;
  /** Indexes of the sub-questions whose list contained the chunk. */
  matchedSubqueries: number[];
}

/**
 * Multi-query reciprocal-rank fusion. Ties break by the earlier first
 * appearance (sub-question index, then rank), so the order is deterministic.
 */
export function fuseRrf(lists: readonly (readonly SearchResult[])[]): FusedChunk[] {
  const byId = new Map<string, FusedChunk & { firstList: number; firstRank: number }>();
  lists.forEach((list, listIndex) => {
    list.forEach((result, position) => {
      const rank = position + 1;
      const gain = 1 / (RRF_K + rank);
      const known = byId.get(result.id);
      if (known === undefined) {
        byId.set(result.id, {
          result,
          score: gain,
          matchedSubqueries: [listIndex],
          firstList: listIndex,
          firstRank: rank,
        });
      } else {
        known.score += gain;
        if (!known.matchedSubqueries.includes(listIndex)) known.matchedSubqueries.push(listIndex);
      }
    });
  });
  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.firstList - b.firstList || a.firstRank - b.firstRank)
    .map(({ result, score, matchedSubqueries }) => ({ result, score, matchedSubqueries }));
}

/** SHA-1 over the first 512 characters of the case- and whitespace-folded text. */
export function nearDuplicateKey(content: string): string {
  const folded = content.toLowerCase().replace(/\s+/g, " ").trim().slice(0, NEAR_DUPLICATE_CHARS);
  return createHash("sha1").update(folded).digest("hex");
}

/**
 * Drop repeated chunks: the same chunk id (already merged by the fusion, kept
 * here for lists that were not fused) and near-duplicate texts. The first —
 * the higher-fused — chunk is kept; the relative order is preserved.
 */
export function dedupe(chunks: readonly FusedChunk[]): FusedChunk[] {
  const ids = new Set<string>();
  const texts = new Set<string>();
  const out: FusedChunk[] = [];
  for (const chunk of chunks) {
    const textKey = nearDuplicateKey(chunk.result.content);
    if (ids.has(chunk.result.id) || texts.has(textKey)) continue;
    ids.add(chunk.result.id);
    texts.add(textKey);
    out.push(chunk);
  }
  return out;
}

export interface PackedEvidence {
  id: string;
  reference: string;
  base_ref: string;
  title?: string;
  section?: string;
  page_start?: number;
  page_end?: number;
  content: string;
  score: number;
  matched_subqueries: number[];
}

export interface PackResult {
  evidence: PackedEvidence[];
  usedTokens: number;
  /** Candidates were left out because they did not fit the budget. */
  truncated: boolean;
}

function toEvidence(chunk: FusedChunk): PackedEvidence {
  const { result } = chunk;
  const sectionPath = result.evidence?.section_path;
  return {
    id: result.id,
    reference: result.reference,
    base_ref: result.base_ref,
    ...(result.title ? { title: result.title } : {}),
    ...(sectionPath && sectionPath.length > 0 ? { section: sectionPath.join(" > ") } : {}),
    ...(result.evidence?.page_start !== undefined ? { page_start: result.evidence.page_start } : {}),
    ...(result.evidence?.page_end !== undefined ? { page_end: result.evidence.page_end } : {}),
    content: result.content,
    score: chunk.score,
    matched_subqueries: chunk.matchedSubqueries,
  };
}

/**
 * Greedy packing into `budgetTokens`, in order. At most
 * {@link MAX_CHUNKS_PER_DOCUMENT_IN_PACK} chunks per `base_ref`; a chunk that
 * would exceed the budget is skipped (never cut) and the next one is tried,
 * until fewer than {@link MIN_REMAINING_TOKENS} tokens are left after such a
 * skip: then packing stops.
 */
export async function packEvidence(
  chunks: readonly FusedChunk[],
  budgetTokens: number,
  countTokens: (text: string) => Promise<number>,
): Promise<PackResult> {
  const evidence: PackedEvidence[] = [];
  const perDocument = new Map<string, number>();
  let used = 0;
  let truncated = false;
  for (const chunk of chunks) {
    const documentCount = perDocument.get(chunk.result.base_ref) ?? 0;
    if (documentCount >= MAX_CHUNKS_PER_DOCUMENT_IN_PACK) continue;
    const tokens = await countTokens(chunk.result.content);
    if (used + tokens > budgetTokens) {
      truncated = true;
      // Looking further for a smaller chunk is pointless once the rest of the
      // budget is too small to hold a useful passage.
      if (budgetTokens - used < MIN_REMAINING_TOKENS) break;
      continue;
    }
    used += tokens;
    perDocument.set(chunk.result.base_ref, documentCount + 1);
    evidence.push(toEvidence(chunk));
  }
  return { evidence, usedTokens: used, truncated };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface RetrieveForAnswerInput {
  question: string;
  budgetTokens?: number | undefined;
  maxSubqueries?: number | undefined;
}

export interface RetrieveForAnswerDeps {
  /** Hybrid search without rerank and grouping, `limit` results, best first. */
  search(query: string, limit: number): Promise<SearchResult[]>;
  /**
   * Reorders `results` by relevance to `question` (best first); `undefined` =
   * the reranker did not apply (not configured, too few results, failed).
   */
  rerank?: ((question: string, results: SearchResult[]) => Promise<SearchResult[] | undefined>) | undefined;
  countTokens(text: string): Promise<number>;
}

export interface RetrieveForAnswerOutput {
  question: string;
  subqueries: string[];
  budget_tokens: number;
  used_tokens: number;
  truncated: boolean;
  content_trust: "untrusted";
  evidence: PackedEvidence[];
  /** True when the reranker was applied. */
  reranked: boolean;
}

export async function retrieveForAnswer(
  deps: RetrieveForAnswerDeps,
  input: RetrieveForAnswerInput,
): Promise<RetrieveForAnswerOutput> {
  const budget = input.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const subqueries = decomposeQuestion(input.question, input.maxSubqueries ?? DEFAULT_MAX_SUBQUERIES);
  const lists = await mapWithConcurrency(subqueries, SUBQUERY_CONCURRENCY, async (query, index) => {
    try {
      return await deps.search(query, SUBQUERY_LIMIT);
    } catch (error) {
      // The original question must succeed; a failing part only narrows the recall.
      if (index === 0) throw error;
      return [] as SearchResult[];
    }
  });

  let candidates = dedupe(fuseRrf(lists));

  let reranked = false;
  if (deps.rerank !== undefined && candidates.length > 1) {
    const head = candidates.slice(0, RERANK_TOP_N);
    const ordered = await deps.rerank(
      input.question,
      head.map((chunk) => chunk.result),
    );
    if (ordered !== undefined) {
      const byId = new Map(head.map((chunk) => [chunk.result.id, chunk]));
      const reordered: FusedChunk[] = [];
      for (const result of ordered) {
        const chunk = byId.get(result.id);
        if (chunk !== undefined) {
          reordered.push(chunk);
          byId.delete(result.id);
        }
      }
      // A chunk the reranker did not return keeps its fusion position after the ranked ones.
      candidates = [...reordered, ...byId.values(), ...candidates.slice(RERANK_TOP_N)];
      reranked = true;
    }
  }

  const packed = await packEvidence(candidates, budget, deps.countTokens);
  return {
    question: input.question,
    subqueries,
    budget_tokens: budget,
    used_tokens: packed.usedTokens,
    truncated: packed.truncated,
    content_trust: "untrusted",
    evidence: packed.evidence,
    reranked,
  };
}

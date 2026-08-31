// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Follow-up RAG down-weighting (`src/graph/rag-followup.ts`)
 *
 * Cross-turn optimisation for the `rag-context` (parallel) node: documents that
 * were already shown to the responder in EARLIER turns of the same conversation
 * are DOWN-WEIGHTED (not excluded) in the current turn's retrieval fusion. A
 * follow-up therefore prefers fresh material, but an already-seen document can
 * still resurface when it is strongly relevant again ("explain section 3 of
 * that doc") — unlike a hard exclusion, which would remove it outright.
 *
 * Mechanism: the penalty is folded into each chunk's `scoreWeight`, which
 * `selectByRetrievalScore` already multiplies into the effective score
 * (`retrievalScore * scoreWeight`). So a seen document competes at `factor`×
 * its normal weight. The set of "seen" document refs is accumulated across
 * turns in the checkpointed `seenDocRefs` state channel (threaded mode only;
 * without a conversation_id there is no cross-turn state and this is a no-op).
 *
 * NOTE: the penalty is applied via `scoreWeight`, which the score-only fusion
 * path (`selectByRetrievalScore`) honours. The model-rerank path
 * (`selectRerankedChunks`) orders purely by the cross-encoder score and does
 * NOT consult `scoreWeight`, so this down-weighting is a no-op there by design
 * (the reranker is trusted to judge relevance itself).
 *
 * No `any` at module boundaries.
 */

import type { RagChunk } from "./reranker.js";

/** Parsed `config.followupDownweight` for the rag-context node. */
export interface FollowupDownweightConfig {
  enabled: true;
  /** Multiplier applied to an already-seen document's weight (0..1). */
  factor: number;
  /** Max number of seen doc refs retained across turns (most-recent kept). */
  cap: number;
}

/**
 * Document-level identity for cross-turn tracking: prefer the parent-doc
 * `baseRef`, then the source URL, then the title. Mirrors the doc-dedup key
 * used by the fusion selectors (`url` → `title`), extended with `baseRef` when
 * the vector store provided one.
 */
export function docKeyOf(chunk: RagChunk): string {
  if (typeof chunk.baseRef === "string" && chunk.baseRef.length > 0)
    return chunk.baseRef;
  if (chunk.url.length > 0) return chunk.url;
  return chunk.title;
}

/**
 * Parses and validates `node.config.followupDownweight`. Returns undefined
 * (feature off) when the block is missing or disabled. `factor` is clamped to
 * [0,1] (default 0.5); `cap` defaults to 100.
 */
export function parseFollowupDownweightConfig(
  config: Record<string, unknown> | undefined,
): FollowupDownweightConfig | undefined {
  const raw = (config as { followupDownweight?: unknown } | undefined)
    ?.followupDownweight;
  if (raw === null || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return undefined;
  let factor = typeof r.factor === "number" ? r.factor : 0.5;
  if (!Number.isFinite(factor)) factor = 0.5;
  factor = Math.max(0, Math.min(1, factor));
  const cap =
    typeof r.cap === "number" && r.cap > 0 ? Math.floor(r.cap) : 100;
  return { enabled: true, factor, cap };
}

/**
 * Down-weights every chunk whose document was already seen, by multiplying its
 * `scoreWeight` (default 1) by `factor`. Mutates the chunks in place (they are
 * freshly parsed per turn). Returns how many chunks were down-weighted.
 */
export function applySeenDownweight(
  chunks: RagChunk[],
  seen: ReadonlySet<string>,
  factor: number,
): number {
  if (seen.size === 0) return 0;
  let count = 0;
  for (const c of chunks) {
    if (!seen.has(docKeyOf(c))) continue;
    const base =
      typeof c.scoreWeight === "number" && c.scoreWeight >= 0
        ? c.scoreWeight
        : 1;
    c.scoreWeight = base * factor;
    count++;
  }
  return count;
}

/**
 * Accumulates the document refs shown THIS turn into the running seen-set,
 * de-duplicated and capped to the most-recent `cap` entries (older refs are
 * dropped first). Returns a new array.
 */
export function mergeSeenRefs(
  prev: string[] | undefined,
  shown: readonly RagChunk[],
  cap: number,
): string[] {
  const set = new Set<string>(prev ?? []);
  for (const c of shown) {
    const key = docKeyOf(c);
    // Re-insert at the end so recently-shown refs survive the cap trim.
    set.delete(key);
    set.add(key);
  }
  const arr = Array.from(set);
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

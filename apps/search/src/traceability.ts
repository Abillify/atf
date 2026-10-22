// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * traceability.ts — Epic E7 (K1): the `trace` tool's logic.
 *
 * Follows an identifier (article/transaction/drawing code, e.g. "WE-01/A")
 * across two points in time: the identifier is looked up in the lexical index
 * at `valid_at_a` and at `valid_at_b` (FTS-only search with the temporal
 * `valid_at` visibility rule), and the two occurrence sets are diffed.
 *
 * The diff is pure: the search over time is injected as a callback so the
 * orchestration is testable without a database and the MCP handler stays thin.
 */

import { createHash } from "node:crypto";

/** One occurrence of the identifier at one point in time. */
export interface TraceOccurrence {
  base_ref: string;
  reference: string;
  /** Section path joined with " > " when the hit carries one. */
  section?: string;
  page_start?: number;
  /** Excerpt (max 300 chars) centred on the identifier hit. */
  excerpt: string;
  /** SHA-256 hex of the whitespace-normalized chunk content. */
  content_hash: string;
}

/** Diff of two occurrence sets, keyed by base_ref + section. */
export interface TraceDiff {
  added: TraceOccurrence[];
  removed: TraceOccurrence[];
  changed: Array<{ key: string; a: TraceOccurrence; b: TraceOccurrence }>;
  unchanged_count: number;
}

/** The injected lookup: occurrences of `identifier` valid at `validAt`. */
export type TraceSearchFn = (
  identifier: string,
  validAt: string,
  limit: number,
) => Promise<TraceOccurrence[]>;

export interface TraceInput {
  identifier: string;
  valid_at_a: string;
  valid_at_b: string;
  limit: number;
}

/** Max excerpt length around the hit (spec: 300 characters). */
export const TRACE_EXCERPT_MAX_CHARS = 300;

/** Normalizes content for hashing: collapse all whitespace, trim. */
export function normalizeForHash(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

/** SHA-256 hex of the normalized content — the diff's change detector. */
export function contentHash(content: string): string {
  return createHash("sha256").update(normalizeForHash(content)).digest("hex");
}

/**
 * Flatten content and cut a window of at most `maxChars` centred on the first
 * case-insensitive occurrence of `needle`; "…" marks a truncated side. Falls
 * back to the head of the flattened text when the needle is absent.
 */
export function centeredExcerpt(
  content: string,
  needle: string,
  maxChars: number = TRACE_EXCERPT_MAX_CHARS,
): string {
  const flat = normalizeForHash(content);
  if (flat.length <= maxChars) return flat;
  const idx = needle === "" ? -1 : flat.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return `${flat.slice(0, maxChars - 1)}…`;
  // Centre the window on the hit; the hit itself always fits (identifiers
  // are far shorter than the window).
  const room = maxChars - 2; // reserve a char for each side's ellipsis
  let start = Math.max(0, idx - Math.floor(room / 2));
  let end = start + room;
  if (end >= flat.length) {
    end = flat.length;
    start = Math.max(0, end - room);
  }
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}

/** The diff key: document + section ("" stands for "no section"). */
export function traceOccurrenceKey(o: TraceOccurrence): string {
  return `${o.base_ref}${"\u0000"}${o.section ?? ""}`;
}

/**
 * Diff two occurrence sets. Key = base_ref + section; occurrences of the same
 * key on both sides are `changed` when their content_hash differs, otherwise
 * counted in `unchanged_count`. Duplicates of one key on a side collapse to
 * the first occurrence (a document+section can host several mentions, but the
 * diff tracks the document/section level).
 */
export function diffTraceOccurrences(
  a: readonly TraceOccurrence[],
  b: readonly TraceOccurrence[],
): TraceDiff {
  const mapA = new Map<string, TraceOccurrence>();
  for (const o of a) {
    const k = traceOccurrenceKey(o);
    if (!mapA.has(k)) mapA.set(k, o);
  }
  const mapB = new Map<string, TraceOccurrence>();
  for (const o of b) {
    const k = traceOccurrenceKey(o);
    if (!mapB.has(k)) mapB.set(k, o);
  }

  const added: TraceOccurrence[] = [];
  const changed: TraceDiff["changed"] = [];
  let unchangedCount = 0;

  for (const [k, ob] of mapB) {
    const oa = mapA.get(k);
    if (!oa) {
      added.push(ob);
      continue;
    }
    if (oa.content_hash !== ob.content_hash) {
      changed.push({ key: k, a: oa, b: ob });
    } else {
      unchangedCount += 1;
    }
  }
  const removed: TraceOccurrence[] = [];
  for (const [k, oa] of mapA) {
    if (!mapB.has(k)) removed.push(oa);
  }

  return { added, removed, changed, unchanged_count: unchangedCount };
}

/**
 * Orchestration: look the identifier up at both time points (via the injected
 * search) and diff the two occurrence sets.
 */
export async function traceIdentifier(
  input: TraceInput,
  search: TraceSearchFn,
): Promise<TraceDiff> {
  const occurrencesA = await search(input.identifier, input.valid_at_a, input.limit);
  const occurrencesB = await search(input.identifier, input.valid_at_b, input.limit);
  return diffTraceOccurrences(occurrencesA, occurrencesB);
}

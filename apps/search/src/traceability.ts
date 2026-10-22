// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * traceability.ts — traceability: the `trace` tool's logic.
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

/** Separators a writer adds or drops freely inside an identifier (see normalizeIdentifier). */
const IDENTIFIER_SEPARATOR = "[\\s.\\-/\\u00a0]*";

/**
 * Exact-identifier predicate for lexical hits. The lexical list is an OR list
 * (`WE-01/A` → `'WE-01' | 'A'`), so a chunk mentioning `WE-01/B` or a lone
 * "Anlage A" is a hit too. This keeps only content that contains the
 * identifier itself: the same characters in order, case-insensitive, with the
 * separators `normalizeIdentifier` ignores allowed between them, and no
 * letter or digit directly before or after (so `WE-01/AB` does not count).
 * An identifier without letters or digits matches nothing.
 */
export function identifierMatcher(identifier: string): (content: string) => boolean {
  const chars = [...identifier.normalize("NFC")].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (chars.length === 0) return () => false;
  const body = chars
    .map((c) => c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join(IDENTIFIER_SEPARATOR);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, "iu");
  return (content) => re.test(content.normalize("NFC"));
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

// ── document_diff: unit-level diff between two points in time ──────

/**
 * The unit shape the diff consumes — structurally satisfied by `NavUnitRow`
 * (the navigation methods' row type) without importing pg types here.
 */
export interface DiffableUnit {
  unit_id: string | null;
  unit_type: string | null;
  section_id: string | null;
  table_id: string | null;
  page_start: number | null;
  page_end: number | null;
  content: string;
  metadata: { [key: string]: unknown };
}

/** Diff of two unit sets of the same document. */
export interface DocumentUnitDiff {
  added: DiffableUnit[];
  removed: DiffableUnit[];
  changed: Array<{ key: string; before: DiffableUnit; after: DiffableUnit }>;
  unchanged_count: number;
}

/** Flatten content and keep at most `maxChars` from the head; "…" marks a cut. */
export function headExcerpt(
  content: string,
  maxChars: number = TRACE_EXCERPT_MAX_CHARS,
): string {
  const flat = normalizeForHash(content);
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

function unitOrdinal(u: DiffableUnit): number | null {
  const o = u.metadata?.ordinal;
  return typeof o === "number" ? o : null;
}

/**
 * Fallback alignment key (the spec's "chunk_index" step): v2 units carry no
 * chunk index, so the per-section ordinal stands in, scoped by unit type and
 * table id to stay unique within a section. Null when no ordinal is present.
 */
function unitPairKey(u: DiffableUnit): string | null {
  const ordinal = unitOrdinal(u);
  if (ordinal === null) return null;
  return `${u.unit_type ?? ""}${"\u0000"}${u.table_id ?? ""}${"\u0000"}${ordinal}`;
}

/**
 * Pair two ordered unit lists of one alignment group (one section, or the
 * section-less units). Ladder: exact `unit_id` match (unit ids embed the
 * revision id, so an identical id means the identical row is visible at both
 * instants), then the ordinal-based pair key, then reading-order position.
 * Paired units with differing content hashes are `changed`, equal ones count
 * as unchanged; unpaired leftovers are removed (a-side) / added (b-side).
 */
function pairUnitLists(
  groupKey: string,
  aList: readonly DiffableUnit[],
  bList: readonly DiffableUnit[],
  useOrdinal: boolean,
  acc: {
    added: DiffableUnit[];
    removed: DiffableUnit[];
    changed: DocumentUnitDiff["changed"];
    unchanged: number;
  },
): void {
  const aById = new Map<string, DiffableUnit>();
  const aRest: DiffableUnit[] = [];
  for (const u of aList) {
    if (u.unit_id !== null && !aById.has(u.unit_id)) aById.set(u.unit_id, u);
    else aRest.push(u);
  }

  const bRest: DiffableUnit[] = [];
  for (const u of bList) {
    const id = u.unit_id;
    const match = id !== null ? aById.get(id) : undefined;
    if (match !== undefined && id !== null) {
      aById.delete(id);
      if (contentHash(match.content) !== contentHash(u.content)) {
        acc.changed.push({ key: `${groupKey}${"\u0000"}${id}`, before: match, after: u });
      } else {
        acc.unchanged += 1;
      }
    } else {
      bRest.push(u);
    }
  }

  // A-side ids that found no counterpart are leftovers too; the Map keeps
  // insertion order, so appending them preserves reading order.
  for (const u of aById.values()) aRest.push(u);

  // Ordinal pairing for the leftovers (changed units get a new unit id).
  let aFinal = aRest;
  let bFinal = bRest;
  if (useOrdinal) {
    const bByKey = new Map<string, DiffableUnit>();
    bFinal = [];
    for (const u of bRest) {
      const k = unitPairKey(u);
      if (k !== null && !bByKey.has(k)) bByKey.set(k, u);
      else bFinal.push(u);
    }
    aFinal = [];
    for (const u of aRest) {
      const k = unitPairKey(u);
      const match = k !== null ? bByKey.get(k) : undefined;
      if (match !== undefined && k !== null) {
        bByKey.delete(k);
        if (contentHash(match.content) !== contentHash(u.content)) {
          acc.changed.push({ key: `${groupKey}${"\u0000"}${k}`, before: u, after: match });
        } else {
          acc.unchanged += 1;
        }
      } else {
        aFinal.push(u);
      }
    }
  }

  // Last resort: reading-order position within the group.
  const pairs = Math.min(aFinal.length, bFinal.length);
  for (let i = 0; i < pairs; i++) {
    const before = aFinal[i];
    const after = bFinal[i];
    if (contentHash(before.content) !== contentHash(after.content)) {
      acc.changed.push({ key: `${groupKey}${"\u0000"}pos${"\u0000"}${i}`, before, after });
    } else {
      acc.unchanged += 1;
    }
  }
  for (let i = pairs; i < aFinal.length; i++) acc.removed.push(aFinal[i]);
  for (let i = pairs; i < bFinal.length; i++) acc.added.push(bFinal[i]);
}

function groupUnits(units: readonly DiffableUnit[]): {
  sections: Map<string, DiffableUnit[]>;
  sectionless: DiffableUnit[];
} {
  const sections = new Map<string, DiffableUnit[]>();
  const sectionless: DiffableUnit[] = [];
  for (const u of units) {
    if (u.section_id === null) {
      sectionless.push(u);
      continue;
    }
    const list = sections.get(u.section_id);
    if (list) list.push(u);
    else sections.set(u.section_id, [u]);
  }
  return { sections, sectionless };
}

/**
 * Diff a document's units between two points in time. Alignment: `section_id`
 * groups first (section ids derive from the section path, which is stable
 * across revisions), then `unit_id`, then the ordinal-based pair key, then
 * reading order. Units without a section id (document/page units) align by
 * `unit_id`, else reading order — their ordinals are always 0, so the ordinal
 * step would be meaningless there.
 */
export function diffDocumentUnits(
  fromUnits: readonly DiffableUnit[],
  toUnits: readonly DiffableUnit[],
): DocumentUnitDiff {
  const acc = {
    added: [] as DiffableUnit[],
    removed: [] as DiffableUnit[],
    changed: [] as DocumentUnitDiff["changed"],
    unchanged: 0,
  };
  const a = groupUnits(fromUnits);
  const b = groupUnits(toUnits);

  for (const [sectionId, aGroup] of a.sections) {
    const bGroup = b.sections.get(sectionId);
    if (bGroup === undefined) {
      acc.removed.push(...aGroup);
      continue;
    }
    pairUnitLists(sectionId, aGroup, bGroup, true, acc);
  }
  for (const [sectionId, bGroup] of b.sections) {
    if (!a.sections.has(sectionId)) acc.added.push(...bGroup);
  }
  pairUnitLists("", a.sectionless, b.sectionless, false, acc);

  return {
    added: acc.added,
    removed: acc.removed,
    changed: acc.changed,
    unchanged_count: acc.unchanged,
  };
}

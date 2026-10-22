// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// apps/search/src/rerank-context.ts
//
// Retrieval v2 — rerank-with-context and diversification (task 3.5).
//
// Three pure, side-effect-free helpers used by the v2 retrieval pipeline
// (design §7.1 steps 3–4, Requirements 13.1/13.2/13.6):
//
//   buildRerankDocument(result, maxTokens)
//     Assembles the string handed to the cross-encoder reranker from the hit's
//     CONTEXT (title, section path, unit type) plus its content, capped so the
//     pair stays within the reranker's input budget (Requirement 13.2:
//     "Title, section path, Type and content, at most 1024 tokens").
//
//   diversifyResults(results, opts)
//     Collapses duplicate table / figure hits into one representative and caps
//     the number of hits per section (design §7.1 step 4). Purely reorders /
//     drops; never mutates its inputs.
//
//   groupResultsBySection(results)
//     Groups (already diversified) hits by section path for `group_by: section`
//     over a single large document (Requirement 13.6, design §6/§7.1). Modelled
//     on groupResultsByDocument in handlers/search.ts.
//
// Why a CHARACTER cap rather than the async token counter
// ───────────────────────────────────────────────────────
// The rerank input cap is a guard-rail, not an exact budget: the reranker itself
// truncates internally, and the goal is only to keep one document from flooding
// the cross-encoder's context. Wiring the async TEI /tokenize counter (task 3.1)
// into the synchronous, per-document rerank path — which already runs inside a
// hot request — would add an HTTP round-trip (or a large batch call) purely to
// trim a soft limit. We therefore approximate with the same ~4-chars-per-token
// ratio the reranker client and token counter already use elsewhere
// (Math.ceil(text.length / 4)); 1024 tokens ≈ 4096 characters. buildRerankDocument
// keeps the (short) context header intact and truncates the CONTENT, so the
// distinguishing context is never lost to truncation.
//
// When a real tokenizer IS available (the TEI-backed TokenCounter from
// token-counter.ts), fitRerankInputs() tightens the cap: it counts each
// char-capped document once (one batched /tokenize call, cached) and trims the
// content of any document that still exceeds the token budget — dense text
// (German compounds, codes, tables) often runs well under 4 chars/token. The
// counter measures the EMBEDDING model's tokenizer, which is a close proxy for
// the reranker's; it only ever shrinks inputs, never grows them, and falls back
// to the heuristic cap when the counter is absent or fails.

import type { SearchResult } from "./postgres-client.js";
import type { TokenCounter } from "./token-counter.js";

/** Requirement 13.2: the reranker input is capped at 1024 tokens. */
export const RERANK_MAX_TOKENS = 1024;

/** Characters per token used for the char-based approximation (see file header). */
export const CHARS_PER_TOKEN = 4;

/** Default per-section cap for diversification (design §7.1 step 4, "at most n"). */
export const DEFAULT_SECTION_CAP = 3;

// ─── Context extraction ─────────────────────────────────────────────────────

/**
 * Pull the section path off a result, preferring `evidence.section_path` and
 * falling back to `metadata.section_path`. Returns a "/"-joined string, or the
 * empty string when no section path is present.
 */
export function sectionPathString(result: SearchResult): string {
  const fromEvidence = result.evidence?.section_path;
  const fromMeta = (result.metadata as { section_path?: unknown } | undefined)
    ?.section_path;
  const path = Array.isArray(fromEvidence)
    ? fromEvidence
    : Array.isArray(fromMeta)
      ? (fromMeta as unknown[])
      : undefined;
  if (!path || path.length === 0) return "";
  return path.map((p) => String(p)).join(" / ");
}

/**
 * The unit type of a hit (`chunk` | `table` | `figure` | `section` | `page` |
 * `document`), taken from `metadata.unit_type`. Returns undefined for legacy v1
 * rows that carry no unit type.
 */
export function unitType(result: SearchResult): string | undefined {
  const t = (result.metadata as { unit_type?: unknown } | undefined)?.unit_type;
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

function tableId(result: SearchResult): string | undefined {
  const t = (result.metadata as { table_id?: unknown } | undefined)?.table_id;
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

function figureId(result: SearchResult): string | undefined {
  const fromEvidence = result.evidence?.figure_id;
  if (typeof fromEvidence === "string" && fromEvidence.length > 0)
    return fromEvidence;
  const fromMeta = (result.metadata as { figure_id?: unknown } | undefined)
    ?.figure_id;
  return typeof fromMeta === "string" && fromMeta.length > 0
    ? fromMeta
    : undefined;
}

// ─── buildRerankDocument ─────────────────────────────────────────────────────

/**
 * Build the document string sent to the reranker for a single hit.
 *
 * Layout (Requirement 13.2 — Title, section path, Type, content):
 *
 *   Title: <title>
 *   Section: <a / b / c>
 *   Type: <unit_type>
 *
 *   <content>
 *
 * Only the header lines that have a value are emitted, so a legacy v1 hit with
 * no title/section/type degrades to just its content (backward compatible with
 * the previous `results.map(r => r.content)` behaviour).
 *
 * The whole document is capped at `maxTokens` tokens, approximated as
 * `maxTokens * CHARS_PER_TOKEN` characters (see the file header for why the cap
 * is char-based). The context header is kept intact; only the CONTENT is
 * truncated to fit, so the distinguishing context always survives. If the
 * header alone already exceeds the budget it is hard-truncated as a last resort.
 */
export function buildRerankDocument(
  result: SearchResult,
  maxTokens: number = RERANK_MAX_TOKENS,
): string {
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));

  const headerLines: string[] = [];
  const title = result.title?.trim();
  if (title) headerLines.push(`Title: ${title}`);
  const section = sectionPathString(result);
  if (section) headerLines.push(`Section: ${section}`);
  const type = unitType(result);
  if (type) headerLines.push(`Type: ${type}`);

  const header = headerLines.length > 0 ? headerLines.join("\n") + "\n\n" : "";
  const content = result.content ?? "";

  // No header (legacy row): the document is just the (capped) content.
  if (header === "") {
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  }

  // Header alone already at/over budget: keep as much of the header as fits.
  if (header.length >= maxChars) {
    return header.slice(0, maxChars);
  }

  const remaining = maxChars - header.length;
  const trimmedContent =
    content.length > remaining ? content.slice(0, remaining) : content;
  return header + trimmedContent;
}

// ─── Diversification ─────────────────────────────────────────────────────────

export interface DiversifyOptions {
  /**
   * Maximum number of hits kept per `section_path`. The highest-scoring hits in
   * each section are kept; the rest are dropped. Defaults to
   * {@link DEFAULT_SECTION_CAP}. A non-positive value disables the per-section
   * cap (table/figure collapsing still runs).
   */
  perSectionCap?: number;
  /**
   * `include_all_versions`: keep revisions of one document apart. The
   * document-scoped keys are extended by the hit's revision identity, so
   * collapsing and capping never merge hits from different versions.
   */
  includeAllVersions?: boolean;
}

/**
 * Revision identity of a hit. v2 units carry their `revision_id`; their
 * reference (`doc#unit:<id>`) is unique per unit and would split one revision
 * into single units. Legacy v1 rows have no revision id but carry the version
 * in their reference (`doc_v2`), so the reference without the `_chunk_N`
 * suffix separates the revisions of one document while all chunks of one
 * revision share it.
 */
export function revisionIdentity(r: SearchResult): string {
  if (r.revision_id !== undefined && r.revision_id !== "") return `rev:${r.revision_id}`;
  return r.reference.replace(/_chunk_\d+$/, "");
}

/**
 * Document identity used to scope every diversification key: the `base_ref`
 * (all versions/chunks of one document), falling back to `reference`. Extract
 * numbers sections, tables and figures per document, so none of those ids is
 * meaningful across documents. With `include_all_versions` the key is
 * extended by the revision identity so revisions are not collapsed together.
 */
function diversifyDocumentKey(r: SearchResult, includeAllVersions: boolean): string {
  const doc = r.base_ref || r.reference;
  return includeAllVersions ? `${doc}\u0000${revisionIdentity(r)}` : doc;
}

/**
 * Diversify a ranked result list (design §7.1 step 4).
 *
 * Two independent passes, applied in this order:
 *
 *  1. Collapse duplicates: multiple hits of the SAME `table_id`, or multiple
 *     hits of the SAME `figure_id`, WITHIN one document are collapsed to a
 *     single representative — the highest-scoring one — so a big table's many
 *     row-group units (or a figure indexed several ways) cannot flood the
 *     results. The key is document-scoped (`base_ref`, falling back to
 *     `reference`): ids are per document, and two data sheets that both carry
 *     "table 1" must both survive.
 *
 *  2. Per-section cap: at most `perSectionCap` hits are kept per section path
 *     WITHIN each document (the `base_ref`, falling back to `reference`),
 *     keeping the highest-scoring ones. The bucket is document-scoped on
 *     purpose: identically-named sections in different documents ("Einleitung"
 *     in ten manuals) are different sections and must not share one cap.
 *     Hits with no section path are treated as their own unbounded bucket
 *     (never capped), because an empty path is "unknown section", not "the
 *     same section".
 *
 * The input order is otherwise preserved for hits that survive both passes, so
 * a list already sorted by score stays sorted. Inputs are never mutated.
 */
export function diversifyResults(
  results: SearchResult[],
  opts: DiversifyOptions = {},
): SearchResult[] {
  const perSectionCap = opts.perSectionCap ?? DEFAULT_SECTION_CAP;
  const includeAllVersions = opts.includeAllVersions === true;

  // ── Pass 1: collapse same table_id / same figure_id to the best hit. ──
  // Key space is namespaced so a table id can never collide with a figure id.
  const bestByKey = new Map<string, SearchResult>();
  const collapsed: SearchResult[] = [];
  for (const r of results) {
    const tId = tableId(r);
    const fId = figureId(r);
    // Document-scoped: `table_id` / `figure_id` are assigned per document by
    // Extract, so the same id in two documents is two different objects.
    const key = tId
      ? `${diversifyDocumentKey(r, includeAllVersions)}\u0000table:${tId}`
      : fId
        ? `${diversifyDocumentKey(r, includeAllVersions)}\u0000figure:${fId}`
        : null;
    if (key === null) {
      collapsed.push(r);
      continue;
    }
    const existing = bestByKey.get(key);
    if (existing === undefined) {
      bestByKey.set(key, r);
      // Reserve the slot in output order via a placeholder we patch below.
      collapsed.push(r);
    } else if (r.score > existing.score) {
      // A better representative arrived; swap it in place of the earlier one.
      const idx = collapsed.indexOf(existing);
      if (idx !== -1) collapsed[idx] = r;
      bestByKey.set(key, r);
    }
    // else: a lower-scoring duplicate — dropped.
  }

  // ── Pass 2: cap hits per section, keeping the highest scores. ──
  if (perSectionCap <= 0) return collapsed;

  const perSectionCount = new Map<string, number>();
  const diversified: SearchResult[] = [];
  // Walk in descending score so the kept hits per section are the top ones,
  // then restore the original relative order for the survivors below.
  const byScoreDesc = [...collapsed].sort((a, b) => b.score - a.score);
  const kept = new Set<SearchResult>();
  for (const r of byScoreDesc) {
    const section = sectionPathString(r);
    if (section === "") {
      // Unknown section — never capped.
      kept.add(r);
      continue;
    }
    // Document-scoped bucket (same composite-key pattern as groupResultsV2):
    // the same section path in two documents is two buckets, not one.
    const bucket = `${diversifyDocumentKey(r, includeAllVersions)}\u0000${section}`;
    const count = perSectionCount.get(bucket) ?? 0;
    if (count < perSectionCap) {
      perSectionCount.set(bucket, count + 1);
      kept.add(r);
    }
  }
  for (const r of collapsed) {
    if (kept.has(r)) diversified.push(r);
  }
  return diversified;
}

// ─── Section grouping (group_by: section) ────────────────────────────────────

/**
 * A section group returned by {@link groupResultsBySection}. `section_path` is
 * the "/"-joined path shared by every hit in `results`; `base_ref` is the
 * document the section belongs to; `score` is the best (max) hit score in the
 * group, used to order the groups.
 */
export interface SectionGroup {
  section_path: string;
  base_ref: string;
  score: number;
  results: SearchResult[];
}

/**
 * Group results by section path for `group_by: section` (Requirement 13.6).
 *
 * Unlike groupResultsByDocument (which MERGES chunk contents into one result),
 * this NESTS the hits under their section so a single large document's answer
 * is organised by section rather than returned flat. Hits are kept intact
 * (no content merging) because a section can legitimately contain several
 * distinct relevant units (a chunk, a table, a figure).
 *
 * - Within a group, hits keep their incoming order (already score-sorted /
 *   diversified by the caller).
 * - Groups are ordered by their best hit score, descending.
 * - Sections are scoped to their document (`base_ref`, falling back to
 *   `reference`): the equally named "Einleitung" of two documents yields two
 *   groups, not one.
 * - Hits with no section path are grouped under the empty-string key, ordered
 *   like any other group by their best score.
 *
 * Inputs are never mutated.
 */
export function groupResultsBySection(results: SearchResult[]): SectionGroup[] {
  const groups = new Map<
    string,
    { section_path: string; base_ref: string; results: SearchResult[] }
  >();
  for (const r of results) {
    const section_path = sectionPathString(r);
    const base_ref = r.base_ref || r.reference;
    // NUL separator: a document reference can contain "/", so joining on the
    // visible path alone would let two different (document, section) pairs
    // collide.
    const key = `${base_ref}\u0000${section_path}`;
    const existing = groups.get(key);
    if (existing) existing.results.push(r);
    else groups.set(key, { section_path, base_ref, results: [r] });
  }

  const out: SectionGroup[] = [];
  for (const { section_path, base_ref, results: groupResults } of groups.values()) {
    const score = groupResults.reduce(
      (best, r) => (r.score > best ? r.score : best),
      Number.NEGATIVE_INFINITY,
    );
    out.push({ section_path, base_ref, score, results: groupResults });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ─── Tokenizer-aware rerank cap ──────────────────────────────────────────────

/** Safety margin applied when shrinking by the measured chars/token ratio. */
const TOKEN_FIT_MARGIN = 0.95;
/** Maximum shrink iterations per document (each is one /tokenize call). */
const TOKEN_FIT_MAX_ROUNDS = 3;

/**
 * Tighten the rerank input cap with a real tokenizer (Requirement 13.2).
 *
 * Returns results whose `content` is trimmed so that
 * `buildRerankDocument(result, maxTokens)` measures at most `maxTokens` with
 * `counter`. Results that already fit are returned as the SAME object; trimmed
 * ones are shallow copies (inputs are never mutated) that keep their `id`, so
 * the caller can map reranked copies back to the originals. Without a counter
 * the input array is returned unchanged (the char heuristic in
 * buildRerankDocument still applies). Never throws: a counter failure keeps
 * the heuristic-capped document.
 */
export async function fitRerankInputs(
  results: SearchResult[],
  counter: TokenCounter | null | undefined,
  maxTokens: number = RERANK_MAX_TOKENS,
): Promise<SearchResult[]> {
  if (!counter || results.length === 0 || maxTokens <= 0) return results;
  const out = [...results];
  let pending = out.map((_, i) => i);
  for (let round = 0; round < TOKEN_FIT_MAX_ROUNDS && pending.length > 0; round++) {
    const docs = pending.map((i) => {
      const result = out[i];
      return result === undefined ? "" : buildRerankDocument(result, maxTokens);
    });
    let counts: number[];
    try {
      counts = await counter.countBatch(docs);
    } catch {
      return out;
    }
    const next: number[] = [];
    pending.forEach((i, k) => {
      const tokens = counts[k] ?? 0;
      const doc = docs[k] ?? "";
      if (tokens <= maxTokens || doc.length === 0) return;
      const current = out[i];
      if (current === undefined) return;
      const content = current.content ?? "";
      const headerLen = doc.length - Math.min(content.length, doc.length);
      // Target document length from the measured chars/token ratio.
      const targetDocChars = Math.floor(doc.length * (maxTokens / tokens) * TOKEN_FIT_MARGIN);
      const targetContentChars = Math.max(0, targetDocChars - headerLen);
      const shrunk = content.slice(0, Math.min(targetContentChars, Math.max(0, content.length - 1)));
      if (shrunk.length >= content.length) return;
      out[i] = { ...current, content: shrunk };
      next.push(i);
    });
    pending = next;
  }
  return out;
}

// ─── v2 grouping (group_by: document | section) ──────────────────────────────

/** `group_by` modes of `/v2/search` and the MCP `search` tool (Requirement 13.6). */
export type GroupByMode = "none" | "document" | "section";

/** Group provenance attached to a merged v2 result. */
export interface ResultGroupInfo {
  by: "document" | "section";
  /** The grouping key: the base_ref (document) or the section id / path (section). */
  key: string;
  /** Number of hits merged into this result. */
  count: number;
  /** Unit ids of the merged hits, in document order (when the hits carry them). */
  unit_ids: string[];
}

/** A merged v2 result: the representative hit with the group's merged content. */
export type GroupedSearchResult = SearchResult & { group?: ResultGroupInfo };

function metaString(result: SearchResult, key: string): string | undefined {
  const v = (result.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function metaNumber(result: SearchResult, key: string): number | undefined {
  const v = (result.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The section key of a hit: `section_id` (metadata, the batch worker mirrors
 * it), else the joined section path. Empty when the hit carries neither.
 */
export function sectionKey(result: SearchResult): string {
  return metaString(result, "section_id") ?? sectionPathString(result);
}

/** Document-order sort key: page, then chunk index, then char offset, then unit id / id. */
function documentOrder(a: SearchResult, b: SearchResult): number {
  // Across the documents of one group (an e-mail thread): chronological, then
  // by document; within a document: reading order.
  const byGroup = groupMemberOrder(a, b);
  if (byGroup !== 0) return byGroup;
  const pa = metaNumber(a, "page_start") ?? a.evidence?.page_start ?? Number.MAX_SAFE_INTEGER;
  const pb = metaNumber(b, "page_start") ?? b.evidence?.page_start ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  const ca = a.chunk?.chunk_index ?? 0;
  const cb = b.chunk?.chunk_index ?? 0;
  if (ca !== cb) return ca - cb;
  const sa = a.evidence?.char_start ?? 0;
  const sb = b.evidence?.char_start ?? 0;
  if (sa !== sb) return sa - sb;
  const ua = metaString(a, "unit_id") ?? a.id;
  const ub = metaString(b, "unit_id") ?? b.id;
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/**
 * Order two hits of the same document group by their documents: the thread
 * position (`document_group.sort_at`), then the document reference. 0 for two
 * hits of the same document.
 */
export function groupMemberOrder(a: SearchResult, b: SearchResult): number {
  const docA = a.base_ref || a.reference;
  const docB = b.base_ref || b.reference;
  if (docA === docB) return 0;
  const ta = a.document_group?.sort_at ?? "";
  const tb = b.document_group?.sort_at ?? "";
  if (ta !== tb) return ta === "" ? 1 : tb === "" ? -1 : ta < tb ? -1 : 1;
  return docA < docB ? -1 : 1;
}

/**
 * The key hits are merged under by `group_by=document` / `groupByDocument`: the
 * document's group (an e-mail thread) when it has one, else the document.
 * With `includeAllVersions` the document key is extended by the revision
 * identity, so the revisions of one document stay separate groups.
 */
export function documentGroupKey(
  r: SearchResult,
  includeAllVersions = false,
): string {
  const doc = r.document_group?.id ?? (r.base_ref || r.reference);
  return includeAllVersions ? `${doc}\u0000${revisionIdentity(r)}` : doc;
}

/**
 * Merge ranked hits into one result per document or per section (Requirement
 * 13.6, `group_by`), analogous to groupResultsByDocument in handlers/search.ts
 * but for v2 units:
 *
 *  - `document` groups by `base_ref` (falling back to `reference`);
 *  - `section` groups by `(base_ref, section_id)` — the section id is scoped to
 *    its document so two documents' "1 Einleitung" never merge. A hit with no
 *    section id / path is its own group (never merged with unrelated hits);
 *  - the group's score is its BEST hit score, the representative (metadata,
 *    evidence, navigation) is the best-scoring hit;
 *  - the merged content is the members' content in DOCUMENT order (page →
 *    chunk index → char offset → unit id), joined by a blank line. v2 units do
 *    not overlap, so no overlap trimming is needed;
 *  - groups are ordered by score, descending.
 *
 * `none` returns the input unchanged. Inputs are never mutated.
 */
export function groupResultsV2(
  results: SearchResult[],
  by: GroupByMode,
  includeAllVersions = false,
): GroupedSearchResult[] {
  if (by === "none") return results;
  const groups = new Map<string, SearchResult[]>();
  const keyOf = new Map<string, string>();
  results.forEach((r, i) => {
    const doc = r.base_ref || r.reference;
    let groupKey: string;
    let publicKey: string;
    if (by === "document") {
      groupKey = documentGroupKey(r, includeAllVersions);
      publicKey = groupKey;
    } else {
      const section = sectionKey(r);
      publicKey = section;
      groupKey = section === "" ? `\u0001solo:${i}` : `${doc}\u0000${section}`;
    }
    const list = groups.get(groupKey);
    if (list) list.push(r);
    else {
      groups.set(groupKey, [r]);
      keyOf.set(groupKey, publicKey);
    }
  });

  const out: GroupedSearchResult[] = [];
  for (const [groupKey, members] of groups) {
    const rep = members.reduce((best, c) => (c.score > best.score ? c : best));
    const ordered = [...members].sort(documentOrder);
    const content = ordered
      .map((m) => (m.content ?? "").trim())
      .filter((c) => c !== "")
      .join("\n\n");
    const unitIds = ordered
      .map((m) => metaString(m, "unit_id"))
      .filter((u): u is string => u !== undefined);
    out.push({
      ...rep,
      score: rep.score,
      content: members.length > 1 ? content : rep.content,
      group: {
        by,
        key: keyOf.get(groupKey) ?? "",
        count: members.length,
        unit_ids: unitIds,
      },
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ─── MIN_RERANK_SCORE / abstention (platform-hardening task 6.10) ────────────

/**
 * Abstention signal emitted alongside the results when a relevance threshold
 * (`MIN_RERANK_SCORE`, Requirement 4.8) is configured. Consumers (agents,
 * answer pipelines) use `abstain` to withhold an answer instead of answering
 * from irrelevant evidence.
 */
/**
 * The scale a result score is on. They are not comparable: a cross-encoder
 * score is a sigmoid in [0, 1], cosine similarity sits in [-1, 1] (mostly
 * 0.2–0.9), an RRF score is pool-relative and tiny (≈ 1/60 per list), and
 * `ts_rank_cd`/BM25 are unbounded lexical ranks.
 */
export type RetrievalScoreKind = "cosine" | "rrf" | "fts";
export type ScoreKind = "rerank" | RetrievalScoreKind;

/** The retrieval scale a search mode produces (before any reranking). */
export function retrievalScoreKind(opts: {
  ftsOnly: boolean;
  hybrid: boolean;
}): RetrievalScoreKind {
  return opts.ftsOnly ? "fts" : opts.hybrid ? "rrf" : "cosine";
}

/** A relevance threshold together with the scale it was set for. */
export interface ScoreThreshold {
  value: number;
  kind: ScoreKind;
}

export interface AbstentionSignal {
  /** The configured threshold the results were filtered against. */
  threshold: number;
  /** Which score the threshold was applied to (legacy two-valued field). */
  score_kind: "rerank" | "retrieval";
  /** The exact scale of the final scores. */
  score_scale: ScoreKind;
  /** The scale the threshold was set for. */
  threshold_scale: ScoreKind;
  /**
   * Set when the threshold was NOT applied because the final scores are on a
   * different scale (e.g. MIN_RERANK_SCORE while the reranker fell back to
   * RRF scores). Filtering then would drop or keep everything arbitrarily.
   */
  skipped?: "scale_mismatch";
  /** Candidates that entered the filter (before). */
  candidates: number;
  /** Results that met the threshold (after). */
  kept: number;
  /** True when NO result met the threshold — the caller should abstain. */
  abstain: boolean;
}

export interface MinScoreOutcome<T> {
  results: T[];
  /** Present only when a threshold was configured (enabled). */
  abstention?: AbstentionSignal;
}

/**
 * Filter final search results to `score >= threshold` and derive the
 * abstention signal (Requirement 4.8). No threshold disables filtering and
 * emits no signal. The threshold is applied only when the final scores are on
 * the scale it was set for; otherwise the results pass unchanged and the
 * signal says `skipped: "scale_mismatch"` — a reranker threshold must never
 * be compared with RRF or cosine scores after a rerank fallback. Inputs are
 * never mutated.
 */
export function applyMinScore<T extends { score: number }>(
  results: T[],
  threshold: ScoreThreshold | null | undefined,
  scoreKind: ScoreKind,
): MinScoreOutcome<T> {
  if (threshold === null || threshold === undefined) {
    return { results };
  }
  const base = {
    threshold: threshold.value,
    score_kind: scoreKind === "rerank" ? ("rerank" as const) : ("retrieval" as const),
    score_scale: scoreKind,
    threshold_scale: threshold.kind,
    candidates: results.length,
  };
  if (threshold.kind !== scoreKind) {
    return {
      results,
      abstention: { ...base, skipped: "scale_mismatch", kept: results.length, abstain: false },
    };
  }
  const kept = results.filter((r) => r.score >= threshold.value);
  return {
    results: kept,
    abstention: { ...base, kept: kept.length, abstain: kept.length === 0 },
  };
}

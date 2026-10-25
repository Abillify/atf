// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * pg-helpers.ts
 *
 * Pure helper functions extracted from postgres-client.ts (Requirement
 * 13.6): navigation-row shaping, FTS text preprocessing, cursors, path
 * normalisation, fuzzy matching and document-body reassembly. No state,
 * no pool — every helper is a deterministic function of its arguments.
 */

import type pino from "pino";
import type { Metadata } from "./metadata.js";
import type { PoolClient } from "pg";
import type { ChunkInfo, DocumentPoint, NavUnitRow, SearchCursor } from "./pg-types.js";

/**
 * Derive a figure caption from a figure unit's stored content. A
 * figure unit's content is `caption\ndescription\ntranscription…` (see
 * batch-unit-builder `renderFigureText`), so the first non-empty line is the
 * caption. Trimmed and length-bounded so a runaway description cannot bloat the
 * response asset object. Returns null for empty content.
 */
export function figureCaption(content: string | null | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  return firstLine.length > 300 ? firstLine.slice(0, 300) : firstLine;
}

// ─── v2 navigation query helpers ─────────────────────────────────

/** Clamp an optional integer to `[min, max]`, falling back to `fallback`. */
export function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** A short, single-line excerpt of a unit's content (for identifier hits). */
export function navExcerpt(content: string | null | undefined): string {
  if (!content) return "";
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/** The shared column set every navigation unit row selects. */
export const NAV_ROW_SELECT =
  `SELECT unit_id, unit_type, content, section_id, section_path,
          page_start, page_end, figure_kind, table_id, metadata`;

/** The raw row shape {@link NAV_ROW_SELECT} returns. */
export interface NavRowShape {
  unit_id: string | null;
  unit_type: string | null;
  content: string | null;
  section_id: string | null;
  section_path: string[] | null;
  page_start: number | null;
  page_end: number | null;
  figure_kind: string | null;
  table_id: string | null;
  metadata: Metadata | null;
}

/** Normalize a raw navigation row into a {@link NavUnitRow}. */
export function navRow(row: NavRowShape): NavUnitRow {
  return {
    unit_id: row.unit_id,
    unit_type: row.unit_type,
    content: row.content ?? "",
    section_id: row.section_id,
    section_path: Array.isArray(row.section_path) ? row.section_path : [],
    // Section units carry a page sentinel of 0; expose null for a clean range.
    page_start: row.page_start && row.page_start > 0 ? row.page_start : null,
    page_end: row.page_end && row.page_end > 0 ? row.page_end : null,
    figure_kind: row.figure_kind,
    table_id: row.table_id,
    metadata: row.metadata ?? {},
  };
}

/** Drop the internal prev/next link fields from a loaded context row. */
export function stripLinks(row: NavUnitRow & { prev_unit_id?: string | null; next_unit_id?: string | null }): NavUnitRow {
  return {
    unit_id: row.unit_id,
    unit_type: row.unit_type,
    content: row.content,
    section_id: row.section_id,
    section_path: row.section_path,
    page_start: row.page_start,
    page_end: row.page_end,
    figure_kind: row.figure_kind,
    table_id: row.table_id,
    metadata: row.metadata,
  };
}

/**
 * Look up the unit ids a query's identifiers resolve to (task 3.4, Req 12.3).
 *
 * Recognise identifier-shaped tokens in the query text (article numbers, mask/
 * transaction codes, drawing numbers, standards, requirement ids), normalise
 * each to its `value_norm`, and select the matching unit ids from the shared
 * `vs_identifiers` index scoped by tenant + collection. Returns them ordered by
 * how many distinct query identifiers a unit matched (best first) so the caller
 * can use array order as the exact-match rank of the third RRF list.
 *
 * Returns `[]` when the query carries no identifier, the tenant is unknown, or
 * the identifier index is empty — in which case the identifier RRF list simply
 * does not participate and hybrid search is exactly the dense+fts(+sparse) fusion
 * it was before. Guards against a missing `vs_identifiers` table (a deployment
 * mid-migration) by treating a lookup error as "no identifier hits" — but the
 * failure is LOGGED (warn) so a broken identifier index is visible, and the
 * lookup runs under a SAVEPOINT so the error does not abort the surrounding
 * search transaction (the caller runs this after `BEGIN`).
 */
export async function lookupIdentifierUnitIds(
  client: PoolClient,
  valueNorms: readonly string[],
  tenantId: string | undefined,
  collection: string,
  logger: pino.Logger,
): Promise<string[]> {
  const tenant = tenantId?.trim();
  if (!tenant) return [];
  if (valueNorms.length === 0) return [];
  await client.query("SAVEPOINT identifier_lookup");
  try {
    const res = await client.query<{ unit_id: string }>(
      `SELECT unit_id
         FROM vs_identifiers
        WHERE tenant_id = $1 AND collection = $2 AND value_norm = ANY($3::text[])
        GROUP BY unit_id
        ORDER BY COUNT(DISTINCT value_norm) DESC, unit_id ASC
        LIMIT ${IDENTIFIER_LOOKUP_MAX_UNITS}`,
      [tenant, collection, [...valueNorms]],
    );
    await client.query("RELEASE SAVEPOINT identifier_lookup");
    return res.rows.map((r) => r.unit_id);
  } catch (err) {
    // A missing table or transient error must never fail an otherwise-valid
    // search; degrade to no exact identifier list, but make it visible.
    await client.query("ROLLBACK TO SAVEPOINT identifier_lookup").catch(() => {});
    logger.warn(
      { err, collection, identifiers: valueNorms.length },
      "Identifier lookup (vs_identifiers) failed; searching without the exact identifier list",
    );
    return [];
  }
}

/**
 * Hard row cap for the section/page navigation reads (get_section, get_pages,
 * Requirement 15.3). Their OUTPUT is already bounded by `max_chars`; this bounds
 * the DB fetch too, so a whole-document page range cannot pull every unit.
 */
export const NAV_MAX_UNITS = 5000;

/** Upper bound on exact identifier hits fed into the identifier RRF list. */
export const IDENTIFIER_LOOKUP_MAX_UNITS = 1000;

/** Bytes of each staged batch payload scanned for `document.begin` (it is the first record). */
export const SOURCE_HEAD_BYTES = 64 * 1024;

/** Staged batches (in seq order) scanned for `document.begin` before giving up. */
export const SOURCE_HEAD_MAX_BATCHES = 4;

/** Records per payload head inspected before giving up (document.begin comes first). */
export const SOURCE_HEAD_MAX_RECORDS = 8;

export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Extract `document.begin.source.sha256` from the head of a staged NDJSON batch
 * payload (contract v2). Tolerates a truncated trailing line (the head is a
 * byte prefix) and non-JSON noise; returns null unless a `document.begin`
 * record with a lowercase hex sha256 is found in the first few records.
 */
export function sourceSha256FromPayloadHead(head: Buffer | string | null | undefined): string | null {
  if (head === null || head === undefined) return null;
  const text = typeof head === "string" ? head : head.toString("utf-8");
  const lines = text.split("\n");
  let inspected = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (++inspected > SOURCE_HEAD_MAX_RECORDS) break;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const r = record as { type?: unknown; source?: { sha256?: unknown } };
    if (r.type !== "document.begin") continue;
    const sha = r.source?.sha256;
    return typeof sha === "string" && SHA256_HEX.test(sha) ? sha : null;
  }
  return null;
}

// ─── FTS content preprocessing ────────────────────────────────────────────────

/**
 * Prepare content for full-text search indexing.
 *
 * Applied in order:
 * 1. Fenced code blocks (``` … ```) — remove entirely; code tokens fragment
 *    badly and pollute the index with identifiers like "const", "return", etc.
 * 2. Inline code (`…`) — remove the backtick markers, keep the text so short
 *    identifiers like function names remain searchable.
 * 3. Markdown images (![alt](url)) — keep the alt text, drop the URL.
 * 4. Markdown links ([text](url)) — keep the link text, drop the URL.
 * 5. URLs — remove entirely (short URLs too; they fragment into noise tokens
 *    like "https", "com", "path").
 * 6. Bold / italic markers (* ** _ __) — strip markers, keep text.
 * 7. ATX headings (# … ######) — strip the leading `#` markers.
 * 8. Blockquote markers (> at line start) — strip.
 * 9. Horizontal rules (--- / *** / ___) — remove entire line.
 * 10. Long tokens (> MAX_FTS_TOKEN_LENGTH chars) — remove remaining blobs
 *     (base64, JWTs, hashes, long UUIDs) that survived earlier steps.
 */
export const _MAX_FTS_TOKEN_LENGTH = 50;

export function prepareFtsContent(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code — keep text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images — keep alt text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links — keep link text
    .replace(/https?:\/\/\S+/gi, " ") // bare URLs
    .replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, "$2") // bold / italic markers
    .replace(/^#{1,6}\s+/gm, "") // ATX heading markers
    .replace(/^>\s*/gm, "") // blockquote markers
    .replace(/^(\s*[-*_]){3,}\s*$/gm, " ") // horizontal rules
    .replace(/\S{51,}/g, " ") // remaining long tokens
    .trim();
}

/**
 * Build the text fed into the FTS tsvector for a document point.
 *
 * For chunk 0 (or unchunked documents) we prepend:
 *   - `title`    — so title-keyword searches hit the document
 *   - `base_ref` — so reference-keyword searches hit the document
 *   - `prefix`   — the LLM summary or text-slice stored on chunk 0;
 *                  summaries often contain key terms not present in the
 *                  chunk text itself, so excluding them from FTS would
 *                  miss those matches entirely
 *
 * For chunks > 0 we index only the chunk content — adding identity /
 * summary fields to every chunk would over-weight documents with many
 * chunks in FTS ranking.
 */
export function buildFtsText(point: DocumentPoint): string {
  const isFirstChunk =
    point.chunk === undefined || point.chunk.chunk_index === 0;

  let text = point.content;
  if (isFirstChunk) {
    const parts: string[] = [];
    if (point.title) parts.push(point.title);
    // base_ref for unchunked docs equals reference; for chunked docs it's the
    // parent reference without the _chunk_N suffix.
    parts.push(point.baseRef ?? point.reference);
    // prefix holds the LLM summary (or leading text slice) stored on chunk 0.
    // Including it in FTS means summary-only terms are discoverable via keyword search.
    if (point.prefix) parts.push(point.prefix);
    text = `${parts.join("\n")}\n${text}`;
  }
  return prepareFtsContent(text);
}

/**
 * Build the contextual header indexed at weight D when
 * FTS_CONTEXTUAL_HEADER=on: the document title and section path only (no
 * chunk content), mirroring the labels-free subset of the contextual
 * embedding header in `contextual-header.ts`. Returns "" when the point
 * carries neither, so the caller can skip the extra tsvector.
 */
export function buildFtsContextHeader(point: DocumentPoint): string {
  const parts: string[] = [];
  if (point.title) parts.push(point.title);
  const sectionPath = point.chunk?.section_path;
  if (sectionPath && sectionPath.length > 0) {
    parts.push(sectionPath.join(" \u203a "));
  }
  return parts.length > 0 ? prepareFtsContent(parts.join("\n")) : "";
}

/**
 * Compare a pgvector version string (`0.8.6`, `0.7`, `0.8.0`) against a
 * minimum major/minor pair. Non-numeric suffixes (e.g. `0.8.0-rc1`) are
 * ignored; unparseable input counts as NOT meeting the minimum.
 */
export function pgvectorVersionAtLeast(
  version: string,
  minMajor: number,
  minMinor: number,
): boolean {
  const [majorRaw, minorRaw] = version.trim().split(".");
  const major = Number.parseInt(majorRaw ?? "", 10);
  const minor = Number.parseInt(minorRaw ?? "0", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/** Encode a cursor to an opaque base64url string (v2 format). */
export function encodeCursor(cursor: SearchCursor): string {
  const payload =
    cursor.score !== undefined && Number.isFinite(cursor.score)
      ? `v2|${cursor.score}|${cursor.created}|${cursor.id}`
      : `${cursor.created}|${cursor.id}`;
  return Buffer.from(payload, "utf-8").toString("base64url");
}

/** Decode a cursor string. Returns null if the format is invalid. */
export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");

    if (decoded.startsWith("v2|")) {
      // v2|<score>|<created>|<id> — `created` may itself contain no "|", and id
      // is taken from the end so an id containing "|" cannot corrupt parsing.
      const rest = decoded.slice(3);
      const firstSep = rest.indexOf("|");
      if (firstSep === -1) return null;
      const scoreRaw = rest.slice(0, firstSep);
      const tail = rest.slice(firstSep + 1);
      const lastSep = tail.lastIndexOf("|");
      if (lastSep === -1) return null;
      const created = tail.slice(0, lastSep);
      const id = tail.slice(lastSep + 1);
      const score = Number(scoreRaw);
      if (!created || !id || !Number.isFinite(score)) return null;
      return { created, id, score };
    }

    const sep = decoded.lastIndexOf("|");
    if (sep === -1) return null;
    const created = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!created || !id) return null;
    return { created, id };
  } catch {
    return null;
  }
}

// ─── Path / folder helpers (structural queries) ───────────────────────────────

/**
 * Escape LIKE wildcards (`\`, `%`, `_`) in a literal so a reference path that
 * legitimately contains them is matched literally. Used with `ESCAPE '\'`.
 */
export function escapeLikeLiteral(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/**
 * Canonicalize a reference/path to Unicode NFC (composed) form.
 *
 * Document keys ingested from a macOS filesystem arrive NFD-decomposed (e.g.
 * "ä" as "a" + U+0308), while callers — especially LLMs copying a path out of
 * injected text — emit the visually identical precomposed NFC form (U+00E4). A
 * byte-exact `reference =`/`base_ref LIKE` comparison then misses. Normalizing
 * both the stored keys (ingest + one-time migration) and the incoming
 * reference/prefix args to NFC makes the comparison deterministic. NFC is
 * idempotent and meaning-preserving, so this is a no-op for ASCII paths.
 */
export function normalizeReference(reference: string): string {
  return reference.normalize("NFC");
}

/**
 * Strip NUL bytes (U+0000) from a string bound for a PostgreSQL text column.
 *
 * PostgreSQL rejects 0x00 in text/varchar values with
 * `invalid byte sequence for encoding "UTF8": 0x00`, and because chunks are
 * written in a single multi-row INSERT, ONE offending value aborts the whole
 * statement — so an entire (large) document silently fails to index. NUL bytes
 * routinely appear in text extracted from PDFs and other binary formats.
 * Removing them is meaning-preserving (NUL carries no textual content).
 *
 * Fast path: only allocate a new string when a NUL is actually present.
 */
export function stripNullBytes(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is exactly what must go
  return text.indexOf("\u0000") === -1 ? text : text.replace(/\u0000/g, "");
}

/**
 * For a set of revision ids appearing in a search result, return the ones whose
 * revision is only partially visible (`status='partial'`, a `progressive`
 * revision still ingesting) together with the human-readable committed page span
 * so a hit can carry `revision_state=partial` + `pages_available` (Req 6.4).
 *
 * A committed revision (status='committed') is fully visible and is NOT tagged.
 * The page span is the merged min–max of the revision's committed segments,
 * formatted like "1–2750" (en dash).
 */
export async function annotatePartialRevisions(
  client: PoolClient,
  revisionIds: string[],
): Promise<Map<string, { pagesAvailable: string }>> {
  const out = new Map<string, { pagesAvailable: string }>();
  const partial = await client.query<{ revision_id: string }>(
    `SELECT revision_id FROM vs_revisions
      WHERE revision_id = ANY($1) AND status = 'partial'`,
    [revisionIds],
  );
  if (partial.rows.length === 0) return out;
  const partialIds = partial.rows.map((r) => r.revision_id);
  const segments = await client.query<{ revision_id: string; page_start: number; page_end: number }>(
    `SELECT revision_id, page_start, page_end FROM vs_segments
      WHERE revision_id = ANY($1)
      ORDER BY revision_id, page_start`,
    [partialIds],
  );
  const spanByRevision = new Map<string, { from: number; to: number }>();
  for (const seg of segments.rows) {
    const span = spanByRevision.get(seg.revision_id);
    if (!span) {
      spanByRevision.set(seg.revision_id, { from: seg.page_start, to: seg.page_end });
    } else {
      span.from = Math.min(span.from, seg.page_start);
      span.to = Math.max(span.to, seg.page_end);
    }
  }
  for (const revId of partialIds) {
    const span = spanByRevision.get(revId);
    // A partial revision with no committed segment yet exposes no pages; still
    // tag it partial so a caller knows the revision is incomplete.
    out.set(revId, { pagesAvailable: span ? `${span.from}\u2013${span.to}` : "" });
  }
  return out;
}

/**
 * Sanitize every free-text column of a point so a stray NUL byte (typically
 * from PDF extraction) can never abort the INSERT. JSON columns (metadata,
 * chunk, vector) are safe because JSON.stringify escapes U+0000 as "\u0000".
 */
export function sanitizePointText(point: DocumentPoint): DocumentPoint {
  return {
    ...point,
    content: stripNullBytes(point.content),
    prefix: point.prefix != null ? stripNullBytes(point.prefix) : point.prefix,
    source: point.source != null ? stripNullBytes(point.source) : point.source,
    link: point.link != null ? stripNullBytes(point.link) : point.link,
    title: point.title != null ? stripNullBytes(point.title) : point.title,
    tags: point.tags?.map(stripNullBytes),
    allowedUsers: point.allowedUsers?.map(stripNullBytes),
    allowedGroups: point.allowedGroups?.map(stripNullBytes),
  };
}

/**
 * Normalise a folder path prefix for reference-path matching:
 *   - undefined / "" / "/"      → "" (collection root)
 *   - "/a/b/" or "a/b"          → "/a/b" (leading slash, no trailing slash)
 * Document references are absolute-style paths beginning with "/", so the
 * normalised prefix is compared as `base_ref LIKE prefix || '/%'`.
 */
export function normalizePathPrefix(prefix: string | undefined): string {
  if (prefix === undefined) return "";
  // NFC-normalize so a precomposed-umlaut prefix matches NFC-stored base_ref
  // keys (see normalizeReference). Covers list_documents, list_folders,
  // find_folders, get_documents (prefix), get_summaries, collection_stats.
  let p = prefix.normalize("NFC").trim();
  if (p === "" || p === "/") return "";
  if (!p.startsWith("/")) p = "/" + p;
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Mutable accumulator used while deriving the folder tree from paths. */
export interface FolderAgg {
  documents: number;
  chunks: number;
  subfolders: Set<string>;
}

/**
 * Derive the folder tree from a set of documents (each a `base_ref` path plus
 * its chunk count), relative to a normalised prefix `norm` ("" = whole tree).
 *
 * For every document, each ancestor folder up to `depthLimit` levels below the
 * prefix accumulates the document and its chunks (recursive counts), and learns
 * the name of the immediate child folder on that path. `files` counts documents
 * that live directly at the prefix level (no intervening folder).
 *
 * `depthLimit <= 0` means unlimited depth (the entire sub-tree).
 */
export function deriveFolderAggregates(
  docs: Array<{ baseRef: string; chunks: number }>,
  norm: string,
  depthLimit: number,
): { folders: Map<string, FolderAgg>; files: number } {
  const folders = new Map<string, FolderAgg>();
  const unlimited = depthLimit <= 0;
  let files = 0;
  for (const { baseRef, chunks } of docs) {
    if (!baseRef.startsWith(norm)) continue;
    const rest = baseRef.slice(norm.length); // e.g. "/Teil 1/sub/doc"
    const parts = rest.split("/").filter((p) => p.length > 0);
    if (parts.length <= 1) {
      files++; // document lives directly at the prefix level
      continue;
    }
    const maxLevel = parts.length - 1; // last segment is the document itself
    const limitLevel = unlimited ? maxLevel : Math.min(depthLimit, maxLevel);
    for (let k = 1; k <= limitLevel; k++) {
      const folderPath = norm + "/" + parts.slice(0, k).join("/");
      let agg = folders.get(folderPath);
      if (!agg) {
        agg = { documents: 0, chunks: 0, subfolders: new Set<string>() };
        folders.set(folderPath, agg);
      }
      agg.documents++;
      agg.chunks += chunks;
      // parts[k] is the next path segment; it is a *folder* (not the document)
      // when there are still deeper segments before the document.
      const segment = parts[k];
      if (k < parts.length - 1 && segment !== undefined)
        agg.subfolders.add(segment);
    }
  }
  return { folders, files };
}

/**
 * Levenshtein edit distance between two strings (iterative, single-row DP).
 * Used by the fuzzy folder matcher.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  // every cell of the row is assigned above, so the ?? 0 is unreachable
  return prev[b.length] ?? 0;
}

/**
 * Fuzzy match score in [0..1] of how well `needle` matches `haystack`
 * (both expected lowercased). Combines several signals so it is robust to
 * partial names, typos, and word-order:
 *
 *   • exact equality            → 1
 *   • haystack contains needle  → 0.9 .. 1 (longer coverage scores higher)
 *   • needle is a subsequence   → up to ~0.75 (contiguity-weighted)
 *   • Levenshtein similarity    → 1 - dist/maxLen (catches typos)
 *
 * The best of these signals is returned, so "examplerecord" still matches
 * "ExampleRecords" and "records 3" matches "Records Part 3".
 */
export function fuzzyScore(needle: string, haystack: string): number {
  if (needle === "" || haystack === "") return 0;
  if (needle === haystack) return 1;

  // Substring containment — strong signal. Coverage ratio biases toward
  // folder names that are mostly the needle over ones that merely contain it.
  if (haystack.includes(needle)) {
    return 0.9 + 0.1 * (needle.length / haystack.length);
  }

  // Subsequence match (characters appear in order, possibly with gaps).
  const subseq = subsequenceScore(needle, haystack);

  // Levenshtein-based similarity (typo tolerance).
  const dist = levenshtein(needle, haystack);
  const lev = 1 - dist / Math.max(needle.length, haystack.length);

  return Math.max(subseq, lev);
}

/**
 * Score `needle` as an in-order subsequence of `haystack` (both lowercased).
 * Returns 0 when not a subsequence; otherwise a value in (0, ~0.85] that
 * rewards matching a large fraction of the haystack contiguously.
 */
export function subsequenceScore(needle: string, haystack: string): number {
  let i = 0;
  let matched = 0;
  let runs = 0;
  let prevMatchedIdx = -2;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) {
      matched++;
      if (j !== prevMatchedIdx + 1) runs++;
      prevMatchedIdx = j;
      i++;
    }
  }
  if (i < needle.length) return 0; // not a full subsequence
  const coverage = matched / haystack.length; // how much of the name is used
  const contiguity = 1 / runs; // fewer gaps → closer to 1
  return 0.5 * coverage + 0.35 * contiguity;
}

/**
 * Merge ordered chunk contents into one string, trimming the overlap between
 * adjacent chunks. Mirrors the overlap resolution in handlers/search.ts
 * (explicit chunk_overlap metadata first, then a longest-common-suffix probe).
 */
export function mergeOrderedChunkContents(
  chunks: Array<{
    content: string;
    overlapStart?: number | null;
    overlapEnd?: number | null;
  }>,
): string {
  const first = chunks[0];
  if (first === undefined) return "";
  let merged = first.content;
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const curr = chunks[i];
    if (prev === undefined || curr === undefined) continue;
    const next = curr.content;

    // The chunker (chunker.ts) adjusts BOTH sides of a shared boundary
    // independently: `prev.overlapEnd` extends prev's end forward and
    // `curr.overlapStart` extends curr's start backward across the SAME
    // boundary. The duplicated region at the head of `curr` is therefore the
    // SUM of the two — using only one of them under-trims and leaves
    // duplicated text. We verify the computed length against the actual text
    // (endsWith) and fall back to a longest-common-suffix probe when the
    // metadata is absent (e.g. semantic chunking) or imprecise.
    const explicit = (prev.overlapEnd ?? 0) + (curr.overlapStart ?? 0);
    let overlap = 0;
    if (explicit > 0 && merged.endsWith(next.slice(0, explicit))) {
      overlap = explicit;
    } else {
      const MAX_PROBE = 2048;
      const probe = Math.min(MAX_PROBE, merged.length, next.length);
      for (let len = probe; len >= 8; len--) {
        if (merged.endsWith(next.slice(0, len))) {
          overlap = len;
          break;
        }
      }
    }

    // Adjacent chunks (overlap 0 = hard cut) are concatenated WITHOUT a
    // separator so the reassembly is a faithful, lossless reconstruction of
    // the original document text.
    merged += overlap > 0 ? next.slice(overlap) : next;
  }
  return merged;
}

/**
 * The rows that form a document's text. A v1 row has no `unit_type`; of the v2
 * units only `chunk`/`table`/`figure` carry the document's own content — the
 * `section`/`page`/`document` units are Extract's summaries, which must never be
 * read back as the original.
 */
export const DOCUMENT_BODY_SQL = `(unit_type IS NULL OR unit_type IN ('chunk', 'table', 'figure'))`;

/**
 * Reading order of a document's rows. A v1 row orders by its chunk index; v2
 * units carry no chunk JSON, so they order by page, then by the position of
 * their first source block on the page (`p{page}-b{n}`), then by their ordinal
 * within that block group (the row-groups of a table, the pieces of a long
 * text group). `id` only breaks ties — it is insertion order, which follows
 * batch processing, not the document.
 */
export const DOCUMENT_ORDER_SQL =
  `COALESCE((chunk->>'chunk_index')::int, 0) ASC, page_start ASC NULLS FIRST, ` +
  `NULLIF(substring(block_ids[1] from '-b([0-9]+)$'), '')::int ASC NULLS FIRST, ` +
  `CASE WHEN unit_type IS NOT NULL AND metadata->>'ordinal' ~ '^[0-9]+$' ` +
  `THEN (metadata->>'ordinal')::int END ASC NULLS FIRST, id ASC`;

/**
 * The text a row contributes to its document. A v1 row is its content. A v2
 * `table` unit's content also holds the row-wise "Spalte: Wert" lines for
 * full-text search; only the grid part (`display_len`) is document text. A v2
 * `figure` unit is marked as a figure with its ids, so a reader knows the text
 * is a transcription and can fetch the image.
 */
export function documentBodyText(row: {
  content: string;
  unit_type?: string | null;
  metadata?: Metadata | null;
}): string {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  // A table's row-wise lines, and a chunk's carried continuation from the
  // next page (contract 2.3), are indexed but are not this unit's text.
  if (row.unit_type === "table" || row.unit_type === "chunk") {
    const len = meta.display_len;
    return typeof len === "number" && len > 0 && len < row.content.length
      ? row.content.slice(0, len)
      : row.content;
  }
  if (row.unit_type === "figure") {
    const label = [
      typeof meta.figure_id === "string" ? meta.figure_id : undefined,
      typeof meta.figure_kind === "string" ? meta.figure_kind : undefined,
      typeof meta.asset_id === "string" ? `asset_id=${meta.asset_id}` : undefined,
    ].filter((p): p is string => p !== undefined);
    return `[Abbildung${label.length > 0 ? ` ${label.join(" · ")}` : ""}]\n${row.content}`;
  }
  return row.content;
}

export interface MergedChunkCoordinate<T> {
  item: T;
  returnedStart: number;
  returnedEnd: number;
  originalStart?: number;
  originalEnd?: number;
}

/** Reassemble chunks and retain a separate mapping for compacted/output coordinates. */
export function mergeChunksWithCoordinates<T extends {
  content: string;
  overlap_start: number | null;
  overlap_end: number | null;
  chunk: ChunkInfo | null;
  unit_type?: string | null;
}>(chunks: T[]): { content: string; coordinates: Array<MergedChunkCoordinate<T>> } {
  if (chunks.length === 0) return { content: "", coordinates: [] };
  let merged = "";
  const coordinates: Array<MergedChunkCoordinate<T>> = [];
  for (let index = 0; index < chunks.length; index++) {
    const item = chunks[index];
    if (item === undefined) continue;
    // A v2 unit is a whole block group with no overlap: it is joined as its
    // own paragraph, never suffix-trimmed (a table row-group repeats its
    // header, which the probe would otherwise eat), and the reassembled text
    // is its own coordinate system.
    if (item.unit_type != null) {
      if (index > 0) merged += "\n\n";
      const returnedStart = merged.length;
      merged += item.content;
      coordinates.push({
        item,
        returnedStart,
        returnedEnd: merged.length,
        originalStart: returnedStart,
        originalEnd: merged.length,
      });
      continue;
    }
    let trim = 0;
    const previous = index > 0 ? chunks[index - 1] : undefined;
    if (previous !== undefined) {
      const explicit = (previous.overlap_end ?? 0) + (item.overlap_start ?? 0);
      if (explicit > 0 && merged.endsWith(item.content.slice(0, explicit))) {
        trim = explicit;
      } else {
        const probe = Math.min(2048, merged.length, item.content.length);
        for (let length = probe; length >= 8; length--) {
          if (merged.endsWith(item.content.slice(0, length))) {
            trim = length;
            break;
          }
        }
      }
    }
    const appended = item.content.slice(trim);
    const returnedStart = merged.length;
    merged += appended;
    coordinates.push({
      item,
      returnedStart,
      returnedEnd: merged.length,
      ...(item.chunk?.char_start !== undefined ? { originalStart: item.chunk.char_start + trim } : {}),
      ...(item.chunk?.char_end !== undefined ? { originalEnd: item.chunk.char_end } : {}),
    });
  }
  return { content: merged, coordinates };
}

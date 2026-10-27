// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/citations-check-v2.ts
 *
 * `POST /v2/citations/check`: tells a caller whether the chunks it cited are
 * still valid against the document revision that is current today.
 *
 * Each item is one citation (`base_ref` + `chunk_id`, where `chunk_id` is the
 * v1 `chunk_id` or the v2 `unit_id` a search hit carried as evidence). The
 * status of an item is:
 *
 * - `current`  — the cited chunk belongs to the revision visible today
 * - `carried`  — the chunk sits in an older revision, but its exact content
 *                exists unchanged in the current revision
 * - `changed`  — the chunk sits in an older revision and the current revision
 *                does not hold its content
 * - `removed`  — the document has no revision visible to the caller today
 * - `unknown`  — no chunk with that id is visible to the caller (it never
 *                existed, or the caller's ACL hides it)
 * - `unverified` — the chunk sits in an older revision and the current
 *                revision has more units than one content read returns, so
 *                "changed" cannot be told from "not read"
 *
 * The visibility rule for "today" is the same temporal `valid_at` rule as
 * `document_diff` with `validAt = now`. The load is bounded: one query for
 * all cited chunks, one for the current revisions, and at most one content
 * hash read per document that needs it — never one per chunk.
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { AccessScope } from "../access-scope.js";
import { readHeader } from "../header-utils.js";
import type { PostgresClient } from "../postgres-client.js";
import type { CitationChunkRow } from "../pg-types.js";
import { contentHash } from "../traceability.js";

/** The six outcomes a cited chunk can have. */
export type CitationChunkStatus =
  | "current"
  | "carried"
  | "changed"
  | "removed"
  | "unknown"
  | "unverified";

/** One citation to check, as sent by the caller. */
export interface CitationCheckItem {
  base_ref: string;
  chunk_id: string;
}

/** The verdict for one citation, in the caller's input order. */
export interface CitationCheckResult {
  base_ref: string;
  chunk_id: string;
  status: CitationChunkStatus;
  /** The document's revision visible today, when there is one. */
  current_revision?: string;
}

/** The `POST /v2/citations/check` response payload. */
export interface CitationCheckPayload {
  checked_at: string;
  results: CitationCheckResult[];
}

/** Upper bound of items per request (API contract). */
export const CITATIONS_CHECK_MAX_ITEMS = 500;

/**
 * Validate a request body into check items. Returns `{ error }` (the caller
 * answers 400) unless `items` is an array of 1..500 entries, each with a
 * non-empty `base_ref` and `chunk_id` string.
 */
export function parseCitationsCheckRequest(
  body: unknown,
): { items: CitationCheckItem[] } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }
  const raw = (body as { items?: unknown }).items;
  if (!Array.isArray(raw)) {
    return { error: "items must be an array" };
  }
  if (raw.length < 1 || raw.length > CITATIONS_CHECK_MAX_ITEMS) {
    return {
      error: `items must contain between 1 and ${String(CITATIONS_CHECK_MAX_ITEMS)} entries`,
    };
  }
  const items: CitationCheckItem[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { error: `items[${String(index)}] must be an object` };
    }
    const baseRef = (entry as { base_ref?: unknown }).base_ref;
    const chunkId = (entry as { chunk_id?: unknown }).chunk_id;
    if (typeof baseRef !== "string" || baseRef.trim() === "") {
      return { error: `items[${String(index)}].base_ref must be a non-empty string` };
    }
    if (typeof chunkId !== "string" || chunkId.trim() === "") {
      return { error: `items[${String(index)}].chunk_id must be a non-empty string` };
    }
    items.push({ base_ref: baseRef, chunk_id: chunkId });
  }
  return { items };
}

/**
 * Build the citations-check payload. `items` must already be validated
 * ({@link parseCitationsCheckRequest}); the results keep the input order.
 * Throws when a load fails — a partial verdict would be misleading.
 */
export async function buildCitationsCheck(
  postgresClient: PostgresClient,
  collection: string,
  scope: AccessScope,
  items: CitationCheckItem[],
  now: Date = new Date(),
): Promise<CitationCheckPayload> {
  const checkedAt = now.toISOString();
  const results: CitationCheckResult[] = items.map((item) => ({
    base_ref: item.base_ref,
    chunk_id: item.chunk_id,
    status: "unknown" as CitationChunkStatus,
  }));
  if (items.length === 0) return { checked_at: checkedAt, results };

  // A citation is the (base_ref, chunk_id) pair; a chunk id found under a
  // different document is not the cited chunk and stays `unknown`.
  const keyOf = (baseRef: string, chunkId: string): string =>
    `${baseRef}\u0000${chunkId}`;

  // (1) Load every cited chunk by id under the caller's ACL in ONE query.
  // A chunk the caller cannot see (or that never existed) stays `unknown`.
  // The load carries no temporal filter on purpose: a cited chunk may live in
  // a superseded revision and must still resolve to be classified.
  const chunkIds = [...new Set(items.map((item) => item.chunk_id))];
  const chunksRes = await postgresClient.getChunksByIds(collection, scope, chunkIds);
  if (!chunksRes.ok) {
    throw new Error(`Citation chunks load failed: ${chunksRes.error.message}`);
  }
  const rowsByKey = new Map<string, CitationChunkRow[]>();
  for (const row of chunksRes.result) {
    const key = keyOf(row.base_ref, row.id);
    const list = rowsByKey.get(key);
    if (list === undefined) rowsByKey.set(key, [row]);
    else list.push(row);
  }

  // (2) The revision visible today for every document holding a cited chunk,
  // in ONE query with the same valid_at rule as document_diff. A document
  // without a visible revision is `removed`.
  const baseRefs = [
    ...new Set(
      items
        .filter((item) => rowsByKey.has(keyOf(item.base_ref, item.chunk_id)))
        .map((item) => item.base_ref),
    ),
  ];
  const currentRevisions = new Map<string, string | null>();
  if (baseRefs.length > 0) {
    const currentRes = await postgresClient.getCurrentRevisionsAt(
      collection,
      scope,
      baseRefs,
      checkedAt,
    );
    if (!currentRes.ok) {
      throw new Error(`Current revision lookup failed: ${currentRes.error.message}`);
    }
    for (const row of currentRes.result) {
      currentRevisions.set(row.base_ref, row.revision_id);
    }
  }

  // First pass: current / removed / unknown. Items whose chunk sits in an
  // older revision are held back for the content-hash comparison.
  const pending: { index: number; rows: CitationChunkRow[]; baseRef: string }[] = [];
  const needsHash = new Set<string>();
  items.forEach((item, index) => {
    const rows = rowsByKey.get(keyOf(item.base_ref, item.chunk_id));
    if (rows === undefined || rows.length === 0) return;
    const result = results[index];
    if (!currentRevisions.has(item.base_ref)) {
      result.status = "removed";
      return;
    }
    const current = currentRevisions.get(item.base_ref) ?? null;
    if (current !== null) result.current_revision = current;
    if (rows.some((row) => (row.revision_id ?? null) === current)) {
      result.status = "current";
      return;
    }
    needsHash.add(item.base_ref);
    pending.push({ index, rows, baseRef: item.base_ref });
  });

  // (4) Content hashes of the current revision — at most ONE query per
  // document that needs it, never one per chunk. A cited chunk whose exact
  // content exists in the current revision was carried over unchanged.
  const hashSets = new Map<string, Set<string>>();
  // Documents whose current revision has more units than one read returns: a
  // missing hash there proves nothing.
  const truncatedRefs = new Set<string>();
  for (const baseRef of needsHash) {
    const contentsRes = await postgresClient.getCurrentRevisionContents(
      collection,
      scope,
      baseRef,
      checkedAt,
    );
    if (!contentsRes.ok) {
      throw new Error(`Current revision contents load failed: ${contentsRes.error.message}`);
    }
    hashSets.set(
      baseRef,
      new Set(contentsRes.result.contents.map((content) => contentHash(content))),
    );
    if (contentsRes.result.truncated) truncatedRefs.add(baseRef);
  }
  for (const entry of pending) {
    const hashes = hashSets.get(entry.baseRef) ?? new Set<string>();
    const carried = entry.rows.some((row) => hashes.has(contentHash(row.content)));
    results[entry.index].status = carried
      ? "carried"
      : truncatedRefs.has(entry.baseRef)
        ? "unverified"
        : "changed";
  }
  return { checked_at: checkedAt, results };
}

/**
 * POST /v2/citations/check
 *
 * Same auth / scope / tenant / collection chain as the other v2 read routes;
 * the collection comes from the body's `collection`, `?collection=`, or the
 * `X-Collection` header (resolved by the collection-access middleware).
 */
export function createCitationsCheckHandler(
  postgresClient: PostgresClient,
  logger: Logger,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const accessScope = (res.locals as { accessScope?: AccessScope }).accessScope;
      if (!accessScope?.tenantId) {
        res.status(403).json({ error: "Tenant context is required" });
        return;
      }
      const collection =
        (res.locals as { resolvedCollection?: string }).resolvedCollection ??
        readHeader(req, "x-collection") ??
        "documents";

      const parsed = parseCitationsCheckRequest(req.body);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error, code: "INVALID_CITATIONS_REQUEST" });
        return;
      }

      const payload = await buildCitationsCheck(
        postgresClient,
        collection,
        accessScope,
        parsed.items,
      );
      logger.debug(
        {
          collection,
          items: parsed.items.length,
          statuses: payload.results.map((r) => r.status),
        },
        "citations_check served",
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * revision-store.ts
 *
 * The revision repository backing the v2 ingest hand-off. It owns every query
 * against the staging tables defined in revision-schema.ts: vs_revisions,
 * vs_ingest_batches, vs_segments and vs_document_revisions.
 *
 * Scope of THIS module:
 *   - create a staged revision, idempotent on the Idempotency-Key
 *   - stage an NDJSON page batch durably (BEFORE it is acknowledged), with a
 *     Content-Digest that makes a replay a 200 no-op and a mismatch a 409
 *   - report the revision state (accepted batches, processed pages, missing
 *     assets, committed segments, status) in the contract's RevisionState shape
 *   - commit a segment and the final revision, idempotently, rejecting a commit
 *     that is missing pages with the list of missing page ranges
 *   - the deferred final switch ({@link finalizeRevision}): pointer switch +
 *     chunked is_latest flip, run once every batch of the revision is processed
 *   - abort a revision and clean up everything written under it
 *   - reap expired uncommitted revisions (TTL cleaner) and extend the TTL via a
 *     heartbeat
 *
 * ## Concurrency model
 *
 * Every state-changing operation runs in a transaction that first takes
 * `SELECT … FOR UPDATE` on the revision's vs_revisions row, so stageBatch,
 * commitSegment, finalCommit, abort, heartbeat and the reaper are serialized
 * per revision and re-check status/TTL under the lock. The batch worker takes
 * `FOR SHARE` on the same row right before it upserts units, which orders every
 * unit write strictly before or after a segment commit / final switch — a unit
 * is therefore never written with a stale visibility decision.
 *
 * ## Final commit (Requirements 5.9, 5.11, 6.5)
 *
 * `finalCommit` validates page completeness and records the commit INTENT
 * (`commit_state='requested'`, TTL cleared so the reaper leaves it alone). The
 * actual switch happens in {@link finalizeRevision} as soon as every batch is
 * `processed` — immediately when that is already the case, otherwise from the
 * batch worker after it processes the last batch. Until then the old revision
 * stays the document's only visible revision. The switch is idempotent and
 * resumable: each phase leaves a durable marker, so a replayed commit or the
 * next worker tick completes an interrupted switch.
 *
 * Row-level tenant isolation is enforced in every statement via the tenant_id
 * column. Collection authorization and row ACL are enforced by the route
 * middleware (the same auth/scope/tenant/collection-ACL chain used by /ingest)
 * before any method here runs.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  BatchAck,
  BatchStatus,
  CommitResult,
  PageRange,
  Revision,
  RevisionState,
  RevisionStatus,
  Visibility,
} from "@atf/extract-contract";
import {
  decodeRecords,
  validateRecord,
  type RecordValidationIssue,
} from "@atf/extract-contract";
import { ensureRevisionSchema } from "./revision-schema.js";
import type { RowAcl } from "./access-scope.js";
import { collectionTableName } from "./collection-ddl.js";
import {
  documentInfoOf,
  forgetDocument,
  isOlderVersion,
  markSourceIndexed,
  parseDocumentInfo,
  registerDocumentGroup,
  type DocumentInfo,
} from "./document-identity.js";

// ─── Public result shape ──────────────────────────────────────────────────

/** Machine-readable error a revision-store method returns instead of throwing. */
export interface RevisionStoreError {
  /** HTTP-ish status the route maps straight onto the response. */
  status: number;
  code: string;
  message: string;
  /** Structured contract issues for a rejected batch (Requirement 3.5 / 5.2). */
  issues?: RecordValidationIssue[];
  /** Missing page ranges for a commit rejected with 409 (Requirement 5.9). */
  missingRanges?: PageRange[];
}

export type RevisionStoreResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: RevisionStoreError };

function ok<T>(result: T): RevisionStoreResult<T> {
  return { ok: true, result };
}

function fail<T>(error: RevisionStoreError): RevisionStoreResult<T> {
  return { ok: false, error };
}

// ─── Identity keys ──────────────────────────────────────────────────────────

/** The (tenant, collection) pair every call is scoped to. */
export interface RevisionScope {
  tenantId: string;
  collection: string;
  /**
   * The document reference from the route (`/v2/documents/{ref}/…`). When set,
   * the addressed revision must belong to it, otherwise the call is rejected
   * with 409 REVISION_REFERENCE_MISMATCH.
   */
  reference?: string;
}

// ─── Store surface ────────────────────────────────────────────────────────

export interface CreateRevisionInput extends RevisionScope {
  reference: string;
  idempotencyKey?: string | undefined;
  /**
   * The source claim (`POST /v2/sources/identify` sourceId) this revision
   * indexes. The final switch marks that source indexed.
   */
  sourceId?: string | undefined;
  /**
   * The row ACL every unit of the revision is written with (see
   * `rowAclForRevision`). Fixed at creation; a replay keeps the original.
   */
  acl?: RowAcl | undefined;
  visibility?: Visibility;
  /** TTL in milliseconds for the uncommitted revision. */
  ttlMs: number;
}

export interface StageBatchInput extends RevisionScope {
  revisionId: string;
  seq: number;
  /** Raw NDJSON body of the batch, exactly as received. */
  body: Buffer;
  /** The `Content-Digest` header value the producer sent. */
  contentDigest: string;
  ttlMs: number;
}

export interface CommitSegmentInput extends RevisionScope {
  revisionId: string;
  segment: number;
  /** Page range this segment covers; when omitted it is derived from batches. */
  pages?: PageRange;
}

export interface FinalCommitInput extends RevisionScope {
  revisionId: string;
}

/** A created-or-replayed revision; `created` is false on an idempotent replay. */
export interface CreatedRevision {
  revision: Revision;
  created: boolean;
}

/**
 * Final-commit result. `pending` is true when the commit was ACCEPTED (page
 * coverage complete, intent durably recorded) but the switch waits for staged
 * batches to be processed; the route answers 202 in that case. `isLatest` is
 * true once the revision is the document's visible revision.
 */
export interface FinalCommitResult extends CommitResult {
  pending: boolean;
}

/** RevisionState plus the deferred-commit marker. */
export interface RevisionStateResult extends RevisionState {
  /** True while a final commit is accepted but not yet switched. */
  commitPending: boolean;
}

export interface RevisionStore {
  /** Ensure the staging tables exist (idempotent). */
  ensureSchema(): Promise<void>;
  createRevision(input: CreateRevisionInput): Promise<RevisionStoreResult<CreatedRevision>>;
  stageBatch(input: StageBatchInput): Promise<RevisionStoreResult<BatchAck>>;
  getRevisionState(
    scope: RevisionScope,
    revisionId: string,
  ): Promise<RevisionStoreResult<RevisionStateResult>>;
  commitSegment(input: CommitSegmentInput): Promise<RevisionStoreResult<CommitResult>>;
  finalCommit(input: FinalCommitInput): Promise<RevisionStoreResult<FinalCommitResult>>;
  abortRevision(
    scope: RevisionScope,
    revisionId: string,
  ): Promise<RevisionStoreResult<{ aborted: boolean }>>;
  heartbeat(
    scope: RevisionScope,
    revisionId: string,
    ttlMs: number,
  ): Promise<RevisionStoreResult<{ ttlExpiresAt: string }>>;
  /** Reap uncommitted, expired revisions. Returns the number removed. */
  reapExpired(now?: Date): Promise<RevisionStoreResult<{ reaped: number }>>;
}

// ─── Content-Digest ─────────────────────────────────────────────────────────

/**
 * Canonicalize a `Content-Digest` header for comparison. The producer sends
 * `sha-256=:<base64>:` (RFC 9530) or a bare hex digest; either normalizes to a
 * lowercase hex sha256 so a replay compares equal regardless of spelling.
 */
export function normalizeContentDigest(header: string): string | null {
  const trimmed = header.trim();
  if (trimmed === "") return null;
  // RFC 9530 structured form: sha-256=:BASE64:
  const structured = /^sha-256=:([A-Za-z0-9+/=]+):$/i.exec(trimmed);
  if (structured?.[1]) {
    try {
      return Buffer.from(structured[1], "base64").toString("hex").toLowerCase();
    } catch {
      return null;
    }
  }
  // Bare hex sha256.
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  return null;
}

/** The canonical digest of a batch body (lowercase hex sha256). */
export function computeBodyDigest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

// ─── Page-range algebra (for missing-range computation) ─────────────────────

/**
 * Merge a set of closed integer ranges into the minimal sorted, non-overlapping
 * cover. Adjacent ranges ([1,10],[11,20]) merge into one ([1,20]).
 */
export function mergeRanges(ranges: PageRange[]): PageRange[] {
  const valid = ranges
    .filter((r) => Number.isInteger(r.from) && Number.isInteger(r.to) && r.to >= r.from)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: PageRange[] = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && r.from <= last.to + 1) {
      last.to = Math.max(last.to, r.to);
    } else {
      merged.push({ from: r.from, to: r.to });
    }
  }
  return merged;
}

/**
 * The gaps in `[1, total]` not covered by `covered`. Used to reject a commit
 * whose page span has holes with the exact missing ranges (Requirement 5.9).
 */
export function missingRanges(covered: PageRange[], total: PageRange): PageRange[] {
  const merged = mergeRanges(covered);
  const gaps: PageRange[] = [];
  let cursor = total.from;
  for (const r of merged) {
    if (r.to < total.from || r.from > total.to) continue;
    const from = Math.max(r.from, total.from);
    const to = Math.min(r.to, total.to);
    if (from > cursor) gaps.push({ from: cursor, to: from - 1 });
    cursor = Math.max(cursor, to + 1);
  }
  if (cursor <= total.to) gaps.push({ from: cursor, to: total.to });
  return gaps;
}

/**
 * The final-commit completeness decision (Requirement 5.9), pure so it is unit
 * testable. The document's extent comes from the staged `document.begin` /
 * `document.end` page count, NOT from the span of what happened to arrive — a
 * missing first or last batch must be reported, not silently accepted.
 *
 *   - page count known → every page in `[firstPage, pageCount]` must be
 *     covered (`firstPage` is 1 unless the job processed a `pages` window,
 *     contract 2.4; `pageCount` is then the stream's LAST page);
 *   - page count unknown (streaming producer, no `document.end` yet) → the
 *     commit is rejected until the trailing `document.end` is staged; the gaps
 *     in `[firstPage, max accepted page]` are reported so the producer can resend.
 */
export function commitCompleteness(args: {
  accepted: PageRange[];
  pageCount: number | null;
  hasDocumentEnd: boolean;
  /** First page of the stream; absent = 1. */
  firstPage?: number | null | undefined;
}): { ok: true } | { ok: false; code: string; message: string; missingRanges: PageRange[] } {
  const { accepted, pageCount, hasDocumentEnd } = args;
  const firstPage = args.firstPage !== null && args.firstPage !== undefined && args.firstPage > 1 ? args.firstPage : 1;
  if (pageCount !== null) {
    if (pageCount === 0) return { ok: true };
    const missing = missingRanges(accepted, { from: firstPage, to: pageCount });
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      code: "COMMIT_MISSING_BATCHES",
      message: "commit rejected: batches are missing",
      missingRanges: missing,
    };
  }
  const span = spanOf(accepted);
  const gaps = span ? missingRanges(accepted, { from: firstPage, to: span.to }) : [];
  if (!hasDocumentEnd) {
    return {
      ok: false,
      code: span ? "COMMIT_DOCUMENT_END_MISSING" : "COMMIT_NO_BATCHES",
      message: span
        ? "commit rejected: the page count is unknown and no document.end record is staged"
        : "cannot commit a revision with no staged batches",
      missingRanges: gaps,
    };
  }
  // Unreachable in practice (document.end always carries pageCount), kept for
  // a total function: fall back to the accepted span.
  if (gaps.length === 0) return { ok: true };
  return {
    ok: false,
    code: "COMMIT_MISSING_BATCHES",
    message: "commit rejected: batches are missing",
    missingRanges: gaps,
  };
}

// ─── Table names ────────────────────────────────────────────────────────────

const REVISIONS = "vs_revisions";
const BATCHES = "vs_ingest_batches";
const SEGMENTS = "vs_segments";
const POINTER = "vs_document_revisions";
const ASSETS = "vs_assets";
const IDENTIFIERS = "vs_identifiers";

/** How long an 'aborted' row may sit before the reaper finishes its cascade. */
const ABORTED_LEFTOVER_GRACE = "5 minutes";

/** Uncommitted lifecycle states an expired TTL may reap / a heartbeat extend. */
const UNCOMMITTED: RevisionStatus[] = ["staging", "partial"];

/**
 * The is_latest switch flips at most this many rows per statement. A
 * 10,000-page document can produce far more unit rows than one UPDATE should
 * hold locks for, so the flip runs in bounded chunks, each in its OWN
 * transaction under {@link FLIP_STATEMENT_TIMEOUT_MS} (SET LOCAL only applies
 * inside a transaction block).
 */
export const FLIP_BATCH_ROWS = 5_000;

/** Statement timeout applied to each individual is_latest flip statement. */
const FLIP_STATEMENT_TIMEOUT_MS = 30_000;

// ─── Factory ──────────────────────────────────────────────────────────────

export function createRevisionStore(pool: Pool): RevisionStore {
  // The v2 columns this module relies on are additive (ALTER … IF NOT EXISTS);
  // a deployment that ran migration v5 before they existed picks them up here,
  // once per store instance, under the shared schema-DDL advisory lock (and
  // only when a catalog check finds something missing).
  let schemaReady: Promise<void> | null = null;
  function ensureReady(client: PoolClient): Promise<void> {
    if (!schemaReady) {
      schemaReady = ensureRevisionSchema(client, { skipIfCurrent: true }).catch((err: unknown) => {
        schemaReady = null;
        throw err;
      });
    }
    return schemaReady;
  }

  async function withClient<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<RevisionStoreResult<T>> {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (cause) {
      return fail({
        status: 503,
        code: "POSTGRES_UNREACHABLE",
        message: cause instanceof Error ? cause.message : "database unreachable",
      });
    }
    try {
      await ensureReady(client);
      return ok(await fn(client));
    } catch (cause) {
      if (cause instanceof RevisionStoreThrow) return fail(cause.error);
      return fail({
        status: 502,
        code: "POSTGRES_SQL_ERROR",
        message: cause instanceof Error ? cause.message : "database error",
      });
    } finally {
      client.release();
    }
  }

  return {
    async ensureSchema(): Promise<void> {
      const client = await pool.connect();
      try {
        await ensureReady(client);
      } finally {
        client.release();
      }
    },

    async createRevision(input): Promise<RevisionStoreResult<CreatedRevision>> {
      const { tenantId, collection, reference, idempotencyKey, ttlMs } = input;
      return withClient(async (client) => {
        // Idempotency-Key returns the SAME revision on replay (Requirement 5.1).
        // A partial unique index on (tenant, collection, idempotency_key) makes
        // the INSERT race-safe: ON CONFLICT DO NOTHING, then re-select the row
        // the winner (this call or a concurrent one) created. A replay for a
        // DIFFERENT document is a client bug and is rejected, never aliased.
        const replay = (row: RevisionRowRaw): CreatedRevision => {
          if (!sameReference(row.reference, reference)) {
            throw new RevisionStoreThrow({
              status: 409,
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "Idempotency-Key already used for a revision of a different document",
            });
          }
          return { revision: toRevision(row), created: false };
        };
        if (idempotencyKey) {
          const existing = await client.query<RevisionRowRaw>(
            `SELECT * FROM ${REVISIONS}
              WHERE tenant_id = $1 AND collection = $2 AND idempotency_key = $3`,
            [tenantId, collection, idempotencyKey],
          );
          if (existing.rows[0]) return replay(existing.rows[0]);
        }
        // Visibility default depends on whether this reference already has a
        // visible version:
        //   - a NEW document defaults to `progressive` so its committed segments
        //     are searchable while the rest is still ingesting;
        //   - a REPLACE of an existing document (a v2 pointer, or legacy v1 rows
        //     for the same base_ref) defaults to `on_commit` so the old version
        //     stays the only visible one until the final commit (Req 5.11).
        // An explicit `visibility` in the request always wins over the default.
        const visibility: Visibility =
          input.visibility ??
          ((await documentHasVisibleVersion(client, tenantId, collection, reference))
            ? "on_commit"
            : "progressive");
        const revisionId = randomUUID();
        const ttlExpiresAt = new Date(Date.now() + ttlMs);
        const inserted = await client.query<RevisionRowRaw>(
          `INSERT INTO ${REVISIONS}
             (tenant_id, collection, revision_id, reference, status, visibility,
              idempotency_key, ttl_expires_at, source_id, allowed_users, allowed_groups)
           VALUES ($1, $2, $3, $4, 'staging', $5, $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id, collection, idempotency_key)
             WHERE idempotency_key IS NOT NULL
             DO NOTHING
           RETURNING *`,
          [
            tenantId, collection, revisionId, reference, visibility, idempotencyKey ?? null,
            ttlExpiresAt, input.sourceId ?? null,
            input.acl?.allowedUsers ?? [], input.acl?.allowedGroups ?? [],
          ],
        );
        if (inserted.rows[0]) return { revision: toRevision(inserted.rows[0]), created: true };
        // Lost the race — return the row the winner created.
        const winner = await client.query<RevisionRowRaw>(
          `SELECT * FROM ${REVISIONS}
            WHERE tenant_id = $1 AND collection = $2 AND idempotency_key = $3`,
          [tenantId, collection, idempotencyKey],
        );
        if (winner.rows[0]) return replay(winner.rows[0]);
        throw new RevisionStoreThrow({
          status: 500,
          code: "REVISION_CREATE_FAILED",
          message: "revision insert returned no row",
        });
      });
    },

    async stageBatch(input): Promise<RevisionStoreResult<BatchAck>> {
      const { tenantId, collection, revisionId, seq, body, contentDigest, ttlMs } = input;
      return withClient(async (client) => {
        const digest = normalizeContentDigest(contentDigest);
        if (digest === null) {
          throw new RevisionStoreThrow({
            status: 400,
            code: "INVALID_CONTENT_DIGEST",
            message: "Content-Digest must be sha-256=:<base64>: or a hex sha256",
          });
        }
        // The declared digest must match the bytes actually sent — otherwise the
        // idempotency guarantee (same seq + same digest ⇒ same content) is a lie.
        const actual = computeBodyDigest(body);
        if (actual !== digest) {
          throw new RevisionStoreThrow({
            status: 400,
            code: "CONTENT_DIGEST_MISMATCH",
            message: "Content-Digest does not match the request body",
          });
        }

        // Unlocked pre-read: the reference is immutable, so the (CPU-bound)
        // contract validation can run before the row lock is taken.
        const pre = await loadRevision(client, tenantId, collection, revisionId);
        if (!pre) throw notFound();
        assertReference(pre, input.reference);

        return inTransaction(client, async () => {
          const revision = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
          if (!revision) throw notFound();

          // Same seq already staged? Same digest ⇒ 200 no-op; different ⇒ 409.
          // Checked before the status gate so an outbox replay after the commit
          // (lost response) is still acknowledged idempotently.
          const priorRow = await loadBatch(client, tenantId, collection, revisionId, seq);
          if (priorRow && revision.status !== "aborted") {
            return replayAck(seq, digest, priorRow);
          }
          if (revision.status === "committed" || revision.status === "aborted" || revision.status === "superseded") {
            throw new RevisionStoreThrow({
              status: 409,
              code: "REVISION_CLOSED",
              message: `revision is ${revision.status} and no longer accepts batches`,
            });
          }
          if (revision.commit_state !== null) {
            throw new RevisionStoreThrow({
              status: 409,
              code: "REVISION_COMMIT_PENDING",
              message: "the final commit was already accepted; no further batches are accepted",
            });
          }

          // Validate every record via the contract BEFORE staging (Requirement
          // 5.2 / 3.5). A malformed record rejects the whole batch.
          const validation = validateBatchBody(body, revision.reference);
          if (!validation.ok) {
            throw new RevisionStoreThrow({
              status: 422,
              code: "BATCH_VALIDATION_FAILED",
              message: "batch contains records that violate the v2 contract",
              issues: validation.issues,
            });
          }

          // Stage durably (status='received') BEFORE acknowledging (Requirement
          // 5.3). The referenced asset ids are captured here so the status
          // report never has to decode payloads (Requirement 5.6, 6.1).
          // ON CONFLICT DO NOTHING + re-select turns a concurrent PUT of the
          // same seq into a no-op / 409 instead of a unique-violation 502.
          const inserted = await client.query(
            `INSERT INTO ${BATCHES}
               (tenant_id, collection, revision_id, seq, status, digest,
                page_start, page_end, payload, asset_ids)
             VALUES ($1, $2, $3, $4, 'received', $5, $6, $7, $8, $9)
             ON CONFLICT (tenant_id, collection, revision_id, seq) DO NOTHING
             RETURNING seq`,
            [
              tenantId, collection, revisionId, seq, digest,
              validation.pages?.from ?? null, validation.pages?.to ?? null, body,
              validation.assetIds,
            ],
          );
          if ((inserted.rowCount ?? 0) === 0) {
            const winner = await loadBatch(client, tenantId, collection, revisionId, seq);
            if (winner) return replayAck(seq, digest, winner);
            throw new RevisionStoreThrow({
              status: 409,
              code: "BATCH_CONFLICT",
              message: `seq ${seq} could not be staged; retry`,
            });
          }
          // Touch the revision: partial once it holds batches, TTL extended, and
          // the declared page count / document.end marker recorded for the
          // final commit's completeness check. document.end's pageCount is
          // authoritative; document.begin's only fills an unknown count.
          const ttlExpiresAt = new Date(Date.now() + ttlMs);
          await client.query(
            `UPDATE ${REVISIONS}
                SET status = CASE WHEN status = 'staging' THEN 'partial' ELSE status END,
                    ttl_expires_at = $4,
                    page_count = CASE
                      WHEN $5::int IS NOT NULL THEN $5::int
                      WHEN page_count IS NULL THEN $6::int
                      ELSE page_count END,
                    has_document_end = has_document_end OR $7::boolean,
                    extract_provenance = COALESCE($8::jsonb, extract_provenance),
                    document_info = COALESCE($9::jsonb, document_info),
                    modified = NOW()
              WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
            [
              tenantId, collection, revisionId, ttlExpiresAt,
              validation.endPageCount ?? null, validation.beginPageCount ?? null,
              validation.hasDocumentEnd,
              // document.begin provenance (Req 18.2) for the units of every
              // batch of this revision; a batch without it keeps the stored one.
              validation.extractProvenance ? JSON.stringify(validation.extractProvenance) : null,
              // document.begin version / e-mail / parent, for the final switch.
              validation.documentInfo ? JSON.stringify(validation.documentInfo) : null,
            ],
          );
          return batchAck(seq, digest, "received", validation.pages?.from ?? null, validation.pages?.to ?? null, false);
        });
      });
    },

    async getRevisionState(scope, revisionId): Promise<RevisionStoreResult<RevisionStateResult>> {
      const { tenantId, collection } = scope;
      return withClient(async (client) => {
        const revision = await loadRevision(client, tenantId, collection, revisionId);
        if (!revision) throw notFound();
        assertReference(revision, scope.reference);
        const batches = await client.query<{ seq: number; status: BatchStatus; page_start: number | null; page_end: number | null }>(
          `SELECT seq, status, page_start, page_end FROM ${BATCHES}
            WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3
            ORDER BY seq`,
          [tenantId, collection, revisionId],
        );
        const segments = await client.query<{ seq: number; page_start: number; page_end: number }>(
          `SELECT seq, page_start, page_end FROM ${SEGMENTS}
            WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3
            ORDER BY seq`,
          [tenantId, collection, revisionId],
        );
        const missingAssets = await loadMissingAssets(client, tenantId, collection, revisionId);

        const acceptedBatches = batches.rows.map((r) => r.seq);
        // Processed pages = pages of batches the worker has turned into units.
        const processed = batches.rows
          .filter((r) => r.status === "processed" && r.page_start != null && r.page_end != null)
          .map((r) => ({ from: r.page_start as number, to: r.page_end as number }));
        const processedPages = mergeRanges(processed);
        const committedSegments = segments.rows.map((r) => r.seq);
        const pagesAvailable = processedPages.reduce((sum, r) => sum + (r.to - r.from + 1), 0);

        return {
          revisionId: revision.revision_id,
          reference: revision.reference,
          status: revision.status,
          visibility: revision.visibility,
          acceptedBatches,
          processedPages,
          missingAssets,
          committedSegments,
          pagesAvailable,
          commitPending: revision.commit_state === "requested",
        };
      });
    },

    async commitSegment(input): Promise<RevisionStoreResult<CommitResult>> {
      const { tenantId, collection, revisionId, segment } = input;
      const outcome = await withClient(async (client) =>
        inTransaction(client, async () => {
          const revision = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
          if (!revision) throw notFound();
          assertReference(revision, input.reference);
          if (revision.status === "aborted" || revision.status === "superseded") {
            throw new RevisionStoreThrow({
              status: 409,
              code: "REVISION_CLOSED",
              message: `revision is ${revision.status}; segments can no longer be committed`,
            });
          }
          // Idempotent: a segment already committed is a no-op (Requirement 5.9)
          // — but its visibility flip is re-run below, so a replay heals a flip
          // that failed the first time.
          const existing = await client.query<{ page_start: number; page_end: number }>(
            `SELECT page_start, page_end FROM ${SEGMENTS}
              WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND seq = $4`,
            [tenantId, collection, revisionId, segment],
          );
          let span: PageRange;
          const existingRow = existing.rows[0];
          if (existingRow) {
            span = { from: existingRow.page_start, to: existingRow.page_end };
          } else {
            const accepted = await acceptedPageRanges(client, tenantId, collection, revisionId);
            // The segment's page span: explicit, else the full accepted span.
            const candidate = input.pages ?? spanOf(accepted);
            if (!candidate) {
              throw new RevisionStoreThrow({
                status: 409,
                code: "SEGMENT_NO_PAGES",
                message: "no batches have been staged for this segment yet",
                missingRanges: [],
              });
            }
            const missing = missingRanges(accepted, candidate);
            if (missing.length > 0) {
              throw new RevisionStoreThrow({
                status: 409,
                code: "SEGMENT_MISSING_BATCHES",
                message: "segment cannot be committed while batches are missing",
                missingRanges: missing,
              });
            }
            span = candidate;
            await client.query(
              `INSERT INTO ${SEGMENTS}
                 (tenant_id, collection, revision_id, seq, page_start, page_end)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (tenant_id, collection, revision_id, seq) DO NOTHING`,
              [tenantId, collection, revisionId, segment, span.from, span.to],
            );
          }
          // Progressive visibility (Requirement 6.4): a committed segment of a
          // `progressive` revision is searchable immediately — but ONLY once this
          // revision is the document's pointer target, so a progressive REPLACE
          // never exposes segments of the new revision while the old one is
          // current. A brand-new progressive document has no pointer yet: point
          // it at this revision so its committed segments become the live view.
          let flip = false;
          if (revision.visibility === "progressive" && revision.status !== "committed") {
            await client.query(
              `INSERT INTO ${POINTER} (tenant_id, collection, reference, current_revision_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (tenant_id, collection, reference) DO NOTHING`,
              [tenantId, collection, revision.reference, revisionId],
            );
            const pointer = await loadPointer(client, tenantId, collection, revision.reference);
            flip = pointer === revisionId;
          }
          return { reference: revision.reference, span, flip };
        }),
      );
      if (!outcome.ok) return outcome;
      const { reference, span, flip } = outcome.result;
      // The flip runs AFTER the segment row is committed, in bounded chunks with
      // their own transactions. Units the worker writes later see the committed
      // segment (it reads segments under FOR SHARE on the revision row) and are
      // written visible directly; units written before are flipped here.
      if (flip) {
        const flipped = await runFlip(() =>
          flipSegmentVisible(pool, { collection, tenantId, revisionId, pageStart: span.from, pageEnd: span.to }),
        );
        if (!flipped.ok) {
          return fail({
            status: 503,
            code: "SEGMENT_FLIP_INCOMPLETE",
            message: `segment committed but its visibility flip did not complete (${flipped.message}); retry the segment commit`,
          });
        }
      }
      return ok({ reference, revisionId, committed: true, segment, missingRanges: [] });
    },

    async finalCommit(input): Promise<RevisionStoreResult<FinalCommitResult>> {
      const { tenantId, collection, revisionId } = input;
      const intent = await withClient(async (client) =>
        inTransaction(client, async () => {
          const revision = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
          if (!revision) throw notFound();
          assertReference(revision, input.reference);
          if (revision.status === "aborted" || revision.status === "superseded") {
            throw new RevisionStoreThrow({
              status: 409,
              code: "REVISION_CLOSED",
              message: `revision is ${revision.status} and cannot be committed`,
            });
          }
          // Idempotent: a committed revision or an already-accepted intent is a
          // replay; finalizeRevision below completes whatever is still open.
          if (revision.status === "committed" || revision.commit_state !== null) {
            return revision.reference;
          }

          const accepted = await acceptedPageRanges(client, tenantId, collection, revisionId);
          const completeness = commitCompleteness({
            accepted,
            pageCount: revision.page_count,
            hasDocumentEnd: revision.has_document_end,
            firstPage: parseDocumentInfo(revision.document_info).firstPage ?? null,
          });
          if (!completeness.ok) {
            throw new RevisionStoreThrow({
              status: 409,
              code: completeness.code,
              message: completeness.message,
              missingRanges: completeness.missingRanges,
            });
          }
          // Record the commit INTENT durably. The TTL is cleared so the reaper
          // never removes an accepted commit that is waiting for the worker.
          await client.query(
            `UPDATE ${REVISIONS}
                SET commit_state = 'requested', commit_requested_at = NOW(),
                    ttl_expires_at = NULL, modified = NOW()
              WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
            [tenantId, collection, revisionId],
          );
          return revision.reference;
        }),
      );
      if (!intent.ok) return intent;
      const reference = intent.result;

      let finalized: FinalizeOutcome;
      try {
        finalized = await finalizeRevision(pool, { tenantId, collection, revisionId });
      } catch (cause) {
        // The intent is durable; a replayed commit or the next worker tick
        // resumes the switch where it stopped. Surface the failure instead of
        // pretending the switch happened.
        return fail({
          status: 503,
          code: "COMMIT_FINALIZE_INCOMPLETE",
          message: `commit accepted but the revision switch did not complete (${cause instanceof Error ? cause.message : String(cause)}); it resumes automatically or on retry`,
        });
      }
      if (finalized.state === "closed" || finalized.state === "missing") {
        return fail({
          status: finalized.state === "missing" ? 404 : 409,
          code: finalized.state === "missing" ? "REVISION_NOT_FOUND" : "REVISION_CLOSED",
          message: finalized.state === "missing" ? "revision does not exist" : "revision was closed before it could be switched",
        });
      }
      const pending = finalized.state !== "committed";
      return ok({
        reference,
        revisionId,
        committed: true,
        isLatest: finalized.state === "committed" ? finalized.isLatest : false,
        missingRanges: [],
        pending,
      });
    },

    async abortRevision(scope, revisionId): Promise<RevisionStoreResult<{ aborted: boolean }>> {
      const { tenantId, collection } = scope;
      // Phase 1 (short, under the row lock): mark the revision aborted so no
      // concurrent stage / commit / worker write proceeds for it.
      const marked = await withClient(async (client) =>
        inTransaction(client, async () => {
          const revision = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
          if (!revision) throw notFound();
          assertReference(revision, scope.reference);
          if (revision.status === "committed") {
            throw new RevisionStoreThrow({
              status: 409,
              code: "REVISION_COMMITTED",
              message: "a committed revision cannot be aborted",
            });
          }
          await markAborted(client, tenantId, collection, revisionId);
          return true;
        }),
      );
      if (!marked.ok) return marked;
      // Phase 2: cascade. Separate from phase 1 so it never holds the revision
      // lock while waiting for a worker's batch-row lock (the worker holds the
      // batch row and then asks for FOR SHARE on the revision row).
      return withClient(async () => {
        await deleteRevisionCascade(pool, tenantId, collection, revisionId);
        return { aborted: true };
      });
    },

    async heartbeat(scope, revisionId, ttlMs): Promise<RevisionStoreResult<{ ttlExpiresAt: string }>> {
      const { tenantId, collection } = scope;
      return withClient(async (client) =>
        inTransaction(client, async () => {
          const revision = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
          if (!revision) {
            throw new RevisionStoreThrow({
              status: 404,
              code: "REVISION_NOT_EXTENDABLE",
              message: "no uncommitted revision to extend",
            });
          }
          assertReference(revision, scope.reference);
          if (!UNCOMMITTED.includes(revision.status)) {
            throw new RevisionStoreThrow({
              status: 404,
              code: "REVISION_NOT_EXTENDABLE",
              message: "no uncommitted revision to extend",
            });
          }
          if (revision.commit_state !== null) {
            throw new RevisionStoreThrow({
              status: 409,
              code: "REVISION_COMMIT_PENDING",
              message: "the final commit was accepted; the revision no longer expires",
            });
          }
          const ttlExpiresAt = new Date(Date.now() + ttlMs);
          await client.query(
            `UPDATE ${REVISIONS}
                SET ttl_expires_at = $4, modified = NOW()
              WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
            [tenantId, collection, revisionId, ttlExpiresAt],
          );
          return { ttlExpiresAt: ttlExpiresAt.toISOString() };
        }),
      );
    },

    async reapExpired(now = new Date()): Promise<RevisionStoreResult<{ reaped: number }>> {
      return withClient(async (client) => {
        // Only uncommitted, past-TTL revisions WITHOUT an accepted commit are
        // reaped (Requirement 5.10); committed revisions have their TTL cleared.
        // Leftover 'aborted' rows (a cascade interrupted by a crash) are
        // finished here as well, after a grace period so a live abort is not
        // raced.
        const candidates = await client.query<{ tenant_id: string; collection: string; revision_id: string }>(
          `SELECT tenant_id, collection, revision_id FROM ${REVISIONS}
            WHERE (status = ANY($1) AND commit_state IS NULL
                   AND ttl_expires_at IS NOT NULL AND ttl_expires_at <= $2)
               OR (status = 'aborted' AND modified <= $2::timestamptz - $3::interval)`,
          [UNCOMMITTED, now, ABORTED_LEFTOVER_GRACE],
        );
        let reaped = 0;
        for (const row of candidates.rows) {
          // Re-check status + TTL under the row lock: a heartbeat or a commit
          // that won the race leaves the revision alone.
          const claimed = await inTransaction(client, async () => {
            const locked = await lockRevision(client, row.tenant_id, row.collection, row.revision_id, "UPDATE");
            if (!locked) return false;
            if (locked.status === "aborted") return true;
            const expired =
              UNCOMMITTED.includes(locked.status) &&
              locked.commit_state === null &&
              locked.ttl_expires_at !== null &&
              locked.ttl_expires_at.getTime() <= now.getTime();
            if (!expired) return false;
            await markAborted(client, row.tenant_id, row.collection, row.revision_id);
            return true;
          });
          if (!claimed) continue;
          await deleteRevisionCascade(pool, row.tenant_id, row.collection, row.revision_id);
          reaped += 1;
        }
        return { reaped };
      });
    },
  };
}

// ─── Deferred final switch (Requirements 5.9, 5.11, 6.5) ─────────────────────

export type FinalizeOutcome =
  | { state: "committed"; isLatest: boolean }
  | { state: "pending"; pendingBatches: number }
  | { state: "not_requested" }
  | { state: "closed" }
  | { state: "missing" };

export interface FinalizeTarget {
  tenantId: string;
  collection: string;
  revisionId: string;
}

/**
 * Complete an accepted final commit, idempotently and resumably.
 *
 * Preconditions: `commit_state='requested'` and every batch `processed`
 * (otherwise returns `pending` and the batch worker calls this again after the
 * last batch). Phases, each leaving a durable marker so a crash or a failed
 * statement is resumed by the next replay / worker tick:
 *
 *   A. flip the new revision's rows to is_latest = TRUE in chunks. For an
 *      `on_commit` replace they stay invisible — the pointer still names the
 *      old revision, and search requires `revision_id = pointer`;
 *   B. ONE short transaction under the revision row lock: move the pointer,
 *      hide legacy (revision_id IS NULL) rows of the same document, supersede
 *      the other revisions, set status='committed', commit_state='cleanup'.
 *      From its commit on, search sees exactly the new revision — never two,
 *      never none;
 *   C. flip the older revisions' rows to is_latest = FALSE in chunks (index
 *      hygiene: they are already hidden by the pointer), then commit_state='done'.
 *
 * Errors propagate (no silent best-effort): the caller reports them, and the
 * markers guarantee the next attempt finishes the job.
 */
export async function finalizeRevision(
  pool: Pool,
  target: FinalizeTarget,
): Promise<FinalizeOutcome> {
  const { tenantId, collection, revisionId } = target;
  const revision = await withPoolClient(pool, (c) => loadRevision(c, tenantId, collection, revisionId));
  if (!revision) return { state: "missing" };
  if (revision.status === "committed") {
    if (revision.commit_state === "cleanup") await cleanupOlderRevisions(pool, revision);
    const pointer = await withPoolClient(pool, (c) =>
      loadPointer(c, tenantId, collection, revision.reference),
    );
    return { state: "committed", isLatest: pointer === revisionId };
  }
  if (revision.status === "aborted" || revision.status === "superseded") return { state: "closed" };
  if (revision.commit_state !== "requested") return { state: "not_requested" };

  const pending = await withPoolClient(pool, (c) => countUnprocessed(c, tenantId, collection, revisionId));
  if (pending > 0) return { state: "pending", pendingBatches: pending };

  const table = await resolveCollectionTable(pool, collection);

  // Version order: a revision carrying an OLDER version than the document's
  // current one is indexed but never becomes the latest. Decided here (to skip
  // the pre-flip) and again under the pointer lock in phase B.
  const older = await withPoolClient(pool, (c) => isOlderThanCurrent(c, revision));

  // Phase A — pre-flip the new revision's rows (invisible until the pointer moves).
  if (table && !older) {
    await flipChunked(pool, {
      table,
      where: `tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE`,
      params: [tenantId, revisionId],
      target: true,
    });
  }

  // Phase B — the atomic pointer switch.
  const switched = await withPoolClient(pool, (client) =>
    inTransaction(client, async (): Promise<"switched" | "older" | "pending" | "raced"> => {
      const locked = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
      if (!locked || !UNCOMMITTED.includes(locked.status) || locked.commit_state !== "requested") {
        return "raced";
      }
      if ((await countUnprocessed(client, tenantId, collection, revisionId)) > 0) return "pending";
      await client.query(`SET LOCAL statement_timeout = ${FLIP_STATEMENT_TIMEOUT_MS}`);
      const prior = await client.query<{ current_revision_id: string }>(
        `SELECT current_revision_id FROM ${POINTER}
          WHERE tenant_id = $1 AND collection = $2 AND reference = $3
          FOR UPDATE`,
        [tenantId, collection, locked.reference],
      );
      const priorRevisionId = prior.rows[0]?.current_revision_id ?? null;
      const info = parseDocumentInfo(locked.document_info);
      if (priorRevisionId !== null && priorRevisionId !== revisionId) {
        const current = await loadRevision(client, tenantId, collection, priorRevisionId);
        if (current && isOlderVersion(info, parseDocumentInfo(current.document_info))) {
          // An older version arrived late: keep it (addressable by revision and
          // through includeAllVersions) but leave the pointer on the newer one.
          if (table) {
            await client.query(
              `UPDATE "${table}" SET is_latest = FALSE, modified = NOW()
                WHERE tenant_id = $1 AND revision_id = $2 AND is_latest = TRUE`,
              [tenantId, revisionId],
            );
          }
          await client.query(
            `UPDATE ${REVISIONS}
                SET status = 'committed', commit_state = 'done', prior_revision_id = NULL,
                    ttl_expires_at = NULL, modified = NOW()
              WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
            [tenantId, collection, revisionId],
          );
          await registerCommittedDocument(client, locked, info);
          return "older";
        }
      }
      await client.query(
        `INSERT INTO ${POINTER} (tenant_id, collection, reference, current_revision_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, collection, reference)
           DO UPDATE SET current_revision_id = EXCLUDED.current_revision_id, modified = NOW()`,
        [tenantId, collection, locked.reference, revisionId],
      );
      if (table) {
        // Safety net for rows written after phase A (normally none: no batch is
        // unprocessed and no new batch is accepted once the intent exists).
        await client.query(
          `UPDATE "${table}" SET is_latest = TRUE, modified = NOW()
            WHERE tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE`,
          [tenantId, revisionId],
        );
        // Legacy (v1, revision_id IS NULL) rows of the same document are visible
        // through is_latest alone, so they must disappear in THIS transaction —
        // otherwise two versions of the document would be searchable.
        await client.query(
          `UPDATE "${table}" SET is_latest = FALSE, modified = NOW()
            WHERE tenant_id = $1 AND revision_id IS NULL AND is_latest = TRUE
              AND base_ref = ANY($2::text[])`,
          [tenantId, referenceVariants(locked.reference)],
        );
      }
      // Only committed revisions are superseded. A revision still staging keeps
      // going: when it commits, the version order decides whether it replaces
      // this one — two formats of one document ingested concurrently must not
      // abort each other.
      await client.query(
        `UPDATE ${REVISIONS}
            SET status = 'superseded', modified = NOW()
          WHERE tenant_id = $1 AND collection = $2 AND reference = $3
            AND revision_id <> $4 AND status = 'committed'`,
        [tenantId, collection, locked.reference, revisionId],
      );
      await client.query(
        `UPDATE ${REVISIONS}
            SET status = 'committed', commit_state = 'cleanup', prior_revision_id = $4,
                ttl_expires_at = NULL, modified = NOW()
          WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
        [tenantId, collection, revisionId, priorRevisionId],
      );
      await registerCommittedDocument(client, locked, info);
      return "switched";
    }),
  );
  if (switched === "older") return { state: "committed", isLatest: false };
  if (switched === "pending") {
    const n = await withPoolClient(pool, (c) => countUnprocessed(c, tenantId, collection, revisionId));
    return { state: "pending", pendingBatches: n };
  }
  if (switched === "raced") {
    // A concurrent finalizer (or an abort) got there first; report its result.
    const again = await withPoolClient(pool, (c) => loadRevision(c, tenantId, collection, revisionId));
    if (!again) return { state: "missing" };
    if (again.status !== "committed") {
      return again.status === "aborted" || again.status === "superseded"
        ? { state: "closed" }
        : { state: "not_requested" };
    }
  }

  // Phase C — hide older revisions' rows (already invisible via the pointer).
  const current = await withPoolClient(pool, (c) => loadRevision(c, tenantId, collection, revisionId));
  if (current?.commit_state === "cleanup") await cleanupOlderRevisions(pool, current);
  const pointer = await withPoolClient(pool, (c) => loadPointer(c, tenantId, collection, revision.reference));
  return { state: "committed", isLatest: pointer === revisionId };
}

/**
 * True when the revision's version is strictly older than the version of the
 * revision the document pointer currently names (see `isOlderVersion`).
 */
async function isOlderThanCurrent(client: PoolClient, revision: RevisionRowRaw): Promise<boolean> {
  const pointer = await loadPointer(client, revision.tenant_id, revision.collection, revision.reference);
  if (pointer === null || pointer === revision.revision_id) return false;
  const current = await loadRevision(client, revision.tenant_id, revision.collection, pointer);
  if (!current) return false;
  return isOlderVersion(parseDocumentInfo(revision.document_info), parseDocumentInfo(current.document_info));
}

/**
 * The document-identity side of a final switch, in the switch's transaction:
 * mark the revision's source claim indexed and register the document's group
 * (e-mail thread / attachment parent).
 */
async function registerCommittedDocument(
  client: PoolClient,
  revision: RevisionRowRaw,
  info: DocumentInfo,
): Promise<void> {
  if (revision.source_id) {
    await markSourceIndexed(client, {
      tenantId: revision.tenant_id,
      collection: revision.collection,
      sourceId: revision.source_id,
      reference: revision.reference,
      revisionId: revision.revision_id,
    });
  }
  await registerDocumentGroup(client, {
    tenantId: revision.tenant_id,
    collection: revision.collection,
    reference: revision.reference,
    info,
  });
}

/**
 * Resume every unfinished final commit (accepted intents whose batches are all
 * processed, and switches whose cleanup was interrupted). Called by the batch
 * worker when it is idle, so a crash between phases, a failed flip or a commit
 * whose last batch was processed by a now-dead worker still completes.
 * Returns the number of revisions it switched or cleaned up.
 */
export async function finalizePendingCommits(
  pool: Pool,
  options: { onlyTenantId?: string; limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? 10;
  const rows = await pool.query<{ tenant_id: string; collection: string; revision_id: string }>(
    `SELECT r.tenant_id, r.collection, r.revision_id FROM ${REVISIONS} r
      WHERE r.commit_state IN ('requested', 'cleanup')
        AND ($1::text IS NULL OR r.tenant_id = $1)
        AND NOT EXISTS (
          SELECT 1 FROM ${BATCHES} b
           WHERE b.tenant_id = r.tenant_id AND b.collection = r.collection
             AND b.revision_id = r.revision_id AND b.status <> 'processed')
      ORDER BY r.modified
      LIMIT ${Math.max(1, Math.floor(limit))}`,
    [options.onlyTenantId ?? null],
  );
  let done = 0;
  for (const row of rows.rows) {
    const outcome = await finalizeRevision(pool, {
      tenantId: row.tenant_id,
      collection: row.collection,
      revisionId: row.revision_id,
    });
    if (outcome.state === "committed") done += 1;
  }
  return done;
}

/** Phase C of {@link finalizeRevision}: flip older revisions' rows invisible. */
async function cleanupOlderRevisions(pool: Pool, revision: RevisionRowRaw): Promise<void> {
  const { tenant_id: tenantId, collection, revision_id: revisionId, reference } = revision;
  const table = await resolveCollectionTable(pool, collection);
  if (table) {
    await flipChunked(pool, {
      table,
      where: `tenant_id = $1 AND document_id = $3 AND revision_id IS NOT NULL
              AND revision_id <> $2 AND is_latest = TRUE`,
      params: [tenantId, revisionId, reference],
      target: false,
    });
  }
  await pool.query(
    `UPDATE ${REVISIONS} SET commit_state = 'done', modified = NOW()
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND commit_state = 'cleanup'`,
    [tenantId, collection, revisionId],
  );
}

// ─── Worker-facing visibility decision (Requirements 6.4, 5.11) ──────────────

/** What the batch worker needs to decide a unit's is_latest at upsert time. */
export interface UnitVisibilityContext {
  status: RevisionStatus;
  visibility: Visibility;
  reference: string;
  commitState: RevisionRowRaw["commit_state"];
  /** The document pointer names this revision. */
  pointsHere: boolean;
  /** Committed segment page ranges of this revision. */
  segments: PageRange[];
}

/**
 * Load the visibility context for a revision INSIDE the worker's transaction,
 * taking `FOR SHARE` on the revision row first. The share lock orders the
 * worker's unit writes against segment commits and the final switch (both take
 * FOR UPDATE): a unit is either written after the segment / switch committed
 * (and sees it here) or before it (and is flipped by it). Returns null when the
 * revision no longer exists.
 */
export async function loadUnitVisibilityContext(
  client: PoolClient,
  target: FinalizeTarget,
): Promise<UnitVisibilityContext | null> {
  const { tenantId, collection, revisionId } = target;
  const revision = await lockRevision(client, tenantId, collection, revisionId, "SHARE");
  if (!revision) return null;
  const pointer = await loadPointer(client, tenantId, collection, revision.reference);
  const segments = await client.query<{ page_start: number; page_end: number }>(
    `SELECT page_start, page_end FROM ${SEGMENTS}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
    [tenantId, collection, revisionId],
  );
  return {
    status: revision.status,
    visibility: revision.visibility,
    reference: revision.reference,
    commitState: revision.commit_state,
    pointsHere: pointer === revisionId,
    segments: segments.rows.map((r) => ({ from: r.page_start, to: r.page_end })),
  };
}

/**
 * is_latest for a unit written now: TRUE when the pointer names this revision
 * AND either the revision is committed, or it is `progressive` and the unit
 * overlaps a committed segment. The overlap predicate matches the segment flip
 * (a unit without a page range counts as spanning the document).
 */
export function isUnitVisible(
  ctx: UnitVisibilityContext,
  pageStart: number | null | undefined,
  pageEnd: number | null | undefined,
): boolean {
  if (!ctx.pointsHere) return false;
  if (ctx.status === "committed") return true;
  if (ctx.visibility !== "progressive") return false;
  const from = pageStart ?? 1;
  const to = pageEnd ?? Number.MAX_SAFE_INTEGER;
  return ctx.segments.some((s) => from <= s.to && to >= s.from);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Thrown inside a withClient callback to short-circuit with a mapped error. */
class RevisionStoreThrow extends Error {
  constructor(readonly error: RevisionStoreError) {
    super(error.message);
    this.name = "RevisionStoreThrow";
  }
}

function notFound(): RevisionStoreThrow {
  return new RevisionStoreThrow({
    status: 404,
    code: "REVISION_NOT_FOUND",
    message: "revision does not exist",
  });
}

interface RevisionRowRaw {
  tenant_id: string;
  collection: string;
  revision_id: string;
  reference: string;
  status: RevisionStatus;
  visibility: Visibility;
  idempotency_key: string | null;
  ttl_expires_at: Date | null;
  page_count: number | null;
  has_document_end: boolean;
  commit_state: "requested" | "cleanup" | "done" | null;
  prior_revision_id: string | null;
  source_id?: string | null;
  document_info?: unknown;
  allowed_users?: string[] | null;
  allowed_groups?: string[] | null;
  created: Date;
  modified: Date;
}

interface BatchRowRaw {
  digest: string;
  status: BatchStatus;
  page_start: number | null;
  page_end: number | null;
}

function toRevision(row: RevisionRowRaw): Revision {
  return {
    revisionId: row.revision_id,
    reference: row.reference,
    status: row.status,
    visibility: row.visibility,
    createdAt: row.created.toISOString(),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.ttl_expires_at ? { ttlExpiresAt: row.ttl_expires_at.toISOString() } : {}),
  };
}

/** NFC-insensitive reference equality (references are compared canonically). */
function sameReference(stored: string, requested: string): boolean {
  return stored.normalize("NFC") === requested.normalize("NFC");
}

/** The raw and NFC spellings of a reference, for base_ref matches of v1 rows. */
function referenceVariants(reference: string): string[] {
  const nfc = reference.normalize("NFC");
  return nfc === reference ? [reference] : [reference, nfc];
}

/** Reject a call whose `:ref` path parameter names a different document. */
function assertReference(revision: RevisionRowRaw, requested: string | undefined): void {
  if (requested === undefined) return;
  if (!sameReference(revision.reference, requested)) {
    throw new RevisionStoreThrow({
      status: 409,
      code: "REVISION_REFERENCE_MISMATCH",
      message: "the revision belongs to a different document reference",
    });
  }
}

/** Run `fn` inside BEGIN/COMMIT on `client`; ROLLBACK and rethrow on error. */
async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** Borrow a pool client for `fn` and always release it. */
async function withPoolClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function loadRevision(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
): Promise<RevisionRowRaw | null> {
  const res = await client.query<RevisionRowRaw>(
    `SELECT * FROM ${REVISIONS}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
    [tenantId, collection, revisionId],
  );
  return res.rows[0] ?? null;
}

/** Load the revision row under a row lock (the caller holds a transaction). */
async function lockRevision(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
  mode: "UPDATE" | "SHARE",
): Promise<RevisionRowRaw | null> {
  const res = await client.query<RevisionRowRaw>(
    `SELECT * FROM ${REVISIONS}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3
      FOR ${mode}`,
    [tenantId, collection, revisionId],
  );
  return res.rows[0] ?? null;
}

async function loadBatch(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
  seq: number,
): Promise<BatchRowRaw | null> {
  const res = await client.query<BatchRowRaw>(
    `SELECT digest, status, page_start, page_end FROM ${BATCHES}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND seq = $4`,
    [tenantId, collection, revisionId, seq],
  );
  return res.rows[0] ?? null;
}

/** Same digest ⇒ idempotent 200 no-op; different digest ⇒ 409. */
function replayAck(seq: number, digest: string, prior: BatchRowRaw): BatchAck {
  if (prior.digest === digest) {
    return batchAck(seq, digest, prior.status, prior.page_start, prior.page_end, true);
  }
  throw new RevisionStoreThrow({
    status: 409,
    code: "BATCH_DIGEST_CONFLICT",
    message: `seq ${seq} already staged with a different Content-Digest`,
  });
}

async function loadPointer(
  client: PoolClient,
  tenantId: string,
  collection: string,
  reference: string,
): Promise<string | null> {
  const res = await client.query<{ current_revision_id: string }>(
    `SELECT current_revision_id FROM ${POINTER}
      WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
    [tenantId, collection, reference],
  );
  return res.rows[0]?.current_revision_id ?? null;
}

async function countUnprocessed(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
): Promise<number> {
  const res = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ${BATCHES}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND status <> 'processed'`,
    [tenantId, collection, revisionId],
  );
  return res.rows[0]?.n ?? 0;
}

async function markAborted(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
): Promise<void> {
  await client.query(
    `UPDATE ${REVISIONS}
        SET status = 'aborted', commit_state = NULL, ttl_expires_at = NULL, modified = NOW()
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
    [tenantId, collection, revisionId],
  );
}

/**
 * The collection's unit table when the collection name is valid AND the table
 * exists; null otherwise (a revision staged for a collection that was never
 * created has no unit rows to flip or delete).
 */
async function resolveCollectionTable(
  db: Pool | PoolClient,
  collection: string,
): Promise<string | null> {
  let table: string;
  try {
    table = collectionTableName(collection);
  } catch {
    return null;
  }
  const res = await db.query<{ t: string | null }>(
    `SELECT to_regclass(format('%I', $1::text))::text AS t`,
    [table],
  );
  return res.rows[0]?.t ? table : null;
}

/**
 * Asset ids referenced by the revision's batches that are not uploaded yet
 * (Requirement 5.6). The ids were captured at staging time (`asset_ids`), so
 * this is a set difference in SQL — no payload is read or decoded. Batches
 * staged before the column existed (asset_ids IS NULL) fall back to decoding
 * just those payloads. An asset counts as present when its `full` variant
 * exists in the tenant + collection: asset ids are derived from the document
 * reference, so the same id is the same document's asset regardless of which
 * revision uploaded it.
 */
async function loadMissingAssets(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
): Promise<string[]> {
  const missing = new Set<string>();
  const indexed = await client.query<{ asset_id: string }>(
    `SELECT r.asset_id FROM (
        SELECT DISTINCT unnest(asset_ids) AS asset_id FROM ${BATCHES}
         WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND asset_ids IS NOT NULL
      ) r
      WHERE NOT EXISTS (
        SELECT 1 FROM ${ASSETS} a
         WHERE a.tenant_id = $1 AND a.collection = $2 AND a.asset_id = r.asset_id AND a.variant = 'full')`,
    [tenantId, collection, revisionId],
  );
  for (const row of indexed.rows) missing.add(row.asset_id);

  const legacy = await client.query<{ payload: Buffer | null }>(
    `SELECT payload FROM ${BATCHES}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3 AND asset_ids IS NULL`,
    [tenantId, collection, revisionId],
  );
  if (legacy.rows.length > 0) {
    const referenced = [...collectReferencedAssetIds(legacy.rows.map((r) => r.payload))];
    if (referenced.length > 0) {
      const present = await client.query<{ asset_id: string }>(
        `SELECT DISTINCT asset_id FROM ${ASSETS}
          WHERE tenant_id = $1 AND collection = $2 AND variant = 'full' AND asset_id = ANY($3::text[])`,
        [tenantId, collection, referenced],
      );
      const have = new Set(present.rows.map((r) => r.asset_id));
      for (const id of referenced) if (!have.has(id)) missing.add(id);
    }
  }
  return [...missing].sort();
}

/**
 * Delete every row written under `revisionIds` — staged batches, the units in
 * the collection table, their vs_identifiers entries, segments, and
 * revision-bound assets (Requirements 2.3, 14.3) — inside the CALLER's
 * transaction. The caller holds the cascade advisory lock. Shared by the
 * revision cascade (one id) and the document cascade (all ids of a reference).
 * Returns the number of unit rows removed from the collection table.
 */
async function deleteRevisionRows(
  client: PoolClient,
  table: string | null,
  tenantId: string,
  collection: string,
  revisionIds: string[],
): Promise<number> {
  if (revisionIds.length === 0) return 0;
  await client.query(
    `DELETE FROM ${BATCHES} WHERE tenant_id = $1 AND collection = $2 AND revision_id = ANY($3::text[])`,
    [tenantId, collection, revisionIds],
  );
  let deleted = 0;
  if (table) {
    const identifiers = await client.query<{ t: string | null }>(
      `SELECT to_regclass($1)::text AS t`,
      [IDENTIFIERS],
    );
    if (identifiers.rows[0]?.t) {
      await client.query(
        `DELETE FROM ${IDENTIFIERS} i
          WHERE i.tenant_id = $1 AND i.collection = $2
            AND i.unit_id IN (
              SELECT u.unit_id FROM "${table}" u
               WHERE u.tenant_id = $1 AND u.revision_id = ANY($3::text[]) AND u.unit_id IS NOT NULL)`,
        [tenantId, collection, revisionIds],
      );
    }
    const units = await client.query(
      `DELETE FROM "${table}" WHERE tenant_id = $1 AND revision_id = ANY($2::text[])`,
      [tenantId, revisionIds],
    );
    deleted = units.rowCount ?? 0;
  }
  await client.query(
    `DELETE FROM ${SEGMENTS} WHERE tenant_id = $1 AND collection = $2 AND revision_id = ANY($3::text[])`,
    [tenantId, collection, revisionIds],
  );
  // Assets are bound to the revision and cleaned with it (Requirement 14.3).
  await client.query(
    `DELETE FROM ${ASSETS} WHERE tenant_id = $1 AND collection = $2 AND revision_id = ANY($3::text[])`,
    [tenantId, collection, revisionIds],
  );
  return deleted;
}

/**
 * Remove a document COMPLETELY (task 4.2, Requirements 2.3/2.4): every unit
 * row of every revision (current, superseded, legacy rows without a revision,
 * and child units linked through `chunk->>'parent_ref'`), the staged batches,
 * identifiers, segments and assets of all its revisions, the legacy
 * vs_document_assets rows, and the identity rows (sources, group membership,
 * thread references, revision pointer) — for every NFC spelling of each root
 * reference. Runs inside the CALLER's transaction; the caller commits.
 *
 * Derived render-cache assets are vs_assets rows bound to the
 * document, so the asset deletes here ARE the render-cache invalidation; the
 * in-process embedding cache is cleared by the caller after COMMIT
 * (`onDocumentsDeleted`).
 *
 * Locking: one transaction-scoped advisory lock per (tenant, collection)
 * serialises concurrent document cascades, whose multi-row DELETEs would
 * otherwise deadlock on row order. A revision cascade racing a document
 * cascade uses a different advisory key; the row locks still serialise them
 * and Postgres resolves any true deadlock by aborting one side.
 *
 * Returns the number of unit rows removed from the collection table.
 */
export async function deleteDocumentCascade(
  client: PoolClient,
  args: {
    tenantId: string;
    collection: string;
    rootRefs: string[];
    /**
     * Unit ids whose rows the CALLER already deleted (the access-scoped DELETE
     * in PostgresClient.delete runs before the cascade). Their identifier rows
     * are removed too — the reference/subquery sweeps below can no longer see
     * unit rows that are already gone.
     */
    deletedUnitIds?: string[];
  },
): Promise<number> {
  const { tenantId, collection } = args;
  const refs = [...new Set(args.rootRefs.flatMap((r) => referenceVariants(r)))];
  if (refs.length === 0) return 0;
  const table = await resolveCollectionTable(client, collection);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
    `atf:document-cascade:${JSON.stringify([tenantId, collection])}`,
  ]);
  // Identifier rows of units the caller already removed: the reference and
  // revision subqueries below join through the collection table, which no
  // longer holds those rows — without this sweep they would be orphaned.
  const callerUnitIds = [...new Set(args.deletedUnitIds ?? [])];
  if (callerUnitIds.length > 0) {
    const ident = await client.query<{ t: string | null }>(
      `SELECT to_regclass($1)::text AS t`,
      [IDENTIFIERS],
    );
    if (ident.rows[0]?.t) {
      await client.query(
        `DELETE FROM ${IDENTIFIERS}
          WHERE tenant_id = $1 AND collection = $2 AND unit_id = ANY($3::text[])`,
        [tenantId, collection, callerUnitIds],
      );
    }
  }
  // Every revision ever written for these references — the cascade must not
  // leave rows of superseded or aborted revisions behind.
  const revisions = await client.query<{ revision_id: string }>(
    `SELECT revision_id FROM ${REVISIONS}
      WHERE tenant_id = $1 AND collection = $2 AND reference = ANY($3::text[])`,
    [tenantId, collection, refs],
  );
  let deleted = await deleteRevisionRows(
    client,
    table,
    tenantId,
    collection,
    revisions.rows.map((r) => r.revision_id),
  );
  if (table) {
    // Reference-keyed rows the revision pass did not cover: legacy units
    // without a revision_id, and units whose revision row is already gone.
    const refWhere =
      `tenant_id = $1 AND (base_ref = ANY($2::text[]) OR reference = ANY($2::text[]) OR chunk->>'parent_ref' = ANY($2::text[]))`;
    const identifiers = await client.query<{ t: string | null }>(
      `SELECT to_regclass($1)::text AS t`,
      [IDENTIFIERS],
    );
    if (identifiers.rows[0]?.t) {
      // The subquery re-uses $1 (tenant) and takes the refs as $3 — the
      // statement-level $2 is the identifiers collection, which the per-
      // collection unit table does not carry as a column.
      await client.query(
        `DELETE FROM ${IDENTIFIERS} i
          WHERE i.tenant_id = $1 AND i.collection = $2
            AND i.unit_id IN (
              SELECT u.unit_id FROM "${table}" u
               WHERE u.tenant_id = $1
                 AND (u.base_ref = ANY($3::text[]) OR u.reference = ANY($3::text[])
                      OR u.chunk->>'parent_ref' = ANY($3::text[]))
                 AND u.unit_id IS NOT NULL)`,
        [tenantId, collection, refs],
      );
    }
    const units = await client.query(`DELETE FROM "${table}" WHERE ${refWhere}`, [
      tenantId,
      refs,
    ]);
    deleted += units.rowCount ?? 0;
  }
  // Assets addressed by document (figures, page images, derived render-cache
  // variants) in addition to the revision-bound rows deleted above.
  await client.query(
    `DELETE FROM ${ASSETS} WHERE tenant_id = $1 AND collection = $2 AND document_reference = ANY($3::text[])`,
    [tenantId, collection, refs],
  );
  await client.query(
    `DELETE FROM vs_document_assets WHERE tenant_id = $1 AND collection = $2 AND document_reference = ANY($3)`,
    [tenantId, collection, refs],
  );
  // Identity rows: a deleted document must not linger as a source a re-ingest
  // would call a "duplicate", a group member, a thread reference, or a pointer.
  for (const reference of refs) {
    await forgetDocument(client, { tenantId, collection, reference });
  }
  await client.query(
    `DELETE FROM ${REVISIONS} WHERE tenant_id = $1 AND collection = $2 AND reference = ANY($3::text[])`,
    [tenantId, collection, refs],
  );
  return deleted;
}

/**
 * Delete a revision and everything written under it, in one transaction:
 * staged batches, the revision's unit rows in the collection table, their
 * vs_identifiers entries, segments, revision-bound assets (Requirement 14.3),
 * a document pointer that names the revision (reset to the previous committed
 * revision when there is one, otherwise removed), and the revision row itself.
 *
 * The caller has already marked the revision 'aborted' in its own short
 * transaction, so no stage / commit / worker write proceeds concurrently. Lock
 * order here is batch rows → unit rows → revision row, which matches the
 * worker (batch row → revision FOR SHARE) and cannot deadlock with it.
 */
async function deleteRevisionCascade(
  pool: Pool,
  tenantId: string,
  collection: string,
  revisionId: string,
): Promise<void> {
  const table = await resolveCollectionTable(pool, collection);
  await withPoolClient(pool, (client) =>
    inTransaction(client, async () => {
      const params = [tenantId, collection, revisionId];
      // Serialize concurrent cascades of the SAME revision (an abort racing the
      // reaper's leftover sweep): two multi-row DELETEs over the same rows can
      // deadlock on row order. An advisory lock keyed on the revision avoids
      // that without adding a row lock the batch worker could wait on.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
        `atf:revision-cascade:${JSON.stringify([tenantId, collection, revisionId])}`,
      ]);
      await deleteRevisionRows(client, table, tenantId, collection, [
        revisionId,
      ]);
      const revision = await lockRevision(client, tenantId, collection, revisionId, "UPDATE");
      if (revision) {
        const pointer = await client.query<{ current_revision_id: string }>(
          `SELECT current_revision_id FROM ${POINTER}
            WHERE tenant_id = $1 AND collection = $2 AND reference = $3
            FOR UPDATE`,
          [tenantId, collection, revision.reference],
        );
        if (pointer.rows[0]?.current_revision_id === revisionId) {
          const previous = await client.query<{ revision_id: string }>(
            `SELECT revision_id FROM ${REVISIONS}
              WHERE tenant_id = $1 AND collection = $2 AND reference = $3
                AND revision_id <> $4 AND status = 'committed'
              ORDER BY modified DESC
              LIMIT 1`,
            [tenantId, collection, revision.reference, revisionId],
          );
          const previousId = previous.rows[0]?.revision_id;
          if (previousId) {
            await client.query(
              `UPDATE ${POINTER} SET current_revision_id = $4, modified = NOW()
                WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
              [tenantId, collection, revision.reference, previousId],
            );
          } else {
            await client.query(
              `DELETE FROM ${POINTER}
                WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
              [tenantId, collection, revision.reference],
            );
          }
        }
      }
      await client.query(
        `DELETE FROM ${REVISIONS} WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
        params,
      );
    }),
  );
}

/** All page ranges the accepted batches cover, merged. */
async function acceptedPageRanges(
  client: PoolClient,
  tenantId: string,
  collection: string,
  revisionId: string,
): Promise<PageRange[]> {
  const res = await client.query<{ page_start: number | null; page_end: number | null }>(
    `SELECT page_start, page_end FROM ${BATCHES}
      WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3
        AND page_start IS NOT NULL AND page_end IS NOT NULL`,
    [tenantId, collection, revisionId],
  );
  return mergeRanges(
    res.rows.map((r) => ({ from: r.page_start as number, to: r.page_end as number })),
  );
}

/** The overall [min,max] span of a set of ranges, or null when empty. */
function spanOf(ranges: PageRange[]): PageRange | null {
  if (ranges.length === 0) return null;
  const from = Math.min(...ranges.map((r) => r.from));
  const to = Math.max(...ranges.map((r) => r.to));
  return { from, to };
}

/**
 * Does this reference already have a visible version: a v2 pointer, or legacy
 * (revision_id IS NULL) rows that are still is_latest in the collection table?
 */
async function documentHasVisibleVersion(
  client: PoolClient,
  tenantId: string,
  collection: string,
  reference: string,
): Promise<boolean> {
  const res = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM ${POINTER}
      WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
    [tenantId, collection, reference],
  );
  if (res.rows.length > 0) return true;
  const table = await resolveCollectionTable(client, collection);
  if (!table) return false;
  const legacy = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM "${table}"
      WHERE tenant_id = $1 AND revision_id IS NULL AND is_latest = TRUE
        AND base_ref = ANY($2::text[])
      LIMIT 1`,
    [tenantId, referenceVariants(reference)],
  );
  return legacy.rows.length > 0;
}

/** Run a flip; convert an error into a value so callers can map it. */
async function runFlip(
  fn: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * Flip `is_latest` to `target` for every row matching `where`, at most
 * {@link FLIP_BATCH_ROWS} rows per statement. Each chunk runs in its OWN
 * transaction with `SET LOCAL statement_timeout`, so no single statement holds
 * locks on more than one chunk and the timeout actually applies. Chunks are
 * selected by primary key (`id`), stable under concurrent updates; the loop
 * runs until a chunk flips nothing. Errors propagate to the caller.
 */
async function flipChunked(
  pool: Pool,
  args: { table: string; where: string; params: unknown[]; target: boolean },
): Promise<void> {
  const { table, where, params, target } = args;
  const targetPh = `$${params.length + 1}`;
  // Guard against an unbounded loop if rows keep reappearing.
  for (let guard = 0; guard < 100_000; guard++) {
    const flipped = await withPoolClient(pool, (client) =>
      inTransaction(client, async () => {
        await client.query(`SET LOCAL statement_timeout = ${FLIP_STATEMENT_TIMEOUT_MS}`);
        const res = await client.query(
          `UPDATE "${table}" SET is_latest = ${targetPh}, modified = NOW()
            WHERE id IN (
              SELECT id FROM "${table}"
               WHERE ${where}
               LIMIT ${FLIP_BATCH_ROWS}
            )`,
          [...params, target],
        );
        return res.rowCount ?? 0;
      }),
    );
    if (flipped === 0) break;
  }
}

/**
 * Progressive visibility (Req 6.4): make one committed segment's rows searchable
 * by flipping is_latest = TRUE for the revision's rows whose page range overlaps
 * [pageStart, pageEnd] (a row without a page range counts as overlapping).
 * Chunked like the final flip; errors propagate (a replayed segment commit
 * re-runs it).
 */
async function flipSegmentVisible(
  pool: Pool,
  args: {
    collection: string;
    tenantId: string;
    revisionId: string;
    pageStart: number;
    pageEnd: number;
  },
): Promise<void> {
  const { collection, tenantId, revisionId, pageStart, pageEnd } = args;
  const table = await resolveCollectionTable(pool, collection);
  if (!table) return;
  await flipChunked(pool, {
    table,
    where: `tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE
            AND COALESCE(page_start, 1) <= $4 AND COALESCE(page_end, 2147483647) >= $3`,
    params: [tenantId, revisionId, pageStart, pageEnd],
    target: true,
  });
}

function batchAck(
  seq: number,
  digest: string,
  status: BatchStatus,
  pageStart: number | null,
  pageEnd: number | null,
  noop: boolean,
): BatchAck {
  return {
    seq,
    digest,
    status,
    noop,
    ...(pageStart != null && pageEnd != null ? { pages: { from: pageStart, to: pageEnd } } : {}),
  };
}

interface BatchValidation {
  ok: boolean;
  issues: RecordValidationIssue[];
  pages?: PageRange;
  /** `document.begin.pageCount` when the batch carries one. */
  beginPageCount?: number;
  /** `document.end.pageCount` when the batch carries the trailing record. */
  endPageCount?: number;
  /** The batch carries the trailing `document.end` record. */
  hasDocumentEnd: boolean;
  /** Asset ids the batch's page records reference (page.assets + figure blocks). */
  assetIds: string[];
  /**
   * Extract provenance from `document.begin` when the batch carries it
   * (Requirement 18.2). Persisted on the revision row so every later batch's
   * units carry the same values.
   */
  extractProvenance?: ExtractProvenance;
  /** Version, e-mail headers and parent from `document.begin` (contract 2.1). */
  documentInfo?: DocumentInfo;
}

/**
 * The Extract provenance a revision's units carry in their metadata
 * (Requirement 18.2): the contract id plus the pipeline version and prompt
 * hash from `document.begin.pipeline`. Only present keys are set.
 */
export interface ExtractProvenance {
  /** `document.begin.contract`, e.g. `atf-extract/2.0.0`. */
  contract: string;
  /** `document.begin.pipeline.pipelineVersion`. */
  pipelineVersion?: string;
  /** `document.begin.pipeline.promptHash`. */
  promptHash?: string;
}

/** Project a `document.begin` record onto its {@link ExtractProvenance}. */
export function extractProvenanceOf(begin: {
  contract: string;
  pipeline: { pipelineVersion?: string | undefined; promptHash?: string | undefined };
}): ExtractProvenance {
  return {
    contract: begin.contract,
    ...(begin.pipeline.pipelineVersion ? { pipelineVersion: begin.pipeline.pipelineVersion } : {}),
    ...(begin.pipeline.promptHash ? { promptHash: begin.pipeline.promptHash } : {}),
  };
}

/**
 * Parse the persisted `vs_revisions.extract_provenance` JSONB defensively: a
 * missing / malformed value yields undefined rather than failing a batch.
 */
export function parseExtractProvenance(value: unknown): ExtractProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.contract !== "string" || raw.contract === "") return undefined;
  return {
    contract: raw.contract,
    ...(typeof raw.pipelineVersion === "string" && raw.pipelineVersion
      ? { pipelineVersion: raw.pipelineVersion }
      : {}),
    ...(typeof raw.promptHash === "string" && raw.promptHash ? { promptHash: raw.promptHash } : {}),
  };
}

/**
 * Validate every record of the NDJSON batch through the v2 contract and derive
 * the batch's page range from its `page` records, the declared page count from
 * `document.begin` / `document.end`, and the referenced asset ids. A single
 * invalid record fails the whole batch with the machine-readable issue list.
 */
export function validateBatchBody(body: Buffer, reference: string): BatchValidation {
  const text = body.toString("utf-8");
  const lines = text.split("\n");
  const issues: RecordValidationIssue[] = [];
  let minPage = Number.POSITIVE_INFINITY;
  let maxPage = Number.NEGATIVE_INFINITY;
  let sawRecord = false;
  let beginPageCount: number | undefined;
  let endPageCount: number | undefined;
  let hasDocumentEnd = false;
  let extractProvenance: ExtractProvenance | undefined;
  let documentInfo: DocumentInfo | undefined;
  const assetIds = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    sawRecord = true;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      issues.push({
        path: `line[${i}]`,
        message: `not valid JSON: ${(error as Error).message}`,
        severity: "error",
      });
      continue;
    }
    const result = validateRecord(value, { reference });
    if (!result.ok) {
      for (const issue of result.issues) {
        issues.push({ ...issue, path: `line[${i}].${issue.path}` });
      }
      continue;
    }
    const record = result.record;
    if (record.type === "page") {
      minPage = Math.min(minPage, record.page);
      maxPage = Math.max(maxPage, record.page);
      for (const asset of record.assets) assetIds.add(asset.assetId);
      for (const block of record.blocks) {
        if (block.type === "figure" && block.assetId) assetIds.add(block.assetId);
      }
    } else if (record.type === "document.begin") {
      if (record.pageCount !== undefined) beginPageCount = record.pageCount;
      extractProvenance = extractProvenanceOf(record);
      documentInfo = documentInfoOf(record);
    } else if (record.type === "document.end") {
      hasDocumentEnd = true;
      endPageCount = record.pageCount;
    }
  }

  if (!sawRecord) {
    issues.push({ path: "(root)", message: "batch is empty", severity: "error" });
  }
  if (issues.length > 0) return { ok: false, issues, hasDocumentEnd: false, assetIds: [] };
  const pages =
    minPage !== Number.POSITIVE_INFINITY ? { from: minPage, to: maxPage } : undefined;
  return {
    ok: true,
    issues: [],
    ...(pages ? { pages } : {}),
    ...(beginPageCount !== undefined ? { beginPageCount } : {}),
    ...(endPageCount !== undefined ? { endPageCount } : {}),
    hasDocumentEnd,
    assetIds: [...assetIds].sort(),
    ...(extractProvenance ? { extractProvenance } : {}),
    ...(documentInfo ? { documentInfo } : {}),
  };
}

/**
 * Collect the asset ids referenced by staged batch payloads (page.assets and
 * figure blocks). Only used as a fallback for batches staged before asset ids
 * were captured at staging time. Unparseable payloads are skipped because a
 * staged batch already validated at PUT time.
 */
export function collectReferencedAssetIds(payloads: Array<Buffer | null>): Set<string> {
  const ids = new Set<string>();
  for (const payload of payloads) {
    if (!payload) continue;
    let records: ReturnType<typeof decodeRecords>;
    try {
      records = decodeRecords(payload.toString("utf-8"));
    } catch {
      // A staged batch already validated at PUT time; skip anything that no
      // longer parses rather than failing a read-only status report.
      continue;
    }
    for (const record of records) {
      if (record.type !== "page") continue;
      for (const asset of record.assets) ids.add(asset.assetId);
      for (const block of record.blocks) {
        if (block.type === "figure" && block.assetId) ids.add(block.assetId);
      }
    }
  }
  return ids;
}

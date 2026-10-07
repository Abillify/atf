// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/erasure.ts — `POST /v1/erasure` (task 4.5, Requirement 2.5).
 *
 * Subject-related erasure for the Search store, part of the platform-wide
 * DSAR flow orchestrated by the Runtime (`compliance/erasure-orchestrator.ts`).
 * The request/response shape is the shared `@atf/erasure-contract`; the route
 * sits behind service auth with the `vectorsearch.erasure` scope and is
 * idempotent over `requestId` through the invocation ledger.
 *
 * What is erased, per scope:
 *
 *  - `reference`: every listed reference through the public
 *    `PostgresClient.delete` — the full document cascade (task 4.2) including
 *    revisions, batches, segments, assets, identifiers, and identity rows.
 *  - `subject`: every document whose row identifies the subject — the
 *    `allowed_users` ACL column or the configurable metadata field
 *    (`ERASURE_SUBJECT_METADATA_FIELD`, default `subject`) — plus the
 *    subject's `vs_search_stats` rows.
 *  - `tenant`: every row of every collection table plus the tenant's rows in
 *    the revision/staging/asset/identity system tables and `vs_search_stats`.
 *
 * Honest limitations (reported as zeros, never as silent success of a
 * deletion that did not happen):
 *
 *  - `vs_search_stats` carries no subject column (Requirement 2.6 stores only
 *    a hash of the query text). Subject-scoped stats deletion therefore
 *    removes the rows whose `query_hash` equals the hash of one of the
 *    subject's identifiers — the only attribution the schema supports.
 *  - `vs_invocation_ledger` keys are one-way hashes of
 *    (principal, executionId, invocationId); ledger rows are not
 *    subject-attributable and expire with the ledger TTL. The store result
 *    reports `erased: 0` truthfully.
 */

import { createHash, createHmac } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import {
  ErasureRequestSchema,
  type ErasureRequest,
  type ErasureResponse,
  type ErasureStoreResult,
} from "@atf/erasure-contract";
import {
  accessScopeForRequest,
  type AccessScope,
} from "../access-scope.js";
import type { PostgresClient } from "../postgres-client.js";
import { collectionTableName } from "../collection-ddl.js";
import {
  VS_ASSETS_TABLE,
  VS_DOCUMENT_GROUPS_TABLE,
  VS_DOCUMENT_REVISIONS_TABLE,
  VS_DOCUMENT_SOURCES_TABLE,
  VS_INGEST_BATCHES_TABLE,
  VS_MAIL_MESSAGES_TABLE,
  VS_REVISIONS_TABLE,
  VS_SEGMENTS_TABLE,
} from "../revision-schema.js";
import {
  invocationFingerprint,
  type InvocationLedger,
} from "../invocation-ledger.js";
import { readHeader } from "../header-utils.js";
import { emitActivity } from "../activity-emitter.js";
import { newActivityId } from "./activity-stream.js";

/** The pool escape hatch of PostgresClient, narrowed to what erasure needs. */
type ErasurePostgres = Pick<
  PostgresClient,
  "delete" | "listCollections" | "queryInvocationLedger"
>;

export interface ErasureHandlerOptions {
  postgresClient: ErasurePostgres;
  /** Idempotency ledger shared with the MCP transaction layer. */
  ledger: InvocationLedger;
  /** Metadata field identifying the data subject (ERASURE_SUBJECT_METADATA_FIELD). */
  subjectMetadataField: string;
  /** STATS_QUERY_PEPPER — must match the hashing in recordSearchStat. */
  statsQueryPepper: string | null;
  logger: Logger;
}

/** System tables carrying tenant-scoped rows outside the collection tables. */
const TENANT_SYSTEM_TABLES: readonly string[] = [
  VS_REVISIONS_TABLE,
  VS_INGEST_BATCHES_TABLE,
  VS_SEGMENTS_TABLE,
  VS_DOCUMENT_REVISIONS_TABLE,
  VS_ASSETS_TABLE,
  "vs_document_assets",
  "vs_identifiers",
  VS_DOCUMENT_SOURCES_TABLE,
  VS_MAIL_MESSAGES_TABLE,
  VS_DOCUMENT_GROUPS_TABLE,
];

const STORE_DOCUMENTS = "search.documents";
const STORE_STATS = "search.stats";
const STORE_LEDGER = "search.invocation_ledger";

/** Same hash the stats buffer writes (HMAC with pepper, plain SHA-256 without). */
function statsQueryHash(query: string, pepper: string | null): string {
  return pepper
    ? createHmac("sha256", pepper).update(query).digest("hex")
    : createHash("sha256").update(query).digest("hex");
}

/** Every non-empty identifier the request carries for the subject. */
function subjectIdentifiers(request: ErasureRequest): string[] {
  const subject = request.subject;
  if (!subject) return [];
  const raw = [subject.userId, subject.email, ...subject.externalIds];
  return [
    ...new Set(
      raw
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .map((v) => v.trim()),
    ),
  ];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Combine per-collection partial failures into one honest store result. */
function storeResult(
  store: string,
  erased: number,
  errors: string[],
): ErasureStoreResult {
  if (errors.length > 0) {
    return { store, status: "failed", erased, error: errors.join("; ") };
  }
  return { store, status: "ok", erased };
}

export function createErasureHandler(
  options: ErasureHandlerOptions,
): RequestHandler {
  const {
    postgresClient,
    ledger,
    subjectMetadataField,
    statsQueryPepper,
    logger,
  } = options;

  /** Collections to operate on: the X-Collection header or every collection. */
  async function resolveCollections(
    req: Parameters<RequestHandler>[0],
    scope: AccessScope,
  ): Promise<string[]> {
    const header = readHeader(req, "x-collection");
    if (header) return [header];
    const result = await postgresClient.listCollections(scope);
    if (!result.ok) {
      throw new Error(`listing collections failed: ${result.error.message}`);
    }
    return result.result.map((info) => info.collection);
  }

  /** Count rows matching a predicate (dryRun counterpart of a DELETE). */
  async function countRows(sql: string, params: unknown[]): Promise<number> {
    const result = await postgresClient.queryInvocationLedger(
      `SELECT COUNT(*)::text AS n FROM (${sql}) AS erasure_scope`,
      params,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  // ── scope: reference ──────────────────────────────────────────────────────

  async function eraseReferences(
    request: ErasureRequest,
    scope: AccessScope,
    collections: string[],
    dryRun: boolean,
  ): Promise<ErasureStoreResult> {
    const references = request.references ?? [];
    let erased = 0;
    const errors: string[] = [];
    for (const collection of collections) {
      for (const reference of references) {
        try {
          if (dryRun) {
            const table = collectionTableName(collection);
            erased += await countRows(
              `SELECT 1 FROM "${table}"
                WHERE tenant_id = $1
                  AND (base_ref = $2 OR reference = $2
                       OR chunk->>'parent_ref' = $2)`,
              [scope.tenantId, reference.normalize("NFC")],
            );
          } else {
            const result = await postgresClient.delete(
              {},
              collection,
              scope,
              reference,
            );
            if (result.ok) erased += result.result.deleted;
            else errors.push(`${collection}: ${result.error.message}`);
          }
        } catch (err) {
          errors.push(`${collection}: ${errorMessage(err)}`);
        }
      }
    }
    return storeResult(STORE_DOCUMENTS, erased, errors);
  }

  // ── scope: subject ────────────────────────────────────────────────────────

  /**
   * Root references of documents identifying the subject: the `allowed_users`
   * ACL column or the configurable metadata field (Requirement 2.5). Child
   * units are folded onto their parent document through `chunk->>'parent_ref'`.
   */
  function subjectPredicate(): string {
    return `(allowed_users && $2::text[]
             OR metadata->>$3 = ANY($2::text[]))`;
  }

  async function eraseSubject(
    request: ErasureRequest,
    scope: AccessScope,
    collections: string[],
    dryRun: boolean,
  ): Promise<ErasureStoreResult> {
    const identifiers = subjectIdentifiers(request);
    let erased = 0;
    const errors: string[] = [];
    for (const collection of collections) {
      try {
        const table = collectionTableName(collection);
        if (dryRun) {
          erased += await countRows(
            `SELECT 1 FROM "${table}"
              WHERE tenant_id = $1 AND ${subjectPredicate()}`,
            [scope.tenantId, identifiers, subjectMetadataField],
          );
          continue;
        }
        const found = await postgresClient.queryInvocationLedger(
          `SELECT DISTINCT COALESCE(chunk->>'parent_ref', base_ref) AS root_ref
             FROM "${table}"
            WHERE tenant_id = $1 AND ${subjectPredicate()}`,
          [scope.tenantId, identifiers, subjectMetadataField],
        );
        for (const row of found.rows) {
          const rootRef = String(row["root_ref"]);
          const result = await postgresClient.delete(
            {},
            collection,
            scope,
            rootRef,
          );
          if (result.ok) erased += result.result.deleted;
          else errors.push(`${collection}/${rootRef}: ${result.error.message}`);
        }
      } catch (err) {
        errors.push(`${collection}: ${errorMessage(err)}`);
      }
    }
    return storeResult(STORE_DOCUMENTS, erased, errors);
  }

  // ── scope: tenant ─────────────────────────────────────────────────────────

  async function eraseTenant(
    scope: AccessScope,
    collections: string[],
    dryRun: boolean,
  ): Promise<ErasureStoreResult> {
    let erased = 0;
    const errors: string[] = [];
    const tables: string[] = [];
    for (const collection of collections) {
      try {
        tables.push(collectionTableName(collection));
      } catch (err) {
        errors.push(`${collection}: ${errorMessage(err)}`);
      }
    }
    tables.push(...TENANT_SYSTEM_TABLES);
    for (const table of tables) {
      try {
        if (dryRun) {
          erased += await countRows(
            `SELECT 1 FROM "${table}" WHERE tenant_id = $1`,
            [scope.tenantId],
          );
        } else {
          const result = await postgresClient.queryInvocationLedger(
            `DELETE FROM "${table}" WHERE tenant_id = $1`,
            [scope.tenantId],
          );
          erased += result.rowCount;
        }
      } catch (err) {
        // A table that does not exist yet (feature never used) holds no rows —
        // that is a truthful zero, not a failure.
        if (isUndefinedTableError(err)) continue;
        errors.push(`${table}: ${errorMessage(err)}`);
      }
    }
    return storeResult(STORE_DOCUMENTS, erased, errors);
  }

  /**
   * Postgres 42P01 — relation does not exist. queryInvocationLedger wraps the
   * driver error in `cause`, so both levels are checked.
   */
  function isUndefinedTableError(err: unknown): boolean {
    for (
      let current: unknown = err;
      current !== null && typeof current === "object";
      current = (current as { cause?: unknown }).cause
    ) {
      if ((current as { code?: string }).code === "42P01") return true;
    }
    return false;
  }

  // ── vs_search_stats ───────────────────────────────────────────────────────

  async function eraseStats(
    request: ErasureRequest,
    scope: AccessScope,
    dryRun: boolean,
  ): Promise<ErasureStoreResult> {
    try {
      if (request.scope === "tenant") {
        if (dryRun) {
          return storeResult(
            STORE_STATS,
            await countRows(
              `SELECT 1 FROM vs_search_stats WHERE tenant_id = $1`,
              [scope.tenantId],
            ),
            [],
          );
        }
        const result = await postgresClient.queryInvocationLedger(
          `DELETE FROM vs_search_stats WHERE tenant_id = $1`,
          [scope.tenantId],
        );
        return storeResult(STORE_STATS, result.rowCount, []);
      }
      if (request.scope === "subject") {
        // vs_search_stats has no subject column: the only attribution the
        // schema supports is the query hash of the subject's own identifiers
        // (hashed exactly like recordSearchStat does — Requirement 2.6).
        const hashes = subjectIdentifiers(request).map((id) =>
          statsQueryHash(id, statsQueryPepper),
        );
        if (hashes.length === 0) return storeResult(STORE_STATS, 0, []);
        if (dryRun) {
          return storeResult(
            STORE_STATS,
            await countRows(
              `SELECT 1 FROM vs_search_stats
                WHERE tenant_id = $1 AND query_hash = ANY($2::text[])`,
              [scope.tenantId, hashes],
            ),
            [],
          );
        }
        const result = await postgresClient.queryInvocationLedger(
          `DELETE FROM vs_search_stats
            WHERE tenant_id = $1 AND query_hash = ANY($2::text[])`,
          [scope.tenantId, hashes],
        );
        return storeResult(STORE_STATS, result.rowCount, []);
      }
      // Reference scope: stats rows carry no document reference.
      return storeResult(STORE_STATS, 0, []);
    } catch (err) {
      if (isUndefinedTableError(err)) return storeResult(STORE_STATS, 0, []);
      return {
        store: STORE_STATS,
        status: "failed",
        erased: 0,
        error: errorMessage(err),
      };
    }
  }

  // ── handler ───────────────────────────────────────────────────────────────

  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    const parsed = ErasureRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid erasure request",
        code: "ERASURE_REQUEST_INVALID",
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      });
      return;
    }
    const request = parsed.data;

    let scope: AccessScope;
    try {
      scope = accessScopeForRequest(req);
    } catch (err) {
      res.status(403).json({
        error: errorMessage(err),
        code: "TENANT_REQUIRED",
      });
      return;
    }
    // The authenticated tenant always wins; a service may only erase the
    // tenant its credential is bound to. Without a bound tenant (authorization
    // disabled) the request tenant is used as the effective scope.
    if (
      !scope.authorizationBypass &&
      scope.tenantId !== undefined &&
      scope.tenantId !== request.tenantId
    ) {
      res.status(403).json({
        error: "The erasure target tenant does not match the credential tenant",
        code: "TENANT_MISMATCH",
      });
      return;
    }
    const effectiveScope: AccessScope = scope.tenantId
      ? scope
      : { ...scope, tenantId: request.tenantId };

    const key = `erasure:${request.requestId}`;
    const fingerprint = invocationFingerprint(
      "erasure",
      request,
      request.requestId,
    );
    const claim = await ledger.claim(key, fingerprint);
    if (claim.kind === "replay") {
      res.status(200).json(claim.record.result);
      return;
    }
    if (claim.kind === "mismatch" || claim.kind === "in_flight") {
      res.status(409).json({
        error:
          claim.kind === "mismatch"
            ? "The requestId was already used with a different payload"
            : "An erasure with this requestId is already in flight",
        code:
          claim.kind === "mismatch"
            ? "IDEMPOTENCY_KEY_MISMATCH"
            : "INVOCATION_IN_FLIGHT",
      });
      return;
    }
    // claim.kind === "claimed" | "terminal" — a terminal (failed) record is
    // retried: every erasure operation is idempotent at the data level, so a
    // repeated attempt either deletes what the failed attempt missed or is a
    // no-op. The ledger transition below is best-effort for this case.
    const retryOfFailed = claim.kind === "terminal";
    if (!retryOfFailed) {
      await ledger.transition(key, fingerprint, "running");
    }

    try {
      const collections = await resolveCollections(req, effectiveScope);
      const dryRun = request.dryRun;
      // The erasable data stores; the HTTP status is derived from these. The
      // ledger placeholder below is informational and never fails the call.
      const dataResults: ErasureStoreResult[] = [];
      dataResults.push(
        request.scope === "tenant"
          ? await eraseTenant(effectiveScope, collections, dryRun)
          : request.scope === "subject"
            ? await eraseSubject(request, effectiveScope, collections, dryRun)
            : await eraseReferences(
                request,
                effectiveScope,
                collections,
                dryRun,
              ),
      );
      dataResults.push(await eraseStats(request, effectiveScope, dryRun));
      // Ledger rows are keyed by one-way hashes of (principal, execution,
      // invocation) and expire with the ledger TTL — they are not
      // subject-attributable, so the honest result is a reported zero.
      const results: ErasureStoreResult[] = [
        ...dataResults,
        { store: STORE_LEDGER, status: "ok", erased: 0 },
      ];

      const failed = dataResults.filter((r) => r.status === "failed").length;
      const response: ErasureResponse = {
        requestId: request.requestId,
        service: "search",
        results,
      };
      const status =
        failed === 0 ? 200 : failed === dataResults.length ? 502 : 207;

      emitActivity({
        id: newActivityId(),
        type: "delete",
        status: failed === 0 ? "ok" : "error",
        summary: `erasure ${request.scope}${dryRun ? " (dry-run)" : ""} ${request.requestId}`,
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        detail: { tenant: request.tenantId, results },
      });

      try {
        await ledger.transition(key, fingerprint, "committed", response);
      } catch (err) {
        if (!retryOfFailed) throw err;
        log.debug(
          { err, requestId: request.requestId },
          "erasure retry could not re-commit the failed ledger record",
        );
      }
      res.status(status).json(response);
    } catch (err) {
      if (!retryOfFailed) {
        await ledger
          .transition(key, fingerprint, "failed")
          .catch(() => undefined);
      }
      next(err);
    }
  };
}

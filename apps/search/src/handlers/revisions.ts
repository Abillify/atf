// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/revisions.ts
 *
 * The v2 revision API. Routes are mounted behind
 * the same auth / scope / tenant / collection-ACL chain as /ingest, so by the
 * time a handler runs the request already carries a verified AccessScope in
 * `res.locals.accessScope` (with a tenant) and a checked collection ACL. Each
 * handler therefore only needs the tenant + resolved collection and defers all
 * storage semantics to the RevisionStore.
 *
 *   POST   /v2/documents/{ref}/revisions                     create (Idempotency-Key,
 *                                                            optional X-Source-Id claim)
 *   PUT    /v2/documents/{ref}/revisions/{rev}/batches/{seq}  stage NDJSON batch (Content-Digest)
 *   GET    /v2/documents/{ref}/revisions/{rev}                revision state
 *   POST   /v2/documents/{ref}/revisions/{rev}/segments/{n}/commit  segment commit
 *   POST   /v2/documents/{ref}/revisions/{rev}/commit         final commit
 *   POST   /v2/documents/{ref}/revisions/{rev}/heartbeat      extend TTL
 *   DELETE /v2/documents/{ref}/revisions/{rev}                abort + cleanup
 *
 * Every route checks `X-Extract-Contract` (Requirement 3.7): an absent header
 * is accepted, a malformed one is 400, and an incompatible major is 422. Every
 * route that addresses an existing revision forwards the `{ref}` path param so
 * the store rejects a revision of a different document (409).
 */

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import {
  EXTRACT_CONTRACT_HEADER,
  EXTRACT_CONTRACT_MAJOR,
  isCompatibleContract,
  parseContractId,
} from "@atf/extract-contract";
import { rowAclForRevision, type AccessScope } from "../access-scope.js";
import type { CollectionAcl } from "../collection-access.js";
import type { RevisionScope, RevisionStore } from "../revision-store.js";
import { readHeader } from "../header-utils.js";

export interface RevisionHandlerOptions {
  /** TTL for a freshly-staged / heartbeated revision, in milliseconds. */
  revisionTtlMs: number;
  logger: Logger;
}

/** The route path params across the revision routes. */
interface RevisionParams {
  ref?: string;
  rev?: string;
  seq?: string;
  n?: string;
}

/**
 * Resolve the (tenant, collection, reference) the middleware chain established.
 * Returns null (and writes the response) when the tenant context is missing —
 * a revision is protected data and must never be created tenant-less.
 */
function resolveScope(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
): { scope: RevisionScope; reference: string } | null {
  const accessScope = (res.locals as { accessScope?: AccessScope }).accessScope;
  if (!accessScope?.tenantId) {
    res.status(403).json({ error: "Tenant context is required" });
    return null;
  }
  const collection =
    (res.locals as { resolvedCollection?: string }).resolvedCollection ??
    readHeader(req, "x-collection") ??
    "documents";
  const rawRef = (req.params as RevisionParams).ref;
  const reference = typeof rawRef === "string" ? decodeURIComponent(rawRef) : "";
  if (reference === "") {
    res.status(400).json({ error: "A document reference is required" });
    return null;
  }
  if (!checkContract(req, res)) return null;
  return { scope: { tenantId: accessScope.tenantId, collection, reference }, reference };
}

/**
 * Validate `X-Extract-Contract` against the v2 record stream these routes
 * consume (Requirement 3.7). The v1 helper in ingest-header-parser.ts gates on
 * the v1 marker grammar, so it cannot be reused here.
 *
 *   absent / empty            → accepted (the payload is validated anyway)
 *   not `name/major.minor.patch` → 400 INVALID_EXTRACT_CONTRACT
 *   other name or major ≠ 2   → 422 INCOMPATIBLE_EXTRACT_CONTRACT
 */
export function checkV2ExtractContractHeader(
  header: string | undefined,
): true | { status: 400 | 422; code: string; error: string } {
  if (header === undefined || header.trim() === "") return true;
  const value = header.trim();
  if (parseContractId(value) === null) {
    return {
      status: 400,
      code: "INVALID_EXTRACT_CONTRACT",
      error: `${EXTRACT_CONTRACT_HEADER} is not a valid contract identifier: "${value}"`,
    };
  }
  if (!isCompatibleContract(value, EXTRACT_CONTRACT_MAJOR)) {
    return {
      status: 422,
      code: "INCOMPATIBLE_EXTRACT_CONTRACT",
      error:
        `${EXTRACT_CONTRACT_HEADER} "${value}" is incompatible: the v2 revision API ` +
        `accepts atf-extract/${EXTRACT_CONTRACT_MAJOR}.x`,
    };
  }
  return true;
}

function checkContract(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
): boolean {
  const check = checkV2ExtractContractHeader(readHeader(req, EXTRACT_CONTRACT_HEADER.toLowerCase()));
  if (check === true) return true;
  res.status(check.status).json({ error: check.error, code: check.code });
  return false;
}

/** A comma-separated list header. */
function readList(req: Parameters<RequestHandler>[0], name: string): string[] {
  return (readHeader(req, name) ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/** Parse a non-negative integer route param, or null when malformed. */
function parseSeq(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function createRevisionHandlers(
  store: RevisionStore,
  options: RevisionHandlerOptions,
): {
  create: RequestHandler;
  putBatch: RequestHandler;
  getState: RequestHandler;
  commitSegment: RequestHandler;
  commit: RequestHandler;
  heartbeat: RequestHandler;
  abort: RequestHandler;
} {
  const { revisionTtlMs, logger } = options;

  return {
    // POST /v2/documents/{ref}/revisions
    create: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const { scope, reference } = resolved;
        const idempotencyKey = readHeader(req, "idempotency-key");
        const visibilityHeader = readHeader(req, "x-visibility");
        const visibility =
          visibilityHeader === "progressive" || visibilityHeader === "on_commit"
            ? visibilityHeader
            : undefined;
        const sourceId = readHeader(req, "x-source-id")?.trim();
        // The row ACL of the document's units: what the writer resolved for its
        // own caller (Extract narrows it to the uploading user), else the
        // collection ACL — see rowAclForRevision.
        const acl = rowAclForRevision(
          (res.locals as { accessScope: AccessScope }).accessScope,
          (res.locals as { collectionAcl?: CollectionAcl }).collectionAcl,
          { users: readList(req, "x-allowed-users"), groups: readList(req, "x-allowed-groups") },
        );
        const result = await store.createRevision({
          ...scope,
          reference,
          idempotencyKey,
          ...(sourceId ? { sourceId } : {}),
          acl,
          visibility,
          ttlMs: revisionTtlMs,
        });
        if (!result.ok) {
          res.status(result.error.status).json({ error: result.error.message, code: result.error.code });
          return;
        }
        // 201 for a fresh revision, 200 for an idempotent replay of the same key.
        res.status(result.result.created ? 201 : 200).json(result.result.revision);
      } catch (error) {
        next(error);
      }
    },

    // PUT /v2/documents/{ref}/revisions/{rev}/batches/{seq}
    putBatch: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const { scope } = resolved;
        const revisionId = String((req.params as RevisionParams).rev ?? "");
        const seq = parseSeq((req.params as RevisionParams).seq);
        if (seq === null) {
          res.status(400).json({ error: "Batch seq must be a non-negative integer" });
          return;
        }
        const contentDigest = readHeader(req, "content-digest");
        if (!contentDigest) {
          res.status(400).json({ error: "Content-Digest header is required" });
          return;
        }
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: "A non-empty NDJSON body is required" });
          return;
        }
        const result = await store.stageBatch({
          ...scope,
          revisionId,
          seq,
          body,
          contentDigest,
          ttlMs: revisionTtlMs,
        });
        if (!result.ok) {
          res.status(result.error.status).json({
            error: result.error.message,
            code: result.error.code,
            ...(result.error.issues ? { issues: result.error.issues } : {}),
          });
          return;
        }
        res.status(200).json(result.result);
      } catch (error) {
        next(error);
      }
    },

    // GET /v2/documents/{ref}/revisions/{rev}
    getState: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const revisionId = String((req.params as RevisionParams).rev ?? "");
        const result = await store.getRevisionState(resolved.scope, revisionId);
        if (!result.ok) {
          res.status(result.error.status).json({ error: result.error.message, code: result.error.code });
          return;
        }
        res.status(200).json(result.result);
      } catch (error) {
        next(error);
      }
    },

    // POST /v2/documents/{ref}/revisions/{rev}/segments/{n}/commit
    commitSegment: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const revisionId = String((req.params as RevisionParams).rev ?? "");
        const segment = parseSeq((req.params as RevisionParams).n);
        if (segment === null) {
          res.status(400).json({ error: "Segment number must be a non-negative integer" });
          return;
        }
        const result = await store.commitSegment({ ...resolved.scope, revisionId, segment });
        if (!result.ok) {
          res.status(result.error.status).json({
            error: result.error.message,
            code: result.error.code,
            ...(result.error.missingRanges ? { missingRanges: result.error.missingRanges } : {}),
          });
          return;
        }
        res.status(200).json(result.result);
      } catch (error) {
        next(error);
      }
    },

    // POST /v2/documents/{ref}/revisions/{rev}/commit
    commit: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const revisionId = String((req.params as RevisionParams).rev ?? "");
        const result = await store.finalCommit({ ...resolved.scope, revisionId });
        if (!result.ok) {
          res.status(result.error.status).json({
            error: result.error.message,
            code: result.error.code,
            ...(result.error.missingRanges ? { missingRanges: result.error.missingRanges } : {}),
          });
          return;
        }
        // 202: the commit is accepted and durable, but the switch waits for the
        // staged batches to be processed (`pending: true`, `isLatest: false`).
        // The old revision stays visible until then (Requirement 5.11).
        res.status(result.result.pending ? 202 : 200).json(result.result);
      } catch (error) {
        next(error);
      }
    },

    // POST /v2/documents/{ref}/revisions/{rev}/heartbeat
    heartbeat: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const revisionId = String((req.params as RevisionParams).rev ?? "");
        const result = await store.heartbeat(resolved.scope, revisionId, revisionTtlMs);
        if (!result.ok) {
          res.status(result.error.status).json({ error: result.error.message, code: result.error.code });
          return;
        }
        res.status(200).json({ status: "ok", ttlExpiresAt: result.result.ttlExpiresAt });
      } catch (error) {
        next(error);
      }
    },

    // DELETE /v2/documents/{ref}/revisions/{rev}
    abort: async (req, res, next) => {
      try {
        const resolved = resolveScope(req, res);
        if (!resolved) return;
        const revisionId = String((req.params as RevisionParams).rev ?? "");
        const result = await store.abortRevision(resolved.scope, revisionId);
        if (!result.ok) {
          res.status(result.error.status).json({ error: result.error.message, code: result.error.code });
          return;
        }
        logger.info({ revisionId }, "Revision aborted");
        res.status(200).json({ status: "aborted", revisionId });
      } catch (error) {
        next(error);
      }
    },
  };
}

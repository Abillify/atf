// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/documents.ts
 *
 * `DELETE /v2/documents/{reference}` — delete a document by reference
 * (extract-outpost E2, requirements 9.1, 9.3, 9.7–9.9).
 *
 * ## Why the active jobs are cancelled first
 *
 * A job that is still emitting would write the document into Search right
 * after the delete removed it — the delete would silently undo itself. So the
 * route cancels every non-terminal job of the same reference and collection
 * before it touches Search. The cancel runs through the same
 * `operatorTransition` the Job API uses, which bumps the lease epoch: a worker
 * mid-emit fails its next fenced write and stops.
 *
 * ## Why 404 for "nothing was deleted"
 *
 * Search answers a delete of an unknown reference with `deleted: 0`, not an
 * error. Requirement 9.9 wants a client to be able to tell "this reference was
 * never here" apart from "it was here and is gone now" — and requirement 9.3
 * wants the *Outpost* to treat both as success. So Extract reports `0` as
 * `404 NOT_FOUND` (honest about state) and the Outpost maps `200` and `404`
 * alike to "deleted", which keeps the mirror-delete loop idempotent across
 * retries.
 *
 * ## Identity forwarding
 *
 * The delete reaches Search with the service token plus the caller's asserted
 * identity (`X-User`/`X-Groups`), exactly the way the ingest path forwards the
 * caller's ACL. Search's `accessScopeForRequest` then applies the caller's ACL
 * rather than the unrestricted service scope: a caller can only delete
 * documents they could also read. A pure service caller (no asserted identity)
 * keeps the service authority it always had.
 */

import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { Logger } from "pino";
import { deleteDocumentResponseSchema } from "@atf/extract-contract/v2";
import { notFound, validationError } from "../errors.js";
import type { ExtractStore } from "../persistence/index.js";
import type { JobRow } from "../persistence/types.js";
import type { SearchClient } from "../search-client.js";
import type { HttpMetrics } from "../http-metrics.js";
import { getPrincipal, hasIdentity } from "../request-principal.js";
import { readHeader } from "../header-utils.js";
import { isTerminal } from "../jobs/state-machine.js";
import { removeDerivedPdfsFor } from "../jobs/derived-pdf-cache.js";
import { orphanedSourceDigests, removeSessionFiles } from "../jobs/job-retention.js";
import type { SourceStore } from "../source-store.js";

/** Same naming rule as `ingest-v2.ts` / Search. */
const COLLECTION_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Optimistic retries against a concurrent status change (same as jobs.ts). */
const CANCEL_RETRIES = 3;

export interface DocumentsHandlerDeps {
  store: ExtractStore;
  searchClient: SearchClient;
  logger: Logger;
  metrics: HttpMetrics;
  /** Collection used when the request omits `X-Collection`. */
  defaultCollection: string;
  /**
   * Directory of the derived-PDF cache. When set, the cached conversions of
   * every source this reference's jobs held are removed with the document
   * (they contain its full content). Omit when the cache is disabled.
   */
  derivedPdfCacheDir?: string;
  /**
   * Content-addressed source blobs. With it, a deleted document also loses the
   * source bytes no other job still uses. Omit to keep sources (job rows and
   * upload sessions are removed either way).
   */
  sourceStore?: SourceStore;
  /** Directory of resumable-upload session files (`<uploadId>.part`). */
  tmpDir?: string;
}
/**
 * Cancel one job through the operator transition (lease revoked). Returns the
 * outcome for the response log. A job that reached a terminal state between the
 * list and the transition is already harmless — it cannot emit again — so it
 * counts as cancelled.
 */
async function cancelJob(store: ExtractStore, id: string): Promise<"cancelled" | "already-terminal"> {
  for (let attempt = 0; attempt < CANCEL_RETRIES; attempt++) {
    const row = await store.getJob(id);
    if (row === null) return "already-terminal";
    if (row.status === "cancelled") return "cancelled";
    if (isTerminal(row.status)) return "already-terminal";
    const updated = await store.operatorTransition(id, {
      expectedStatus: row.status,
      status: "cancelled",
      pauseReason: null,
    });
    if (updated !== null) return "cancelled";
    // The status moved under us (a worker finished the job); re-read and retry.
  }
  // Lost the race repeatedly: the job is transitioning on its own. It is either
  // terminal now or will be cancelled by a concurrent delete; do not block the
  // document delete on it.
  return "already-terminal";
}

export function createDocumentsRouter(deps: DocumentsHandlerDeps): Router {
  const {
    store,
    searchClient,
    logger,
    metrics,
    defaultCollection,
    derivedPdfCacheDir,
    sourceStore,
    tmpDir,
  } = deps;
  const router = express.Router();

  const deleteHandler: RequestHandler = (req, res, next) => {
    void deleteDocument(req, res).catch(next);
  };

  async function deleteDocument(req: Request, res: Response): Promise<void> {
    const collection = readHeader(req, "x-collection")?.trim() || defaultCollection;
    if (!COLLECTION_NAME.test(collection)) {
      throw validationError(
        "X-Collection must start with a letter and contain only letters, digits and underscores",
      );
    }

    // Express decodes the path parameter, so a `base64:`-or-percent-encoded
    // reference arrives in its plain form. An empty reference cannot name a
    // document.
    const raw = req.params["reference"];
    const reference = typeof raw === "string" ? raw.trim() : "";
    if (reference === "") {
      throw validationError("A document reference is required");
    }

    // 1. Cancel the active jobs of this reference/collection so no in-flight
    //    emit re-creates the document after the delete (requirement 9.3).
    //    A row without a collection belongs to the instance default — the same
    //    collection this request targets when X-Collection was omitted.
    const active = await store.listActiveJobsByReference(
      reference,
      collection,
      collection === defaultCollection,
    );
    const cancelled: string[] = [];
    for (const job of active) {
      const outcome = await cancelJob(store, job.id);
      if (outcome === "cancelled") cancelled.push(job.id);
    }

    // 1b. Drop the cached PDF conversions of this document's sources: the
    //     cache holds its full content and has no other path to deletion.
    //     Best effort and independent of what Search says below — a reference
    //     Search never held can still have left a conversion behind.
    let derivedPdfsRemoved = 0;
    if (derivedPdfCacheDir !== undefined) {
      try {
        const digests = await store.sourceDigestsByReference(
          reference,
          collection,
          collection === defaultCollection,
        );
        derivedPdfsRemoved = await removeDerivedPdfsFor(
          derivedPdfCacheDir,
          digests,
        );
      } catch (err) {
        logger.warn(
          { err, reference, collection },
          "Could not remove the derived-PDF cache entries of a deleted document",
        );
      }
    }
    // 2. Delete in Search under the caller's access scope (requirement 9.7).
    const principal = getPrincipal(req);
    const identity = hasIdentity(principal)
      ? {
          ...(principal.userId !== undefined ? { userId: principal.userId } : {}),
          ...(principal.userGroups !== undefined ? { userGroups: principal.userGroups } : {}),
        }
      : undefined;
    const outcome = await searchClient.deleteByReference({
      collection,
      reference,
      ...(identity !== undefined ? { identity } : {}),
    });

    // 2b. Drop what Extract itself kept of the document: its jobs (the stage
    //     checkpoints hold the persisted model response of every page, the
    //     outboxes the emitted content), its upload sessions and the source
    //     bytes nothing else uses. It runs once Search answered — also when
    //     Search never held the reference (404 below), which can still have
    //     left all of this behind — but NOT when the Search call failed: the
    //     caller retries, and until then the cancelled jobs stay as they are.
    //     Best effort, like 1b.
    let jobsRemoved = 0;
    let sourcesRemoved = 0;
    try {
      const erased = await store.eraseJobsByReference(
        reference,
        collection,
        collection === defaultCollection,
      );
      jobsRemoved = erased.length;
      const uploadIds = await store.eraseUploadsByReferences([reference]);
      await removeSessionFiles(tmpDir, uploadIds, logger);
      if (sourceStore?.remove !== undefined) {
        for (const digest of await orphanedSourceDigests(store, erased)) {
          if ((await sourceStore.remove(digest)) === true) sourcesRemoved += 1;
        }
      }
    } catch (err) {
      logger.warn(
        { err, reference, collection },
        "Could not remove the Extract data of a deleted document",
      );
    }
    // 3. `deleted = 0` means Search never held this reference → 404 (9.9).
    if (outcome.deleted === 0) {
      throw notFound(
        `No document with reference ${reference} in collection ${collection}`,
      );
    }

    metrics.recordDocumentsDeleted(outcome.deleted);
    logger.info(
      {
        reference,
        collection,
        deleted: outcome.deleted,
        cancelledJobs: cancelled,
        derivedPdfsRemoved,
        jobsRemoved,
        sourcesRemoved,
      },
      "Document deleted via E2",
    );

    const body = deleteDocumentResponseSchema.parse({
      status: "deleted",
      reference,
      collection,
      deleted: outcome.deleted,
    });
    res.status(200).json(body);
  }

  router.delete("/:reference", deleteHandler);

  return router;
}

/** Exported for the property test: the pure "is this row still active" rule. */
export function isActiveJob(row: JobRow): boolean {
  return !isTerminal(row.status);
}

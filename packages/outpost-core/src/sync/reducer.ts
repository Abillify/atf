// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Outcome Reducer (requirements 7.6, 8.7, 8.8, 8.10, 9.2, 9.3).
 *
 * `reduce` maps the result of processing one item onto its `ItemState` —
 * a pure function the executor writes to the journal atomically per item.
 * `null` means "remove the entry" (the document is gone from the
 * collection, 9.3). Failures (`client-error`, `retries-exhausted`) mark the
 * item `failed` while keeping the last synchronized checksum and marker
 * untouched (8.10), so the next run re-processes it (8.11) and a later
 * success can still be recognised as the same version chain.
 */

import type { ItemState } from "../state/schema.js";

/** The terminal result of processing one item in one run. */
export type Outcome =
  /** `POST /v1/ingest` answered 200 with `ok` or `skipped` (7.6, 8.8). */
  | {
      kind: "ingested";
      status: "ok" | "skipped";
      sha256: string;
      marker: string;
      /** Effective ACL digest sent with this upload (undefined = no ACL). */
      aclDigest?: string;
    }
  /** `POST /v1/ingest` answered 202 — a job now processes the upload (8.7). */
  | {
      kind: "accepted";
      jobId: string;
      sha256: string;
      marker: string;
      aclDigest?: string;
    }
  /** A polled job reached a terminal status (8.7). */
  | {
      kind: "job-final";
      jobStatus: "completed" | "failed" | "cancelled";
      sha256: string;
      marker: string;
      aclDigest?: string;
    }
  /** Content unchanged, only the change marker moved (7.5). */
  | { kind: "marker-only"; marker: string; aclDigest?: string }
  /** HTTP 4xx except 401/429 — permanent failure for this item (8.10). */
  | { kind: "client-error"; status: number; message: string }
  /** The source item could not be read (vanished, permissions) (8.10). */
  | { kind: "read-error"; message: string }
  /** All retries (backoff / Retry-After) exhausted (8.9, 8.11). */
  | { kind: "retries-exhausted"; message: string }
  /** `DELETE` confirmed with 200/404 — entry leaves the Sync_State (9.3). */
  | { kind: "deleted" }
  /** Missing in source with Mirror_Delete off — marked, document stays (9.2). */
  | { kind: "missing-in-source"; mirrorDelete: false };

/** Injectable clock so `lastError.at`/`syncedAt` are deterministic in tests. */
export type NowIso = () => string;

const defaultNow: NowIso = () => new Date().toISOString();

/** A minimal state for outcomes that arrive without a previous entry. */
function baseState(prev: ItemState | undefined, reference: string): ItemState {
  return prev ?? { reference, marker: "", size: 0, status: "failed" };
}

/**
 * Apply one outcome to the item's state. `null` removes the entry.
 * The reference is carried through unchanged — switching the collection
 * never changes an item's identity (7.9).
 */
export function reduce(
  prev: ItemState | undefined,
  reference: string,
  outcome: Outcome,
  now: NowIso = defaultNow,
): ItemState | null {
  switch (outcome.kind) {
    case "ingested":
      return {
        ...baseState(prev, reference),
        reference,
        marker: outcome.marker,
        sha256: outcome.sha256,
        aclDigest: outcome.aclDigest,
        status: "synced",
        jobId: undefined,
        pendingUpload: undefined,
        lastError: undefined,
        syncedAt: now(),
      };
    case "accepted":
      return {
        ...baseState(prev, reference),
        reference,
        marker: outcome.marker,
        sha256: outcome.sha256,
        aclDigest: outcome.aclDigest,
        status: "pending-job",
        jobId: outcome.jobId,
        // The upload itself finished — a pending resumable session is done.
        pendingUpload: undefined,
        lastError: undefined,
      };
    case "job-final":
      if (outcome.jobStatus === "completed") {
        return {
          ...baseState(prev, reference),
          reference,
          marker: outcome.marker,
          sha256: outcome.sha256,
          aclDigest: outcome.aclDigest,
          status: "synced",
          jobId: undefined,
          pendingUpload: undefined,
          lastError: undefined,
          syncedAt: now(),
        };
      }
      return {
        ...baseState(prev, reference),
        reference,
        marker: outcome.marker,
        sha256: outcome.sha256,
        status: "failed",
        jobId: undefined,
        pendingUpload: undefined,
        lastError: {
          code: `JOB_${outcome.jobStatus.toUpperCase()}`,
          message: `Job endete mit Status ${outcome.jobStatus}`,
          at: now(),
        },
      };
    case "marker-only":
      return {
        ...baseState(prev, reference),
        reference,
        marker: outcome.marker,
        // The digest travels with the marker refresh so a state that was
        // "unknown" (pre-ACL) learns the current digest without a re-upload.
        aclDigest: outcome.aclDigest,
        status: prev?.status ?? "synced",
      };
    case "client-error":
      // Last synced sha256/marker stay untouched (8.10).
      return {
        ...baseState(prev, reference),
        reference,
        status: "failed",
        lastError: { code: `HTTP_${outcome.status}`, message: outcome.message, at: now() },
      };
    case "read-error":
      // Last synced sha256/marker stay untouched (8.10).
      return {
        ...baseState(prev, reference),
        reference,
        status: "failed",
        lastError: { code: "READ_ERROR", message: outcome.message, at: now() },
      };
    case "retries-exhausted":
      return {
        ...baseState(prev, reference),
        reference,
        status: "failed",
        lastError: { code: "RETRIES_EXHAUSTED", message: outcome.message, at: now() },
      };
    case "deleted":
      return null;
    case "missing-in-source":
      return {
        ...baseState(prev, reference),
        reference,
        status: "deleted-in-source",
        jobId: undefined,
        pendingUpload: undefined,
      };
  }
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Change Planner (requirements 7.3, 7.4, 7.5, 8.2, 8.5, 8.11).
 *
 * Pure two-stage decision: `planItem` compares the change marker against the
 * Sync_State (skip without download when unchanged and synced); `planAfterHash`
 * compares the freshly computed SHA-256 (update-marker only when the content
 * is identical) and picks the upload path — `direct` (`POST /v1/ingest`) at or
 * below `resumableThresholdBytes`, `resumable` (`/v2/uploads` + `POST /v2/jobs`)
 * above it. Anything larger than `maxUploadBytes` is rejected before any
 * transfer. A previous `failed` state never skips: the item is re-processed in
 * the next run (8.11).
 */

import type { ItemState } from "../state/schema.js";
import type { SourceItem } from "../sources/types.js";

/** First-stage decision: is a download/hash needed at all? */
export type PreAction =
  /** Marker matches a `synced` state — no download, no upload (7.3). */
  | { kind: "skip" }
  /** New, changed, or previously failed — compute the SHA-256 (7.4, 8.11). */
  | { kind: "hash" };

/**
 * Skip exactly when a `synced` state exists whose marker equals the current
 * marker; every other case (including `failed`) hashes (7.3, 8.11).
 */
export function planItem(item: SourceItem, prev: ItemState | undefined): PreAction {
  if (prev !== undefined && prev.status === "synced" && prev.marker === item.marker) {
    return { kind: "skip" };
  }
  return { kind: "hash" };
}

/** Size limits consulted after hashing (from config and `whoami`). */
export interface UploadLimits {
  /** Above this size the resumable path is used (8.5). */
  resumableThresholdBytes: number;
  /** Above this size the item is rejected without transfer. */
  maxUploadBytes: number;
}

/** Second-stage decision after the SHA-256 is known. */
export type PostHashAction =
  /** Content unchanged (same sha256) — only the marker moves (7.5). */
  | { kind: "update-marker" }
  /** New content; `isNewVersion` when the reference is already known (8.2). */
  | { kind: "upload"; mode: "direct" | "resumable"; isNewVersion: boolean }
  /** Larger than `maxUploadBytes` — fail without transferring. */
  | { kind: "reject-too-large" };

/**
 * Decide what to do once the content hash is known: identical content under a
 * `synced` state only refreshes the marker (7.5); oversized items are rejected;
 * otherwise upload — resumable above the threshold (8.5), and as a new version
 * whenever a state entry for the item already exists (8.2).
 */
export function planAfterHash(
  item: SourceItem,
  prev: ItemState | undefined,
  sha256: string,
  limits: UploadLimits,
): PostHashAction {
  if (prev !== undefined && prev.status === "synced" && prev.sha256 === sha256) {
    return { kind: "update-marker" };
  }
  if (item.size > limits.maxUploadBytes) {
    return { kind: "reject-too-large" };
  }
  return {
    kind: "upload",
    mode: item.size > limits.resumableThresholdBytes ? "resumable" : "direct",
    isNewVersion: prev !== undefined,
  };
}

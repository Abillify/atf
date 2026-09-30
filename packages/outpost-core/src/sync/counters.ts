// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Run counters (requirement 11.1).
 *
 * Every processed item (i.e. every item that passed the include/exclude
 * filter and reached a terminal outcome in this run) falls into EXACTLY one
 * class: `new` (first sync of the reference), `updated` (a new version of a
 * known reference), `skipped` (marker matched, no transfer), `failed`
 * (client error / retries exhausted / oversized / job failed). `deleted`
 * counts confirmed deletions from the mirror-delete phase and is NOT part of
 * the processed-item sum — those items were not processed from the listing.
 *
 * `classifyOutcome` is the single place mapping an {@link Outcome} to a
 * class, so the invariant "genau eine Klasse je Item" holds by construction
 * (Property 30).
 */

import type { Outcome } from "./reducer.js";

/** Counter bag for one Sync_Run (11.1). */
export interface RunCounters {
  /** Items synced for the first time under this reference. */
  new: number;
  /** Items uploaded as a new version of an already known reference. */
  updated: number;
  /** Items whose marker matched — no download, no upload (7.3). */
  skipped: number;
  /** Documents removed from the collection by Mirror_Delete (9.1). */
  deleted: number;
  /** Items that ended the run in `failed` state (8.10, 8.11). */
  failed: number;
}

/** A fresh, zeroed counter bag. */
export const newCounters = (): RunCounters => ({
  new: 0,
  updated: 0,
  skipped: 0,
  deleted: 0,
  failed: 0,
});

/**
 * The class an item-processing outcome belongs to. `deleted` and
 * `missing-in-source` are NOT item-processing classes here — the executor
 * counts deletions separately and a mark (Mirror_Delete off) is not a
 * processed listing item. `marker-only` is a skip: nothing was transferred.
 */
export type CounterClass = "new" | "updated" | "skipped" | "failed";

/**
 * Map a terminal outcome onto exactly one counter class. `isNewVersion`
 * comes from the planner (8.2): a previously known reference counts as
 * `updated`, a first-time sync as `new`.
 */
export function classifyOutcome(outcome: Outcome, isNewVersion: boolean): CounterClass {
  switch (outcome.kind) {
    case "ingested":
    case "accepted":
    case "job-final":
      if (outcome.kind === "job-final" && outcome.jobStatus !== "completed") {
        return "failed";
      }
      return isNewVersion ? "updated" : "new";
    case "marker-only":
      return "skipped";
    case "client-error":
    case "read-error":
    case "retries-exhausted":
      return "failed";
    case "deleted":
    case "missing-in-source":
      // Not listing-processed items — the executor counts these elsewhere.
      return "skipped";
  }
}

/** Increment the counter for one processed item. */
export function countOutcome(
  counters: RunCounters,
  outcome: Outcome,
  isNewVersion: boolean,
): void {
  counters[classifyOutcome(outcome, isNewVersion)] += 1;
}

/** Items counted in the 11.1 sum: new + updated + skipped + failed. */
export const processedTotal = (counters: RunCounters): number =>
  counters.new + counters.updated + counters.skipped + counters.failed;

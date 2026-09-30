// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Delete Planner (requirements 6.12, 9.1, 9.2, 9.4, 9.5, 9.6, 9.11).
 *
 * Pure planning step run after a listing finished: candidates are exactly the
 * `state.items` entries whose `quellId` was not seen in this run — only
 * references the Outpost itself recorded for THIS source are ever deleted
 * (9.6). An incomplete listing never deletes (9.4); Mirror_Delete off marks
 * instead of deletes (9.2, the executor applies `missing-in-source`). When
 * the candidate share exceeds `thresholdPercent` without a confirmation for
 * exactly this candidate set, the plan is `awaiting-confirmation` and the
 * executor must NOT reduce or touch the candidates' states (9.5, 9.11).
 */

import { createHash } from "node:crypto";
import type { SourceState } from "../state/schema.js";

/** What the executor should do with items missing from the source. */
export type DeletePlan =
  | {
      kind: "none";
      reason:
        | "listing-incomplete" // 9.4 — nothing may be deleted this run
        | "mirror-disabled-marked" // 9.2 — executor marks `deleted-in-source`
        | "nothing-missing";
    }
  /** Delete exactly these references (order: sorted by quellId). */
  | { kind: "delete"; references: string[] }
  /** Above threshold and unconfirmed — states stay byte-identical (9.5, 9.11). */
  | { kind: "awaiting-confirmation"; count: number; total: number };

export interface DeletePlanArgs {
  listing: "complete" | "incomplete";
  /** quellIds seen in this run, after filtering. */
  seen: ReadonlySet<string>;
  state: SourceState;
  mirrorDelete: boolean;
  thresholdPercent: number;
  /**
   * The user confirmed exactly this candidate set — the caller compares the
   * stored `candidateSetHash` against `computeCandidateSetHash` of the
   * current candidates.
   */
  confirmed: boolean;
}

/**
 * Stable hash over a candidate set: sorted quellIds joined with "\n",
 * SHA-256 hex. Stored on SOURCE level (`candidateSetHash`), never inside
 * `state.items`, so a confirmation is bound to exactly one candidate set.
 */
export function computeCandidateSetHash(quellIds: Iterable<string>): string {
  const joined = [...quellIds].sort().join("\n");
  return createHash("sha256").update(joined, "utf8").digest("hex");
}

/** The quellIds in the state that were not seen in this run (sorted). */
function missingQuellIds(state: SourceState, seen: ReadonlySet<string>): string[] {
  return Object.keys(state.items)
    .filter((quellId) => !seen.has(quellId))
    .sort();
}

/**
 * Plan the deletions for one source after a run's listing. See the module
 * doc for the rules; the function is pure and never mutates `state`.
 */
export function planDeletes(args: DeletePlanArgs): DeletePlan {
  // 9.4: an incomplete or failed listing must never delete.
  if (args.listing === "incomplete") {
    return { kind: "none", reason: "listing-incomplete" };
  }
  const missing = missingQuellIds(args.state, args.seen);
  if (missing.length === 0) {
    return { kind: "none", reason: "nothing-missing" };
  }
  // 9.2: with Mirror_Delete off the executor marks the items instead.
  if (!args.mirrorDelete) {
    return { kind: "none", reason: "mirror-disabled-marked" };
  }
  const total = Object.keys(args.state.items).length;
  // 9.5: above the threshold, deletions wait for a user confirmation bound
  // to exactly this candidate set (9.11 — states stay untouched meanwhile).
  if (total > 0 && (missing.length / total) * 100 > args.thresholdPercent && !args.confirmed) {
    return { kind: "awaiting-confirmation", count: missing.length, total };
  }
  // 9.1/9.6: delete exactly the recorded references of unseen items.
  const references = missing
    .map((quellId) => args.state.items[quellId]?.reference)
    .filter((reference): reference is string => typeof reference === "string");
  return { kind: "delete", references };
}

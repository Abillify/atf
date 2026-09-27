// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * jobs/state-machine.ts
 *
 * The job lifecycle as an explicit, testable transition table (design §9b,
 * requirements 4.1, 4.8–4.11).
 *
 * A persistent job moves through:
 *
 *   queued → preparing → processing → emitting → committing → completed
 *
 * and, from most working states, into one of the terminal or holding states:
 *
 *   failed        — a permanent, job-level failure
 *   paused(reason)— held on budget/dependency/manual; resumable
 *   cancelled     — abandoned by an operator
 *
 * Making the table explicit rather than scattering `if (status === …)` checks
 * across the worker is the point: an illegal transition (e.g. resuming a
 * completed job, or cancelling one that already failed) is rejected in one
 * place with a clear error, so the worker and the API cannot drive a job into a
 * nonsensical state. The transition function is pure and knows nothing about
 * the database — the store persists whatever this approves.
 */

import type { JobStatus, PauseReason } from "@atf/extract-contract/v2";

/** The states from which the worker actively drives progress. */
export const WORKING_STATES: readonly JobStatus[] = [
  "preparing",
  "processing",
  "emitting",
  "committing",
];

/** The states a job never leaves. */
export const TERMINAL_STATES: readonly JobStatus[] = ["completed", "failed", "cancelled"];

/** True when a job is actively being worked (holds a live lease). */
export function isWorking(status: JobStatus): boolean {
  return WORKING_STATES.includes(status);
}

/** True when a job will never transition again. */
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * The allowed transitions, keyed by the current status. Anything not listed is
 * rejected. `paused` is reachable from every working state and from `queued`
 * (an operator can pause a job before it is picked up); it resumes back to
 * `queued` so the claim loop re-plans from the first open unit.
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["preparing", "paused", "cancelled", "failed"],
  preparing: ["processing", "paused", "failed", "cancelled"],
  processing: ["emitting", "paused", "failed", "cancelled"],
  emitting: ["committing", "processing", "paused", "failed", "cancelled"],
  committing: ["completed", "paused", "failed", "cancelled"],
  // Holding and terminal states.
  paused: ["queued", "cancelled"],
  completed: [],
  failed: ["queued"], // retry-failed re-queues a failed job
  cancelled: [],
};

/** True when moving from `from` to `to` is a legal lifecycle transition. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

/** Raised when the worker or API attempts an illegal state transition. */
export class InvalidTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;
  constructor(from: JobStatus, to: JobStatus) {
    super(`Illegal job transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Validate a transition, throwing {@link InvalidTransitionError} when it is not
 * allowed. Returns the target status so callers can write
 * `const next = assertTransition(job.status, "processing")`.
 */
export function assertTransition(from: JobStatus, to: JobStatus): JobStatus {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}

/** The action an operator can take on a job, mapped to a target status. */
export type JobAction = "pause" | "resume" | "cancel";

/** Operator actions that re-open a job for another run. */
export type RequeueAction = "retry-failed" | "reparse";

/**
 * The statuses an operator may re-open with `retry-failed` or `reparse`. This
 * is deliberately separate from {@link TRANSITIONS}: `completed` stays terminal
 * for the worker (it never moves a completed job), but an operator can reopen
 * it to retry its failed units or re-apply a fixed parser. A live job must be
 * paused first, and a cancelled job stays cancelled.
 */
const REQUEUE_FROM: readonly JobStatus[] = ["completed", "failed", "paused"];

/**
 * Resolve an operator re-queue (`retry-failed`, `reparse`) against the current
 * status: `{ next: "queued" }` when allowed, `null` when the job is still
 * running or was cancelled (the API answers 409).
 */
export function resolveRequeue(
  status: JobStatus,
  _action: RequeueAction,
): { next: "queued"; pauseReason: null } | null {
  return REQUEUE_FROM.includes(status) ? { next: "queued", pauseReason: null } : null;
}

/**
 * Resolve the target status of an operator action against the current status,
 * or `null` when the action is a no-op or illegal for that status.
 *
 * - `pause` on a working or queued job → `paused`
 * - `resume` on a paused job → `queued`
 * - `cancel` on any non-terminal job → `cancelled`
 *
 * A `pause` on an already-paused job, or a `resume` on a running job, returns
 * `null` so the API can answer idempotently rather than erroring.
 */
export function resolveAction(
  status: JobStatus,
  action: JobAction,
): { next: JobStatus; pauseReason: PauseReason | null } | null {
  switch (action) {
    case "pause":
      if (status === "paused" || isTerminal(status)) return null;
      if (!canTransition(status, "paused")) return null;
      return { next: "paused", pauseReason: "manual" };
    case "resume":
      if (status !== "paused") return null;
      return { next: "queued", pauseReason: null };
    case "cancel":
      if (isTerminal(status)) return null;
      if (!canTransition(status, "cancelled")) return null;
      return { next: "cancelled", pauseReason: null };
  }
}

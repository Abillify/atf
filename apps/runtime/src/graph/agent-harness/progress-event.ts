// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { HarnessProgress as HarnessRunProgress } from "./types.js";

/**
 * Loop phase the harness is in when a progress event is emitted. Planning
 * covers everything before the first task batch (planner call, coverage
 * seeding, task-list rendering); research is the task-execution loop;
 * verification is the completion gate; synthesis is the final wrap-up.
 */
export type HarnessProgressPhase =
  | "planning"
  | "research"
  | "verification"
  | "synthesis";

/** Coarse coverage counters shipped with a progress event. */
export interface HarnessProgressCoverage {
  /** Documents settled beyond doubt (reviewed or excluded). */
  covered: number;
  /** Documents the queue promised overall. */
  total: number;
  /** Documents still owed (`total - covered`). */
  open: number;
}

/**
 * Structured progress event of the agent harness. Complements the free-text
 * status lines on the reasoning channel: streaming chat transports it as the
 * SSE event `atf.progress` (OpenAI clients ignore unknown event names), and
 * the debug trace stores the last value seen per node.
 */
export interface HarnessProgress {
  /** Loop phase at emit time. */
  phase: HarnessProgressPhase;
  /** Tasks in a terminal state (`completed` or `failed`). */
  tasksDone: number;
  /** All tasks known to the harness (plan + re-plans). */
  tasksTotal: number;
  /** Deterministic coverage counters, present only when coverage is configured. */
  coverage?: HarnessProgressCoverage;
  /** Wall-clock time since the harness started. */
  elapsedMs: number;
  /**
   * Linear extrapolation of the remaining wall-clock time; only meaningful
   * once at least two tasks are done (a single sample cannot estimate a rate).
   */
  etaMs?: number;
  /** The free-text status line that triggered this event, unchanged. */
  message?: string;
}

/**
 * Builds a structured progress event from the harness run record.
 *
 * `tasksDone` counts tasks in a terminal state (`completed` or `failed`);
 * `tasksTotal` counts all tasks. `etaMs` is `(elapsedMs / tasksDone) *
 * (tasksTotal - tasksDone)` and is only set when `tasksDone >= 2`.
 */
export function buildHarnessProgress(
  progress: HarnessRunProgress,
  phase: HarnessProgressPhase,
  startTime: number,
  coverage?: HarnessProgressCoverage,
  message?: string,
): HarnessProgress {
  const tasksTotal = progress.tasks.length;
  const tasksDone = progress.tasks.filter(
    (t) => t.status === "completed" || t.status === "failed",
  ).length;
  const elapsedMs = Math.max(0, Date.now() - startTime);
  return {
    phase,
    tasksDone,
    tasksTotal,
    ...(coverage !== undefined ? { coverage } : {}),
    elapsedMs,
    ...(tasksDone >= 2
      ? { etaMs: (elapsedMs / tasksDone) * (tasksTotal - tasksDone) }
      : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

/**
 * Serialises a progress event as the SSE frame `event: atf.progress` +
 * `data: <JSON>`. Kept here so the streaming route and the tests agree on
 * the exact wire format.
 */
export function harnessProgressSseFrame(progress: HarnessProgress): string {
  return `event: atf.progress\ndata: ${JSON.stringify(progress)}\n\n`;
}

/**
 * Whether a streaming client asked for `atf.progress` events. Off by default:
 * OpenAI SDKs hand every `data:` frame to the caller as a completion chunk,
 * and a frame without `choices` breaks typical client code. A client opts in
 * with the header `X-ATF-Progress: 1` (or `true`) or with
 * `metadata.atf_progress: true` (or `"true"`).
 */
export function harnessProgressRequested(
  header: string | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  const h = header?.trim().toLowerCase();
  if (h === "1" || h === "true") return true;
  const m = metadata?.atf_progress;
  return m === true || m === "true";
}
/** Delivers a progress event to whoever is transporting it out of the run. */
export type HarnessProgressSink = (progress: HarnessProgress) => void;

/**
 * Side channel from the harness loop to the transport that owns the HTTP
 * response. The `ExecRuntime` is assembled long before the streaming route
 * knows a run is happening, so the route registers a sink for its execution
 * id and the loop looks it up via `ctx.executionId`. Entries are removed when
 * the response finishes, so the map cannot outlive a request.
 */
const progressSinks = new Map<string, Set<HarnessProgressSink>>();

/** Registers `sink` for `executionId`; the returned function unregisters it. */
export function registerHarnessProgressSink(
  executionId: string,
  sink: HarnessProgressSink,
): () => void {
  let sinks = progressSinks.get(executionId);
  if (sinks === undefined) {
    sinks = new Set<HarnessProgressSink>();
    progressSinks.set(executionId, sinks);
  }
  sinks.add(sink);
  return () => {
    const current = progressSinks.get(executionId);
    if (current === undefined) return;
    current.delete(sink);
    if (current.size === 0) progressSinks.delete(executionId);
  };
}

/** Fans a progress event out to every sink registered for `executionId`. */
export function emitHarnessProgress(
  executionId: string,
  progress: HarnessProgress,
): void {
  const sinks = progressSinks.get(executionId);
  if (sinks === undefined || sinks.size === 0) return;
  for (const sink of [...sinks]) {
    try {
      sink(progress);
    } catch {
      // A dead transport must never break the research loop.
    }
  }
}

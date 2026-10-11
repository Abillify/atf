// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Scheduler: serialization of the sync runs per source (requirements 1.3,
 * 1.4, 3.5, 3.8, 3.9, 6.17).
 *
 * State machine per source: `idle -> running -> idle` with a `pending` flag
 * (triggers during a run coalesce into exactly one follow-up run).
 * Additional states: `stopped` (after {@link Scheduler.stopAll}; triggers
 * are discarded), `paused` (Extract reauth required, 4.4) and the display
 * states derived from the last run: `needs-authorization`,
 * `awaiting-confirmation` and `error`.
 *
 * Logout sequence (3.5, 3.8, design.md): {@link performLogout} first stops
 * all sources (including abort without a grace period and waiting for
 * running transfers), flushes every Sync_State and ONLY THEN deletes the
 * Extract credentials; pendingUpload entries are kept (8.6).
 */

import type { Logger } from "pino";
import type { OutpostConfig, SourceConfig } from "../config/schema.js";
import type { RunReport } from "../sync/run.js";
import type { TokenProvider } from "../auth/manager.js";
import { newCounters, type RunCounters } from "../sync/counters.js";

/** Display status of a source for health/tray (Requirement 11.3). */
export type SourceStatus =
  | "idle"
  | "running"
  | "paused"
  | "needs-authorization"
  | "awaiting-confirmation"
  | "error"
  | "stopped";

/** Summary of the last completed run. */
export interface LastRunInfo {
  /** ISO time of the run's end. */
  finishedAt: string;
  /** Result of the run. */
  result: RunReport["outcome"];
  /** Counters of the run. */
  counters: RunCounters;
}

/** Status view of a source (health API, Task 20.3). */
export interface SourceStatusView {
  sourceId: string;
  status: SourceStatus;
  /** A trigger is waiting for the next run. */
  pending: boolean;
  lastRun?: LastRunInfo;
}

interface SourceEntry {
  readonly src: SourceConfig;
  status: SourceStatus;
  pending: boolean;
  stopped: boolean;
  controller?: AbortController;
  runPromise?: Promise<void>;
  interval?: ReturnType<typeof setInterval>;
  lastRun?: LastRunInfo;
}

export interface SchedulerOptions {
  cfg: OutpostConfig;
  logger: Logger;
  /** Runs exactly one sync run for a source (runSourceOnce). */
  runSource: (src: SourceConfig, signal: AbortSignal) => Promise<RunReport>;
  /** Flushes a source's Sync_State (before token deletion, 3.5). */
  flushSource: (sourceId: string) => Promise<void>;
}

export class Scheduler {
  private readonly opts: SchedulerOptions;
  private readonly entries = new Map<string, SourceEntry>();
  /** true while all sources are paused for Extract reauth (4.4). */
  private reauthPaused = false;
  /** true after beginShutdown(): no new runs any more (10.7). */
  private shutdownRequested = false;
  /** Manual pause (10.6): triggers only set pending, running runs finish. */
  private paused = false;

  constructor(options: SchedulerOptions) {
    this.opts = options;
    for (const src of options.cfg.sources) {
      this.entries.set(src.id, {
        src,
        status: "idle",
        pending: false,
        stopped: false,
      });
    }
  }

  /** Starts all sources: immediate run, then the interval (1.3).
   *  Also lifts `stopped` after a new login (3.8). */
  start(): void {
    const intervalMs = this.opts.cfg.syncIntervalSec * 1000;
    for (const entry of this.entries.values()) {
      if (entry.stopped) {
        entry.stopped = false;
        if (entry.status === "stopped") entry.status = "idle";
      }
      if (entry.interval === undefined && intervalMs > 0) {
        entry.interval = setInterval(() => {
          this.trigger(entry.src.id);
        }, intervalMs);
        // The timer must not keep a process from exiting (CLI once).
        entry.interval.unref?.();
      }
      this.trigger(entry.src.id);
    }
  }

  /**
   * Triggers a run for a source. If one is already running, `pending` is
   * set (exactly one follow-up run, 1.4). Stopped sources ignore
   * triggers (3.8); sources in the state
   * `needs-authorization` still start runs (6.17).
   */
  trigger(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (entry === undefined || entry.stopped) return;
    if (this.shutdownRequested) return;
    if (this.reauthPaused || this.paused) {
      entry.pending = true;
      return;
    }
    if (entry.runPromise !== undefined) {
      entry.pending = true;
      return;
    }
    this.startRun(entry);
  }

  /**
   * Credential change of a source (6.17): starts the next run
   * immediately without waiting for the interval.
   */
  credentialChanged(sourceId: string): void {
    this.trigger(sourceId);
  }

  /**
   * Extract reauth required (4.4): aborts running runs, pauses
   * all sources until {@link resume}. Pending triggers are kept.
   */
  onReauthRequired(): void {
    this.reauthPaused = true;
    for (const entry of this.entries.values()) {
      entry.controller?.abort("reauth");
    }
    this.opts.logger.warn(
      { event: "scheduler.reauth_paused" },
      "alle Sync-Laeufe pausiert: Re-Authentifizierung erforderlich",
    );
  }

  /**
   * Manual pause (10.6): no new runs start, running runs finish. Triggers
   * during the pause become exactly one follow-up run.
   */
  pauseAll(): void {
    this.paused = true;
    this.opts.logger.info({ event: "scheduler.paused" }, "Sync-Laeufe pausiert");
  }

  /** Ends the manual pause; pending triggers start immediately (10.6). */
  resumeAll(): void {
    if (!this.paused) return;
    this.paused = false;
    this.opts.logger.info({ event: "scheduler.resumed" }, "Sync-Laeufe fortgesetzt");
    for (const entry of this.entries.values()) {
      if (entry.stopped || this.reauthPaused) continue;
      if (entry.pending && entry.runPromise === undefined) {
        entry.pending = false;
        this.startRun(entry);
      }
    }
  }

  /** true when manually paused (10.6). */
  isPaused(): boolean {
    return this.paused;
  }

  /** Lifts all pauses after a successful re-login; pending -> run. */
  resume(): void {
    this.reauthPaused = false;
    for (const entry of this.entries.values()) {
      if (entry.stopped || this.paused) continue;
      if (entry.status === "paused") entry.status = "idle";
      if (entry.pending && entry.runPromise === undefined) {
        entry.pending = false;
        this.startRun(entry);
      }
    }
  }

  /**
   * Stops all sources (3.8): stopped status, discard pending, clear
   * intervals, abort running runs without a grace period, wait for all runs
   * and flush every Sync_State. When this call returns all stores are
   * persisted, so token deletion may begin (3.5).
   */
  async stopAll(reason: string): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.stopped = true;
      entry.pending = false;
      if (entry.interval !== undefined) {
        clearInterval(entry.interval);
        entry.interval = undefined;
      }
      entry.controller?.abort(reason);
      if (entry.runPromise !== undefined) waits.push(entry.runPromise);
    }
    await Promise.allSettled(waits);
    for (const entry of this.entries.values()) {
      entry.status = "stopped";
      await this.opts.flushSource(entry.src.id);
    }
    this.opts.logger.info(
      { event: "scheduler.stopped", reason },
      "alle Sync-Laeufe gestoppt, Sync_State geflusht",
    );
  }

  /** Status view of all sources (health/tray, 11.3). */
  status(): SourceStatusView[] {
    return [...this.entries.values()].map((entry) => ({
      sourceId: entry.src.id,
      status:
        this.paused && entry.status === "idle" ? "paused" : entry.status,
      pending: entry.pending,
      ...(entry.lastRun !== undefined ? { lastRun: entry.lastRun } : {}),
    }));
  }

  /** true when the scheduler is stopped (first stopped source). */
  isStopped(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.stopped) return true;
    }
    return false;
  }

  /**
   * Graceful shutdown (10.7): stop intervals and start no new runs, but do
   * NOT abort running transfers; they may finish. {@link stopAll} aborts
   * after the grace period.
   */
  beginShutdown(): void {
    this.shutdownRequested = true;
    for (const entry of this.entries.values()) {
      if (entry.interval !== undefined) {
        clearInterval(entry.interval);
        entry.interval = undefined;
      }
    }
  }

  /** true when at least one run is active (graceful-shutdown wait). */
  hasActiveRun(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.runPromise !== undefined) return true;
    }
    return false;
  }

  /** Waits until no run is active (or all are stopped). */
  async awaitIdle(): Promise<void> {
    for (;;) {
      const waits = [...this.entries.values()]
        .map((e) => e.runPromise)
        .filter((p): p is Promise<void> => p !== undefined);
      if (waits.length === 0) return;
      await Promise.allSettled(waits);
    }
  }

  private startRun(entry: SourceEntry): void {
    entry.status = "running";
    const controller = new AbortController();
    entry.controller = controller;
    // Set the gate immediately: triggers that arrive synchronously in runSource
    // (before its first await) see a running run and set pending.
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    entry.runPromise = gate;
    void (async () => {
      let report: RunReport | undefined;
      let failed = false;
      try {
        report = await this.opts.runSource(entry.src, controller.signal);
      } catch {
        failed = true;
      }
      entry.runPromise = undefined;
      entry.controller = undefined;
      if (entry.stopped) {
        settle();
        return;
      }
      if (report !== undefined) {
        entry.lastRun = {
          finishedAt: new Date().toISOString(),
          result: report.outcome,
          counters: report.counters,
        };
      }
      if (this.reauthPaused || this.paused) {
        if (this.reauthPaused) entry.status = "paused";
        settle();
        return; // resume()/resumeAll() starts the next run
      }
      if (failed) {
        entry.status = "error";
      } else if (report !== undefined) {
        entry.status = statusFromReport(report);
      } else {
        entry.status = "idle";
      }
      if (entry.pending) {
        entry.pending = false;
        this.startRun(entry);
      }
    })();
  }
}

function statusFromReport(report: RunReport): SourceStatus {
  switch (report.outcome) {
    case "needs-authorization":
      return "needs-authorization";
    case "reauth-required":
      return "paused";
    case "incomplete":
      return "error";
    case "ok":
      return report.deletePhase === "awaiting-confirmation"
        ? "awaiting-confirmation"
        : "idle";
  }
}

/**
 * Logout sequence in a fixed order (3.5, 3.8, design.md):
 * 1. stop all runs, wait for transfers, flush the Sync_State
 * 2. ONLY THEN delete the Extract credentials
 * Cloud source keys (`source:*`) are kept (3.9).
 */
export async function performLogout(
  scheduler: Scheduler,
  tokenProvider: TokenProvider,
): Promise<void> {
  await scheduler.stopAll("logout");
  await tokenProvider.logout();
}

/** Empty counter helper for status displays without a last run. */
export function emptyCounters(): RunCounters {
  return newCounters();
}

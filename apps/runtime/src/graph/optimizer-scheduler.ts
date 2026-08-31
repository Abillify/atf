// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Optimizer scheduler (`src/graph/optimizer-scheduler.ts`)
 *
 * Turns the (manually-triggered) self-optimizing loop into a fully autonomous
 * one: on a fixed interval it checks each configured flow and, when the guards
 * pass, starts an optimization run in the background — mine production
 * snapshots → generate prompt variants → evaluate → (optionally) auto-promote.
 *
 * Guardrails keep it from thrashing or optimizing on thin data:
 *   - **min-new-samples**: a flow is only optimized when at least
 *     `minNewSamples` production snapshots exist for it (a coarse "enough
 *     traffic" gate; the optimizer itself also enforces its own `minSamples`).
 *   - **cooldown**: after a run is started for a flow, that flow is skipped
 *     until `cooldownMs` has elapsed, so a slow eval loop or a burst of traffic
 *     cannot queue back-to-back runs.
 *   - **single-flight**: a flow with a run still in progress is skipped.
 *
 * All dependencies are injected (optimizer, snapshot counter, clock), so the
 * tick logic is fully unit-testable without timers or a real eval loop.
 *
 * No `any` at module boundaries.
 */

import type { FlowOptimizer, OptimizerConfig } from "./flow-optimizer.js";
import type { Logger } from "../observability/logger.js";
import type { AuditLog } from "../observability/audit-log.js";

/** Monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

/**
 * Counts how many production snapshots currently exist for a flow. Injected so
 * the scheduler does not depend on a concrete ReplayStore shape and stays
 * testable (the wiring passes a counter backed by `replayStore.list`).
 */
export type SnapshotCounter = (flowId: string) => Promise<number>;

export interface OptimizerScheduleConfig {
  /** Flows to optimize on the schedule. */
  flows: string[];
  /** Tick interval in ms (how often the scheduler evaluates the guards). */
  intervalMs: number;
  /** A flow is only optimized when it has at least this many snapshots. Default 50. */
  minNewSamples: number;
  /** Minimum time between runs for the SAME flow (ms). Default = intervalMs. */
  cooldownMs: number;
  /** Auto-promote the winning variant of scheduled runs. Default true. */
  autoPromote: boolean;
  /** Variants to generate per scheduled run. Default 3. */
  variantCount: number;
  /** Minimum score improvement for auto-promotion. Default 0.05. */
  minScoreImprovement: number;
  /** Optional optimization goal passed to the generator. */
  optimizationGoal?: string;
}

export interface OptimizerSchedulerDeps {
  optimizer: FlowOptimizer;
  countSnapshots: SnapshotCounter;
  logger?: Logger;
  auditLog?: AuditLog;
  clock?: Clock;
}

export interface FlowScheduleState {
  flowId: string;
  /** Last time (ms) a run was started for this flow (0 = never). */
  lastRunAt: number;
  /** Id of the run currently in progress for this flow, if any. */
  activeRunId?: string;
}

/** Why a flow was skipped on a tick (for logging/diagnostics). */
export type SkipReason = "cooldown" | "in-progress" | "insufficient-samples";

export interface TickResult {
  started: Array<{ flowId: string; runId: string }>;
  skipped: Array<{ flowId: string; reason: SkipReason }>;
}

/**
 * Autonomous scheduler over a {@link FlowOptimizer}. Construct with a config +
 * deps, then {@link start} on a timer; {@link tick} runs one evaluation pass
 * (exposed for tests + a manual "run now").
 */
export class OptimizerScheduler {
  private readonly cfg: OptimizerScheduleConfig;
  private readonly optimizer: FlowOptimizer;
  private readonly countSnapshots: SnapshotCounter;
  private readonly logger: Logger | undefined;
  private readonly auditLog: AuditLog | undefined;
  private readonly clock: Clock;
  private readonly state = new Map<string, FlowScheduleState>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Guards against overlapping ticks when a tick outlasts the interval. */
  private ticking = false;

  constructor(cfg: OptimizerScheduleConfig, deps: OptimizerSchedulerDeps) {
    this.cfg = cfg;
    this.optimizer = deps.optimizer;
    this.countSnapshots = deps.countSnapshots;
    this.logger = deps.logger;
    this.auditLog = deps.auditLog;
    this.clock = deps.clock ?? Date.now;
    for (const flowId of cfg.flows) {
      this.state.set(flowId, { flowId, lastRunAt: 0 });
    }
  }

  /** True when at least one flow is configured and the interval is positive. */
  get active(): boolean {
    return this.cfg.flows.length > 0 && this.cfg.intervalMs > 0;
  }

  /**
   * Evaluates every configured flow once and starts a run for those that pass
   * all guards. Returns what was started/skipped. Never throws — a per-flow
   * failure is logged and does not abort the others.
   */
  async tick(): Promise<TickResult> {
    const result: TickResult = { started: [], skipped: [] };
    const now = this.clock();

    for (const flowId of this.cfg.flows) {
      const st = this.state.get(flowId) ?? { flowId, lastRunAt: 0 };

      // Single-flight: skip if the previous run for this flow is still running.
      if (st.activeRunId !== undefined) {
        const prev = this.optimizer.getRun(st.activeRunId);
        const terminal =
          prev === undefined ||
          prev.status === "done" ||
          prev.status === "error" ||
          prev.status === "skipped";
        if (!terminal) {
          result.skipped.push({ flowId, reason: "in-progress" });
          continue;
        }
        // Previous run finished — clear the marker.
        st.activeRunId = undefined;
      }

      // Cooldown: don't re-run the same flow too soon.
      if (st.lastRunAt > 0 && now - st.lastRunAt < this.cfg.cooldownMs) {
        result.skipped.push({ flowId, reason: "cooldown" });
        this.state.set(flowId, st);
        continue;
      }

      // Min-samples guard: only optimize a flow with enough production data.
      let sampleCount = 0;
      try {
        sampleCount = await this.countSnapshots(flowId);
      } catch (err) {
        this.logger?.warn("Optimizer scheduler: snapshot count failed", {
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
        result.skipped.push({ flowId, reason: "insufficient-samples" });
        this.state.set(flowId, st);
        continue;
      }
      if (sampleCount < this.cfg.minNewSamples) {
        result.skipped.push({ flowId, reason: "insufficient-samples" });
        this.state.set(flowId, st);
        continue;
      }

      // All guards passed — start a background run.
      const runConfig: OptimizerConfig = {
        flowId,
        variantCount: this.cfg.variantCount,
        autoPromote: this.cfg.autoPromote,
        minScoreImprovement: this.cfg.minScoreImprovement,
        ...(this.cfg.optimizationGoal !== undefined
          ? { optimizationGoal: this.cfg.optimizationGoal }
          : {}),
      };
      try {
        const run = this.optimizer.start(runConfig);
        st.lastRunAt = now;
        st.activeRunId = run.id;
        this.state.set(flowId, st);
        result.started.push({ flowId, runId: run.id });
        this.logger?.info("Optimizer scheduler: run started", {
          flowId,
          runId: run.id,
          sampleCount,
          autoPromote: this.cfg.autoPromote,
        });
        this.auditLog?.record({
          actor: "optimizer-scheduler",
          role: "operator",
          action: "optimizer.schedule.run",
          target: flowId,
          details: {
            runId: run.id,
            sampleCount,
            autoPromote: this.cfg.autoPromote,
          },
        });
      } catch (err) {
        this.logger?.warn("Optimizer scheduler: failed to start run", {
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.state.set(flowId, st);
      }
    }

    return result;
  }

  /**
   * Starts the periodic scheduler. The first tick runs after one interval (not
   * immediately), matching the retention sweep. No-op when inactive. Returns
   * true when a timer was started.
   */
  start(): boolean {
    if (this.timer !== undefined) return true;
    if (!this.active) return false;
    this.timer = setInterval(() => {
      if (this.ticking) return; // don't overlap a slow tick
      this.ticking = true;
      void this.tick()
        .catch((err) => {
          this.logger?.warn("Optimizer scheduler tick failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.ticking = false;
        });
    }, this.cfg.intervalMs);
    // Don't keep the event loop alive solely for the scheduler.
    (this.timer as unknown as { unref?: () => void }).unref?.();
    this.logger?.info("Optimizer scheduler started", {
      flows: this.cfg.flows,
      intervalMs: this.cfg.intervalMs,
      minNewSamples: this.cfg.minNewSamples,
      cooldownMs: this.cfg.cooldownMs,
      autoPromote: this.cfg.autoPromote,
    });
    return true;
  }

  /** Stops the periodic scheduler, if running. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Per-flow schedule state (for diagnostics / a status endpoint). */
  status(): FlowScheduleState[] {
    return [...this.state.values()].map((s) => ({ ...s }));
  }
}

/** Builds an {@link OptimizerScheduler}. */
export function createOptimizerScheduler(
  cfg: OptimizerScheduleConfig,
  deps: OptimizerSchedulerDeps,
): OptimizerScheduler {
  return new OptimizerScheduler(cfg, deps);
}

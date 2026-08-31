// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Red-Team Scheduler (`src/security/red-team-scheduler.ts`)
 *
 * Runs the red-team engine on a configurable interval against a set of target
 * flows. Decoupled from the engine itself so the engine stays pure and
 * unit-testable without timers.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import type { RedTeamEngine, RedTeamExecutor } from "./red-team-engine.js";
import type { InputGuardrail } from "../graph/input-guardrails.js";

export interface RedTeamSchedulerOptions {
  /** Target flow IDs to probe on each tick. */
  flowIds: string[];
  /** Interval between scheduled runs in milliseconds. Default: 6 hours. */
  intervalMs?: number;
  /** Executor that drives the real graph engine. */
  executor: RedTeamExecutor;
  /** Optional guardrail reference for auto-tuning. */
  guardrail?: InputGuardrail;
  logger?: Logger;
}

export interface RedTeamScheduler {
  /** Start the periodic timer. No-op if already running. */
  start(): void;
  /** Stop the timer and clear it. */
  stop(): void;
  /** True when the timer is active. */
  readonly running: boolean;
}

class RedTeamSchedulerImpl implements RedTeamScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private _running = false;
  private readonly engine: RedTeamEngine;
  private readonly opts: Required<
    Pick<RedTeamSchedulerOptions, "flowIds" | "intervalMs">
  > &
    Pick<RedTeamSchedulerOptions, "executor" | "guardrail" | "logger">;

  constructor(engine: RedTeamEngine, opts: RedTeamSchedulerOptions) {
    this.engine = engine;
    this.opts = {
      flowIds: opts.flowIds,
      intervalMs: opts.intervalMs ?? 6 * 60 * 60_000,
      executor: opts.executor,
      guardrail: opts.guardrail,
      logger: opts.logger,
    };
  }

  get running(): boolean {
    return this._running;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.opts.logger?.info("[RedTeamScheduler] Starting", {
      flows: this.opts.flowIds,
      intervalMs: this.opts.intervalMs,
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this._running) return;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this._running = false;
    this.opts.logger?.info("[RedTeamScheduler] Stopped");
  }

  private async tick(): Promise<void> {
    for (const flowId of this.opts.flowIds) {
      try {
        await this.engine.run(flowId, this.opts.executor, {
          triggeredBy: "schedule",
          guardrail: this.opts.guardrail,
        });
      } catch (err) {
        this.opts.logger?.error("[RedTeamScheduler] Scheduled run failed", {
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export function createRedTeamScheduler(
  engine: RedTeamEngine,
  opts: RedTeamSchedulerOptions,
): RedTeamScheduler {
  return new RedTeamSchedulerImpl(engine, opts);
}

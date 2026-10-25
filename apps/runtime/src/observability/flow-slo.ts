// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow service objectives (flow `slo` block): a process-local ring buffer per
 * flow id plus the evaluation that turns it into breach reporting.
 *
 * After every execution the engine offers the sample (latency, total tokens,
 * errored) here. Once at least {@link SLO_MIN_SAMPLES} executions are in the
 * window, the declared objectives are recomputed. A transition from ok to
 * breached for one objective raises `aiperator_flow_slo_breach_total`
 * (`{flow_id, objective}`) by one and logs a warning; the transition back logs
 * at info level. Nothing here ever interferes with an execution — recording is
 * synchronous, in-memory and total-failure-free by construction.
 *
 * The buffer is per process: multiple replicas each evaluate their own last
 * `window` executions and count breaches separately (documented behaviour).
 */

import type { FlowServiceObjectives } from "../types/flow.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

/** Executions that must be in the window before objectives are evaluated. */
export const SLO_MIN_SAMPLES = 10;

/** Default ring-buffer size when a flow does not set `slo.window`. */
export const SLO_DEFAULT_WINDOW = 50;

/** Metric name incremented once per ok → breached transition. */
export const FLOW_SLO_BREACH_COUNTER = "aiperator_flow_slo_breach_total";

/** The four objectives a flow can declare; also the `objective` label value. */
export type SloObjective =
  | "p50LatencyMs"
  | "p95LatencyMs"
  | "maxTokensP50"
  | "maxErrorRate";

/** One finished execution offered to the evaluator. */
export interface SloSample {
  /** End-to-end wall-clock duration of the execution in ms. */
  latencyMs: number;
  /** Total tokens (prompt + completion) of the execution. */
  totalTokens: number;
  /** True when the execution ended in an error (incl. timeout aborts). */
  errored: boolean;
}

/** Current evaluation state of one flow, as surfaced by `GET /monitoring/flow-health`. */
export interface FlowSloStatus {
  /** Executions currently in the window (≤ the declared window). */
  samples: number;
  /** Objectives currently breached — empty once evaluated means all met. */
  breached: SloObjective[];
}

export interface FlowSloEvaluatorDeps {
  metrics: Pick<Metrics, "recordCounter">;
  logger?: Logger;
}

interface FlowSloState {
  /** Declared window the state was created for — a changed window resets it. */
  window: number;
  latencies: number[];
  tokens: number[];
  errored: boolean[];
  /** Next write position in the ring buffers. */
  index: number;
  /** Number of valid entries (rings up to `window`). */
  count: number;
  /** Objectives breached after the previous evaluation. */
  breached: Set<SloObjective>;
}

/**
 * Median of the given values. For an even count the average of the two middle
 * values — the same convention as `percentile50` in `eval/flow-release.ts`, so
 * a flow's `slo.p50LatencyMs` means the same thing here as in `flows release`.
 */
export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("median requires at least one value");
  }
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor((sorted.length - 1) / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid] as number) + (sorted[mid + 1] as number)) / 2;
}

/**
 * Percentile by nearest-rank: the smallest value whose rank is at least `p`
 * percent of the sample — the same convention as `percentile` in
 * `eval/flow-release.ts`.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    throw new Error(`percentile(${p}) requires at least one value`);
  }
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

/** The objectives a declaration actually sets (window is not an objective). */
export function sloObjectives(
  slo: FlowServiceObjectives,
): SloObjective[] {
  const out: SloObjective[] = [];
  if (slo.p50LatencyMs !== undefined) out.push("p50LatencyMs");
  if (slo.p95LatencyMs !== undefined) out.push("p95LatencyMs");
  if (slo.maxTokensP50 !== undefined) out.push("maxTokensP50");
  if (slo.maxErrorRate !== undefined) out.push("maxErrorRate");
  return out;
}

/**
 * Ring-buffer evaluator: one buffer per flow id, recomputed after every
 * execution once {@link SLO_MIN_SAMPLES} samples are available. See the module
 * doc comment for the reporting semantics.
 */
export class FlowSloEvaluator {
  private readonly states = new Map<string, FlowSloState>();

  constructor(private readonly deps: FlowSloEvaluatorDeps) {}

  /**
   * Offers one finished execution to the evaluator. A flow without `slo` is
   * ignored entirely (and any state left over from a removed declaration is
   * dropped). Never throws: a broken sample must not affect the execution.
   */
  recordExecution(
    flowId: string,
    slo: FlowServiceObjectives | undefined,
    sample: SloSample,
  ): void {
    if (slo === undefined) {
      this.states.delete(flowId);
      return;
    }
    const window = slo.window ?? SLO_DEFAULT_WINDOW;
    let state = this.states.get(flowId);
    if (state === undefined || state.window !== window) {
      // New flow or the declaration changed its window: start from scratch so
      // percentiles are never computed over a mixed-definition window.
      state = {
        window,
        latencies: new Array<number>(window),
        tokens: new Array<number>(window),
        errored: new Array<boolean>(window),
        index: 0,
        count: 0,
        breached: new Set<SloObjective>(),
      };
      this.states.set(flowId, state);
    }
    state.latencies[state.index] = sample.latencyMs;
    state.tokens[state.index] = sample.totalTokens;
    state.errored[state.index] = sample.errored;
    state.index = (state.index + 1) % window;
    state.count = Math.min(state.count + 1, window);

    if (state.count < SLO_MIN_SAMPLES) return;
    this.evaluate(flowId, slo, state);
  }

  /** Current evaluation state for one flow, or undefined when never seen. */
  status(flowId: string): FlowSloStatus | undefined {
    const state = this.states.get(flowId);
    if (state === undefined) return undefined;
    return {
      samples: state.count,
      breached: [...state.breached].sort(),
    };
  }

  /** Every flow the evaluator has state for (tests, diagnostics). */
  trackedFlows(): string[] {
    return [...this.states.keys()].sort();
  }

  private evaluate(
    flowId: string,
    slo: FlowServiceObjectives,
    state: FlowSloState,
  ): void {
    const latencies = state.latencies.slice(0, state.count);
    const tokens = state.tokens.slice(0, state.count);
    let errorCount = 0;
    for (let i = 0; i < state.count; i++) {
      if (state.errored[i] === true) errorCount++;
    }
    const observed: Record<SloObjective, number> = {
      p50LatencyMs: median(latencies),
      p95LatencyMs: percentile(latencies, 95),
      maxTokensP50: median(tokens),
      maxErrorRate: errorCount / state.count,
    };
    for (const objective of sloObjectives(slo)) {
      const threshold = slo[objective] as number;
      const value = observed[objective];
      const breachedNow = value > threshold;
      const breachedBefore = state.breached.has(objective);
      if (breachedNow && !breachedBefore) {
        state.breached.add(objective);
        this.deps.metrics.recordCounter(FLOW_SLO_BREACH_COUNTER, {
          flow_id: flowId,
          objective,
        });
        this.deps.logger?.warn("flow SLO breached", {
          flowId,
          objective,
          observed: roundMetric(objective, value),
          threshold,
          samples: state.count,
        });
      } else if (!breachedNow && breachedBefore) {
        state.breached.delete(objective);
        this.deps.logger?.info("flow SLO recovered", {
          flowId,
          objective,
          observed: roundMetric(objective, value),
          threshold,
          samples: state.count,
        });
      }
    }
  }
}

/** Round for logs: the error rate is a fraction, the others are integers. */
function roundMetric(objective: SloObjective, value: number): number {
  return objective === "maxErrorRate"
    ? Math.round(value * 1000) / 1000
    : Math.round(value);
}

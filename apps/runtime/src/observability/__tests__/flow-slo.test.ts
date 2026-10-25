// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the flow service-objective evaluator
 * (`src/observability/flow-slo.ts`).
 */

import { describe, test, expect } from "bun:test";
import {
  FLOW_SLO_BREACH_COUNTER,
  FlowSloEvaluator,
  median,
  percentile,
  sloObjectives,
  SLO_MIN_SAMPLES,
  type SloSample,
} from "../flow-slo.js";
import type { FlowServiceObjectives } from "../../types/flow.js";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface CounterCall {
  name: string;
  labels: Record<string, string>;
  by: number | undefined;
}

interface LogCall {
  level: "warn" | "info";
  message: string;
  // biome-ignore lint/suspicious/noExplicitAny: test double for Logger data
  data: any;
}

function makeEvaluator() {
  const counters: CounterCall[] = [];
  const logs: LogCall[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (message, fields) => {
      logs.push({ level: "info", message, data: fields });
    },
    warn: (message, fields) => {
      logs.push({ level: "warn", message, data: fields });
    },
    error: () => {},
    child: () => logger,
  };
  const evaluator = new FlowSloEvaluator({
    metrics: {
      recordCounter: (name, labels, by) => {
        counters.push({ name, labels, by });
      },
    },
    logger,
  });
  return { evaluator, counters, logs };
}

function sample(overrides?: Partial<SloSample>): SloSample {
  return { latencyMs: 1000, totalTokens: 100, errored: false, ...overrides };
}

/** Record `n` identical samples for a flow. */
function record(
  evaluator: FlowSloEvaluator,
  flowId: string,
  slo: FlowServiceObjectives | undefined,
  n: number,
  overrides?: Partial<SloSample>,
): void {
  for (let i = 0; i < n; i++) evaluator.recordExecution(flowId, slo, sample(overrides));
}

// ---------------------------------------------------------------------------
// Statistics helpers (conventions must match eval/flow-release.ts)
// ---------------------------------------------------------------------------

describe("median", () => {
  test("odd count picks the middle value", () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3);
  });

  test("even count averages the two middle values", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  test("does not mutate the input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  test("throws on empty input", () => {
    expect(() => median([])).toThrow();
  });
});

describe("percentile", () => {
  test("nearest-rank p95 of 20 values picks the 19th", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(19);
  });

  test("p50 of an even sample is the lower middle (nearest-rank)", () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });

  test("p100 picks the maximum", () => {
    expect(percentile([7, 3, 9], 100)).toBe(9);
  });

  test("throws on empty input", () => {
    expect(() => percentile([], 95)).toThrow();
  });
});

describe("sloObjectives", () => {
  test("lists only the objectives the declaration sets", () => {
    expect(sloObjectives({ window: 20, p95LatencyMs: 100 })).toEqual([
      "p95LatencyMs",
    ]);
  });

  test("lists all four when all are set", () => {
    expect(
      sloObjectives({
        p50LatencyMs: 1,
        p95LatencyMs: 2,
        maxTokensP50: 3,
        maxErrorRate: 0.5,
      }),
    ).toEqual(["p50LatencyMs", "p95LatencyMs", "maxTokensP50", "maxErrorRate"]);
  });
});

// ---------------------------------------------------------------------------
// FlowSloEvaluator — window bookkeeping
// ---------------------------------------------------------------------------

describe("FlowSloEvaluator window bookkeeping", () => {
  test("a flow without slo is never tracked", () => {
    const { evaluator } = makeEvaluator();
    record(evaluator, "flow-a", undefined, 12);
    expect(evaluator.status("flow-a")).toBeUndefined();
    expect(evaluator.trackedFlows()).toEqual([]);
  });

  test("removing a flow's slo declaration drops its state", () => {
    const { evaluator } = makeEvaluator();
    record(evaluator, "flow-a", { p50LatencyMs: 2000 }, 12);
    expect(evaluator.status("flow-a")?.samples).toBe(12);
    evaluator.recordExecution("flow-a", undefined, sample());
    expect(evaluator.status("flow-a")).toBeUndefined();
  });

  test("changing the window resets the buffer", () => {
    const { evaluator } = makeEvaluator();
    record(evaluator, "flow-a", { window: 20, p50LatencyMs: 2000 }, 12);
    expect(evaluator.status("flow-a")?.samples).toBe(12);
    record(evaluator, "flow-a", { window: 50, p50LatencyMs: 2000 }, 3);
    expect(evaluator.status("flow-a")?.samples).toBe(3);
  });

  test("the ring buffer caps at the declared window", () => {
    const { evaluator } = makeEvaluator();
    record(evaluator, "flow-a", { window: 10, p50LatencyMs: 2000 }, 25);
    expect(evaluator.status("flow-a")?.samples).toBe(10);
  });

  test("status is undefined for an unknown flow", () => {
    const { evaluator } = makeEvaluator();
    expect(evaluator.status("nope")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FlowSloEvaluator — evaluation & transitions
// ---------------------------------------------------------------------------

describe("FlowSloEvaluator evaluation", () => {
  test("nothing is evaluated below the minimum sample count", () => {
    const { evaluator, counters } = makeEvaluator();
    const slo: FlowServiceObjectives = { p50LatencyMs: 500 };
    record(evaluator, "flow-a", slo, SLO_MIN_SAMPLES - 1, {
      latencyMs: 5000,
    });
    expect(counters).toHaveLength(0);
    const status = evaluator.status("flow-a");
    if (status === undefined) throw new Error("expected state");
    expect(status.samples).toBe(SLO_MIN_SAMPLES - 1);
    expect(status.breached).toEqual([]);
  });

  test("ok → breached increments the counter once and warns", () => {
    const { evaluator, counters, logs } = makeEvaluator();
    const slo: FlowServiceObjectives = { p50LatencyMs: 500 };
    record(evaluator, "flow-a", slo, SLO_MIN_SAMPLES, { latencyMs: 5000 });
    expect(counters).toHaveLength(1);
    const call = counters[0];
    if (call === undefined) throw new Error("expected a counter call");
    expect(call.name).toBe(FLOW_SLO_BREACH_COUNTER);
    expect(call.labels).toEqual({ flow_id: "flow-a", objective: "p50LatencyMs" });
    const warn = logs.find((l) => l.level === "warn");
    if (warn === undefined) throw new Error("expected a warning");
    expect(warn.message).toBe("flow SLO breached");
    expect(warn.data.objective).toBe("p50LatencyMs");
    expect(warn.data.threshold).toBe(500);
  });

  test("staying breached does not increment again", () => {
    const { evaluator, counters } = makeEvaluator();
    const slo: FlowServiceObjectives = { p50LatencyMs: 500 };
    record(evaluator, "flow-a", slo, SLO_MIN_SAMPLES + 5, {
      latencyMs: 5000,
    });
    expect(counters).toHaveLength(1);
  });

  test("breached → ok logs info and re-arms the counter", () => {
    const { evaluator, counters, logs } = makeEvaluator();
    const slo: FlowServiceObjectives = { window: 10, p50LatencyMs: 500 };
    record(evaluator, "flow-a", slo, SLO_MIN_SAMPLES, { latencyMs: 5000 });
    expect(evaluator.status("flow-a")?.breached).toEqual(["p50LatencyMs"]);
    // A full window of fast executions brings the median back under the bound.
    record(evaluator, "flow-a", slo, 10, { latencyMs: 100 });
    expect(evaluator.status("flow-a")?.breached).toEqual([]);
    const info = logs.find((l) => l.level === "info");
    if (info === undefined) throw new Error("expected an info log");
    expect(info.message).toBe("flow SLO recovered");
    // Breaching again increments a second time.
    record(evaluator, "flow-a", slo, 10, { latencyMs: 5000 });
    expect(counters).toHaveLength(2);
  });

  test("each objective reports under its own label", () => {
    const { evaluator, counters } = makeEvaluator();
    const slo: FlowServiceObjectives = {
      p50LatencyMs: 500,
      maxTokensP50: 50,
      maxErrorRate: 0.1,
    };
    record(evaluator, "flow-a", slo, SLO_MIN_SAMPLES, {
      latencyMs: 5000,
      totalTokens: 5000,
      errored: true,
    });
    const objectives = counters.map((c) => c.labels["objective"]);
    expect(objectives.sort()).toEqual([
      "maxErrorRate",
      "maxTokensP50",
      "p50LatencyMs",
    ]);
  });

  test("error rate is the errored share of the window", () => {
    const { evaluator, counters } = makeEvaluator();
    const slo: FlowServiceObjectives = { maxErrorRate: 0.2 };
    // 2 of 10 errored = 0.2, which is not > 0.2 → no breach.
    record(evaluator, "flow-a", slo, 8);
    record(evaluator, "flow-a", slo, 2, { errored: true });
    expect(counters).toHaveLength(0);
    // One more error crosses the bound (3/10 = 0.3 > 0.2).
    evaluator.recordExecution("flow-a", slo, sample({ errored: true }));
    expect(counters).toHaveLength(1);
    const call = counters[0];
    if (call === undefined) throw new Error("expected a counter call");
    expect(call.labels["objective"]).toBe("maxErrorRate");
  });

  test("p95 uses the nearest-rank percentile of latencies", () => {
    const { evaluator, counters } = makeEvaluator();
    const slo: FlowServiceObjectives = { window: 20, p95LatencyMs: 1500 };
    // 19 fast samples + one slow one: p95 (rank 18 of 20) stays fast.
    record(evaluator, "flow-a", slo, 19);
    evaluator.recordExecution("flow-a", slo, sample({ latencyMs: 9000 }));
    expect(counters).toHaveLength(0);
    // More slow samples push the 95th percentile over the bound.
    record(evaluator, "flow-a", slo, 2, { latencyMs: 9000 });
    expect(counters).toHaveLength(1);
  });

  test("flows are tracked independently", () => {
    const { evaluator, counters } = makeEvaluator();
    const slo: FlowServiceObjectives = { p50LatencyMs: 500 };
    record(evaluator, "flow-a", slo, SLO_MIN_SAMPLES, { latencyMs: 5000 });
    record(evaluator, "flow-b", slo, SLO_MIN_SAMPLES, { latencyMs: 100 });
    expect(counters).toHaveLength(1);
    expect(evaluator.trackedFlows()).toEqual(["flow-a", "flow-b"]);
    expect(evaluator.status("flow-a")?.breached).toEqual(["p50LatencyMs"]);
    expect(evaluator.status("flow-b")?.breached).toEqual([]);
  });
});

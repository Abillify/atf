// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the autonomous optimizer scheduler (`src/graph/optimizer-scheduler.ts`).
 *
 * All timers and the clock are injectable — no real setInterval calls. The
 * optimizer and snapshot counter are fakes, so tests are fast and deterministic.
 */

import { describe, test, expect } from "bun:test";
import {
  OptimizerScheduler,
  type OptimizerScheduleConfig,
  type OptimizerSchedulerDeps,
  type SnapshotCounter,
} from "../optimizer-scheduler.js";
import type {
  FlowOptimizer,
  OptimizationRun,
  OptimizerConfig,
} from "../flow-optimizer.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeRun(
  id: string,
  status: OptimizationRun["status"] = "done",
): OptimizationRun {
  return {
    id,
    flowId: "test-flow",
    targetNodeId: "responder",
    startedAt: new Date().toISOString(),
    status,
    sampleCount: 0,
    variants: [],
  };
}

function makeFakeOptimizer(): FlowOptimizer & {
  started: OptimizerConfig[];
  runs: Map<string, OptimizationRun>;
  nextStatus: OptimizationRun["status"];
} {
  const started: OptimizerConfig[] = [];
  const runs = new Map<string, OptimizationRun>();
  let seq = 0;

  return {
    started,
    runs,
    nextStatus: "done" as OptimizationRun["status"],
    start(config) {
      started.push(config);
      const id = `run-${++seq}`;
      const run = makeRun(id, this.nextStatus);
      run.flowId = config.flowId;
      runs.set(id, run);
      return run;
    },
    async run(config) {
      this.start(config);
      return makeRun(`run-sync-${++seq}`, "done");
    },
    async promote(runId, variantLabel) {
      const r = runs.get(runId);
      if (!r) throw new Error(`Run "${runId}" not found`);
      r.promotedVariant = variantLabel;
      return r;
    },
    getRun(id) {
      return runs.get(id);
    },
    listRuns(flowId) {
      return [...runs.values()].filter((r) => r.flowId === flowId);
    },
  };
}

const ENOUGH_SAMPLES: SnapshotCounter = async () => 100;
const TOO_FEW_SAMPLES: SnapshotCounter = async () => 0;

function makeCfg(
  overrides: Partial<OptimizerScheduleConfig> = {},
): OptimizerScheduleConfig {
  return {
    flows: ["test-flow"],
    intervalMs: 60_000,
    minNewSamples: 10,
    cooldownMs: 60_000,
    autoPromote: true,
    variantCount: 2,
    minScoreImprovement: 0.05,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<Omit<OptimizerSchedulerDeps, "optimizer">> & {
    optimizer?: FlowOptimizer;
    countSnapshots?: SnapshotCounter;
  } = {},
): Omit<OptimizerSchedulerDeps, "optimizer"> & {
  optimizer: ReturnType<typeof makeFakeOptimizer>;
} {
  const optimizer =
    (overrides.optimizer as ReturnType<typeof makeFakeOptimizer> | undefined) ??
    makeFakeOptimizer();
  return {
    countSnapshots: overrides.countSnapshots ?? ENOUGH_SAMPLES,
    clock: overrides.clock ?? Date.now,
    ...(overrides.auditLog !== undefined
      ? { auditLog: overrides.auditLog }
      : {}),
    ...(overrides.logger !== undefined ? { logger: overrides.logger } : {}),
    optimizer,
  };
}

// ---------------------------------------------------------------------------
// tick() guard: insufficient samples
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — insufficient-samples guard", () => {
  test("skips when snapshot count is below minNewSamples", async () => {
    const deps = makeDeps({ countSnapshots: TOO_FEW_SAMPLES });
    const s = new OptimizerScheduler(makeCfg({ minNewSamples: 10 }), deps);

    const result = await s.tick();

    expect(result.started).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    const firstSkipped = result.skipped[0];
    if (firstSkipped === undefined) throw new Error("expected a first skipped entry");
    expect(firstSkipped.reason).toBe("insufficient-samples");
    expect(deps.optimizer.started).toHaveLength(0);
  });

  test("starts when snapshot count meets minNewSamples exactly", async () => {
    const deps = makeDeps({ countSnapshots: async () => 10 });
    const s = new OptimizerScheduler(makeCfg({ minNewSamples: 10 }), deps);

    const result = await s.tick();

    expect(result.started).toHaveLength(1);
    const firstStarted = result.started[0];
    if (firstStarted === undefined) throw new Error("expected a first started entry");
    expect(firstStarted.flowId).toBe("test-flow");
  });
});

// ---------------------------------------------------------------------------
// tick() guard: cooldown
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — cooldown guard", () => {
  test("skips a flow within the cooldown window after the first run", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const deps = makeDeps({ clock, countSnapshots: ENOUGH_SAMPLES });
    const s = new OptimizerScheduler(makeCfg({ cooldownMs: 10_000 }), deps);

    // First tick — should start a run.
    const first = await s.tick();
    expect(first.started).toHaveLength(1);

    // Mark the run as done so single-flight doesn't interfere.
    const firstStarted = first.started[0];
    if (firstStarted === undefined) throw new Error("expected a first started entry");
    const run = deps.optimizer.runs.get(firstStarted.runId);
    if (run === undefined) throw new Error("expected the run to be tracked");
    run.status = "done";

    // Advance time by less than the cooldown (5 s < 10 s).
    now += 5_000;
    const second = await s.tick();
    expect(second.started).toHaveLength(0);
    const secondSkipped = second.skipped[0];
    if (secondSkipped === undefined) throw new Error("expected a second skipped entry");
    expect(secondSkipped.reason).toBe("cooldown");
  });

  test("starts again after the cooldown elapses", async () => {
    let now = 1_000_000;
    const clock = () => now;
    const deps = makeDeps({ clock, countSnapshots: ENOUGH_SAMPLES });
    const s = new OptimizerScheduler(makeCfg({ cooldownMs: 10_000 }), deps);

    await s.tick();
    // Mark first run as done.
    const firstStarted = deps.optimizer.started[0];
    if (firstStarted === undefined) throw new Error("expected a first started entry");
    void firstStarted.flowId; // satisfy linter; state is in the run map
    const firstRun = [...deps.optimizer.runs.values()][0];
    if (firstRun === undefined) throw new Error("expected a first run");
    firstRun.status = "done";

    // Advance past the cooldown.
    now += 15_000;
    const second = await s.tick();
    expect(second.started).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// tick() guard: single-flight (in-progress)
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — single-flight guard", () => {
  test("skips a flow while its run is still in progress", async () => {
    const deps = makeDeps({ countSnapshots: ENOUGH_SAMPLES });
    deps.optimizer.nextStatus = "evaluating"; // run starts but stays in-progress
    const s = new OptimizerScheduler(makeCfg(), deps);

    const first = await s.tick();
    expect(first.started).toHaveLength(1);

    // Don't advance time (cooldown would also block, but single-flight takes priority).
    // Force cooldown not to interfere by using a far-future clock for state checks,
    // but the run is still in-progress.
    const second = await s.tick();
    expect(second.started).toHaveLength(0);
    const firstSkipped = second.skipped[0];
    if (firstSkipped === undefined) throw new Error("expected a first skipped entry");
    expect(firstSkipped.reason).toBe("in-progress");
    // optimizer.start() was only called once.
    expect(deps.optimizer.started).toHaveLength(1);
  });

  test("clears the in-progress marker and starts a new run once the run finishes", async () => {
    const now = 0;
    const clock = () => now;
    const deps = makeDeps({ clock, countSnapshots: ENOUGH_SAMPLES });
    deps.optimizer.nextStatus = "evaluating";
    const s = new OptimizerScheduler(makeCfg({ cooldownMs: 0 }), deps);

    const first = await s.tick();
    const firstStarted = first.started[0];
    if (firstStarted === undefined) throw new Error("expected a first started entry");

    // Manually finish the run.
    const run = deps.optimizer.runs.get(firstStarted.runId);
    if (run === undefined) throw new Error("expected the run to be tracked");
    run.status = "done";
    deps.optimizer.nextStatus = "done";

    const second = await s.tick();
    expect(second.started).toHaveLength(1);
    expect(deps.optimizer.started).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Multiple flows
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — multiple flows", () => {
  test("evaluates all flows independently on each tick", async () => {
    const counters: Record<string, number> = {
      "flow-a": 100, // enough
      "flow-b": 2, // too few
      "flow-c": 50, // enough
    };
    const deps = makeDeps({
      countSnapshots: async (id) => counters[id] ?? 0,
    });
    const s = new OptimizerScheduler(
      makeCfg({ flows: ["flow-a", "flow-b", "flow-c"] }),
      deps,
    );

    const result = await s.tick();

    expect(result.started).toHaveLength(2);
    expect(result.started.map((r) => r.flowId).sort()).toEqual([
      "flow-a",
      "flow-c",
    ]);
    expect(result.skipped).toHaveLength(1);
    const firstSkipped = result.skipped[0];
    if (firstSkipped === undefined) throw new Error("expected a first skipped entry");
    expect(firstSkipped.flowId).toBe("flow-b");
    expect(firstSkipped.reason).toBe("insufficient-samples");
  });

  test("each flow has independent cooldown state", async () => {
    let now = 1_000_000; // start positive so lastRunAt > 0 after first tick
    const clock = () => now;
    const deps = makeDeps({ clock, countSnapshots: ENOUGH_SAMPLES });
    const s = new OptimizerScheduler(
      makeCfg({ flows: ["flow-a", "flow-b"], cooldownMs: 10_000 }),
      deps,
    );

    // First tick — both start.
    const t1 = await s.tick();
    expect(t1.started).toHaveLength(2);

    // Mark both runs done.
    for (const r of deps.optimizer.runs.values()) r.status = "done";

    // Advance only half the cooldown.
    now += 5_000;
    const t2 = await s.tick();
    // Both still in cooldown.
    expect(t2.started).toHaveLength(0);
    expect(t2.skipped).toHaveLength(2);

    // Advance past cooldown.
    now += 10_000;
    const t3 = await s.tick();
    expect(t3.started).toHaveLength(2);
    expect(deps.optimizer.started).toHaveLength(4); // 2 original + 2 new
  });
});

// ---------------------------------------------------------------------------
// Optimizer config forwarding
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — config forwarding", () => {
  test("forwards variantCount, autoPromote, minScoreImprovement, and goal to optimizer.start()", async () => {
    const deps = makeDeps({ countSnapshots: ENOUGH_SAMPLES });
    const s = new OptimizerScheduler(
      makeCfg({
        variantCount: 5,
        autoPromote: false,
        minScoreImprovement: 0.1,
        optimizationGoal: "Be more concise.",
      }),
      deps,
    );

    await s.tick();

    const cfg = deps.optimizer.started[0];
    if (cfg === undefined) throw new Error("expected a first started entry");
    expect(cfg.variantCount).toBe(5);
    expect(cfg.autoPromote).toBe(false);
    expect(cfg.minScoreImprovement).toBe(0.1);
    expect(cfg.optimizationGoal).toBe("Be more concise.");
  });

  test("does not forward optimizationGoal when not configured", async () => {
    const deps = makeDeps({ countSnapshots: ENOUGH_SAMPLES });
    const s = new OptimizerScheduler(makeCfg(), deps); // no optimizationGoal

    await s.tick();

    const cfg = deps.optimizer.started[0];
    if (cfg === undefined) throw new Error("expected a first started entry");
    expect(cfg.optimizationGoal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// active flag + start/stop
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — active / start / stop", () => {
  test("active is true when flows are set and interval is positive", () => {
    const s = new OptimizerScheduler(makeCfg({ flows: ["f1"] }), makeDeps());
    expect(s.active).toBe(true);
  });

  test("active is false when no flows are configured", () => {
    const s = new OptimizerScheduler(makeCfg({ flows: [] }), makeDeps());
    expect(s.active).toBe(false);
  });

  test("start() returns false when inactive", () => {
    const s = new OptimizerScheduler(makeCfg({ flows: [] }), makeDeps());
    expect(s.start()).toBe(false);
  });

  test("stop() is idempotent (no throw)", () => {
    const s = new OptimizerScheduler(makeCfg(), makeDeps());
    s.stop();
    s.stop(); // second call must not throw
  });

  test("start() returns true and stop() clears the timer", () => {
    const s = new OptimizerScheduler(makeCfg(), makeDeps());
    expect(s.start()).toBe(true);
    s.stop();
    // After stop, start() should be able to start again (timer re-created).
    expect(s.start()).toBe(true);
    s.stop();
  });
});

// ---------------------------------------------------------------------------
// Audit log recording
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — audit log", () => {
  test("records an audit entry when a run is started", async () => {
    const records: Array<{ action: string; target: string }> = [];
    const deps = makeDeps({
      countSnapshots: ENOUGH_SAMPLES,
      auditLog: {
        record: (entry) => {
          records.push({ action: entry.action, target: entry.target ?? "" });
        },
        list: async () => [],
        verifyChain: async () => ({ valid: true, checked: 0 }),
      },
    });
    const s = new OptimizerScheduler(makeCfg(), deps);

    await s.tick();

    expect(records).toHaveLength(1);
    const firstRecord = records[0];
    if (firstRecord === undefined) throw new Error("expected a first record");
    expect(firstRecord.action).toBe("optimizer.schedule.run");
    expect(firstRecord.target).toBe("test-flow");
  });

  test("does not record when a flow is skipped", async () => {
    const records: unknown[] = [];
    const deps = makeDeps({
      countSnapshots: TOO_FEW_SAMPLES,
      auditLog: {
        record: (e) => records.push(e),
        list: async () => [],
        verifyChain: async () => ({ valid: true, checked: 0 }),
      },
    });
    const s = new OptimizerScheduler(makeCfg(), deps);

    await s.tick();

    expect(records).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// status() snapshot
// ---------------------------------------------------------------------------

describe("OptimizerScheduler — status()", () => {
  test("returns an entry per configured flow before any tick", () => {
    const s = new OptimizerScheduler(
      makeCfg({ flows: ["f1", "f2"] }),
      makeDeps(),
    );
    const st = s.status();
    expect(st).toHaveLength(2);
    expect(st.every((e) => e.lastRunAt === 0)).toBe(true);
    expect(st.every((e) => e.activeRunId === undefined)).toBe(true);
  });

  test("reflects the active run id after a tick starts a run", async () => {
    const deps = makeDeps({
      countSnapshots: ENOUGH_SAMPLES,
    });
    // Keep run in-progress so activeRunId stays set.
    deps.optimizer.nextStatus = "evaluating";
    const s = new OptimizerScheduler(makeCfg(), deps);

    await s.tick();

    const st = s.status();
    const firstStatus = st[0];
    if (firstStatus === undefined) throw new Error("expected a first status entry");
    expect(firstStatus.activeRunId).toBeDefined();
    expect(firstStatus.lastRunAt).toBeGreaterThan(0);
  });
});

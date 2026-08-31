// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Continuous Safety & Quality Autopilot engine governance
 * hardening (`src/autopilot/autopilot-engine.ts`).
 *
 * Focus: the three governance guards added on top of the base red-team →
 * optimizer → canary loop:
 *   1. `requireHumanApproval` — auto-promotion is disabled by default; the
 *      optimizer is still run, but `autoPromote` is forced to `false`.
 *   2. Drift-guard circuit breaker — caps automatic promotions per flow
 *      within a rolling window, using the durable {@link AutopilotRunHistory}
 *      (not just the in-memory run registry) so the count survives restarts.
 *   3. Judge-model pass-through — the configured judge model id is forwarded
 *      to every optimizer run so the optimizer's own self-grading guard can
 *      evaluate it.
 *
 * All I/O is faked: no real LLM, no timers beyond `setTimeout` polling delays
 * (kept tiny via a fast FlowOptimizer fake that resolves synchronously).
 */

import { describe, test, expect } from "bun:test";
import {
  createAutopilotEngine,
  InMemoryAutopilotRunHistory,
  type AutopilotRun,
  type AutopilotRunHistory,
} from "../autopilot-engine.js";
import type { FlowOptimizer, OptimizationRun } from "../../graph/flow-optimizer.js";
import type { FlowStore } from "../../graph/flow-store.js";
import type { RedTeamRun } from "../../security/red-team-engine.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A FlowOptimizer fake whose `start()` resolves the run synchronously (no polling delay). */
function makeFakeOptimizer(opts: {
  promotedVersion?: number;
  status?: OptimizationRun["status"];
  capturedAutoPromote?: { value?: boolean };
  capturedJudgeModelId?: { value?: { provider: string; model: string } };
}): FlowOptimizer {
  const runs = new Map<string, OptimizationRun>();
  let seq = 0;
  return {
    start(config) {
      if (opts.capturedAutoPromote !== undefined) {
        opts.capturedAutoPromote.value = config.autoPromote;
      }
      if (opts.capturedJudgeModelId !== undefined) {
        opts.capturedJudgeModelId.value = config.judgeModelId;
      }
      const id = `opt-${seq++}`;
      const run: OptimizationRun = {
        id,
        flowId: config.flowId,
        targetNodeId: "responder",
        startedAt: new Date().toISOString(),
        status: opts.status ?? "done",
        sampleCount: 10,
        variants: [],
        ...(opts.promotedVersion !== undefined
          ? { promotedVersion: opts.promotedVersion, promotedVariant: "v1" }
          : {}),
      };
      runs.set(id, run);
      return run;
    },
    async run(config) {
      return this.start(config);
    },
    async promote(runId, variantLabel) {
      const run = runs.get(runId);
      if (run === undefined) throw new Error("not found");
      return { ...run, promotedVariant: variantLabel };
    },
    getRun(id) {
      return runs.get(id);
    },
    listRuns() {
      return [...runs.values()];
    },
  };
}

const fakeFlowStore = {} as FlowStore;

/** Fast-poll config for tests — avoids waiting out the 2s production backoff. */
const FAST_POLL = { optimizerPollInitialDelayMs: 5 };

function makeRedTeamRun(flowId: string, bypassRate: number): RedTeamRun {
  return {
    id: "rt-1",
    flowId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: "done",
    attemptCount: 10,
    bypassCount: Math.round(bypassRate * 10),
    bypassRate,
    results: [],
  } as unknown as RedTeamRun;
}

/** Waits until an autopilot run reaches a terminal state (poll, bounded). */
async function waitForTerminal(
  autopilot: { getRun(id: string): AutopilotRun | undefined },
  id: string,
): Promise<AutopilotRun> {
  // The engine's internal optimizer poller (`waitForOptimizer`) starts with a
  // 2s backoff before its first re-check, even though the fake optimizer here
  // resolves synchronously — so the wait budget must clear that first tick.
  for (let i = 0; i < 200; i++) {
    const run = autopilot.getRun(id);
    if (
      run !== undefined &&
      (run.status === "done" || run.status === "error" || run.status === "skipped")
    ) {
      return run;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("autopilot run did not reach a terminal state in time");
}

// ---------------------------------------------------------------------------
// Governance guard 1: requireHumanApproval
// ---------------------------------------------------------------------------

describe("AutopilotEngine — requireHumanApproval", () => {
  test("defaults to true — the optimizer is started with autoPromote: false", async () => {
    const captured: { value?: boolean } = {};
    const optimizer = makeFakeOptimizer({ capturedAutoPromote: captured });
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      FAST_POLL,
    );

    expect(autopilot.config.requireHumanApproval).toBe(true);

    const run = await autopilot.triggerManual("flow-a");
    await waitForTerminal(autopilot, run.id);

    expect(captured.value).toBe(false);
  });

  test("when explicitly disabled, the optimizer is started with autoPromote: true", async () => {
    const captured: { value?: boolean } = {};
    const optimizer = makeFakeOptimizer({
      capturedAutoPromote: captured,
      promotedVersion: 2,
    });
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      { requireHumanApproval: false, ...FAST_POLL },
    );

    const run = await autopilot.triggerManual("flow-a");
    await waitForTerminal(autopilot, run.id);

    expect(captured.value).toBe(true);
  });

  test("a run with requireHumanApproval=true can still surface a recommendation without publishing", async () => {
    // The fake optimizer never sets promotedVersion when autoPromote is false
    // (mirrors the real FlowOptimizer, which only promotes when autoPromote is true).
    const optimizer = makeFakeOptimizer({});
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      FAST_POLL,
    );

    const run = await autopilot.triggerManual("flow-a");
    const finished = await waitForTerminal(autopilot, run.id);

    expect(finished.status).toBe("done");
    expect(finished.canaryRegistered).toBeUndefined();
    expect(finished.promotedVersion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Governance guard 2: drift-guard circuit breaker
// ---------------------------------------------------------------------------

describe("AutopilotEngine — drift-guard circuit breaker", () => {
  test("trips after maxAutoPromotionsPerWindow automatic promotions for the same flow", async () => {
    const history: AutopilotRunHistory = new InMemoryAutopilotRunHistory();
    const optimizer = makeFakeOptimizer({ promotedVersion: 2 });
    const canaryRegistrar = async () => {};
    const autopilot = createAutopilotEngine(
      {
        optimizer,
        flowStore: fakeFlowStore,
        canaryRegistrar,
        history,
      },
      {
        requireHumanApproval: false,
        maxAutoPromotionsPerWindow: 2,
        driftWindowMs: 3_600_000,
        ...FAST_POLL,
      },
    );

    // First two automatic cycles succeed and register a canary.
    const r1 = await autopilot.triggerManual("flow-a");
    const f1 = await waitForTerminal(autopilot, r1.id);
    expect(f1.status).toBe("done");
    expect(f1.canaryRegistered).toBe(true);

    const r2 = await autopilot.triggerManual("flow-a");
    const f2 = await waitForTerminal(autopilot, r2.id);
    expect(f2.status).toBe("done");
    expect(f2.canaryRegistered).toBe(true);

    // Third cycle within the window must be refused by the drift-guard.
    const r3 = await autopilot.triggerManual("flow-a");
    const f3 = await waitForTerminal(autopilot, r3.id);
    expect(f3.status).toBe("skipped");
    expect(f3.error).toContain("Drift-guard");
  });

  test("does not trip for a different flow (per-flow window)", async () => {
    const history: AutopilotRunHistory = new InMemoryAutopilotRunHistory();
    const optimizer = makeFakeOptimizer({ promotedVersion: 2 });
    const canaryRegistrar = async () => {};
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore, canaryRegistrar, history },
      { requireHumanApproval: false, maxAutoPromotionsPerWindow: 1, ...FAST_POLL },
    );

    const r1 = await autopilot.triggerManual("flow-a");
    await waitForTerminal(autopilot, r1.id);

    // flow-b has its own budget — must not be affected by flow-a's promotions.
    const r2 = await autopilot.triggerManual("flow-b");
    const f2 = await waitForTerminal(autopilot, r2.id);
    expect(f2.status).toBe("done");
    expect(f2.canaryRegistered).toBe(true);
  });

  test("does not apply when requireHumanApproval is true (no auto-promotions to guard)", async () => {
    const history: AutopilotRunHistory = new InMemoryAutopilotRunHistory();
    const optimizer = makeFakeOptimizer({});
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore, history },
      { maxAutoPromotionsPerWindow: 1, ...FAST_POLL }, // requireHumanApproval defaults to true
    );

    // Multiple manual cycles must all run normally — the guard only counts
    // and only blocks automatic-promotion cycles.
    for (let i = 0; i < 3; i++) {
      const run = await autopilot.triggerManual("flow-a");
      const finished = await waitForTerminal(autopilot, run.id);
      expect(finished.status).toBe("done");
    }
  });

  test("promotions outside the drift window do not count toward the cap", async () => {
    const history: AutopilotRunHistory = new InMemoryAutopilotRunHistory();
    // Seed history with an "old" promotion outside the window.
    await history.record({
      id: "old-run",
      flowId: "flow-a",
      trigger: "manual",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      finishedAt: new Date(Date.now() - 10_000).toISOString(),
      status: "done",
      canaryRegistered: true,
      promotedVersion: 1,
    });

    const optimizer = makeFakeOptimizer({ promotedVersion: 2 });
    const canaryRegistrar = async () => {};
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore, canaryRegistrar, history },
      {
        requireHumanApproval: false,
        maxAutoPromotionsPerWindow: 1,
        // A near-zero window means the seeded "old" entry (10s ago) is
        // already outside it, so it must not count against the cap.
        driftWindowMs: 1,
        ...FAST_POLL,
      },
    );

    const run = await autopilot.triggerManual("flow-a");
    const finished = await waitForTerminal(autopilot, run.id);
    expect(finished.status).toBe("done");
    expect(finished.canaryRegistered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Governance guard 3: judge-model pass-through
// ---------------------------------------------------------------------------

describe("AutopilotEngine — judge-model pass-through", () => {
  test("forwards the configured judgeModelId to every optimizer run", async () => {
    const captured: { value?: { provider: string; model: string } } = {};
    const optimizer = makeFakeOptimizer({
      capturedJudgeModelId: captured,
    });
    const autopilot = createAutopilotEngine(
      {
        optimizer,
        flowStore: fakeFlowStore,
        judgeModelId: { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
      },
      FAST_POLL,
    );

    const run = await autopilot.triggerManual("flow-a");
    await waitForTerminal(autopilot, run.id);

    expect(captured.value).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
    });
  });

  test("omits judgeModelId when none is configured", async () => {
    const captured: { value?: { provider: string; model: string } } = {
      value: { provider: "placeholder", model: "placeholder" },
    };
    const optimizer = makeFakeOptimizer({ capturedJudgeModelId: captured });
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      FAST_POLL,
    );

    const run = await autopilot.triggerManual("flow-a");
    await waitForTerminal(autopilot, run.id);

    expect(captured.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Durable run history persistence
// ---------------------------------------------------------------------------

describe("AutopilotEngine — durable run history", () => {
  test("every cycle is recorded in the injected history, matching the in-memory registry", async () => {
    const history: AutopilotRunHistory = new InMemoryAutopilotRunHistory();
    const optimizer = makeFakeOptimizer({ promotedVersion: 2 });
    const canaryRegistrar = async () => {};
    const autopilot = createAutopilotEngine(
      {
        optimizer,
        flowStore: fakeFlowStore,
        canaryRegistrar,
        history,
      },
      { requireHumanApproval: false, ...FAST_POLL },
    );

    const run = await autopilot.triggerManual("flow-a");
    const finished = await waitForTerminal(autopilot, run.id);

    const persisted = await history.listByFlow("flow-a");
    expect(persisted).toHaveLength(1);
    const persisted0 = persisted[0];
    if (persisted0 === undefined) throw new Error("expected a persisted run");
    expect(persisted0.id).toBe(finished.id);
    expect(persisted0.status).toBe("done");
    expect(persisted0.canaryRegistered).toBe(true);
  });

  test("falls back to an in-memory history when none is injected", async () => {
    const optimizer = makeFakeOptimizer({});
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      FAST_POLL,
    );

    // Should not throw even without an injected history/database.
    const run = await autopilot.triggerManual("flow-a");
    const finished = await waitForTerminal(autopilot, run.id);
    expect(finished.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Existing (pre-hardening) behaviour still holds
// ---------------------------------------------------------------------------

describe("AutopilotEngine — red-team trigger (regression)", () => {
  test("does not fire below the bypass-rate threshold", async () => {
    const optimizer = makeFakeOptimizer({});
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      { bypassRateThreshold: 0.1 },
    );

    await autopilot.onRedTeamRunCompleted(makeRedTeamRun("flow-a", 0.05));
    // No run should have been created.
    expect(autopilot.listRuns("flow-a")).toHaveLength(0);
  });

  test("fires an optimization cycle above the bypass-rate threshold", async () => {
    const optimizer = makeFakeOptimizer({});
    const autopilot = createAutopilotEngine(
      { optimizer, flowStore: fakeFlowStore },
      { bypassRateThreshold: 0.1, ...FAST_POLL },
    );

    await autopilot.onRedTeamRunCompleted(makeRedTeamRun("flow-a", 0.5));
    // Give the fire-and-forget cycle a moment to register.
    await new Promise((r) => setTimeout(r, 10));
    const runs = autopilot.listRuns("flow-a");
    expect(runs.length).toBeGreaterThan(0);
    const run0 = runs[0];
    if (run0 === undefined) throw new Error("expected a run");
    expect(run0.trigger).toBe("red-team");
    expect(run0.bypassRate).toBe(0.5);
  });
});

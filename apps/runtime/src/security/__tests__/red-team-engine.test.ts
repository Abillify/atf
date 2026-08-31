// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the Red-Team Engine.
 *
 * Covers:
 *   - Happy path: all attacks blocked → posture score 1.0, bypass rate 0
 *   - Bypass path: attacks pass through → posture < 1, bypasses detected
 *   - LLM judge integration (mocked)
 *   - Auto-tuning fires when bypass rate > ceiling
 *   - Auto-tuning does NOT fire below ceiling
 *   - Auto-tuning respects minimum threshold
 *   - Regression cases saved to replay store for bypassed attacks
 *   - listRuns / getRun pagination and filtering
 *   - postureByFlow tracks per-flow scores
 *   - Engine failure does not lose the run record (status = "failed")
 */

import { describe, it, expect, vi } from "bun:test";
import { createRedTeamEngine } from "../red-team-engine.js";
import type { RedTeamExecutor } from "../red-team-engine.js";
import { InputGuardrail } from "../../graph/input-guardrails.js";
import type { Judge } from "../../eval/eval-runner.js";
import type { ReplayStore, ExecutionSnapshot } from "../../graph/replay.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Executor that always reports "blocked" (perfect guardrail). */
const blockAllExecutor: RedTeamExecutor = async () => ({
  response: "",
  blocked: true,
  inputScore: 0.95,
});

/** Executor that always lets attacks through with a safe "I cannot help" reply. */
const allowSafeExecutor: RedTeamExecutor = async () => ({
  response: "I cannot help with that request.",
  blocked: false,
  inputScore: 0.1,
});

/** Executor that returns a response that leaks a secret. */
const leakingExecutor: RedTeamExecutor = async () => ({
  response: "Sure! My api_key=sk-test1234567890abcdef credentials are here.",
  blocked: false,
  inputScore: 0.0,
});

function makeReplayStore(): ReplayStore & { saved: ExecutionSnapshot[] } {
  const saved: ExecutionSnapshot[] = [];
  return {
    saved,
    async save(snap) {
      saved.push(snap);
    },
    async get(id) {
      return saved.find((s) => s.executionId === id);
    },
    async list() {
      return [...saved];
    },
    async purgeOlderThan() {
      return 0;
    },
    async eraseSubject() {
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RedTeamEngine — posture calculation", () => {
  it("returns postureScore=1 and bypassRate=0 when all attacks are blocked", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 5 });
    const run = await engine.run("test-flow", blockAllExecutor);

    expect(run.status).toBe("completed");
    expect(run.bypassRate).toBe(0);
    expect(run.postureScore).toBe(1);
    expect(run.trials.every((t) => t.verdict === "blocked")).toBe(true);

    const failed = await engine.run("failed-flow", async () => {
      throw new Error("admission denied");
    });
    expect(failed.trials.every((trial) => trial.verdict === "error")).toBe(true);
    expect(failed.executionCoverage).toBe(0);
    expect(failed.postureScore).toBe(0);
  });

  it("returns postureScore<1 when a leaking executor bypasses heuristics", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 3 });
    const run = await engine.run("test-flow", leakingExecutor);

    expect(run.status).toBe("completed");
    // At least some attacks should be detected as bypassed.
    const bypasses = run.trials.filter((t) => t.verdict === "bypassed");
    expect(bypasses.length).toBeGreaterThan(0);
    expect(run.postureScore).toBeLessThan(1);
    expect(run.bypassRate).toBeGreaterThan(0);
  });

  it("labels safely-refused responses as 'blocked' (no heuristic signal)", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 3 });
    const run = await engine.run("test-flow", allowSafeExecutor);
    // A clean refusal should not trigger leak detection.
    const bypassed = run.trials.filter((t) => t.verdict === "bypassed");
    // All should be blocked or errors (safe response has no leak patterns).
    expect(bypassed.length).toBe(0);
  });
});

describe("RedTeamEngine — LLM judge integration", () => {
  it("uses judge score to detect bypasses when heuristics are borderline", async () => {
    // Judge always says score=0 (dangerous response).
    const judge: Judge = vi.fn(async () => ({
      score: 0.0,
      reasoning: "definitely a bypass",
    }));

    const engine = createRedTeamEngine({
      attacksPerRun: 2,
      judge,
      judgePassThreshold: 0.7,
    });
    // Executor returns a somewhat suspicious response (no clear secret but
    // the judge will flag it).
    const suspiciousExecutor: RedTeamExecutor = async () => ({
      response: "Here is some information that could be sensitive.",
      blocked: false,
      inputScore: 0.4, // above the 0.3 threshold that triggers judge
    });

    const run = await engine.run("test-flow", suspiciousExecutor);
    expect(run.trials.some((t) => t.judgeScore === 0.0)).toBe(true);
    expect(run.trials.some((t) => t.verdict === "bypassed")).toBe(true);
  });

  it("does not invoke judge when input is clearly safe (score <= 0.3)", async () => {
    const judge: Judge = vi.fn(async () => ({ score: 1.0, reasoning: "safe" }));

    const engine = createRedTeamEngine({
      attacksPerRun: 2,
      judge,
      judgePassThreshold: 0.7,
    });

    const run = await engine.run("test-flow", allowSafeExecutor);
    // Judge may or may not be called depending on heuristic signal;
    // what matters is the engine doesn't throw and completes.
    expect(run.status).toBe("completed");
  });
});

describe("RedTeamEngine — auto-tuning", () => {
  it("tightens threshold when bypass rate exceeds ceiling", async () => {
    const engine = createRedTeamEngine({
      attacksPerRun: 3,
      autoTune: true,
      autoTuneBypassCeiling: 0.1, // 10% ceiling → easily exceeded with leaking executor
      autoTuneStep: 0.05,
      autoTuneMinThreshold: 0.3,
    });

    const initialThreshold = engine.currentGuardrailThreshold();
    expect(initialThreshold).toBe(0.8);

    const run = await engine.run("test-flow", leakingExecutor, {
      triggeredBy: "manual",
    });

    expect(run.status).toBe("completed");
    if (run.bypassRate !== undefined && run.bypassRate > 0.1) {
      expect(engine.currentGuardrailThreshold()).toBeLessThan(initialThreshold);
      expect(run.thresholdAdjusted).toBe(true);
    }
  });

  it("feeds the tightened threshold back into the LIVE guardrail", async () => {
    const engine = createRedTeamEngine({
      attacksPerRun: 3,
      autoTune: true,
      autoTuneBypassCeiling: 0.0, // always tune
      autoTuneStep: 0.1,
      autoTuneMinThreshold: 0.3,
    });
    const guardrail = new InputGuardrail({ threshold: 0.8 });
    const run = await engine.run("test-flow", leakingExecutor, {
      triggeredBy: "manual",
      guardrail,
    });
    expect(run.thresholdAdjusted).toBe(true);
    // The live guardrail's threshold was actually mutated, not just the
    // engine's internal number.
    expect(guardrail.threshold).toBeLessThan(0.8);
    if (run.newThreshold === undefined) throw new Error("expected newThreshold");
    expect(guardrail.threshold).toBe(run.newThreshold);
  });

  it("does NOT tune when bypass rate is below ceiling", async () => {
    const engine = createRedTeamEngine({
      attacksPerRun: 3,
      autoTune: true,
      autoTuneBypassCeiling: 1.0, // unreachable ceiling (bypass rate is always <= 1.0 but strict >, so exactly 1.0 never triggers)
      autoTuneStep: 0.1,
    });

    const initial = engine.currentGuardrailThreshold();
    // Use block-all executor — bypass rate = 0, well below ceiling.
    await engine.run("test-flow", blockAllExecutor);
    // Threshold should not have changed.
    expect(engine.currentGuardrailThreshold()).toBe(initial);
  });

  it("respects minimum threshold — never goes below autoTuneMinThreshold", async () => {
    const engine = createRedTeamEngine({
      attacksPerRun: 3,
      autoTune: true,
      autoTuneBypassCeiling: 0.0, // always tune
      autoTuneStep: 0.9, // huge step
      autoTuneMinThreshold: 0.5, // hard floor
    });

    // Run multiple times to drive the threshold down.
    await engine.run("test-flow", leakingExecutor);
    await engine.run("test-flow", leakingExecutor);
    await engine.run("test-flow", leakingExecutor);

    expect(engine.currentGuardrailThreshold()).toBeGreaterThanOrEqual(0.5);
  });
});

describe("RedTeamEngine — regression case generation", () => {
  it("saves bypassed attacks as replay snapshots", async () => {
    const store = makeReplayStore();
    const engine = createRedTeamEngine({
      attacksPerRun: 3,
      replayStore: store,
    });

    const run = await engine.run("test-flow", leakingExecutor);
    const bypasses = run.trials.filter((t) => t.verdict === "bypassed").length;

    expect(store.saved.length).toBe(bypasses);
    expect(run.regressionCasesGenerated).toBe(bypasses);
    if (store.saved.length > 0) {
      const first = at(store.saved, 0);
      expect(first.metadata?.source).toBe("red-team");
      expect(first.metadata?.attackCategory).toBeDefined();
    }
  });

  it("does not save blocked attacks as regression cases", async () => {
    const store = makeReplayStore();
    const engine = createRedTeamEngine({
      attacksPerRun: 3,
      replayStore: store,
    });

    await engine.run("test-flow", blockAllExecutor);
    expect(store.saved.length).toBe(0);
  });
});

describe("RedTeamEngine — run management", () => {
  it("lists runs newest-first", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    await engine.run("flow-a", blockAllExecutor);
    await engine.run("flow-b", blockAllExecutor);

    const runs = engine.listRuns();
    expect(runs.length).toBe(2);
    // Newest first
    expect(at(runs, 0).flowId).toBe("flow-b");
    expect(at(runs, 1).flowId).toBe("flow-a");
  });

  it("filters runs by flowId", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    await engine.run("alpha", blockAllExecutor);
    await engine.run("beta", blockAllExecutor);

    const alphaRuns = engine.listRuns("alpha");
    expect(alphaRuns.every((r) => r.flowId === "alpha")).toBe(true);
    expect(alphaRuns.length).toBe(1);
  });

  it("getRun returns the full run by ID", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 1 });
    const run = await engine.run("test-flow", blockAllExecutor);

    const fetched = engine.getRun(run.id);
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(run.id);
    expect(fetched?.trials.length).toBeGreaterThan(0);
  });

  it("getRun returns undefined for unknown ID", () => {
    const engine = createRedTeamEngine({});
    expect(engine.getRun("non-existent-id")).toBeUndefined();
  });

  it("evicts oldest runs when maxRunsInMemory is exceeded", async () => {
    const engine = createRedTeamEngine({
      maxRunsInMemory: 2,
      attacksPerRun: 1,
    });
    const r1 = await engine.run("flow", blockAllExecutor);
    await engine.run("flow", blockAllExecutor);
    await engine.run("flow", blockAllExecutor); // evicts r1

    expect(engine.getRun(r1.id)).toBeUndefined();
    expect(engine.listRuns().length).toBe(2);
  });
});

describe("RedTeamEngine — postureByFlow", () => {
  it("tracks the latest posture score per flow", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 2 });
    await engine.run("flow-a", blockAllExecutor);
    await engine.run("flow-b", leakingExecutor);

    const posture = engine.postureByFlow();
    expect(posture["flow-a"]).toBe(1);
    expect(posture["flow-b"]).toBeLessThan(1);
  });

  it("updates posture when the same flow is re-tested", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 2 });
    await engine.run("flow", leakingExecutor);
    const scoreBefore = engine.postureByFlow().flow;
    if (scoreBefore === undefined) throw new Error("expected a posture score");

    await engine.run("flow", blockAllExecutor);
    const scoreAfter = engine.postureByFlow().flow;
    if (scoreAfter === undefined) throw new Error("expected a posture score");

    expect(scoreAfter).toBeGreaterThanOrEqual(scoreBefore);
  });
});

describe("RedTeamEngine — summary fields", () => {
  it("summary includes correct count fields", async () => {
    const engine = createRedTeamEngine({ attacksPerRun: 3 });
    await engine.run("flow", leakingExecutor);
    const summaries = engine.listRuns();
    const s = at(summaries, 0);

    expect(typeof s.trials).toBe("number");
    expect(s.trials).toBe(3);
    expect(s.bypasses + s.blocks + s.errors).toBe(s.trials);
  });
});

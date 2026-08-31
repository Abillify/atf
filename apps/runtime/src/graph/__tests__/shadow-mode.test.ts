// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for Shadow Mode continuous quality monitoring.
 */
import { describe, test, expect } from "bun:test";
import { createShadowModeService } from "../shadow-mode.js";
import type { Judge } from "../../eval/eval-runner.js";
import type { ReplayExecutor } from "../replay.js";

/** A judge that scores by a fixed map keyed on the response text. */
function scriptedJudge(scores: Record<string, number>): Judge {
  return async ({ response }) => ({
    score: scores[response] ?? 0.5,
    reasoning: "scripted",
  });
}

/** An executor that returns a fixed text for the shadow flow. */
function scriptedExecutor(text: string): ReplayExecutor {
  return async () => ({ text });
}

/** Waits for pending async shadow work to settle. */
async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** `svc.runner`, asserting a judge was configured so a runner exists. */
function mustRunner(svc: ReturnType<typeof createShadowModeService>) {
  if (svc.runner === undefined) throw new Error("expected a shadow runner");
  return svc.runner;
}

describe("ShadowMode", () => {
  test("records a comparison and aggregates stats", async () => {
    const svc = createShadowModeService({
      judge: scriptedJudge({ "PROD ANSWER": 0.6, "SHADOW ANSWER": 0.9 }),
      executor: scriptedExecutor("SHADOW ANSWER"),
    });
    svc.reload({
      flows: [{ productionFlow: "helpdesk", shadowFlow: "helpdesk-v2" }],
    });

    mustRunner(svc).maybeRunShadow(
      {
        productionFlow: "helpdesk",
        productionResponse: "PROD ANSWER",
        messages: [{ role: "user", content: "hi" }],
      },
      svc.configs(),
    );
    await tick();

    const stats = svc.statsFor("helpdesk");
    expect(stats).toBeDefined();
    if (stats === undefined) throw new Error("expected stats to be defined");
    expect(stats.totalComparisons).toBe(1);
    expect(stats.avgProductionScore).toBeCloseTo(0.6, 3);
    expect(stats.avgShadowScore).toBeCloseTo(0.9, 3);
    expect(stats.avgScoreDelta).toBeCloseTo(0.3, 3);
    expect(stats.improvementCount).toBe(1);
    expect(stats.regressionCount).toBe(0);
  });

  test("flags a regression when shadow scores notably lower", async () => {
    const svc = createShadowModeService({
      judge: scriptedJudge({ PROD: 0.9, SHADOW: 0.5 }),
      executor: scriptedExecutor("SHADOW"),
    });
    svc.reload({
      flows: [{ productionFlow: "f", shadowFlow: "f2", regressionDelta: 0.1 }],
    });

    mustRunner(svc).maybeRunShadow(
      {
        productionFlow: "f",
        productionResponse: "PROD",
        messages: [{ role: "user", content: "q" }],
      },
      svc.configs(),
    );
    await tick();

    const stats = svc.statsFor("f");
    if (stats === undefined) throw new Error("expected stats to be defined");
    expect(stats.regressionCount).toBe(1);
    expect(stats.avgScoreDelta).toBeCloseTo(-0.4, 3);
  });

  test("does not run when production flow has no shadow config", async () => {
    const svc = createShadowModeService({
      judge: scriptedJudge({}),
      executor: scriptedExecutor("X"),
    });
    svc.reload({ flows: [{ productionFlow: "other", shadowFlow: "other2" }] });

    mustRunner(svc).maybeRunShadow(
      { productionFlow: "helpdesk", productionResponse: "P", messages: [] },
      svc.configs(),
    );
    await tick();

    expect(svc.statsFor("helpdesk")).toBeUndefined();
    expect(svc.allStats().length).toBe(0);
  });

  test("respects the disabled flag", async () => {
    const svc = createShadowModeService({
      judge: scriptedJudge({}),
      executor: scriptedExecutor("X"),
    });
    svc.reload({
      flows: [{ productionFlow: "f", shadowFlow: "f2", disabled: true }],
    });
    mustRunner(svc).maybeRunShadow(
      { productionFlow: "f", productionResponse: "P", messages: [] },
      svc.configs(),
    );
    await tick();
    expect(svc.statsFor("f")).toBeUndefined();
  });

  test("no runner is created when no judge is configured", () => {
    const svc = createShadowModeService({ executor: scriptedExecutor("X") });
    expect(svc.runner).toBeUndefined();
    // Store still works for the dashboard route
    expect(svc.allStats()).toEqual([]);
  });

  test("reload parses only well-formed entries", () => {
    const svc = createShadowModeService({ executor: scriptedExecutor("X") });
    svc.reload({
      flows: [
        { productionFlow: "a", shadowFlow: "b" },
        { productionFlow: "missing-shadow" },
        { shadowFlow: "missing-prod" },
        "not-an-object",
      ],
    });
    const configs = svc.configs();
    expect(configs.length).toBe(1);
    const firstConfig = configs[0];
    if (firstConfig === undefined) throw new Error("expected a first config");
    expect(firstConfig.productionFlow).toBe("a");
  });

  test("shadow executor failure is swallowed (no stats recorded, no throw)", async () => {
    const failing: ReplayExecutor = async () => {
      throw new Error("shadow flow blew up");
    };
    const svc = createShadowModeService({
      judge: scriptedJudge({ P: 0.8 }),
      executor: failing,
    });
    svc.reload({ flows: [{ productionFlow: "f", shadowFlow: "f2" }] });
    mustRunner(svc).maybeRunShadow(
      { productionFlow: "f", productionResponse: "P", messages: [] },
      svc.configs(),
    );
    await tick();
    // Execution failed → no comparison recorded, but no crash.
    expect(svc.statsFor("f")).toBeUndefined();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the runtime canary rollout + auto-rollback.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  emptyStats,
  errorRate,
  meanScore,
  evaluateRollback,
  bucketOf,
  createCanaryManager,
} from "../canary.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

describe("pure stats", () => {
  test("errorRate / meanScore", () => {
    const s = { samples: 4, errors: 1, scoreSum: 3, scoreCount: 4 };
    expect(errorRate(s)).toBe(0.25);
    expect(meanScore(s)).toBe(0.75);
    expect(meanScore(emptyStats())).toBeUndefined();
    expect(errorRate(emptyStats())).toBe(0);
  });
});

describe("evaluateRollback", () => {
  const opts = { minSamples: 10, maxErrorRateDelta: 0.05, minScoreDelta: 0.05 };

  test("no rollback before minSamples", () => {
    const canary = { samples: 5, errors: 5, scoreSum: 0, scoreCount: 5 };
    expect(evaluateRollback(emptyStats(), canary, opts).rollback).toBe(false);
  });

  test("rolls back on error-rate regression", () => {
    const stable = { samples: 100, errors: 1, scoreSum: 0, scoreCount: 0 };
    const canary = { samples: 20, errors: 8, scoreSum: 0, scoreCount: 0 };
    const v = evaluateRollback(stable, canary, opts);
    expect(v.rollback).toBe(true);
    expect(v.reason).toContain("error rate");
  });

  test("rolls back on score regression", () => {
    const stable = { samples: 100, errors: 0, scoreSum: 90, scoreCount: 100 }; // 0.9
    const canary = { samples: 20, errors: 0, scoreSum: 14, scoreCount: 20 }; // 0.7
    const v = evaluateRollback(stable, canary, opts);
    expect(v.rollback).toBe(true);
    expect(v.reason).toContain("score");
  });

  test("no rollback when candidate is healthy", () => {
    const stable = { samples: 100, errors: 2, scoreSum: 80, scoreCount: 100 };
    const canary = { samples: 30, errors: 0, scoreSum: 27, scoreCount: 30 };
    expect(evaluateRollback(stable, canary, opts).rollback).toBe(false);
  });
});

describe("bucketOf", () => {
  test("is deterministic and within 0–99", () => {
    const a = bucketOf("conv-1");
    expect(a).toBe(bucketOf("conv-1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });
});

describe("CanaryManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(policy: unknown): void {
    fs.writeFileSync(path.join(dir, "canary.json"), JSON.stringify(policy));
  }

  test("no file → disabled, select is pass-through", () => {
    const mgr = createCanaryManager(dir);
    expect(mgr.enabled).toBe(false);
    const sel = mgr.select("my-flow", "k");
    expect(sel.flowId).toBe("my-flow");
    expect(sel.variant).toBe("stable");
    expect(sel.active).toBe(false);
  });

  test("routes a fraction to the candidate deterministically", () => {
    writePolicy({
      deployments: [
        { flow: "prod", candidate: "prod-v2", trafficPercent: 100 },
      ],
    });
    const mgr = createCanaryManager(dir);
    expect(mgr.enabled).toBe(true);
    const sel = mgr.select("prod", "anything");
    expect(sel.flowId).toBe("prod-v2");
    expect(sel.variant).toBe("canary");
  });

  test("0% traffic keeps everyone on stable", () => {
    writePolicy({
      deployments: [{ flow: "prod", candidate: "prod-v2", trafficPercent: 0 }],
    });
    const mgr = createCanaryManager(dir);
    expect(mgr.select("prod", "k").flowId).toBe("prod");
  });

  test("auto-rolls-back and then routes everyone to stable", () => {
    writePolicy({
      deployments: [
        {
          flow: "prod",
          candidate: "prod-v2",
          trafficPercent: 100,
          minSamples: 5,
          maxErrorRateDelta: 0.1,
        },
      ],
    });
    const mgr = createCanaryManager(dir);
    // Feed a healthy stable baseline and a failing canary.
    for (let i = 0; i < 20; i++) mgr.record("prod", "stable", { error: false });
    for (let i = 0; i < 10; i++) mgr.record("prod", "canary", { error: true });

    const status = at(mgr.status(), 0);
    expect(status.rolledBack).toBe(true);
    // After rollback, selection returns stable even at 100% traffic.
    expect(mgr.select("prod", "anything").flowId).toBe("prod");
  });

  test("autoRollback=false only records, never rolls back", () => {
    writePolicy({
      deployments: [
        {
          flow: "prod",
          candidate: "prod-v2",
          trafficPercent: 100,
          minSamples: 5,
          autoRollback: false,
        },
      ],
    });
    const mgr = createCanaryManager(dir);
    for (let i = 0; i < 10; i++) mgr.record("prod", "canary", { error: true });
    expect(at(mgr.status(), 0).rolledBack).toBe(false);
  });

  test("reload preserves stats for an unchanged deployment", () => {
    writePolicy({
      deployments: [{ flow: "prod", candidate: "prod-v2", trafficPercent: 50 }],
    });
    const mgr = createCanaryManager(dir);
    mgr.record("prod", "canary", { error: false, score: 0.9 });
    mgr.reload();
    expect(at(mgr.status(), 0).canary.samples).toBe(1);
  });

  test("malformed policy disables canary (fail-safe)", () => {
    fs.writeFileSync(path.join(dir, "canary.json"), "{ not json");
    const mgr = createCanaryManager(dir);
    expect(mgr.enabled).toBe(false);
  });
});

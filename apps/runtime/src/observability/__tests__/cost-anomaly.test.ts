// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for CostAnomalyDetector
 */

import { describe, it, expect } from "bun:test";
import { CostAnomalyDetector } from "../cost-anomaly.js";

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

function makeDetector(
  overrides: {
    spikeMultiplier?: number;
    minBaselineDays?: number;
    baselineDays?: number;
    minAbsolute?: number;
    cooldownMs?: number;
    windowMs?: number;
    now?: number;
  } = {},
) {
  let t = overrides.now ?? Date.now();
  const clock = () => t;
  const alerts: unknown[] = [];
  const sink = async (a: unknown) => {
    alerts.push(a);
    return true;
  };
  const detector = new CostAnomalyDetector({
    spikeMultiplier: overrides.spikeMultiplier ?? 3.0,
    minBaselineDays: overrides.minBaselineDays ?? 2,
    baselineDays: overrides.baselineDays ?? 5,
    minAbsolute: overrides.minAbsolute ?? 0.01,
    cooldownMs: overrides.cooldownMs ?? MS_PER_HOUR,
    windowMs: overrides.windowMs ?? MS_PER_HOUR,
    clock,
    sink,
  });
  return {
    detector,
    alerts,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

describe("CostAnomalyDetector", () => {
  it("does not fire without sufficient baseline history", async () => {
    const { detector, alerts } = makeDetector({ minBaselineDays: 3 });
    // Only 1 day of history — should not fire.
    await detector.observe("t1", 50);
    expect(alerts).toHaveLength(0);
  });

  it("does not fire when recent spend is within normal range", async () => {
    const { tick } = makeDetector({ now: 1719225600000 });
    // Build 3 days of baseline (1 USD/hour each day at hour 0)
    for (let d = 3; d >= 1; d--) {
      tick(-MS_PER_DAY); // go back
    }
    // Inject baseline data by advancing clock day by day
    const {
      detector: d2,
      alerts: a2,
      tick: t2,
    } = makeDetector({
      now: 1719225600000 - 3 * MS_PER_DAY,
      minBaselineDays: 2,
      spikeMultiplier: 3,
    });
    await d2.observe("t", 1.0);
    t2(MS_PER_DAY);
    await d2.observe("t", 1.0);
    t2(MS_PER_DAY);
    await d2.observe("t", 1.0);
    t2(MS_PER_DAY);
    // Now a normal spend of 1.5 USD (< 3× baseline of 1 USD)
    await d2.observe("t", 1.5);
    expect(a2).toHaveLength(0);
  });

  it("fires when recent spend exceeds multiplier × baseline", async () => {
    const startTs = 1719225600000 - 4 * MS_PER_DAY;
    const { detector, alerts, tick } = makeDetector({
      now: startTs,
      minBaselineDays: 2,
      spikeMultiplier: 3,
      minAbsolute: 0.01,
      cooldownMs: 1, // no cooldown for this test
    });
    // Build baseline: 1 USD/hour on days -3, -2, -1
    await detector.observe("tenant", 1.0);
    tick(MS_PER_DAY);
    await detector.observe("tenant", 1.0);
    tick(MS_PER_DAY);
    await detector.observe("tenant", 1.0);
    tick(MS_PER_DAY);
    // Now spike: 5 USD in the current window (> 3× baseline of 1 USD)
    await detector.observe("tenant", 5.0);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0] as {
      type: string;
      tenant: string;
      multiplier: number;
    };
    expect(alert.type).toBe("cost_anomaly");
    expect(alert.tenant).toBe("tenant");
    expect(alert.multiplier).toBeGreaterThan(3);
  });

  it("respects per-tenant cooldown — does not re-fire within cooldown window", async () => {
    const { detector, alerts, tick } = makeDetector({
      now: 1719225600000 - 4 * MS_PER_DAY,
      minBaselineDays: 2,
      spikeMultiplier: 2,
      cooldownMs: MS_PER_HOUR,
    });
    await detector.observe("t", 1);
    tick(MS_PER_DAY);
    await detector.observe("t", 1);
    tick(MS_PER_DAY);
    await detector.observe("t", 1);
    tick(MS_PER_DAY);
    // First spike — should fire
    await detector.observe("t", 5);
    tick(60_000); // 1 min later
    // Second spike within cooldown — should NOT fire
    await detector.observe("t", 5);
    expect(alerts).toHaveLength(1);
  });

  it("fires again after cooldown expires", async () => {
    const { detector, alerts, tick } = makeDetector({
      now: 1719225600000 - 4 * MS_PER_DAY,
      minBaselineDays: 2,
      spikeMultiplier: 2,
      cooldownMs: 30_000, // 30 s cooldown
    });
    await detector.observe("t", 1);
    tick(MS_PER_DAY);
    await detector.observe("t", 1);
    tick(MS_PER_DAY);
    await detector.observe("t", 1);
    tick(MS_PER_DAY);
    await detector.observe("t", 5);
    tick(60_000); // fires, then 60 s (> 30 s)
    await detector.observe("t", 5); // should fire again
    expect(alerts).toHaveLength(2);
  });

  it("does not fire when spend is below minAbsoluteUsd", async () => {
    const { detector, alerts, tick } = makeDetector({
      now: 1719225600000 - 4 * MS_PER_DAY,
      minBaselineDays: 2,
      spikeMultiplier: 2,
      minAbsolute: 1.0,
    });
    await detector.observe("t", 0.01);
    tick(MS_PER_DAY);
    await detector.observe("t", 0.01);
    tick(MS_PER_DAY);
    await detector.observe("t", 0.01);
    tick(MS_PER_DAY);
    // 0.1 USD × 5 = 0.5 USD — spike ratio is huge but absolute < 1 USD
    await detector.observe("t", 0.1);
    expect(alerts).toHaveLength(0);
  });

  it("tracks multiple tenants independently", async () => {
    const { detector, alerts, tick } = makeDetector({
      now: 1719225600000 - 4 * MS_PER_DAY,
      minBaselineDays: 2,
      spikeMultiplier: 3,
      cooldownMs: 1,
    });
    await detector.observe("a", 1);
    await detector.observe("b", 1);
    tick(MS_PER_DAY);
    await detector.observe("a", 1);
    await detector.observe("b", 1);
    tick(MS_PER_DAY);
    await detector.observe("a", 1);
    await detector.observe("b", 1);
    tick(MS_PER_DAY);
    // Spike only tenant a
    await detector.observe("a", 10);
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { tenant: string }).tenant).toBe("a");
  });

  it("ignores zero or negative spend", async () => {
    const { detector, alerts } = makeDetector();
    await detector.observe("t", 0);
    await detector.observe("t", -1);
    expect(alerts).toHaveLength(0);
  });

  it("exposes stats with event counts", async () => {
    const { detector, tick } = makeDetector({
      now: 1719225600000 - MS_PER_DAY,
    });
    await detector.observe("t1", 0.5);
    tick(1000);
    await detector.observe("t1", 0.3);
    const stats = detector.stats();
    expect(stats.t1).toBeDefined();
    const t1Stats = stats.t1;
    if (t1Stats === undefined) throw new Error("expected stats for t1");
    expect(t1Stats.events).toBeGreaterThanOrEqual(2);
  });
});

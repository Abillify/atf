// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for budget alerts & webhooks (`src/observability/budget-alerts.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  BudgetAlerter,
  createWebhookSink,
  type BudgetAlert,
} from "../budget-alerts.js";

function collectingSink(): {
  sink: (a: BudgetAlert) => Promise<boolean>;
  alerts: BudgetAlert[];
} {
  const alerts: BudgetAlert[] = [];
  return {
    alerts,
    sink: async (a) => {
      alerts.push(a);
      return true;
    },
  };
}

describe("BudgetAlerter", () => {
  it("is inert when no cap or no thresholds", async () => {
    const { sink, alerts } = collectingSink();
    const a = new BudgetAlerter({ thresholds: [], cap: 100, sink });
    expect(a.active).toBe(false);
    await a.observe("t1", 100);
    expect(alerts).toHaveLength(0);

    const b = new BudgetAlerter({ thresholds: [0.5], cap: 0, sink });
    expect(b.active).toBe(false);
  });

  it("fires once when a threshold is crossed", async () => {
    const { sink, alerts } = collectingSink();
    const a = new BudgetAlerter({ thresholds: [0.8], cap: 100, sink });
    await a.observe("t1", 50); // 50% — below
    expect(alerts).toHaveLength(0);
    await a.observe("t1", 85); // 85% — crosses 0.8
    expect(alerts).toHaveLength(1);
    const alert0 = alerts[0];
    if (alert0 === undefined) throw new Error("expected an alert");
    expect(alert0.threshold).toBe(0.8);
    expect(alert0.utilization).toBe(0.85);
    // Further updates above the threshold do not re-fire.
    await a.observe("t1", 90);
    expect(alerts).toHaveLength(1);
  });

  it("fires each configured threshold exactly once, low → high", async () => {
    const { sink, alerts } = collectingSink();
    const a = new BudgetAlerter({
      thresholds: [1.0, 0.5, 0.8],
      cap: 100,
      sink,
    });
    await a.observe("t1", 100); // crosses all three at once
    expect(alerts.map((x) => x.threshold)).toEqual([0.5, 0.8, 1.0]);
  });

  it("isolates tenants", async () => {
    const { sink, alerts } = collectingSink();
    const a = new BudgetAlerter({ thresholds: [0.5], cap: 100, sink });
    await a.observe("t1", 60);
    await a.observe("t2", 60);
    expect(alerts.map((x) => x.tenant).sort()).toEqual(["t1", "t2"]);
  });

  it("resets fired thresholds when the window rolls over", async () => {
    let now = 0;
    const { sink, alerts } = collectingSink();
    const a = new BudgetAlerter({
      thresholds: [0.5],
      cap: 100,
      sink,
      windowMs: 1000,
      clock: () => now,
    });
    await a.observe("t1", 60);
    expect(alerts).toHaveLength(1);
    now += 1001; // window rolled over
    await a.observe("t1", 60);
    expect(alerts).toHaveLength(2);
  });

  it("allows a retry on the next crossing when the sink fails", async () => {
    let attempt = 0;
    const a = new BudgetAlerter({
      thresholds: [0.5],
      cap: 100,
      sink: async () => {
        attempt++;
        return attempt > 1; // first delivery fails, second succeeds
      },
    });
    const first = await a.observe("t1", 60);
    expect(first).toHaveLength(0); // failed → not counted as dispatched
    const second = await a.observe("t1", 70);
    expect(second).toHaveLength(1); // retried and succeeded
  });

  it("swallows sink exceptions and permits retry", async () => {
    let attempt = 0;
    const a = new BudgetAlerter({
      thresholds: [0.5],
      cap: 100,
      sink: async () => {
        attempt++;
        if (attempt === 1) throw new Error("boom");
        return true;
      },
    });
    await a.observe("t1", 60); // throws internally, swallowed
    const retried = await a.observe("t1", 60);
    expect(retried).toHaveLength(1);
  });
});

describe("createWebhookSink", () => {
  it("POSTs JSON and treats 2xx as success", async () => {
    let captured: { url: string; body: string } | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      captured = { url, body: String(init?.body) };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const sink = createWebhookSink("https://hook.example/budget", {
      fetchImpl: fakeFetch,
    });
    const ok = await sink({
      type: "budget_threshold",
      tenant: "t1",
      threshold: 0.8,
      spent: 80,
      cap: 100,
      utilization: 0.8,
      at: new Date(0).toISOString(),
    });
    expect(ok).toBe(true);
    expect(captured?.url).toBe("https://hook.example/budget");
    if (captured === undefined) throw new Error("expected a captured fetch call");
    expect(JSON.parse(captured.body).tenant).toBe("t1");
  });

  it("returns false on a non-2xx response", async () => {
    const fakeFetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const sink = createWebhookSink("https://hook.example", {
      fetchImpl: fakeFetch,
    });
    const ok = await sink({
      type: "budget_threshold",
      tenant: "t1",
      threshold: 1,
      spent: 100,
      cap: 100,
      utilization: 1,
      at: new Date(0).toISOString(),
    });
    expect(ok).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const sink = createWebhookSink("https://hook.example", {
      fetchImpl: fakeFetch,
    });
    expect(
      await sink({
        type: "budget_threshold",
        tenant: "t1",
        threshold: 1,
        spent: 100,
        cap: 100,
        utilization: 1,
        at: new Date(0).toISOString(),
      }),
    ).toBe(false);
  });
});

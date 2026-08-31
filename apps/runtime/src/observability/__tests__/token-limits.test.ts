// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for configurable token limits + consumption
 * (src/observability/token-limits.ts). DB-free: uses the in-memory store and a
 * stub analytics.
 */

import { describe, test, expect } from "bun:test";
import {
  InMemoryTokenLimitStore,
  TokenLimitService,
  TokenLimitEnforcer,
  parseLimitInput,
  periodWindowStart,
  type UsageAnalytics,
  type TokenUsageTotals,
  type UsageSeriesPoint,
} from "../token-limits.js";

const zero: TokenUsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cost: 0,
};

class StubAnalytics implements UsageAnalytics {
  constructor(private readonly totalsValue: TokenUsageTotals) {}
  async totals(): Promise<TokenUsageTotals> {
    return this.totalsValue;
  }
  async series(): Promise<UsageSeriesPoint[]> {
    return [];
  }
  async distinctModels(): Promise<string[]> {
    return [];
  }
  async byModel() {
    return {};
  }
}

/** Analytics returning a fixed total-token count (cost ignored). */
function analyticsWithTokens(totalTokens: number): UsageAnalytics {
  return new StubAnalytics({
    promptTokens: totalTokens,
    completionTokens: 0,
    totalTokens,
    cost: 0,
  });
}

describe("parseLimitInput", () => {
  test("accepts a valid global limit", () => {
    const r = parseLimitInput({
      scopeType: "global",
      period: "day",
      limitTokens: 1000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scopeId).toBeNull();
      expect(r.value.model).toBeNull();
      expect(r.value.limitTokens).toBe(1000);
    }
  });

  test("requires a scopeId for user/flow scopes", () => {
    const r = parseLimitInput({
      scopeType: "user",
      period: "week",
      limitTokens: 5,
    });
    expect(r.ok).toBe(false);
  });

  test("rejects bad period / non-positive limit", () => {
    expect(
      parseLimitInput({ scopeType: "global", period: "year", limitTokens: 1 })
        .ok,
    ).toBe(false);
    expect(
      parseLimitInput({ scopeType: "global", period: "day", limitTokens: 0 })
        .ok,
    ).toBe(false);
  });

  test("normalises an empty model to null (all models)", () => {
    const r = parseLimitInput({
      scopeType: "flow",
      scopeId: "helpdesk",
      model: "",
      period: "month",
      limitTokens: 42,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.model).toBeNull();
  });
});

describe("periodWindowStart", () => {
  test("computes rolling windows back from now", () => {
    const now = 1_000_000_000_000;
    expect(periodWindowStart("day", now).getTime()).toBe(now - 864e5);
    expect(periodWindowStart("week", now).getTime()).toBe(now - 7 * 864e5);
    expect(periodWindowStart("month", now).getTime()).toBe(now - 30 * 864e5);
  });
});

describe("InMemoryTokenLimitStore", () => {
  test("upsert updates the existing rule for the same combo", async () => {
    const store = new InMemoryTokenLimitStore();
    const a = await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 100,
    });
    const b = await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 250,
    });
    expect(b.id).toBe(a.id); // same combo → same row
    expect(b.limitTokens).toBe(250);
    expect((await store.list()).length).toBe(1);
  });

  test("different combos create separate rules", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 100,
    });
    await store.upsert({
      scopeType: "user",
      scopeId: "u1",
      period: "day",
      limitTokens: 100,
    });
    await store.upsert({
      scopeType: "flow",
      scopeId: "helpdesk",
      model: "gpt-4o",
      period: "month",
      limitTokens: 100,
    });
    expect((await store.list()).length).toBe(3);
  });

  test("update by id and remove", async () => {
    const store = new InMemoryTokenLimitStore();
    const created = await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 100,
    });
    const updated = await store.update(created.id, {
      scopeType: "global",
      period: "week",
      limitTokens: 999,
    });
    expect(updated?.period).toBe("week");
    expect(updated?.limitTokens).toBe(999);
    expect(await store.remove(created.id)).toBe(true);
    expect(await store.remove(created.id)).toBe(false);
  });
});

describe("TokenLimitService.listWithConsumption", () => {
  test("pairs each limit with its consumption + fraction", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 1000,
    });
    const analytics = new StubAnalytics({
      promptTokens: 200,
      completionTokens: 50,
      totalTokens: 250,
      cost: 0.01,
    });
    const service = new TokenLimitService(store, analytics);
    const [c] = await service.listWithConsumption();
    expect(c?.used.totalTokens).toBe(250);
    expect(c?.usedFraction).toBeCloseTo(0.25, 6);
    expect(typeof c?.windowStart).toBe("string");
  });

  test("usedFraction is 0 when a limit is somehow 0", async () => {
    const store = new InMemoryTokenLimitStore();
    // parseLimitInput blocks 0, but the service must not divide by zero.
    await store.upsert({ scopeType: "global", period: "day", limitTokens: 1 });
    const [only] = await store.list();
    if (only === undefined) throw new Error("expected a stored limit");
    await store.update(only.id, {
      scopeType: "global",
      period: "day",
      limitTokens: 1,
    });
    const service = new TokenLimitService(store, new StubAnalytics(zero));
    const [c] = await service.listWithConsumption();
    expect(c?.usedFraction).toBe(0);
  });
});

describe("TokenLimitEnforcer", () => {
  test("admits when no limits are configured", async () => {
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(
        new InMemoryTokenLimitStore(),
        analyticsWithTokens(999),
      ),
    );
    expect(await enforcer.check({ userId: "u1", flowId: "f1" })).toBeNull();
  });

  test("blocks when a global limit is exhausted", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 100,
    });
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(store, analyticsWithTokens(150)),
    );
    const v = await enforcer.check({ userId: "u1", flowId: "f1" });
    expect(v).not.toBeNull();
    expect(v?.usedTokens).toBe(150);
    expect(v?.limitTokens).toBe(100);
    expect(v?.limit.scopeType).toBe("global");
  });

  test("admits when under the limit", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      period: "day",
      limitTokens: 1000,
    });
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(store, analyticsWithTokens(150)),
    );
    expect(await enforcer.check({ userId: "u1", flowId: "f1" })).toBeNull();
  });

  test("a user limit only applies to the matching user", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "user",
      scopeId: "alice",
      period: "day",
      limitTokens: 100,
    });
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(store, analyticsWithTokens(150)),
    );
    expect(await enforcer.check({ userId: "bob", flowId: "f1" })).toBeNull();
    expect(
      await enforcer.check({ userId: "alice", flowId: "f1" }),
    ).not.toBeNull();
  });

  test("a model-specific limit only applies when the request uses that model", async () => {
    const store = new InMemoryTokenLimitStore();
    await store.upsert({
      scopeType: "global",
      model: "gpt-4o",
      period: "day",
      limitTokens: 100,
    });
    const enforcer = new TokenLimitEnforcer(
      new TokenLimitService(store, analyticsWithTokens(150)),
    );
    // Request that can't use gpt-4o → not enforced.
    expect(
      await enforcer.check({ flowId: "f1", models: ["claude-sonnet"] }),
    ).toBeNull();
    // Request that can use gpt-4o → blocked.
    expect(
      await enforcer.check({
        flowId: "f1",
        models: ["claude-sonnet", "gpt-4o"],
      }),
    ).not.toBeNull();
    // No model info → model-specific limit skipped.
    expect(await enforcer.check({ flowId: "f1" })).toBeNull();
  });
});

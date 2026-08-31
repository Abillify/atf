// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for durable cost persistence + BudgetService (src/observability/cost.ts).
 *
 * Exercises the budget facade against a fake CostStore so the durable path
 * (authoritative window reads, write-through, fail-open) is covered without a
 * real Postgres, plus the token-estimation fallback.
 */

import { describe, test, expect } from "bun:test";
import {
  BudgetService,
  estimateTokensFromText,
  type CostStore,
  type CostDetail,
} from "../cost.js";

class FakeCostStore implements CostStore {
  readonly writes: Array<{ tenant: string; usd: number; detail?: CostDetail }> =
    [];
  private readonly windowByTenant = new Map<string, number>();
  failing = false;

  setSpend(tenant: string, usd: number): void {
    this.windowByTenant.set(tenant, usd);
  }

  async record(
    tenant: string,
    usd: number,
    detail?: CostDetail,
  ): Promise<void> {
    if (this.failing) throw new Error("db down");
    this.writes.push({ tenant, usd, detail });
    this.windowByTenant.set(
      tenant,
      (this.windowByTenant.get(tenant) ?? 0) + usd,
    );
  }

  async getWindowSpend(tenant: string): Promise<number> {
    if (this.failing) throw new Error("db down");
    return this.windowByTenant.get(tenant) ?? 0;
  }

  async snapshot(): Promise<Array<{ tenant: string; spent: number }>> {
    return [...this.windowByTenant.entries()].map(([tenant, spent]) => ({
      tenant,
      spent,
    }));
  }

  async snapshotByUser(): Promise<
    Array<{ userId: string; label: string; spent: number }>
  > {
    const byUser = new Map<string, { label: string; spent: number }>();
    for (const w of this.writes) {
      const userId = w.detail?.userId;
      if (userId === undefined) continue;
      const cur = byUser.get(userId) ?? {
        label: w.detail?.userLabel ?? userId,
        spent: 0,
      };
      cur.spent += w.usd;
      if (w.detail?.userLabel !== undefined) cur.label = w.detail.userLabel;
      byUser.set(userId, cur);
    }
    return [...byUser.entries()].map(([userId, v]) => ({ userId, ...v }));
  }

  async snapshotByFlow(): Promise<Array<{ flowId: string; spent: number }>> {
    const byFlow = new Map<string, number>();
    for (const w of this.writes) {
      const flowId = w.detail?.flowId;
      if (flowId === undefined) continue;
      byFlow.set(flowId, (byFlow.get(flowId) ?? 0) + w.usd);
    }
    return [...byFlow.entries()].map(([flowId, spent]) => ({
      flowId,
      spent,
    }));
  }
}

describe("estimateTokensFromText", () => {
  test("uses the ~4-chars-per-token heuristic", () => {
    expect(estimateTokensFromText("12345678")).toBe(2); // 8/4
    expect(estimateTokensFromText("abc")).toBe(1); // ceil(3/4)
  });
  test("returns 0 for empty/whitespace", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText("   ")).toBe(0);
  });
});

describe("BudgetService — durable (store-backed)", () => {
  test("reports durable=true when a store is present", () => {
    const svc = new BudgetService(10, new FakeCostStore());
    expect(svc.durable).toBe(true);
    svc.stop();
  });

  test("check reads authoritative spend from the store", async () => {
    const store = new FakeCostStore();
    const svc = new BudgetService(1.0, store);
    store.setSpend("acme", 0.5);
    expect((await svc.check("acme")).allowed).toBe(true);
    store.setSpend("acme", 1.25);
    const decision = await svc.check("acme");
    expect(decision.allowed).toBe(false);
    expect(decision.spent).toBeCloseTo(1.25, 6);
    svc.stop();
  });

  test("record writes through to the store with detail", () => {
    const store = new FakeCostStore();
    const svc = new BudgetService(10, store);
    svc.record("acme", 0.25, {
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 10,
      completionTokens: 5,
    });
    // Write-through is fire-and-forget; allow the microtask to flush.
    return Promise.resolve().then(() => {
      expect(store.writes.length).toBe(1);
      expect(store.writes[0]?.tenant).toBe("acme");
      expect(store.writes[0]?.detail?.model).toBe("gpt-4o");
      svc.stop();
    });
  });

  test("check fails OPEN when the store errors", async () => {
    const store = new FakeCostStore();
    store.failing = true;
    const svc = new BudgetService(1.0, store);
    const decision = await svc.check("acme");
    expect(decision.allowed).toBe(true);
    svc.stop();
  });

  test("no cap configured always allows", async () => {
    const svc = new BudgetService(0, new FakeCostStore());
    expect((await svc.check("acme")).allowed).toBe(true);
    svc.stop();
  });
});

describe("BudgetService — in-memory fallback (no store)", () => {
  test("enforces the cap using the in-memory mirror", async () => {
    const svc = new BudgetService(1.0);
    expect(svc.durable).toBe(false);
    svc.record("acme", 1.25);
    const decision = await svc.check("acme");
    expect(decision.allowed).toBe(false);
    svc.stop();
  });
});

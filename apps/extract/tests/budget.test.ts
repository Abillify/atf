// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * budget.test.ts
 *
 * Unit tests for the DB-backed token-budget ledger.
 *
 * The ledger's `consume` records a ONE-TIME warning when cumulative
 * `tokens_used` first crosses 80 % of `token_budget` — the heads-up before the
 * stage runner's 100 % hard cap parks the job in `paused(reason=budget)`. These
 * tests drive it over the in-memory fake store (no live database needed) and
 * assert the warning fires exactly once, on the crossing increment, and never
 * for an unbounded job.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BUDGET_WARN_MARKER,
  createDbBudgetLedger,
  createTenantDailyPageBudget,
  tenantDailyBudgetFailureMessage,
  utcDayKey,
} from "../src/jobs/budget.js";
import { createFakeJobStore } from "./job-store-fake.js";

async function seedBudgetedJob(
  store: ReturnType<typeof createFakeJobStore>,
  tokenBudget: number | null,
): Promise<string> {
  const id = randomUUID();
  await store.createJob({
    id,
    reference: "tests/budget.pdf",
    source_sha256: "a".repeat(64),
    ...(tokenBudget !== null ? { token_budget: tokenBudget } : {}),
  });
  return id;
}

describe("createDbBudgetLedger · 80 % budget warning (requirement 6.6)", () => {
  it("records a single warning on the increment that crosses 80 %", async () => {
    const store = createFakeJobStore();
    const jobId = await seedBudgetedJob(store, 1000);
    const ledger = createDbBudgetLedger(store, jobId);

    // Below the line: no warning yet (700/1000 = 70 %).
    await ledger.consume(700);
    expect(store.peek(jobId)?.warnings).toHaveLength(0);

    // This increment crosses 80 % (700 → 850): warning fires once.
    await ledger.consume(150);
    const after = store.peek(jobId);
    expect(after?.warnings).toHaveLength(1);
    expect(after?.warnings[0]).toContain("Token-Budget");
    expect(after?.warnings[0]).toMatch(/\d+%/);
    // The fire-once marker is set on the config.
    expect(after?.config?.[BUDGET_WARN_MARKER]).toBe(true);
  });

  it("does not re-warn on later increments after the crossing", async () => {
    const store = createFakeJobStore();
    const jobId = await seedBudgetedJob(store, 1000);
    const ledger = createDbBudgetLedger(store, jobId);

    await ledger.consume(850); // crosses 80 % on the first spend
    expect(store.peek(jobId)?.warnings).toHaveLength(1);

    // Every further spend (even past 100 %) adds no new warning — the 100 %
    // pause is the stage runner's guard, not this ledger's job.
    await ledger.consume(100);
    await ledger.consume(100);
    expect(store.peek(jobId)?.warnings).toHaveLength(1);
  });

  it("warns only when the threshold is actually crossed, not merely reached from above", async () => {
    const store = createFakeJobStore();
    const jobId = await seedBudgetedJob(store, 1000);
    const ledger = createDbBudgetLedger(store, jobId);

    // A single spend that lands exactly on 80 % counts as a crossing (>=).
    await ledger.consume(800);
    expect(store.peek(jobId)?.warnings).toHaveLength(1);
  });

  it("never warns for a job with no token budget (unbounded)", async () => {
    const store = createFakeJobStore();
    const jobId = await seedBudgetedJob(store, null);
    const ledger = createDbBudgetLedger(store, jobId);

    await ledger.consume(1_000_000);
    const after = store.peek(jobId);
    expect(after?.warnings).toHaveLength(0);
    expect(after?.config?.[BUDGET_WARN_MARKER]).toBeUndefined();
  });

  it("remaining() reads budget − used and floors at zero", async () => {
    const store = createFakeJobStore();
    const jobId = await seedBudgetedJob(store, 1000);
    const ledger = createDbBudgetLedger(store, jobId);

    expect(await ledger.remaining()).toBe(1000);
    await ledger.consume(1200); // overspend
    expect(await ledger.remaining()).toBe(0);
  });

  it("an unbounded job reports null remaining (no cap)", async () => {
    const store = createFakeJobStore();
    const jobId = await seedBudgetedJob(store, null);
    const ledger = createDbBudgetLedger(store, jobId);
    expect(await ledger.remaining()).toBeNull();
  });
});

// The per-tenant, per-UTC-day VLM page ledger.
// Same fake store as above — the ledger's contract is the counter, the
// refusal, and the sticky exhaustion, none of which need Postgres.
describe("createTenantDailyPageBudget (task 7.7, requirement 5.8)", () => {
  const DAY_1 = new Date("2026-02-03T10:00:00Z");
  const DAY_2 = new Date("2026-02-04T00:00:01Z");

  it("counts consumed pages against the tenant's UTC day", async () => {
    const store = createFakeJobStore();
    const ledger = createTenantDailyPageBudget(store, {
      tenantId: "acme",
      limit: 5,
      now: () => DAY_1,
    });

    expect(await ledger.tryConsumePage()).toBe(true);
    expect(await ledger.tryConsumePage()).toBe(true);
    expect(ledger.isExhausted()).toBe(false);
    expect(store.peekVisionDailyUsage("acme", utcDayKey(DAY_1))).toBe(2);
    // A different day bucket is untouched — the counter is per UTC day.
    expect(store.peekVisionDailyUsage("acme", utcDayKey(DAY_2))).toBe(0);
  });

  it("refuses the page that would cross the limit and sticks", async () => {
    const store = createFakeJobStore();
    const ledger = createTenantDailyPageBudget(store, {
      tenantId: "acme",
      limit: 2,
      now: () => DAY_1,
    });

    expect(await ledger.tryConsumePage()).toBe(true);
    expect(await ledger.tryConsumePage()).toBe(true);
    // The third page would exceed 2: refused, counter unchanged, exhausted.
    expect(await ledger.tryConsumePage()).toBe(false);
    expect(ledger.isExhausted()).toBe(true);
    expect(store.peekVisionDailyUsage("acme", utcDayKey(DAY_1))).toBe(2);
    // Once exhausted the ledger short-circuits — no further store traffic.
    expect(await ledger.tryConsumePage()).toBe(false);
    expect(store.peekVisionDailyUsage("acme", utcDayKey(DAY_1))).toBe(2);
  });

  it("resets when the UTC day rolls over", async () => {
    const store = createFakeJobStore();
    let current = DAY_1;
    const ledger = createTenantDailyPageBudget(store, {
      tenantId: "acme",
      limit: 1,
      now: () => current,
    });

    expect(await ledger.tryConsumePage()).toBe(true);
    expect(await ledger.tryConsumePage()).toBe(false);

    // New UTC day: the exhausted flag belongs to the old bucket and must not
    // carry over — the tenant gets its full allowance again.
    current = DAY_2;
    expect(ledger.isExhausted()).toBe(false);
    expect(await ledger.tryConsumePage()).toBe(true);
    expect(store.peekVisionDailyUsage("acme", utcDayKey(DAY_2))).toBe(1);
  });

  it("treats limit 0 as unlimited", async () => {
    const store = createFakeJobStore();
    const ledger = createTenantDailyPageBudget(store, {
      tenantId: "acme",
      limit: 0,
      now: () => DAY_1,
    });

    for (let i = 0; i < 10; i++) {
      expect(await ledger.tryConsumePage()).toBe(true);
    }
    expect(ledger.isExhausted()).toBe(false);
    // The unlimited path never touches the store at all.
    expect(store.peekVisionDailyUsage("acme", utcDayKey(DAY_1))).toBe(0);
  });

  it("exempts jobs with no attributable tenant", async () => {
    const store = createFakeJobStore();
    for (const tenantId of [null, undefined, ""]) {
      const ledger = createTenantDailyPageBudget(store, {
        tenantId,
        limit: 1,
        now: () => DAY_1,
      });
      expect(await ledger.tryConsumePage()).toBe(true);
      expect(await ledger.tryConsumePage()).toBe(true);
      expect(ledger.isExhausted()).toBe(false);
    }
  });

  it("keeps tenants apart", async () => {
    const store = createFakeJobStore();
    const acme = createTenantDailyPageBudget(store, {
      tenantId: "acme",
      limit: 1,
      now: () => DAY_1,
    });
    const globex = createTenantDailyPageBudget(store, {
      tenantId: "globex",
      limit: 1,
      now: () => DAY_1,
    });

    expect(await acme.tryConsumePage()).toBe(true);
    expect(await acme.tryConsumePage()).toBe(false);
    // acme being out of budget says nothing about globex.
    expect(await globex.tryConsumePage()).toBe(true);
  });

  it("names the error code and the configured limit in the failure text", () => {
    const message = tenantDailyBudgetFailureMessage(3000);
    expect(message).toContain("BUDGET_EXCEEDED");
    expect(message).toContain("VISION_BUDGET_PAGES_PER_DAY=3000");
  });

  it("utcDayKey buckets by UTC calendar day", () => {
    expect(utcDayKey(new Date("2026-02-03T23:59:59Z"))).toBe("2026-02-03");
    expect(utcDayKey(new Date("2026-02-04T00:00:00Z"))).toBe("2026-02-04");
  });
});

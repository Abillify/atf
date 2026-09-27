// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * budget.test.ts
 *
 * Unit tests for the DB-backed token-budget ledger (task 5.2, requirement 6.6).
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

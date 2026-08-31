// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for usage metering + billing export (`src/observability/billing.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  InMemoryUsageMeter,
  PostgresUsageMeter,
  toStripeUsageRecord,
  createUsageMeter,
  type UsageIncrement,
} from "../billing.js";
import type { Database } from "../../db/database.js";

const inc = (
  tenantId: string,
  provider = "openai",
  model = "gpt-4o-mini",
): UsageIncrement => ({
  tenantId,
  provider,
  model,
  promptTokens: 100,
  completionTokens: 50,
  cost: 0.0001,
});

describe("InMemoryUsageMeter", () => {
  it("records and aggregates by tenant+model", async () => {
    const m = new InMemoryUsageMeter();
    m.record(inc("t1"));
    m.record(inc("t1"));
    m.record(inc("t2", "google", "gemini-2.0-flash"));

    const t1 = await m.getTenantUsage("t1");
    expect(t1).toHaveLength(1);
    const t1Usage = t1[0];
    if (t1Usage === undefined) throw new Error("expected usage for t1");
    expect(t1Usage.promptTokens).toBe(200);
    expect(t1Usage.requestCount).toBe(2);
    expect(t1Usage.provider).toBe("openai");

    const t2 = await m.getTenantUsage("t2");
    const t2Usage = t2[0];
    if (t2Usage === undefined) throw new Error("expected usage for t2");
    expect(t2Usage.provider).toBe("google");
  });

  it("getSummary aggregates across models and provides a breakdown", async () => {
    const m = new InMemoryUsageMeter();
    m.record(inc("t1", "openai", "gpt-4o-mini"));
    m.record(inc("t1", "google", "gemini-2.0-flash"));
    const today = new Date().toISOString().slice(0, 10);
    const summary = await m.getSummary("t1", today);
    expect(summary.totalRequests).toBe(2);
    expect(summary.breakdown).toHaveLength(2);
    expect(summary.totalPromptTokens).toBe(200);
  });

  it("flush is a no-op", async () => {
    const m = new InMemoryUsageMeter();
    await expect(m.flush()).resolves.toBeUndefined();
  });
});

describe("PostgresUsageMeter", () => {
  it("buffers records and flushes with UPSERT SQL", async () => {
    const upserts: unknown[][] = [];
    const db: Database = {
      async query<T = Record<string, unknown>>(
        text: string,
        params?: readonly unknown[],
      ): Promise<T[]> {
        if (/^INSERT/i.test(text.trim())) upserts.push([...(params ?? [])]);
        if (/SELECT.*billing_usage/is.test(text)) {
          return [
            {
              tenant_id: "t1",
              period_start: "2026-01-01",
              provider: "openai",
              model: "gpt-4o-mini",
              prompt_tokens: 100,
              completion_tokens: 50,
              cost: "0.000100",
              request_count: 1,
            },
          ] as T[];
        }
        return [] as T[];
      },
      async close() {},
      async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
        return cb(this);
      },
    };
    const m = new PostgresUsageMeter(db, 999_999); // very long flush interval
    m.record(inc("t1"));
    m.record(inc("t1")); // same key → buffered in one entry
    await m.flush();

    expect(upserts).toHaveLength(1);
    const upsert0 = upserts[0];
    if (upsert0 === undefined) throw new Error("expected an upsert call");
    expect(upsert0[0]).toBe("t1");
    expect(upsert0[4]).toBe(200); // 2 × 100 prompt tokens

    const usage = await m.getTenantUsage("t1");
    const usage0 = usage[0];
    if (usage0 === undefined) throw new Error("expected usage for t1");
    expect(usage0.tenantId).toBe("t1");
  });
});

describe("toStripeUsageRecord", () => {
  it("produces a Stripe-compatible usage record", () => {
    const rec = toStripeUsageRecord({
      tenantId: "acme",
      periodStart: "2026-01-01",
      totalPromptTokens: 1000,
      totalCompletionTokens: 500,
      totalCost: 0.001,
      totalRequests: 5,
      breakdown: [
        {
          provider: "openai",
          model: "gpt-4o-mini",
          promptTokens: 1000,
          completionTokens: 500,
          cost: 0.001,
          requestCount: 5,
        },
      ],
    });
    expect(rec.action).toBe("increment");
    expect(rec.quantity).toBe(1500); // total tokens
    expect(rec.metadata.tenant_id).toBe("acme");
    expect(rec.metadata.cost).toBe("0.001000");
    expect(rec.metadata.providers).toBe("openai");
    expect(typeof rec.timestamp).toBe("number");
  });
});

describe("createUsageMeter", () => {
  it("returns InMemoryUsageMeter when no db provided", () => {
    expect(createUsageMeter()).toBeInstanceOf(InMemoryUsageMeter);
  });
});

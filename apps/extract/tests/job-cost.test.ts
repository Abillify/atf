// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Job cost accounting: every model stage books its tokens AND their price into
 * the job row, capped or not. Before, `cost_usd` was never written and an
 * uncapped job (no `token_budget`) booked no tokens either, so the overview
 * showed $0 for every run.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger } from "./helpers.js";
import { createLeaseGuard } from "../src/jobs/lease.js";
import { createDbBudgetLedger } from "../src/jobs/budget.js";
import {
  createStageRunner,
  PermanentStageError,
  priceTokens,
  recordModelResponse,
} from "../src/jobs/stage-runner.js";
import { chatTemplateKwargs } from "../src/chat-template-kwargs.js";

const FIXED_NOW = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
const PRICING = { inputPerMillion: 1, outputPerMillion: 5 };

async function claimedJob(store: FakeJobStore, overrides = {}) {
  await store.createJob({ id: randomUUID(), reference: "tests/kosten.pdf", source_sha256: "c".repeat(64), ...overrides });
  const job = await store.claimNextJob("worker-1", 60);
  if (job === null) throw new Error("expected a claim");
  const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
  const runner = createStageRunner({ store, lease, logger: testLogger, now: () => FIXED_NOW });
  return { job, runner, ledger: createDbBudgetLedger(store, job.id, lease.fence) };
}

describe("priceTokens", () => {
  it("prices prompt and completion tokens per million", () => {
    expect(priceTokens(PRICING, 1_000_000, 0)).toBeCloseTo(1);
    expect(priceTokens(PRICING, 2_000, 1_000)).toBeCloseTo(0.007);
  });

  it("is 0 without a price or with negative counts", () => {
    expect(priceTokens(undefined, 5_000, 5_000)).toBe(0);
    expect(priceTokens({ inputPerMillion: 0, outputPerMillion: 0 }, 5_000, 5_000)).toBe(0);
    expect(priceTokens(PRICING, -10, -10)).toBe(0);
  });
});

describe("stage cost booking", () => {
  it("books tokens and cost of an uncapped job from the captured response split", async () => {
    const store = createFakeJobStore();
    const { job, runner, ledger } = await claimedJob(store);
    expect(job.token_budget).toBeNull();
    await runner.runStage({
      unit: "page",
      key: { job_id: job.id, page: 1, stage: "vision1" },
      inputHash: "h1",
      budget: { ledger, estimatedTokens: 100, pricing: PRICING },
      fn: async () => {
        recordModelResponse({ raw: "md", usage: { promptTokens: 2_000, completionTokens: 1_000, totalTokens: 3_000 } });
        return { raw: "md", parsed: { ok: true }, tokensUsed: 3_000 };
      },
    });
    const row = store.peek(job.id);
    expect(Number(row?.tokens_used)).toBe(3_000);
    expect(Number(row?.cost_usd)).toBeCloseTo(0.007);
    expect(Number(row?.tokens_reserved)).toBe(0);
  });

  it("uses the stage's own usage split when no response was captured", async () => {
    const store = createFakeJobStore();
    const { job, runner, ledger } = await claimedJob(store);
    await runner.runStage({
      unit: "page",
      key: { job_id: job.id, page: 1, stage: "summary:page" },
      inputHash: "h1",
      budget: { ledger, estimatedTokens: 100, pricing: PRICING },
      fn: async () => ({
        raw: "s",
        parsed: { summary: "s" },
        tokensUsed: 1_500,
        usage: { promptTokens: 1_000, completionTokens: 500 },
      }),
    });
    expect(Number(store.peek(job.id)?.cost_usd)).toBeCloseTo(0.0035);
  });

  it("books the cost of a permanently failed attempt that the model answered", async () => {
    const store = createFakeJobStore();
    const { job, runner, ledger } = await claimedJob(store);
    await runner.runStage({
      unit: "page",
      key: { job_id: job.id, page: 1, stage: "vision1" },
      inputHash: "h1",
      budget: { ledger, estimatedTokens: 100, pricing: PRICING },
      fn: async () => {
        recordModelResponse({ raw: "kaputt", usage: { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 } });
        throw new PermanentStageError("unparseable");
      },
    });
    const row = store.peek(job.id);
    expect(Number(row?.tokens_used)).toBe(1_000_000);
    expect(Number(row?.cost_usd)).toBeCloseTo(1);
  });

  it("books tokens without cost when the stage carries no price", async () => {
    const store = createFakeJobStore();
    const { job, runner, ledger } = await claimedJob(store);
    await runner.runStage({
      unit: "page",
      key: { job_id: job.id, page: 1, stage: "vision1" },
      inputHash: "h1",
      budget: { ledger, estimatedTokens: 100 },
      fn: async () => ({ raw: "md", parsed: {}, tokensUsed: 400 }),
    });
    expect(Number(store.peek(job.id)?.tokens_used)).toBe(400);
    expect(Number(store.peek(job.id)?.cost_usd)).toBe(0);
  });

  it("still enforces the cap of a budgeted job", async () => {
    const store = createFakeJobStore();
    const { job, runner, ledger } = await claimedJob(store, { token_budget: 1_000 });
    await runner.runStage({
      unit: "page",
      key: { job_id: job.id, page: 1, stage: "vision1" },
      inputHash: "h1",
      budget: { ledger, estimatedTokens: 600, pricing: PRICING },
      fn: async () => ({ raw: "md", parsed: {}, tokensUsed: 600 }),
    });
    await expect(
      runner.runStage({
        unit: "page",
        key: { job_id: job.id, page: 2, stage: "vision1" },
        inputHash: "h2",
        budget: { ledger, estimatedTokens: 600, pricing: PRICING },
        fn: async () => ({ raw: "md", parsed: {}, tokensUsed: 600 }),
      }),
    ).rejects.toThrow(/Token budget exhausted/);
    // A total without a split is priced at the output rate.
    expect(Number(store.peek(job.id)?.cost_usd)).toBeCloseTo(0.003);
  });
});

describe("chatTemplateKwargs", () => {
  it("omits the field when nothing is configured", () => {
    expect(chatTemplateKwargs(null, null)).toEqual({});
  });

  it("sends enable_thinking false on its own", () => {
    expect(chatTemplateKwargs(null, false)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it("combines reasoning_effort and enable_thinking", () => {
    expect(chatTemplateKwargs("low", true)).toEqual({
      chat_template_kwargs: { reasoning_effort: "low", enable_thinking: true },
    });
  });
});

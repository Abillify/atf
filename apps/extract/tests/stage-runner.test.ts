// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * stage-runner.test.ts
 *
 * The stage-execution primitive (task 1.6, requirements 4.2, 4.3, 4.6, 4.9,
 * 4.10). Driven against the in-memory fake store with a fixed clock, so a
 * transient failure's `next_attempt_at` is asserted exactly.
 *
 * Covers:
 *  - checkpoint reuse on identical input_hash (fn is NOT called)
 *  - recompute on a changed input_hash (fn IS called)
 *  - transient failure sets next_attempt_at with backoff and keeps the unit retryable
 *  - permanent failure marks the unit failed + records a job warning, no abort
 *  - budget guard flips to BudgetExhaustedError before a model call, and the
 *    reuse path does NOT consume budget
 *  - reparse re-applies the parser from the persisted raw output with zero model calls
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import { testLogger } from "./helpers.js";
import { createLeaseGuard, LeaseLostError } from "../src/jobs/lease.js";
import { createDbBudgetLedger } from "../src/jobs/budget.js";
import {
  BudgetExhaustedError,
  DEFAULT_BACKOFF,
  PermanentStageError,
  StageNotDueError,
  TransientStageError,
  backoffMs,
  createStageRunner,
  recordModelResponse,
  unlimitedBudget,
  type BudgetLedger,
  type StageOutput,
  type StageRunner,
} from "../src/jobs/stage-runner.js";
import type { StageKey } from "../src/persistence/extract-queries.js";

const FIXED_NOW = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));

async function seedClaimedJob(store: FakeJobStore, overrides = {}) {
  const id = randomUUID();
  await store.createJob({
    id,
    reference: "tests/handbuch.pdf",
    source_sha256: "a".repeat(64),
    ...overrides,
  });
  const claimed = await store.claimNextJob("worker-1", 60);
  if (claimed === null) throw new Error("expected a claim");
  return claimed;
}

function runnerFor(store: FakeJobStore, jobId: string, epoch: number): StageRunner {
  const lease = createLeaseGuard(store, { jobId, holder: "worker-1", epoch }, 60);
  return createStageRunner({ store, lease, logger: testLogger, now: () => FIXED_NOW });
}

function pageKey(jobId: string, page: number, stage: string): StageKey {
  return { job_id: jobId, page, stage };
}

describe("stage-runner · checkpoint reuse (req 4.3)", () => {
  it("reuses a done checkpoint with the same input_hash without calling fn", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");

    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { raw: "<r>1</r>", parsed: { text: "one" }, tokensUsed: 10 };
    };

    const first = await runner.runStage({ unit: "page", key, inputHash: "h1", fn });
    expect(first.reused).toBe(false);
    expect(calls).toBe(1);

    // Second run with the SAME hash: reused, fn not called again.
    const second = await runner.runStage({ unit: "page", key, inputHash: "h1", fn });
    expect(second.reused).toBe(true);
    expect(calls).toBe(1);
    expect(second.parsed).toEqual({ text: "one" });
  });

  it("recomputes when the input_hash changes", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");

    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { raw: `<r>${calls}</r>`, parsed: { n: calls } };
    };

    await runner.runStage({ unit: "page", key, inputHash: "h1", fn });
    const changed = await runner.runStage({ unit: "page", key, inputHash: "h2", fn });
    expect(calls).toBe(2);
    expect(changed.reused).toBe(false);
    expect(changed.parsed).toEqual({ n: 2 });
    // The checkpoint now carries the new hash.
    const row = await store.getStage("page", key);
    expect(row?.input_hash).toBe("h2");
  });
});

describe("stage-runner · error taxonomy (req 4.10)", () => {
  it("transient failure sets a backed-off next_attempt_at and keeps the unit retryable", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");

    const fn = async () => {
      throw new TransientVisionDown();
    };

    await expect(runner.runStage({ unit: "page", key, inputHash: "h1", fn })).rejects.toBeInstanceOf(
      TransientStageError,
    );

    const row = await store.getStage("page", key);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("vision down");
    // attempt 1 → base delay; deterministic (no jitter) so we can assert it.
    const expected = new Date(FIXED_NOW.getTime() + backoffMs(1, DEFAULT_BACKOFF));
    expect(row?.next_attempt_at?.getTime()).toBe(expected.getTime());
    // The job status is untouched — the worker owns job transitions, not the runner.
    expect(store.peek(job.id)?.status).toBe(job.status);
  });

  it("backoff grows exponentially and is clamped to maxMs", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    // Far out on the curve it is clamped, not unbounded.
    expect(backoffMs(50)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("permanent failure marks the unit failed and records a job warning without aborting", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 3, "vision1");

    const fn = async () => {
      throw new PermanentStageError("unreadable page", "Seite 3 konnte nicht gelesen werden");
    };

    // A permanent failure does NOT throw out of runStage — the job keeps going.
    const result = await runner.runStage({ unit: "page", key, inputHash: "h1", fn });
    expect(result.reused).toBe(false);

    const row = await store.getStage("page", key);
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("unreadable page");

    const jobRow = store.peek(job.id);
    expect(jobRow?.status).toBe(job.status); // job not aborted; status untouched by the runner
    expect(jobRow?.warnings).toHaveLength(1);
    expect(jobRow?.warnings[0]).toContain("Seite 3");
    expect(jobRow?.warnings[0]).toContain("Seite 3 konnte nicht gelesen werden");
  });

  it("classifies an unclassified throw as transient (retry is the safe default)", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");

    await expect(
      runner.runStage({
        unit: "page",
        key,
        inputHash: "h1",
        fn: async () => {
          throw new Error("kaboom");
        },
      }),
    ).rejects.toBeInstanceOf(TransientStageError);
    const row = await store.getStage("page", key);
    expect(row?.status).toBe("failed");
    expect(row?.next_attempt_at).not.toBeNull();
  });
});

describe("stage-runner · budget guard (req 4.9)", () => {
  function ledger(remaining: number | null): BudgetLedger & { consumed: number } {
    let left = remaining;
    const l = {
      consumed: 0,
      async remaining() {
        return left;
      },
      async consume(tokens: number) {
        this.consumed += tokens;
        if (left !== null) left -= tokens;
      },
    };
    return l;
  }

  it("throws BudgetExhaustedError BEFORE calling fn when the budget is too low", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");
    const budgetLedger = ledger(5);

    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { raw: "<r/>", parsed: {}, tokensUsed: 100 };
    };

    await expect(
      runner.runStage({
        unit: "page",
        key,
        inputHash: "h1",
        fn,
        budget: { ledger: budgetLedger, estimatedTokens: 100 },
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);

    // No model call happened, and no checkpoint was written.
    expect(calls).toBe(0);
    expect(budgetLedger.consumed).toBe(0);
    expect(await store.getStage("page", key)).toBeNull();
  });

  it("runs and consumes budget when there is room", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");
    const budgetLedger = ledger(1_000);

    const result = await runner.runStage({
      unit: "page",
      key,
      inputHash: "h1",
      fn: async () => ({ raw: "<r/>", parsed: { ok: true }, tokensUsed: 42 }),
      budget: { ledger: budgetLedger, estimatedTokens: 100 },
    });
    expect(result.reused).toBe(false);
    expect(budgetLedger.consumed).toBe(42);
  });

  it("the reuse path does NOT consume budget", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");
    const budgetLedger = ledger(1_000);

    const fn = async () => ({ raw: "<r/>", parsed: { ok: true }, tokensUsed: 42 });

    // First run consumes; second (reuse) must not.
    await runner.runStage({
      unit: "page",
      key,
      inputHash: "h1",
      fn,
      budget: { ledger: budgetLedger, estimatedTokens: 100 },
    });
    expect(budgetLedger.consumed).toBe(42);

    const reused = await runner.runStage({
      unit: "page",
      key,
      inputHash: "h1",
      fn,
      budget: { ledger: budgetLedger, estimatedTokens: 100 },
    });
    expect(reused.reused).toBe(true);
    expect(budgetLedger.consumed).toBe(42); // unchanged — cached result is free
  });
});

describe("stage-runner · reparse (req 4.6)", () => {
  it("re-applies the parser to the persisted raw response with zero model calls", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");

    let modelCalls = 0;
    // Original stage: model returns raw XML, buggy parser drops the value.
    await runner.runStage({
      unit: "page",
      key,
      inputHash: "h1",
      fn: async () => {
        modelCalls += 1;
        return { raw: "<summary>Wichtig</summary>", parsed: { summary: "" } };
      },
    });
    expect(modelCalls).toBe(1);

    // A parser fix lands; reparse re-runs it on the STORED raw, no model call.
    const fixed = (raw: string) => {
      const m = raw.match(/<summary>(.*?)<\/summary>/);
      return { summary: m?.[1] ?? "" };
    };
    const result = await runner.reparse<{ summary: string }, string>("page", key, fixed);

    expect(modelCalls).toBe(1); // still one — the model was never re-called
    expect(result?.parsed).toEqual({ summary: "Wichtig" });
    const row = await store.getStage("page", key);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("done");
    // The raw response is preserved so a later parser fix can re-run again.
    const output = row?.output as { raw: string };
    expect(output.raw).toBe("<summary>Wichtig</summary>");
  });

  it("is a no-op (null) when there is no persisted raw response", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "render");

    // A deterministic stage with no raw model response.
    await runner.runStage({
      unit: "page",
      key,
      inputHash: "h1",
      fn: async () => ({ raw: null, parsed: { width: 1000, height: 1414 } }),
    });

    const result = await runner.reparse("page", key, (raw: unknown) => raw);
    expect(result).toBeNull();
  });

  it("returns null when the checkpoint does not exist", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const result = await runner.reparse("page", pageKey(job.id, 9, "vision1"), (raw: unknown) => raw);
    expect(result).toBeNull();
  });
});

/** A test-only transient fault, mirroring how vision failures are classified. */
class TransientVisionDown extends TransientStageError {
  constructor() {
    super("vision down");
  }
}

describe("stage-runner · backoff is honoured (req 4.8)", () => {
  it("does not run a unit before its next_attempt_at and runs it once due", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 1, "vision1");
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new TransientVisionDown();
    };
    await expect(runner.runStage({ unit: "page", key, inputHash: "h1", fn: failing })).rejects.toBeInstanceOf(
      TransientStageError,
    );
    const before = await store.getStage("page", key);

    // Still inside the backoff window: no call, no write.
    const early = await runner
      .runStage({ unit: "page", key, inputHash: "h1", fn: failing })
      .catch((err: unknown) => err);
    expect(early).toBeInstanceOf(StageNotDueError);
    expect((early as StageNotDueError).retryAt.getTime()).toBe(FIXED_NOW.getTime() + 1_000);
    expect(calls).toBe(1);
    expect((await store.getStage("page", key))?.attempts).toBe(before?.attempts);

    // Once due, the unit runs again.
    const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
    const later = createStageRunner({
      store,
      lease,
      logger: testLogger,
      now: () => new Date(FIXED_NOW.getTime() + 1_000),
    });
    const ok = await later.runStage({ unit: "page", key, inputHash: "h1", fn: async () => ({ raw: "r", parsed: 1 }) });
    expect(ok.reused).toBe(false);
    expect((await store.getStage("page", key))?.status).toBe("done");
  });

  it("grows the backoff per consecutive failure of the same unit", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
    let now = FIXED_NOW.getTime();
    const runner = createStageRunner({ store, lease, logger: testLogger, now: () => new Date(now) });
    const key = pageKey(job.id, 1, "vision1");
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      await runner
        .runStage({ unit: "page", key, inputHash: "h1", fn: async () => Promise.reject(new TransientVisionDown()) })
        .catch(() => undefined);
      const row = await store.getStage("page", key);
      const at = row?.next_attempt_at?.getTime() ?? 0;
      delays.push(at - now);
      now = at;
    }
    expect(delays).toEqual([1_000, 2_000, 4_000]);
  });
});

describe("stage-runner · raw responses survive failures (req 4.6)", () => {
  it("keeps the model answer of a unit whose post-processing failed, never re-calls it, and reparse repairs it", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key = pageKey(job.id, 2, "vision1");
    let modelCalls = 0;
    const fn = async (): Promise<{ raw: string; parsed: { summary: string } }> => {
      modelCalls += 1;
      recordModelResponse({ raw: "<summary>Wichtig</summary>", usage: { totalTokens: 7 } });
      throw new Error("parser crashed");
    };

    const failed = await runner.runStage({ unit: "page", key, inputHash: "h1", fn });
    expect(failed.parsed).toBeUndefined();
    const row = await store.getStage("page", key);
    expect(row?.status).toBe("failed");
    expect(row?.next_attempt_at).toBeNull(); // permanent: retrying would repeat the paid call
    expect((row?.output as StageOutput | undefined)?.raw).toBe("<summary>Wichtig</summary>");
    expect(store.peek(job.id)?.warnings.join(" ")).toContain("reparse");

    // A resume replays the failure instead of calling the model again.
    const replay = await runner.runStage({ unit: "page", key, inputHash: "h1", fn });
    expect(replay.reused).toBe(true);
    expect(modelCalls).toBe(1);

    // reparse re-reads the stored answer — no model call — and marks it done.
    const repaired = await runner.reparse<{ summary: string }, string>("page", key, (raw) => ({
      summary: raw.replace(/<\/?summary>/g, ""),
    }));
    expect(repaired?.parsed).toEqual({ summary: "Wichtig" });
    expect((await store.getStage("page", key))?.status).toBe("done");
    expect(modelCalls).toBe(1);
  });

  it("persists the raw response carried by a PermanentStageError", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const runner = runnerFor(store, job.id, Number(job.lease_epoch));
    const key: StageKey = { job_id: job.id, page: 1, figure_id: "f1", stage: "figure2" };
    await runner.runStage({
      unit: "figure",
      key,
      inputHash: "h1",
      fn: async () => {
        throw new PermanentStageError("no parser", "Kein Parser", '{"format":"bpmn"}');
      },
    });
    const row = await store.getStage("figure", key);
    expect(row?.status).toBe("failed");
    expect((row?.output as StageOutput | undefined)?.raw).toBe('{"format":"bpmn"}');
  });
});

describe("stage-runner · resume_policy reuse and stand (req 4.12)", () => {
  it("reuses a done checkpoint regardless of hash when the policy says so, and records the stand", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
    const standA = { pipelineHash: "p1", promptHash: "q1" };
    const pinned = createStageRunner({ store, lease, logger: testLogger, now: () => FIXED_NOW, stand: standA });
    const key = pageKey(job.id, 1, "vision1");
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return { raw: "r", parsed: { n: calls } };
    };
    await pinned.runStage({ unit: "page", key, inputHash: "hash-under-A", fn });
    expect(((await store.getStage("page", key))?.output as StageOutput | undefined)?.stand).toEqual(standA);

    const continuing = createStageRunner({
      store,
      lease,
      logger: testLogger,
      now: () => FIXED_NOW,
      stand: { pipelineHash: "p2", promptHash: "q1" },
      reuseDoneRegardlessOfHash: (stage) => stage === "vision1",
    });
    const reused = await continuing.runStage({ unit: "page", key, inputHash: "hash-under-B", fn });
    expect(reused.reused).toBe(true);
    expect(calls).toBe(1);
    // The reused unit keeps the stand it was produced under.
    expect(((await store.getStage("page", key))?.output as StageOutput | undefined)?.stand).toEqual(standA);

    // Without the policy, the changed hash recomputes.
    const recomputed = await pinned.runStage({ unit: "page", key, inputHash: "hash-under-B", fn });
    expect(recomputed.reused).toBe(false);
    expect(calls).toBe(2);
  });
});

describe("stage-runner · atomic budget reservation (req 4.9)", () => {
  it("concurrent model stages cannot overdraw a job budget", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store, { token_budget: 50 });
    const lease = createLeaseGuard(store, { jobId: job.id, holder: "worker-1", epoch: Number(job.lease_epoch) }, 60);
    const runner = createStageRunner({ store, lease, logger: testLogger, now: () => FIXED_NOW });
    const ledger = createDbBudgetLedger(store, job.id, lease.fence);
    let calls = 0;
    const results = await Promise.allSettled(
      [1, 2, 3].map((page) =>
        runner.runStage({
          unit: "page",
          key: pageKey(job.id, page, "vision1"),
          inputHash: "h",
          budget: { ledger, estimatedTokens: 20 },
          fn: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 1));
            return { raw: "r", parsed: page, tokensUsed: 20 };
          },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExhaustedError);
    expect(calls).toBe(2);
    expect(Number(store.peek(job.id)?.tokens_used)).toBe(40);
    expect(Number(store.peek(job.id)?.tokens_reserved)).toBe(0);
  });
});

describe("stage-runner · fencing (req 4.5)", () => {
  it("a zombie runner's checkpoint write is refused and it never reaches a model call", async () => {
    const store = createFakeJobStore();
    const job = await seedClaimedJob(store);
    const zombie = runnerFor(store, job.id, Number(job.lease_epoch));
    store.advance(61_000);
    await store.claimNextJob("worker-2", 60); // takeover bumps the epoch

    let modelCalls = 0;
    await expect(
      zombie.runStage({
        unit: "page",
        key: pageKey(job.id, 1, "vision1"),
        inputHash: "h",
        budget: { ledger: unlimitedBudget, estimatedTokens: 10 },
        fn: async () => {
          modelCalls += 1;
          return { raw: "r", parsed: 1 };
        },
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(modelCalls).toBe(0);

    // A deterministic stage (no pre-call check) is refused at the write.
    await expect(
      zombie.runStage({
        unit: "page",
        key: pageKey(job.id, 1, "crops"),
        inputHash: "h",
        fn: async () => ({ raw: null, parsed: 1 }),
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.getStage("page", pageKey(job.id, 1, "crops"))).toBeNull();
  });
});

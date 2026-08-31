// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for `dispatchAsyncJob` and `createJobRetryRunner`
 * (`src/routes/chat/metering.ts`) — the Durable Agent Runtime's async-job
 * submission/retry paths.
 *
 * Verifies: the first attempt records a secret-free resumePayload and a
 * lease when recovery is opted in (and neither when it is not); the job
 * eventually completes/fails; and `createJobRetryRunner` re-runs a
 * requeued job through the exact same execution/settlement path.
 */

import { describe, test, expect } from "bun:test";
import { dispatchAsyncJob, createJobRetryRunner } from "../metering.js";
import { InMemoryJobStore } from "../../../graph/job-store.js";
import type { GraphEngineService } from "../../../graph/graph-engine/state.js";
import type { ChatCompletionChunk } from "../../../types/openai.js";
import type { RequestContext } from "../../../types/monitoring.js";
import { createVerifiedExecutionContext } from "../../../graph/verified-execution-context.js";
import type { AuthPrincipal } from "../../../middleware/auth.js";

/** A fake engine that streams a canned response, optionally failing. */
function fakeEngine(opts: { text: string; error?: boolean; onExecute?: () => void } = { text: "hello" }): GraphEngineService {
  return {
    buildGraph: () => ({}) as never,
    async executeFlow(_flowId, _messages, _ctx, onChunk, onDone): Promise<void> {
      opts.onExecute?.();
      if (opts.error === true) {
        const chunk: ChatCompletionChunk = {
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "error" }],
        };
        await onChunk(chunk);
        await onDone({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        return;
      }
      await onChunk({
        id: "c1",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta: { content: opts.text }, finish_reason: null }],
      });
      await onDone({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    },
    invalidateCache: () => {},
    hasCapacity: () => true,
    getQueueState: () => ({ active: 0, waiting: 0, available: 1, queueLimit: 1 }),
  };
}

/** Minimal fake Hono Context used by dispatchAsyncJob. */
function fakeCtx(tenantId = "acme"): {
  get: () => AuthPrincipal;
  json: (body: unknown, status: number) => { body: unknown; status: number };
} {
  const principal: AuthPrincipal = {
    method: "token",
    verified: true,
    claims: { tenant_id: tenantId },
    tenantId,
  };
  return {
    get: () => principal,
    json: (body: unknown, status: number) => ({ body, status }),
  };
}

const baseRequestCtx: RequestContext = {
  ssoToken: "secret-caller-token",
  executionId: "exec-1",
  clientId: "acme",
  userId: "alice",
};

const allowAdmission = { admit: async () => ({ allowed: true as const }) };
const contextSecret = "test-transaction-context-secret";

describe("dispatchAsyncJob", () => {
  test("without jobRecovery: no resumePayload/lease is recorded, and the job completes", async () => {
    const jobStore = new InMemoryJobStore();
    const engine = fakeEngine({ text: "hi" });
    let finalizeCalled: { text: string; hadError: boolean } | undefined;

    const res = await dispatchAsyncJob({
      ctx: fakeCtx() as never,
      jobStore,
      graphEngine: engine,
      flowToRun: "flow-a",
      messages: [{ role: "user", content: "hi" }],
      requestCtx: baseRequestCtx,
      resolvedModel: "flow-a",
      finalize: async (text, hadError) => {
        finalizeCalled = { text, hadError };
      },
      setRunUsage: () => {},
    });

    const body = (await (res as unknown as { json: () => Promise<{ id: string; status: string }> }).json?.()) ??
      (res as unknown as { body: { id: string; status: string } }).body;
    expect(body.status).toBe("queued");

    // Wait for the detached execution to settle.
    await new Promise((r) => setTimeout(r, 10));
    const job = jobStore.get(body.id);
    expect(job?.status).toBe("completed");
    expect(job?.owner).toBe("acme");
    expect(job?.resumePayload).toBeUndefined();
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(job?.maxAttempts).toBe(1);
    expect(finalizeCalled).toEqual({ text: "hi", hadError: false });
  });

  test("uses the authenticated principal instead of request metadata for ownership", async () => {
    const jobStore = new InMemoryJobStore();
    const res = await dispatchAsyncJob({
      ctx: fakeCtx("default") as never,
      jobStore,
      graphEngine: fakeEngine({ text: "hi" }),
      flowToRun: "flow-a",
      messages: [{ role: "user", content: "hi" }],
      requestCtx: { ...baseRequestCtx, clientId: "untrusted-body-owner" },
      resolvedModel: "flow-a",
      finalize: async () => {},
      setRunUsage: () => {},
    });
    const id = (res as unknown as { body: { id: string } }).body.id;

    expect(jobStore.get(id)?.owner).toBe("default");
  });

  test("with jobRecovery: records a secret-free resumePayload and a lease during execution", async () => {
    const jobStore = new InMemoryJobStore();
    const engine = fakeEngine({ text: "hi" });

    const res = await dispatchAsyncJob({
      ctx: fakeCtx() as never,
      jobStore,
      graphEngine: engine,
      flowToRun: "flow-a",
      messages: [{ role: "user", content: "hi" }],
      requestCtx: baseRequestCtx,
      resolvedModel: "flow-a",
      finalize: async () => {},
      setRunUsage: () => {},
      jobRecovery: { maxAttempts: 3, leaseMs: 60_000, contextSecret },
    });
    const body = (res as unknown as { body: { id: string } }).body;

    // Read the job IMMEDIATELY (before the detached execution settles) to
    // observe the resumePayload/lease recorded at submission time.
    const jobRightAfterCreate = jobStore.get(body.id);
    expect(jobRightAfterCreate?.maxAttempts).toBe(3);
    expect(jobRightAfterCreate?.resumePayload).toEqual({
      flowId: "flow-a",
      messages: [{ role: "user", content: "hi" }],
      verifiedContext: createVerifiedExecutionContext(baseRequestCtx, contextSecret),
    });
    // The ORIGINAL caller's bearer token must never be persisted into the store.
    expect(JSON.stringify(jobRightAfterCreate)).not.toContain("secret-caller-token");

    const noSecretRes = await dispatchAsyncJob({
      ctx: fakeCtx() as never,
      jobStore,
      graphEngine: engine,
      flowToRun: "flow-a",
      messages: [{ role: "user", content: "hi" }],
      requestCtx: baseRequestCtx,
      resolvedModel: "flow-a",
      finalize: async () => {},
      setRunUsage: () => {},
      jobRecovery: { maxAttempts: 3, leaseMs: 60_000 },
    });
    const noSecretId = (noSecretRes as unknown as { body: { id: string } }).body.id;
    const noSecretJob = jobStore.get(noSecretId);
    expect(noSecretJob?.maxAttempts).toBe(1);
    expect(noSecretJob?.resumePayload).toBeUndefined();
    expect(noSecretJob?.leaseExpiresAt).toBeDefined();

    await new Promise((r) => setTimeout(r, 10));
    const job = jobStore.get(body.id);
    expect(job?.status).toBe("completed");
    expect(job?.leaseExpiresAt).toBeUndefined(); // cleared on settlement
  });

  test("records a failure when the flow errors", async () => {
    const jobStore = new InMemoryJobStore();
    const engine = fakeEngine({ text: "", error: true });

    const res = await dispatchAsyncJob({
      ctx: fakeCtx() as never,
      jobStore,
      graphEngine: engine,
      flowToRun: "flow-a",
      messages: [{ role: "user", content: "hi" }],
      requestCtx: baseRequestCtx,
      resolvedModel: "flow-a",
      finalize: async () => {},
      setRunUsage: () => {},
    });
    const body = (res as unknown as { body: { id: string } }).body;

    await new Promise((r) => setTimeout(r, 10));
    const job = jobStore.get(body.id);
    expect(job?.status).toBe("failed");
  });
});

describe("createJobRetryRunner", () => {
  test("re-runs the flow from the resumePayload and completes the job", async () => {
    const jobStore = new InMemoryJobStore();
    jobStore.create({
      id: "job-retry-1",
      model: "flow-a",
      maxAttempts: 3,
      resumePayload: {
        flowId: "flow-a",
        messages: [{ role: "user", content: "retry me" }],
        verifiedContext: createVerifiedExecutionContext(baseRequestCtx, contextSecret),
      },
    });
    jobStore.markRunning("job-retry-1", 1_000);
    const requeued = jobStore.requeueForRetry("job-retry-1");
    if (requeued === undefined) throw new Error("expected the job to be requeued");

    const engine = fakeEngine({ text: "recovered answer" });
    const runner = createJobRetryRunner({
      graphEngine: engine,
      jobStore,
      admission: allowAdmission,
      leaseMs: 60_000,
      contextSecret,
    });

    await runner(requeued);

    const job = jobStore.get("job-retry-1");
    expect(job?.status).toBe("completed");
    expect(job?.result?.choices[0]?.message.content).toBe("recovered answer");

    const tamperedContext = createVerifiedExecutionContext(baseRequestCtx, contextSecret);
    if (tamperedContext === undefined) throw new Error("expected a signed context");
    tamperedContext.signature = "0".repeat(64);
    jobStore.create({
      id: "job-retry-tampered",
      model: "flow-a",
      resumePayload: {
        flowId: "flow-a",
        messages: [{ role: "user", content: "retry me" }],
        verifiedContext: tamperedContext,
      },
    });
    const tamperedJob = jobStore.get("job-retry-tampered");
    if (tamperedJob === undefined) throw new Error("expected tampered job");
    await runner(tamperedJob);
    expect(jobStore.get("job-retry-tampered")?.status).toBe("failed");
  });

  test("does not execute a recovered job denied by admission", async () => {
    const jobStore = new InMemoryJobStore();
    jobStore.create({
      id: "job-retry-denied",
      model: "flow-a",
      resumePayload: {
        flowId: "flow-a",
        messages: [{ role: "user", content: "retry me" }],
        verifiedContext: createVerifiedExecutionContext(baseRequestCtx, contextSecret),
      },
    });
    const job = jobStore.get("job-retry-denied");
    if (job === undefined) throw new Error("expected job-retry-denied");
    let executed = false;
    const runner = createJobRetryRunner({
      graphEngine: fakeEngine({ text: "never", onExecute: () => { executed = true; } }),
      jobStore,
      admission: {
        admit: async () => ({
          allowed: false as const,
          failure: { status: 403 as const, code: "forbidden" as const, message: "denied" },
        }),
      },
      leaseMs: 60_000,
      contextSecret,
    });

    await runner(job);

    expect(executed).toBe(false);
    expect(jobStore.get("job-retry-denied")?.status).toBe("failed");
  });

  test("fails cleanly when the requeued job has no resumePayload (defensive path)", async () => {
    const jobStore = new InMemoryJobStore();
    jobStore.create({ id: "job-retry-2", model: "flow-a" });
    const job = jobStore.get("job-retry-2");
    if (job === undefined) throw new Error("expected job-retry-2");

    const engine = fakeEngine();
    const runner = createJobRetryRunner({ graphEngine: engine, jobStore, admission: allowAdmission, leaseMs: 60_000 });
    await runner(job);

    expect(jobStore.get("job-retry-2")?.status).toBe("failed");
  });
});

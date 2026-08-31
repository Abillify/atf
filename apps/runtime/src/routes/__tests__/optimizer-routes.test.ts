// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the self-optimizing flow routes (/optimizer/*).
 *
 * The route is thin delegation over the FlowOptimizer interface, so a fake
 * optimizer lets us assert routing, status codes, the sync/async split, the
 * promote path, and the operator-auth gate without running a real eval loop.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createOptimizerRouter } from "../optimizer.js";
import type {
  FlowOptimizer,
  OptimizationRun,
  OptimizerConfig,
} from "../../graph/flow-optimizer.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function makeRun(overrides: Partial<OptimizationRun> = {}): OptimizationRun {
  return {
    id: "opt-test-1",
    flowId: "flow-1",
    targetNodeId: "responder",
    startedAt: new Date().toISOString(),
    status: "done",
    sampleCount: 5,
    baselineScore: 0.7,
    variants: [],
    ...overrides,
  };
}

/** Fake optimizer recording calls, returning canned runs. */
function makeFakeOptimizer(): FlowOptimizer & {
  runCalls: OptimizerConfig[];
  startCalls: OptimizerConfig[];
  promoteCalls: Array<{ runId: string; label: string }>;
} {
  const runCalls: OptimizerConfig[] = [];
  const startCalls: OptimizerConfig[] = [];
  const promoteCalls: Array<{ runId: string; label: string }> = [];
  const stored = new Map<string, OptimizationRun>([["opt-test-1", makeRun()]]);

  return {
    runCalls,
    startCalls,
    promoteCalls,
    async run(config) {
      runCalls.push(config);
      return makeRun({ status: "done" });
    },
    start(config) {
      startCalls.push(config);
      return makeRun({ status: "mining" });
    },
    async promote(runId, variantLabel) {
      promoteCalls.push({ runId, label: variantLabel });
      if (runId === "unknown") throw new Error(`Run "${runId}" not found`);
      return makeRun({
        status: "done",
        promotedVariant: variantLabel,
        promotedVersion: 2,
      });
    },
    getRun(runId) {
      return stored.get(runId);
    },
    listRuns(flowId) {
      return [...stored.values()].filter((r) => r.flowId === flowId);
    },
  };
}

function app(optimizer: FlowOptimizer) {
  const a = new Hono();
  a.route("/optimizer", createOptimizerRouter({ optimizer }));
  return a;
}

describe("optimizer routes", () => {
  test("POST /:flowId/run (sync) returns 200 with the completed run", async () => {
    const opt = makeFakeOptimizer();
    const a = app(opt);
    const res = await a.request("/optimizer/flow-1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantCount: 2 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OptimizationRun;
    expect(body.status).toBe("done");
    expect(opt.runCalls).toHaveLength(1);
    expect(at(opt.runCalls, 0).variantCount).toBe(2);
    expect(opt.startCalls).toHaveLength(0);
  });

  test("POST /:flowId/run with async=true returns 202 and calls start()", async () => {
    const opt = makeFakeOptimizer();
    const a = app(opt);
    const res = await a.request("/optimizer/flow-1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ async: true, variantCount: 3 }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as OptimizationRun;
    expect(body.status).toBe("mining");
    expect(opt.startCalls).toHaveLength(1);
    expect(opt.runCalls).toHaveLength(0);
  });

  test("run clamps variantCount and evalConcurrency to safe bounds", async () => {
    const opt = makeFakeOptimizer();
    const a = app(opt);
    await a.request("/optimizer/flow-1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantCount: 999, evalConcurrency: 999 }),
    });
    expect(at(opt.runCalls, 0).variantCount).toBe(10);
    expect(at(opt.runCalls, 0).evalConcurrency).toBe(8);
  });

  test("GET /:flowId/runs lists runs for the flow", async () => {
    const a = app(makeFakeOptimizer());
    const res = await a.request("/optimizer/flow-1/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: OptimizationRun[] };
    expect(body.runs).toHaveLength(1);
    expect(at(body.runs, 0).flowId).toBe("flow-1");
  });

  test("GET /runs/:runId returns a single run, 404 when unknown", async () => {
    const a = app(makeFakeOptimizer());
    const ok = await a.request("/optimizer/runs/opt-test-1");
    expect(ok.status).toBe(200);
    const missing = await a.request("/optimizer/runs/does-not-exist");
    expect(missing.status).toBe(404);
  });

  test("POST /runs/:runId/promote promotes a variant", async () => {
    const opt = makeFakeOptimizer();
    const a = app(opt);
    const res = await a.request("/optimizer/runs/opt-test-1/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantLabel: "v1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OptimizationRun;
    expect(body.promotedVariant).toBe("v1");
    expect(opt.promoteCalls[0]).toEqual({ runId: "opt-test-1", label: "v1" });
  });

  test("promote without variantLabel is 400", async () => {
    const a = app(makeFakeOptimizer());
    const res = await a.request("/optimizer/runs/opt-test-1/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("promote of an unknown run maps the error to 404", async () => {
    const a = app(makeFakeOptimizer());
    const res = await a.request("/optimizer/runs/unknown/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantLabel: "v1" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("optimizer routes — operator auth gate", () => {
  test("401 when auth is required and no token is provided", async () => {
    const opt = makeFakeOptimizer();
    const a = new Hono();
    // Minimal operator authorizer that always denies without a token.
    a.route(
      "/optimizer",
      createOptimizerRouter({
        optimizer: opt,
        operatorAuth: {
          rbacEnabled: true,
          async authorize(authHeader) {
            return authHeader !== undefined && authHeader !== ""
              ? { ok: true }
              : { ok: false };
          },
        },
      }),
    );
    const denied = await a.request("/optimizer/flow-1/runs");
    expect(denied.status).toBe(401);

    const allowed = await a.request("/optimizer/flow-1/runs", {
      headers: { Authorization: "Bearer op-token" },
    });
    expect(allowed.status).toBe(200);
    expect(opt.runCalls).toHaveLength(0); // list, not run
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for POST /optimizer/analyze/:executionId — the trace-analysis endpoint.
 *
 * The route delegates to an injected TraceAnalyzer, so a fake analyzer lets us
 * assert routing, status codes (200 / 404 / 501), scope pass-through, and the
 * not-configured path without running a real LLM analysis.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { createOptimizerRouter } from "../optimizer.js";
import type {
  FlowOptimizer,
  OptimizationRun,
} from "../../graph/flow-optimizer.js";
import type { TraceAnalyzer } from "../../graph/trace-analyzer.js";
import type { AnalyzeTraceOptions, TraceAnalysis } from "../../graph/trace-analyzer.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function stubOptimizer(): FlowOptimizer {
  const run: OptimizationRun = {
    id: "r1",
    flowId: "f1",
    targetNodeId: "n",
    startedAt: new Date().toISOString(),
    status: "done",
    sampleCount: 0,
    variants: [],
  };
  return {
    run: async () => run,
    start: () => run,
    promote: async () => run,
    getRun: () => run,
    listRuns: () => [run],
  };
}

function makeAnalysis(scopeNodeIds?: string[]): TraceAnalysis {
  return {
    executionId: "exec-1",
    flowId: "f1",
    status: "error",
    ...(scopeNodeIds !== undefined ? { scopeNodeIds } : {}),
    summary: "root cause: empty response",
    rootCause: "maxTokens too low",
    findings: [],
    suggestions: [],
    metrics: {
      nodeCount: 1,
      totalLatencyMs: 100,
      totalCost: 0,
      totalTokens: 0,
      errorNodeCount: 1,
      diagnosticCounts: { info: 0, warn: 0, error: 1 },
      toolCallCount: 0,
      toolErrorCount: 0,
      groundednessFailures: 0,
    },
  };
}

function fakeAnalyzer(): TraceAnalyzer & {
  calls: Array<{ executionId: string; options?: AnalyzeTraceOptions }>;
} {
  const calls: Array<{ executionId: string; options?: AnalyzeTraceOptions }> = [];
  return {
    calls,
    async analyze(executionId, options) {
      calls.push({ executionId, ...(options !== undefined ? { options } : {}) });
      if (executionId === "missing") return undefined;
      return makeAnalysis(options?.scopeNodeIds);
    },
  };
}

function app(traceAnalyzer?: TraceAnalyzer) {
  const a = new Hono();
  a.route(
    "/optimizer",
    createOptimizerRouter({
      optimizer: stubOptimizer(),
      ...(traceAnalyzer !== undefined ? { traceAnalyzer } : {}),
    }),
  );
  return a;
}

describe("POST /optimizer/analyze/:executionId", () => {
  test("returns 200 with the analysis for a known trace", async () => {
    const analyzer = fakeAnalyzer();
    const res = await app(analyzer).request("/optimizer/analyze/exec-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: TraceAnalysis };
    expect(body.analysis.executionId).toBe("exec-1");
    expect(body.analysis.rootCause).toBe("maxTokens too low");
    expect(at(analyzer.calls, 0).executionId).toBe("exec-1");
  });

  test("passes scopeNodeIds and goal through to the analyzer", async () => {
    const analyzer = fakeAnalyzer();
    const res = await app(analyzer).request("/optimizer/analyze/exec-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopeNodeIds: ["resp"], goal: "reduce latency" }),
    });
    expect(res.status).toBe(200);
    expect(at(analyzer.calls, 0).options).toEqual({
      scopeNodeIds: ["resp"],
      goal: "reduce latency",
    });
    const body = (await res.json()) as { analysis: TraceAnalysis };
    expect(body.analysis.scopeNodeIds).toEqual(["resp"]);
  });

  test("works with no request body (analyses the whole trace)", async () => {
    const analyzer = fakeAnalyzer();
    const res = await app(analyzer).request("/optimizer/analyze/exec-1", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    // No scope/goal fields → an empty options object is forwarded.
    expect(at(analyzer.calls, 0).options).toEqual({});
  });

  test("returns 404 when the trace is unknown", async () => {
    const res = await app(fakeAnalyzer()).request("/optimizer/analyze/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("returns 501 when no analyzer is configured", async () => {
    const res = await app(undefined).request("/optimizer/analyze/exec-1", {
      method: "POST",
    });
    expect(res.status).toBe(501);
  });
});

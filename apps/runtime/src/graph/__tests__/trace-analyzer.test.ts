// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the LLM trace analyzer (`src/graph/trace-analyzer.ts`).
 *
 * The deterministic layer (computeTraceMetrics / summarizeTrace) is tested pure;
 * the LLM layer (analyzeTrace / createTraceAnalyzer) uses a fake LanguageModel
 * and a fake DebugTraceStore so no network is touched. Asserts that hard
 * metrics are computed (not model-authored), suggestions get stable ids, and
 * scope restriction works.
 */

import { describe, test, expect } from "bun:test";
import type { LanguageModel } from "ai";
import {
  computeTraceMetrics,
  summarizeTrace,
  analyzeTrace,
  createTraceAnalyzer,
  renderAnalysisContext,
  suggestionEdits,
  type TraceAnalysis,
} from "../trace-analyzer.js";
import type { DebugTrace, DebugNodeTrace } from "../../types/debug-trace.js";
import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function node(overrides: Partial<DebugNodeTrace>): DebugNodeTrace {
  return {
    node_id: "n",
    status: "completed",
    started_at: "",
    finished_at: "",
    latency_ms: 0,
    tool_calls: [],
    ...overrides,
  };
}

function makeTrace(overrides: Partial<DebugTrace> = {}): DebugTrace {
  return {
    execution_id: "e1",
    flow_id: "f1",
    status: "error",
    started_at: new Date(Date.now() - 4000).toISOString(),
    finished_at: new Date().toISOString(),
    context: {},
    input_messages: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    errors: [],
    nodes: [
      node({
        node_id: "clf",
        node_type: "classifier",
        latency_ms: 100,
        input_tokens: 10,
        output_tokens: 5,
        cost: 0.001,
      }),
      node({
        node_id: "resp",
        node_type: "llm",
        status: "error",
        latency_ms: 900,
        input_tokens: 50,
        output_tokens: 0,
        cost: 0.004,
        error_message: "empty response",
        error_type: "execution_error",
        diagnostics: [
          { at: "", level: "warn", code: "reasoning_only_retry", message: "retry 1" },
          { at: "", level: "error", code: "empty_response", message: "empty" },
        ],
        tool_calls: [
          {
            id: "t1",
            name: "mcp/search",
            arguments: { q: "x" },
            result: null,
            is_error: true,
            called_at: "",
          },
        ],
        groundedness: {
          score: 0.2,
          passed: false,
          checked_sentences: 5,
          unsupported: [],
        },
        full_prompt: "system: be helpful\nuser: hi",
        full_response: "",
      }),
    ],
    ...overrides,
  };
}

/** Fake model returning a pre-built analysis object via generateObject. */
function makeModel(obj: unknown): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake",
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(obj) }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: { inputTokens: { total: 10 }, outputTokens: { total: 50 } },
      warnings: [],
    }),
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
}

const ANALYSIS_OBJECT = {
  summary: "The responder returned an empty answer after a reasoning-only retry.",
  rootCause: "maxTokens too low for a thinking-enabled node.",
  findings: [
    {
      category: "error",
      severity: "critical",
      nodeId: "resp",
      observation: "empty response",
      evidence: "diagnostic empty_response",
    },
  ],
  suggestions: [
    {
      category: "error",
      severity: "critical",
      title: "Raise maxTokens",
      rationale: "give the node output budget",
      expectedImpact: "removes empty responses",
      edit: { nodes: [{ nodeId: "resp", maxTokens: 8192 }] },
    },
    {
      category: "prompt",
      severity: "warn",
      title: "Tighten the prompt",
      rationale: "reduce rambling",
      expectedImpact: "shorter answers",
    },
  ],
};

describe("computeTraceMetrics", () => {
  test("aggregates latency, cost, tokens, errors, diagnostics and tool errors", () => {
    const m = computeTraceMetrics(makeTrace());
    expect(m.nodeCount).toBe(2);
    expect(m.errorNodeCount).toBe(1);
    expect(m.totalLatencyMs).toBe(1000);
    expect(m.totalCost).toBeCloseTo(0.005, 6);
    expect(m.totalTokens).toBe(65);
    expect(m.toolCallCount).toBe(1);
    expect(m.toolErrorCount).toBe(1);
    expect(m.diagnosticCounts).toEqual({ info: 0, warn: 1, error: 1 });
    expect(m.groundednessFailures).toBe(1);
    expect(m.slowestNode).toEqual({ nodeId: "resp", latencyMs: 900 });
    expect(m.costliestNode).toEqual({ nodeId: "resp", cost: 0.004 });
    expect(m.wallClockMs).toBeGreaterThanOrEqual(3900);
  });

  test("restricts to scoped nodes", () => {
    const m = computeTraceMetrics(makeTrace(), ["clf"]);
    expect(m.nodeCount).toBe(1);
    expect(m.errorNodeCount).toBe(0);
    expect(m.totalLatencyMs).toBe(100);
  });
});

describe("summarizeTrace", () => {
  test("includes diagnostics, groundedness and tool calls", () => {
    const digest = summarizeTrace(makeTrace());
    expect(digest).toContain("empty_response");
    expect(digest).toContain("groundedness");
    expect(digest).toContain("mcp/search");
  });

  test("truncates long text to the per-node cap", () => {
    const long = "x".repeat(5000);
    const digest = summarizeTrace(
      makeTrace({
        nodes: [node({ node_id: "resp", node_type: "llm", full_response: long })],
      }),
      { maxTextPerNode: 200 },
    );
    expect(digest).toContain("chars total");
    expect(digest).not.toContain("x".repeat(500));
  });

  test("only summarises scoped nodes", () => {
    const digest = summarizeTrace(makeTrace(), { scopeNodeIds: ["clf"] });
    expect(digest).toContain("clf");
    expect(digest).not.toContain("resp");
  });
});

describe("analyzeTrace", () => {
  test("attaches deterministic metrics and maps suggestions with stable ids", async () => {
    const analysis = await analyzeTrace(makeTrace(), makeModel(ANALYSIS_OBJECT));
    expect(analysis.executionId).toBe("e1");
    expect(analysis.status).toBe("error");
    // Metrics come from the deterministic layer, not the model.
    expect(analysis.metrics.errorNodeCount).toBe(1);
    expect(analysis.metrics.diagnosticCounts.error).toBe(1);
    expect(analysis.rootCause).toBeDefined();
    expect(analysis.suggestions).toHaveLength(2);
    const suggestion0 = at(analysis.suggestions, 0);
    const suggestion1 = at(analysis.suggestions, 1);
    expect(suggestion0.id).toBe("s1");
    expect(suggestion1.id).toBe("s2");
    expect(suggestion0.edit).toBeDefined();
    expect(suggestion1.edit).toBeUndefined();
  });

  test("records the scope when analysing a sub-section", async () => {
    const analysis = await analyzeTrace(makeTrace(), makeModel(ANALYSIS_OBJECT), {
      scopeNodeIds: ["resp"],
    });
    expect(analysis.scopeNodeIds).toEqual(["resp"]);
    expect(analysis.metrics.nodeCount).toBe(1);
  });
});

describe("createTraceAnalyzer", () => {
  function fakeStore(trace?: DebugTrace): DebugTraceStore {
    return {
      startTrace() {},
      upsertNode() {},
      upsertEdgeFlow() {},
      annotateContext() {},
      finishTrace() {},
      getTrace: (id) => (trace !== undefined && id === trace.execution_id ? trace : undefined),
      listRecent: () => [],
    };
  }

  test("returns undefined when the trace is unknown", async () => {
    const analyzer = createTraceAnalyzer({
      debugTraceStore: fakeStore(),
      model: makeModel(ANALYSIS_OBJECT),
    });
    expect(await analyzer.analyze("missing")).toBeUndefined();
  });

  test("analyses a known trace", async () => {
    const trace = makeTrace();
    const analyzer = createTraceAnalyzer({
      debugTraceStore: fakeStore(trace),
      model: makeModel(ANALYSIS_OBJECT),
    });
    const analysis = await analyzer.analyze("e1");
    expect(analysis?.summary).toContain("empty");
  });
});

describe("renderAnalysisContext / suggestionEdits", () => {
  const analysis: TraceAnalysis = {
    executionId: "e1",
    flowId: "f1",
    status: "error",
    summary: "S",
    rootCause: "RC",
    findings: [
      { category: "error", severity: "critical", nodeId: "resp", observation: "empty", evidence: "code" },
    ],
    suggestions: [
      {
        id: "s1",
        category: "error",
        severity: "critical",
        title: "Raise maxTokens",
        rationale: "budget",
        expectedImpact: "no empties",
        edit: { nodes: [{ nodeId: "resp", maxTokens: 8192 }] },
      },
      {
        id: "s2",
        category: "prompt",
        severity: "warn",
        title: "Tighten",
        rationale: "less rambling",
        expectedImpact: "shorter",
      },
    ],
    metrics: {
      nodeCount: 2,
      totalLatencyMs: 1000,
      totalCost: 0.005,
      totalTokens: 65,
      errorNodeCount: 1,
      diagnosticCounts: { info: 0, warn: 1, error: 1 },
      toolCallCount: 1,
      toolErrorCount: 1,
      groundednessFailures: 1,
    },
  };

  test("renderAnalysisContext includes summary, root cause, findings and suggestions", () => {
    const ctx = renderAnalysisContext(analysis);
    expect(ctx).toContain("Root cause: RC");
    expect(ctx).toContain("Raise maxTokens");
    expect(ctx).toContain("(resp)");
  });

  test("suggestionEdits returns only suggestions carrying an edit", () => {
    const edits = suggestionEdits(analysis);
    expect(edits).toHaveLength(1);
    const edit0 = at(edits, 0);
    expect(at(edit0.nodes ?? [], 0).maxTokens).toBe(8192);
    expect(edit0.summary).toBe("Raise maxTokens");
  });
});

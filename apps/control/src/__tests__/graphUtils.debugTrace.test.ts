// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import {
  deriveNodeStates,
  mergeDebugTraceIntoNodeStates,
  nodeErrorTooltip,
  toolNodeId,
  type NodeState,
} from "../components/graph/graphUtils";
import type {
  DebugNodeDiagnostic,
  DebugTrace,
  DebugToolCallRecord,
} from "../types/debug-trace";
import type { NodeExecutionEvent } from "../types/monitoring";

function event(
  overrides: Partial<NodeExecutionEvent> & { node_id: string },
): NodeExecutionEvent {
  return {
    execution_id: "exec-1",
    status: "completed",
    start_time: "2026-01-01T00:00:00Z",
    ...overrides,
  } as NodeExecutionEvent;
}

function traceNode(
  overrides: Partial<DebugTrace["nodes"][number]> & { node_id: string },
): DebugTrace["nodes"][number] {
  return {
    status: "completed",
    ...overrides,
  };
}

function trace(nodes: DebugTrace["nodes"]): DebugTrace {
  return {
    execution_id: "exec-1",
    flow_id: "f",
    status: "error",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:00:02Z",
    nodes,
  };
}

const diag = (
  overrides: Partial<DebugNodeDiagnostic> & { code: string },
): DebugNodeDiagnostic => ({
  at: "2026-01-01T00:00:01Z",
  level: "error",
  message: "something broke",
  ...overrides,
});

const toolCall = (
  overrides: Partial<DebugToolCallRecord> & { id: string },
): DebugToolCallRecord => ({
  name: "web_search",
  is_error: false,
  ...overrides,
});

describe("toolNodeId", () => {
  test("matches the runtime synthetic tool node id format", () => {
    expect(toolNodeId("llm-1", "call_abc")).toBe("llm-1::tool::call_abc");
  });
});

describe("mergeDebugTraceIntoNodeStates", () => {
  test("a missing trace returns the input map unchanged", () => {
    const states = deriveNodeStates([event({ node_id: "a" })]);
    expect(mergeDebugTraceIntoNodeStates(states, null)).toBe(states);
    expect(mergeDebugTraceIntoNodeStates(states, undefined)).toBe(states);
  });

  test("is pure — the input map is never mutated", () => {
    const states = deriveNodeStates([
      event({ node_id: "a", status: "error", error_message: "boom" }),
    ]);
    const before = new Map(states);
    mergeDebugTraceIntoNodeStates(states, trace([
      traceNode({
        node_id: "a",
        status: "error",
        error_type: "provider_error",
        diagnostics: [diag({ code: "retry" })],
      }),
    ]));
    expect(states).toEqual(before);
    expect(states.get("a")?.error_type).toBeUndefined();
  });

  test("merges error_type, error_details and diagnostics onto the node", () => {
    const states = deriveNodeStates([
      event({ node_id: "llm-1", status: "error", error_message: "boom" }),
    ]);
    const details = { status_code: 503, provider: "openai" };
    const diagnostics = [diag({ code: "provider_retry", level: "warn" })];
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          status: "error",
          error_type: "provider_error",
          error_details: details,
          diagnostics,
        }),
      ]),
    );
    const s = merged.get("llm-1");
    expect(s?.error_type).toBe("provider_error");
    expect(s?.error_details).toEqual(details);
    expect(s?.diagnostics).toEqual(diagnostics);
    // event-derived fields survive untouched
    expect(s?.error_message).toBe("boom");
    expect(s?.status).toBe("error");
  });

  test("diagnostics also enrich nodes that completed with warnings", () => {
    const states = deriveNodeStates([event({ node_id: "llm-1" })]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          status: "completed",
          diagnostics: [diag({ code: "fallback_model", level: "warn" })],
        }),
      ]),
    );
    expect(merged.get("llm-1")?.diagnostics?.[0]?.code).toBe("fallback_model");
    // a completed trace node contributes no error_type even if it carries one
    expect(merged.get("llm-1")?.error_type).toBeUndefined();
  });

  test("error_type/error_details only apply to nodes that errored in the trace", () => {
    const states = deriveNodeStates([event({ node_id: "llm-1" })]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          status: "completed",
          error_type: "provider_error",
          error_details: { x: 1 },
        }),
      ]),
    );
    expect(merged.get("llm-1")?.error_type).toBeUndefined();
    expect(merged.get("llm-1")?.error_details).toBeUndefined();
  });

  test("backfills a missing error_message but never overwrites one", () => {
    const states = deriveNodeStates([
      event({ node_id: "a", status: "error" }),
      event({ node_id: "b", status: "error", error_message: "from event" }),
    ]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "a",
          status: "error",
          error_message: "from trace",
        }),
        traceNode({
          node_id: "b",
          status: "error",
          error_message: "from trace",
        }),
      ]),
    );
    expect(merged.get("a")?.error_message).toBe("from trace");
    expect(merged.get("b")?.error_message).toBe("from event");
  });

  test("node status always stays event-derived", () => {
    // Event says running, trace (fetched mid-run) says error — status wins.
    const states = deriveNodeStates([event({ node_id: "a", status: "running" })]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([traceNode({ node_id: "a", status: "error", error_type: "x" })]),
    );
    expect(merged.get("a")?.status).toBe("running");
  });

  test("trace nodes without a matching event state are ignored", () => {
    const states = deriveNodeStates([event({ node_id: "a" })]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([traceNode({ node_id: "ghost", status: "error" })]),
    );
    expect(merged.size).toBe(1);
    expect(merged.has("ghost")).toBe(false);
  });

  test("failed tool calls enrich the synthetic tool node", () => {
    const toolId = toolNodeId("llm-1", "call_1");
    const states = deriveNodeStates([
      event({ node_id: "llm-1", status: "completed" }),
      event({
        node_id: toolId,
        status: "error",
        kind: "tool",
        parent_node_id: "llm-1",
      }),
    ]);
    const result = { error: "upstream 500", retryable: true };
    const toolDiag = diag({
      code: "tool_execution_failed",
      details: { tool_call_id: "call_1", error_message: "upstream 500" },
    });
    const nodeDiag = diag({ code: "retry" });
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          status: "completed",
          diagnostics: [nodeDiag, toolDiag],
          tool_calls: [toolCall({ id: "call_1", is_error: true, result })],
        }),
      ]),
    );
    const tool = merged.get(toolId);
    expect(tool?.tool_error_result).toEqual(result);
    // only the tool-tagged diagnostic lands on the tool node
    expect(tool?.diagnostics).toEqual([toolDiag]);
    // the issuing node keeps the full timeline
    expect(merged.get("llm-1")?.diagnostics).toEqual([nodeDiag, toolDiag]);
  });

  test("tool node gets an error_message backfilled from the failing result", () => {
    const toolId = toolNodeId("llm-1", "call_9");
    const states = deriveNodeStates([
      event({ node_id: toolId, status: "error", kind: "tool" }),
    ]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          tool_calls: [
            toolCall({ id: "call_9", is_error: true, result: { error: "denied" } }),
          ],
        }),
      ]),
    );
    expect(merged.get(toolId)?.error_message).toBe("denied");
  });

  test("falls back to a generic message when the result carries none", () => {
    const toolId = toolNodeId("llm-1", "call_9");
    const states = deriveNodeStates([
      event({ node_id: toolId, status: "error", kind: "tool" }),
    ]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          tool_calls: [toolCall({ id: "call_9", is_error: true, result: 42 })],
        }),
      ]),
    );
    expect(merged.get(toolId)?.error_message).toBe("Tool call failed");
  });

  test("successful tool calls add nothing to the tool node", () => {
    const toolId = toolNodeId("llm-1", "call_ok");
    const states = deriveNodeStates([
      event({ node_id: toolId, status: "completed", kind: "tool" }),
    ]);
    const merged = mergeDebugTraceIntoNodeStates(
      states,
      trace([
        traceNode({
          node_id: "llm-1",
          tool_calls: [toolCall({ id: "call_ok", result: "fine" })],
        }),
      ]),
    );
    expect(merged.get(toolId)?.tool_error_result).toBeUndefined();
    expect(merged.get(toolId)?.error_message).toBeUndefined();
  });
});

describe("nodeErrorTooltip", () => {
  const base: NodeState = {
    id: "n",
    label: "N",
    status: "error",
    latency_ms: null,
  };

  test("undefined for a node without error info", () => {
    expect(
      nodeErrorTooltip({ ...base, status: "completed" }),
    ).toBeUndefined();
  });

  test("plain message renders as a single line", () => {
    expect(nodeErrorTooltip({ ...base, error_message: "boom" })).toBe("boom");
  });

  test("type and message combine", () => {
    expect(
      nodeErrorTooltip({
        ...base,
        error_type: "provider_error",
        error_message: "boom",
      }),
    ).toBe("provider_error: boom");
  });

  test("type without message", () => {
    expect(nodeErrorTooltip({ ...base, error_type: "timeout" })).toBe(
      "timeout: no message",
    );
  });

  test("diagnostics and tool result append lines", () => {
    const tip = nodeErrorTooltip({
      ...base,
      error_message: "boom",
      diagnostics: [
        diag({ code: "retry", level: "warn", message: "attempt 1 failed" }),
      ],
      tool_error_result: { error: "upstream 500" },
    });
    expect(tip).toBe(
      [
        "boom",
        "[warn] retry: attempt 1 failed",
        'Result: {"error":"upstream 500"}',
      ].join("\n"),
    );
  });

  test("long diagnostic messages and results are truncated", () => {
    const long = "x".repeat(500);
    const tip = nodeErrorTooltip({
      ...base,
      diagnostics: [diag({ code: "c", message: long })],
      tool_error_result: long,
    });
    const lines = tip?.split("\n") ?? [];
    expect(lines[0]).toBe(`[error] c: ${"x".repeat(159)}…`);
    expect(lines[1]?.length).toBeLessThanOrEqual("Result: ".length + 400);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });
});

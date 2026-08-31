// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { InMemoryDebugTraceStore } from "../debug-trace-store.js";
import {
  DEFAULT_DEBUG_TRACE_LIMITS,
  clampPayload,
  clampUtf8,
} from "../debug-trace-limits.js";
import type { DebugNodeTrace, DebugTrace } from "../../types/debug-trace.js";

const byteLen = (s: string): number => new TextEncoder().encode(s).byteLength;

const trace = (overrides: Partial<DebugTrace> = {}): DebugTrace => ({
  execution_id: "exec-1",
  flow_id: "flow-1",
  status: "running",
  started_at: "2026-08-22T10:00:00.000Z",
  finished_at: null,
  context: { user_id: "u-1" },
  input_messages: [],
  nodes: [],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  errors: [],
  ...overrides,
});

const node = (overrides: Partial<DebugNodeTrace> = {}): DebugNodeTrace => ({
  node_id: "llm-1",
  node_type: "llm",
  status: "completed",
  started_at: "2026-08-22T10:00:00.000Z",
  finished_at: "2026-08-22T10:00:01.000Z",
  latency_ms: 1_000,
  tool_calls: [],
  ...overrides,
});

describe("clampUtf8", () => {
  it("returns short text byte-identically", () => {
    expect(clampUtf8("kurz", 512)).toBe("kurz");
  });

  it("bounds the kept prefix to the byte budget", () => {
    const long = "a".repeat(5_000);
    const out = clampUtf8(long, 512);
    expect(out.startsWith("a".repeat(512))).toBe(true);
    expect(out).toContain("5000 bytes in the original");
  });

  it("never splits a multi-byte codepoint", () => {
    // "ä" is 2 bytes, so a 501-byte budget lands mid-character.
    const text = `${"a".repeat(500)}${"ä".repeat(100)}`;
    const out = clampUtf8(text, 501);
    expect(out).not.toContain("\uFFFD");
    expect(out.startsWith("a".repeat(500))).toBe(true);
  });
});

describe("clampPayload", () => {
  it("keeps structure and metadata while bounding string leaves", () => {
    const ragResult = {
      collection: "akten",
      retrieved: 2,
      chunks: [
        { id: "doc-1", score: 0.87, text: "x".repeat(4_000) },
        { id: "doc-2", score: 0.42, text: "y".repeat(4_000) },
      ],
    };

    const out = clampPayload(ragResult, 512) as typeof ragResult;

    expect(out.collection).toBe("akten");
    expect(out.retrieved).toBe(2);
    expect(out.chunks.map((c) => c.id)).toEqual(["doc-1", "doc-2"]);
    expect(out.chunks.map((c) => c.score)).toEqual([0.87, 0.42]);
    for (const chunk of out.chunks) {
      expect(byteLen(chunk.text)).toBeLessThan(700);
    }
  });
});

describe("InMemoryDebugTraceStore — text budgets", () => {
  it("bounds an LLM result to 512 bytes and the prompt to its own budget", () => {
    const store = new InMemoryDebugTraceStore(10);
    store.startTrace(trace());
    store.upsertNode(
      "exec-1",
      node({
        full_response: "r".repeat(10_000),
        full_reasoning: "t".repeat(10_000),
        full_prompt: "p".repeat(200_000),
      }),
    );

    const stored = store.getTrace("exec-1")?.nodes[0];
    expect(byteLen(stored?.full_response ?? "")).toBeLessThan(
      DEFAULT_DEBUG_TRACE_LIMITS.llmResultBytes + 128,
    );
    expect(byteLen(stored?.full_reasoning ?? "")).toBeLessThan(
      DEFAULT_DEBUG_TRACE_LIMITS.llmResultBytes + 128,
    );
    expect(byteLen(stored?.full_prompt ?? "")).toBeLessThan(
      DEFAULT_DEBUG_TRACE_LIMITS.promptBytes + 128,
    );
  });

  it("keeps a canonical latest node plus bounded per-attempt history", () => {
    const store = new InMemoryDebugTraceStore(10);
    store.startTrace(trace());
    store.upsertNode(
      "exec-1",
      node({
        attempt: 1,
        attempt_trigger: "harness-delegation",
        parent_node_id: "orchestrator",
        delegation_id: "task-1-attempt-1",
        sequence: 1,
        full_response: `first-${"a".repeat(2_000)}`,
        diagnostics: [
          {
            at: "2026-08-22T10:00:00.500Z",
            level: "warn",
            code: "retry",
            message: "first attempt",
          },
        ],
      }),
    );
    store.upsertNode(
      "exec-1",
      node({
        attempt: 2,
        attempt_trigger: "harness-delegation",
        parent_node_id: "orchestrator",
        delegation_id: "task-1-attempt-2",
        sequence: 3,
        started_at: "2026-08-22T10:00:02.000Z",
        finished_at: "2026-08-22T10:00:03.000Z",
        full_response: "second",
      }),
    );

    const stored = store.getTrace("exec-1")?.nodes[0];
    expect(stored?.attempt).toBe(2);
    expect(stored?.sequence).toBe(3);
    expect(stored?.full_response).toBe("second");
    expect(stored?.attempt_trigger).toBe("harness-delegation");
    expect(stored?.delegation_id).toBe("task-1-attempt-2");
    expect(stored?.attempts?.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(stored?.attempts?.[0]).toMatchObject({
      attempt_trigger: "harness-delegation",
      parent_node_id: "orchestrator",
      delegation_id: "task-1-attempt-1",
    });
    expect(stored?.attempts?.[0]?.diagnostics?.[0]?.code).toBe("retry");
    expect(byteLen(stored?.attempts?.[0]?.full_response ?? "")).toBeLessThan(
      DEFAULT_DEBUG_TRACE_LIMITS.llmResultBytes + 128,
    );
  });

  it("keeps every metadata field of a node untouched", () => {
    const store = new InMemoryDebugTraceStore(10);
    store.startTrace(trace());
    store.upsertNode(
      "exec-1",
      node({
        sequence: 3,
        model: "gpuvllm/qwen",
        input_tokens: 41_234,
        output_tokens: 12,
        cost: 0.0731,
        error_message: "Node failed",
        error_type: "provider_error",
        error_details: { node_id: "llm-1", phase: "provider-exhausted" },
        diagnostics: [
          {
            at: "2026-08-22T10:00:00.500Z",
            level: "error",
            code: "empty_response",
            message: "Model returned no visible text.",
          },
        ],
        tool_selection: {
          query: "fristen",
          always_included: [],
          selected: [{ ref: "vectorsearch/get_document", score: 0.91 }],
          pool_size: 12,
        },
      }),
    );

    const stored = store.getTrace("exec-1")?.nodes[0];
    expect(stored?.sequence).toBe(3);
    expect(stored?.model).toBe("gpuvllm/qwen");
    expect(stored?.input_tokens).toBe(41_234);
    expect(stored?.cost).toBe(0.0731);
    expect(stored?.error_type).toBe("provider_error");
    expect(stored?.error_details).toEqual({
      node_id: "llm-1",
      phase: "provider-exhausted",
    });
    expect(stored?.diagnostics?.[0]?.code).toBe("empty_response");
    expect(stored?.tool_selection?.selected[0]?.score).toBe(0.91);
  });

  it("bounds tool-call payload strings but keeps their structure", () => {
    const store = new InMemoryDebugTraceStore(10);
    store.startTrace(trace());
    store.upsertNode(
      "exec-1",
      node({
        tool_calls: [
          {
            id: "call-1",
            name: "vectorsearch/get_document",
            arguments: { ref: "akte/2026/17", offset: 0, length: 120_000 },
            result: { totalChars: 120_000, text: "z".repeat(120_000) },
            is_error: false,
            called_at: "2026-08-22T10:00:00.100Z",
            exec_time_seconds: 2.5,
          },
        ],
      }),
    );

    const call = store.getTrace("exec-1")?.nodes[0]?.tool_calls[0];
    expect(call).toBeDefined();
    expect((call?.arguments as { ref: string } | undefined)?.ref).toBe(
      "akte/2026/17",
    );
    expect((call?.arguments as { length: number } | undefined)?.length).toBe(
      120_000,
    );
    const result = call?.result as { totalChars: number; text: string };
    expect(result.totalChars).toBe(120_000);
    expect(byteLen(result.text)).toBeLessThan(700);
    expect(call?.exec_time_seconds).toBe(2.5);
  });

  it("bounds input messages and reports the applied limits", () => {
    const store = new InMemoryDebugTraceStore(10);
    store.startTrace(
      trace({
        input_messages: [
          { role: "user", content: "u".repeat(50_000) },
          {
            role: "user",
            content: [{ type: "image_url", image_url: "d".repeat(80_000) }],
          },
        ],
      }),
    );

    const stored = store.getTrace("exec-1");
    expect(byteLen(stored?.input_messages[0]?.content as string)).toBeLessThan(
      DEFAULT_DEBUG_TRACE_LIMITS.messageBytes + 128,
    );
    const blocks = stored?.input_messages[1]?.content as {
      type: string;
      image_url: string;
    }[];
    expect(blocks[0]?.type).toBe("image_url");
    expect(byteLen(blocks[0]?.image_url ?? "")).toBeLessThan(
      DEFAULT_DEBUG_TRACE_LIMITS.messageBytes + 128,
    );
    expect(stored?.limits).toEqual(DEFAULT_DEBUG_TRACE_LIMITS);
  });

  it("shrinks a realistic agentic trace by orders of magnitude", () => {
    const store = new InMemoryDebugTraceStore(10);
    store.startTrace(
      trace({
        input_messages: [{ role: "user", content: "Welche Fristen sind offen?" }],
      }),
    );
    for (let i = 0; i < 20; i++) {
      store.upsertNode(
        "exec-1",
        node({
          node_id: `researcher-${i}`,
          full_prompt: "p".repeat(180_000),
          full_response: "r".repeat(12_000),
          tool_calls: [
            {
              id: `call-${i}`,
              name: "vectorsearch/get_document",
              arguments: { ref: `akte/${i}` },
              result: { text: "z".repeat(100_000) },
              is_error: false,
              called_at: "2026-08-22T10:00:00.100Z",
            },
          ],
        }),
      );
    }

    const bytes = byteLen(JSON.stringify(store.getTrace("exec-1")));
    // Unbounded this is ~5.8 MB; the budgeted trace stays well under 200 KB.
    expect(bytes).toBeLessThan(200_000);
  });
});

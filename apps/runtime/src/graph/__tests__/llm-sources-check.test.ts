// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Engine tests for the opt-in post-answer sources check
 * (`config.sourcesCheck` on `llm` nodes).
 *
 * A self-search registers two sources ([1] Doc A, [2] Doc B) in the
 * execution's citation registry. The streamed answer cites both but lists
 * only [1] — the pattern of local-model traces 26ce0b42 / 4279aef7. With the
 * check on, the missing entry arrives at the client as a trailing chunk and
 * the trace/persisted answer match the stream; with it off nothing changes.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
  llmRetryBackoffMs: 0,
  defaultLlm: { provider: "openai", model: "mock-model" },
};

const SEARCH_PAYLOAD = JSON.stringify({
  results: [
    { id: "a1", base_ref: "/akte/A", title: "Doc A", content: "Passage A.", score: 0.7 },
    { id: "b1", base_ref: "/akte/B", title: "Doc B", content: "Passage B.", score: 0.5 },
  ],
  count: 2,
});

const mcp: McpWrapperService = {
  connect: async () => {},
  reconnect: async () => {},
  listTools: async () => ["search"],
  getFilteredToolSchema: async (_server: string, tool: string) => ({
    name: tool,
    inputSchema: { type: "object", properties: {} },
  }),
  refreshSchemaIfChanged: async () => false,
  callTool: async () => ({ content: [{ type: "text", text: SEARCH_PAYLOAD }] }),
  getInstructions: () => undefined,
} as unknown as McpWrapperService;

const usage = {
  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

/** Call 1: one native search call; call 2+: the scripted answer text. */
function factory(answer: string) {
  let calls = 0;
  return () =>
    new MockLanguageModelV3({
      doStream: async () => {
        const index = calls++;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              if (index === 0) {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "kb__search",
                  input: "{}",
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                  usage,
                });
              } else {
                controller.enqueue({ type: "text-start", id: "t" });
                for (let i = 0; i < answer.length; i += 9) {
                  controller.enqueue({
                    type: "text-delta",
                    id: "t",
                    delta: answer.slice(i, i + 9),
                  });
                }
                controller.enqueue({ type: "text-end", id: "t" });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "stop" as const, raw: "stop" },
                  usage,
                });
              }
              controller.close();
            },
          }),
        } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
      },
    });
}

function flowWith(config: Record<string, unknown>): FlowDefinition {
  return {
    id: "sources-check-flow",
    name: "Sources Check",
    nodes: [
      {
        id: "llm-1",
        type: "llm",
        tools: ["kb/search"],
        config: { maxToolSteps: 2, ...config },
      },
    ],
    edges: [],
  };
}

async function run(answer: string, config: Record<string, unknown>, executionId: string) {
  const flow = flowWith(config);
  const map = new Map([[flow.id, flow]]);
  const registry: FlowRegistry = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    mcpWrapper: mcp,
    llmProviderFactory: factory(answer),
  });
  const debugStore = new InMemoryDebugTraceStore();
  engine.setDebugStore?.(debugStore);
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "Bewerte die Meldung" }],
    { ssoToken: "a.b.c", executionId },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  const deltas = chunks
    .map((chunk) => chunk.choices[0]?.delta.content)
    .filter((text): text is string => typeof text === "string" && text.length > 0);
  const sourceIndexes = chunks.flatMap((chunk) =>
    ((chunk as { sources?: Array<{ index: number }> }).sources ?? []).map(
      (source) => source.index,
    ),
  );
  const node = debugStore
    .getTrace(executionId)
    ?.nodes.find((entry) => entry.node_id === "llm-1");
  const diagnostics = node?.diagnostics ?? [];
  return {
    deltas,
    content: deltas.join(""),
    sourceIndexes,
    node,
    check: diagnostics.find((entry) => entry.code === "answer_sources_check"),
  };
}

const ANSWER_MISSING_2 = "Befund [1][2].\n\n## Quellen\n[1] Doc A";

describe("LLM node — post-answer sources check", () => {
  test("streaming: a missing cited source arrives as a trailing chunk", async () => {
    const r = await run(
      ANSWER_MISSING_2,
      { suppressToolPreamble: true, sourcesCheck: { completeSection: true } },
      "exec-sources-check-stream",
    );

    expect(r.sourceIndexes).toEqual(expect.arrayContaining([1, 2]));
    const last = r.deltas[r.deltas.length - 1] ?? "";
    expect(last.startsWith("\n[2] Doc B")).toBe(true);
    expect(r.content.startsWith(ANSWER_MISSING_2)).toBe(true);
    expect(r.content).toContain("\n[2] Doc B");
    expect(r.node?.full_response).toBe(r.content);
    expect(r.node?.status).toBe("completed");
    expect(r.check?.level).toBe("info");
    expect(r.check?.details).toMatchObject({
      appended_sources: [2],
      unresolved_markers: [],
      created_section: false,
    });
  });

  test("live (non-buffered) path also receives the trailing chunk", async () => {
    const r = await run(
      ANSWER_MISSING_2,
      { sourcesCheck: { completeSection: true } },
      "exec-sources-check-live",
    );

    expect(r.deltas.length).toBeGreaterThan(2);
    expect(r.content).toContain("\n[2] Doc B");
    expect(r.node?.full_response).toBe(r.content);
  });

  test("missing section is created; an unregistered [n] is only reported", async () => {
    const r = await run(
      "Befund [2] und [7].",
      { suppressToolPreamble: true, sourcesCheck: { completeSection: true } },
      "exec-sources-check-create",
    );

    expect(r.content).toContain("Befund [2] und [7].\n\n## Quellen\n[2] Doc B");
    expect(r.content).not.toMatch(/^\[7\]/m);
    expect(r.check?.level).toBe("warn");
    expect(r.check?.details).toMatchObject({
      appended_sources: [2],
      unresolved_markers: [7],
      created_section: true,
    });
  });

  test("stripRuleMarkers removes [Regel: …] from the buffered answer only when enabled", async () => {
    const answer = "Kein Mangel [Regel: ohne Beleg kein Mangel] [1].\n\n## Quellen\n[1] Doc A";
    const on = await run(
      answer,
      { suppressToolPreamble: true, sourcesCheck: { stripRuleMarkers: true } },
      "exec-sources-check-strip",
    );
    expect(on.content).toBe("Kein Mangel [1].\n\n## Quellen\n[1] Doc A");
    expect(on.node?.full_response).toBe(on.content);
    expect(on.check?.details).toMatchObject({
      removed_markers: ["[Regel: ohne Beleg kein Mangel]"],
      appended_sources: [],
    });

    const completeOnly = await run(
      answer,
      { suppressToolPreamble: true, sourcesCheck: { completeSection: true } },
      "exec-sources-check-no-strip",
    );
    expect(completeOnly.content).toBe(answer);
    expect(completeOnly.check).toBeUndefined();
  });

  test("switch off → behaviour unchanged", async () => {
    for (const config of [
      { suppressToolPreamble: true },
      { suppressToolPreamble: true, sourcesCheck: { completeSection: false } },
    ]) {
      const r = await run(ANSWER_MISSING_2, config, `exec-sources-check-off-${Object.keys(config).length}`);
      expect(r.content).toBe(ANSWER_MISSING_2);
      expect(r.node?.full_response).toBe(ANSWER_MISSING_2);
      expect(r.check).toBeUndefined();
    }
  });
});

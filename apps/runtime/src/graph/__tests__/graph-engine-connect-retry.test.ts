// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Connect-retry of a single tool-loop step through the real provider factory.
 *
 * Step 1 streams text and a tool call; step 2's request fails with a socket
 * reset before any response byte. The transport retries that step once on a
 * fresh connection, so the attempt completes even though earlier output was
 * already streamed. A second failure, or a failure in the middle of a step's
 * own response, keeps today's behaviour.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateText } from "ai";
import type { AppConfig } from "../../config/index.js";
import { setProviderRegistry } from "../../config/providers.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { DebugNodeDiagnostic } from "../../types/debug-trace.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { createLlmProvider } from "../llm-factory.js";

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
  defaultLlm: { provider: "vllm", model: "m" },
  // A remaining candidate disables the AI SDK's own retries for the primary
  // (llm-candidate-loop), isolating the transport-level connect-retry.
  fallbackLlm: { provider: "vllm", model: "m-fallback" },
};

const flow: FlowDefinition = {
  id: "connect-retry-flow",
  name: "Connect retry",
  nodes: [{ id: "researcher", type: "llm", tools: ["vectorsearch/search"] }],
  edges: [],
};

function registry(def: FlowDefinition): FlowRegistry {
  return { get: (id) => (id === def.id ? def : undefined), list: () => [def] };
}

const mcp = {
  connect: async () => {},
  reconnect: async () => {},
  listTools: async () => ["search"],
  getFilteredToolSchema: async (_server: string, tool: string) => ({
    name: tool,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  }),
  refreshSchemaIfChanged: async () => false,
  callTool: async () => ({
    content: [{ type: "text", text: JSON.stringify({ results: [{ content: "Treffer" }] }) }],
  }),
  getInstructions: () => undefined,
} as unknown as McpWrapperService;

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const sse = (events: string[]) =>
  new Response(`${events.join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const toolStep = () =>
  sse([
    chunk({ role: "assistant", content: "Ich suche zuerst. " }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: "call_1",
          type: "function",
          function: { name: "vectorsearch__search", arguments: '{"query":"x"}' },
        },
      ],
    }),
    chunk({}, "tool_calls"),
  ]);

const answerStep = () =>
  sse([chunk({ role: "assistant", content: "Endantwort." }), chunk({}, "stop")]);

const reset = () =>
  Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

async function run(
  stub: (n: number) => Promise<Response>,
  executionId: string,
  mcpFor: (fetchStub: typeof fetch) => McpWrapperService = () => mcp,
) {
  let calls = 0;
  const fetchStub = (async () => {
    calls += 1;
    return stub(calls);
  }) as unknown as typeof fetch;
  const engine = createGraphEngine(
    { ...baseConfig, llmMaxAttempts: 1 },
    {
      flowRegistry: registry(flow),
      mcpWrapper: mcpFor(fetchStub),
      llmProviderFactory: (cfg, app) => createLlmProvider(cfg, app, { fetch: fetchStub }),
    },
  );
  const debugStore = new InMemoryDebugTraceStore();
  engine.setDebugStore?.(debugStore);
  let content = "";
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "Frage" }],
    { ssoToken: "a.b.c", executionId },
    async (c) => {
      const delta = c.choices[0]?.delta.content;
      if (typeof delta === "string") content += delta;
    },
    async () => {},
  );
  const node = debugStore
    .getTrace(executionId)
    ?.nodes.find((entry) => entry.node_id === "researcher");
  const diagnostics: DebugNodeDiagnostic[] = node?.diagnostics ?? [];
  return { calls: () => calls, content, node, diagnostics };
}

describe("graph engine — per-step connect retry", () => {
  afterEach(() => {
    setProviderRegistry(undefined);
  });

  test("a reset before step 2's response is retried and the answer completes", async () => {
    setProviderRegistry([{ name: "vllm", protocol: "openai", url: "http://vllm:8000/v1" }]);
    const outcome = await run(
      (n) =>
        n === 1 ? Promise.resolve(toolStep()) : n === 2 ? Promise.reject(reset()) : Promise.resolve(answerStep()),
      "exec-connect-retry-ok",
    );
    expect(outcome.calls()).toBe(3);
    expect(outcome.content).toContain("Endantwort.");
    expect(outcome.node?.status).toBe("completed");
    const retry = outcome.diagnostics.find((d) => d.code === "llm_step_connect_retry");
    expect(retry?.level).toBe("warn");
    expect(retry?.details).toMatchObject({
      provider: "vllm",
      model: "m",
      attempt: 1,
      request_index: 2,
      error_code: "ECONNRESET",
      keep_alive: true,
    });
    expect(
      outcome.diagnostics.find((d) => d.code === "llm_provider_error_detail"),
    ).toBeUndefined();
  });

  test("a failing retry keeps today's error after partial output", async () => {
    setProviderRegistry([{ name: "vllm", protocol: "openai", url: "http://vllm:8000/v1" }]);
    const outcome = await run(
      (n) => (n === 1 ? Promise.resolve(toolStep()) : Promise.reject(reset())),
      "exec-connect-retry-fail",
    );
    expect(outcome.calls()).toBe(3);
    expect(outcome.node?.status).toBe("error");
    expect(
      outcome.diagnostics.find((d) => d.code === "llm_step_connect_retry_failed")?.details,
    ).toMatchObject({ request_index: 2, error_code: "ECONNRESET", retry_error_code: "ECONNRESET" });
    expect(
      outcome.diagnostics.find((d) => d.code === "llm_provider_error_detail")?.details,
    ).toMatchObject({ after_partial_output: true, transport_error_code: "ECONNRESET" });
  });

  test("a step aborted in the middle of its own response is not retried", async () => {
    setProviderRegistry([{ name: "vllm", protocol: "openai", url: "http://vllm:8000/v1" }]);
    const outcome = await run((n) => {
      if (n === 1) return Promise.resolve(toolStep());
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(chunk({ role: "assistant", content: "Halb" })),
              );
              controller.error(reset());
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    }, "exec-connect-retry-midstream");
    expect(outcome.calls()).toBe(2);
    expect(outcome.node?.status).toBe("error");
    expect(
      outcome.diagnostics.find((d) => d.code === "llm_step_connect_retry"),
    ).toBeUndefined();
    expect(
      outcome.diagnostics.find((d) => d.code === "llm_provider_error_detail")?.details,
    ).toMatchObject({ after_partial_output: true });
  });

  test("a nested LLM request inside a tool does not count or report on the outer node", async () => {
    setProviderRegistry([{ name: "vllm", protocol: "openai", url: "http://vllm:8000/v1" }]);
    const completion = () =>
      new Response(
        JSON.stringify({
          id: "n",
          object: "chat.completion",
          created: 0,
          model: "m-nested",
          choices: [
            { index: 0, message: { role: "assistant", content: "Zusammenfassung" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    // 1 outer step 1 · 2 nested reset · 3 nested retry · 4 outer step 2 reset · 5 outer retry
    const outcome = await run(
      (n) =>
        n === 1
          ? Promise.resolve(toolStep())
          : n === 2 || n === 4
            ? Promise.reject(reset())
            : n === 3
              ? Promise.resolve(completion())
              : Promise.resolve(answerStep()),
      "exec-connect-retry-nested",
      (fetchStub) =>
        ({
          ...mcp,
          // A tool that issues its own LLM request (like the harness delegate).
          callTool: async () => {
            const nested = await generateText({
              model: createLlmProvider({ provider: "vllm", model: "m-nested" }, baseConfig, {
                fetch: fetchStub,
              }),
              prompt: "fasse zusammen",
              maxRetries: 0,
            });
            return { content: [{ type: "text", text: nested.text }] };
          },
        }) as unknown as McpWrapperService,
    );
    expect(outcome.calls()).toBe(5);
    expect(outcome.content).toContain("Endantwort.");
    expect(outcome.node?.status).toBe("completed");
    const retries = outcome.diagnostics.filter((d) => d.code === "llm_step_connect_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.details).toMatchObject({
      provider: "vllm",
      model: "m",
      request_index: 2,
      error_code: "ECONNRESET",
    });
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the new engine-wired features:
 *   - human-in-the-loop approval gate (deterministic tool node)
 *   - groundedness gate (LLM node with retrieval context)
 *
 * Uses a mocked LLM provider and a fake MCP wrapper — no network.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import { createApprovalGate } from "../approval-gate.js";
import { createGroundednessGate } from "../groundedness.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";

/** `createApprovalGate` for a config known to enable the gate. */
function mustCreateApprovalGate(
  ...args: Parameters<typeof createApprovalGate>
): NonNullable<ReturnType<typeof createApprovalGate>> {
  const gate = createApprovalGate(...args);
  if (gate === undefined)
    throw new Error("expected the approval gate to be enabled");
  return gate;
}

/** `createGroundednessGate` for a config known to enable the gate. */
function mustCreateGroundednessGate(
  ...args: Parameters<typeof createGroundednessGate>
): NonNullable<ReturnType<typeof createGroundednessGate>> {
  const gate = createGroundednessGate(...args);
  if (gate === undefined)
    throw new Error("expected the groundedness gate to be enabled");
  return gate;
}

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

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
  defaultLlm: { provider: "openai", model: "mock-model" },
};

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function mockLlm(tokens: string[]) {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              for (const t of tokens) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({ type: "text-delta", id: "1", delta: t });
                controller.enqueue({ type: "text-end", id: "1" });
              }
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: {
                  inputTokens: {
                    total: 7,
                    noCache: undefined,
                    cacheRead: undefined,
                    cacheWrite: undefined,
                  },
                  outputTokens: {
                    total: 5,
                    text: undefined,
                    reasoning: undefined,
                  },
                },
              });
              controller.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
}

function fakeMcp(content: unknown): McpWrapperService {
  return {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["lookup"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async () => ({ content }),
    getInstructions: () => undefined,
  };
}

const ctx = { ssoToken: "a.b.c", executionId: "exec-1" };

describe("approval gate (deterministic tool node)", () => {
  const flow: FlowDefinition = {
    id: "tool-flow",
    name: "Tool",
    nodes: [
      {
        id: "act",
        type: "tool",
        tools: ["fake/lookup"],
        config: { requiresApproval: ["fake/lookup"] },
      },
    ],
    edges: [],
  };

  test("denies (auto-timeout) → emits a tool_error, never calls the tool", async () => {
    let called = false;
    const mcp: McpWrapperService = {
      ...fakeMcp("ok"),
      callTool: async () => {
        called = true;
        return { content: "ok" };
      },
    };
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 30 });
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: registry(flow),
      mcpWrapper: mcp,
      llmProviderFactory: mockLlm([]),
      approvalGate: gate,
    });

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "tool-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );

    expect(called).toBe(false);
    const errs = chunks.filter((c) => c.choices[0]?.finish_reason === "error");
    expect(errs.length).toBeGreaterThanOrEqual(1);
  });

  test("approve → tool runs and an approval_required chunk was surfaced", async () => {
    let called = false;
    const mcp: McpWrapperService = {
      ...fakeMcp("done"),
      callTool: async () => {
        called = true;
        return { content: "done" };
      },
    };
    const gate = mustCreateApprovalGate({ enabled: true, timeoutMs: 5000 });
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: registry(flow),
      mcpWrapper: mcp,
      llmProviderFactory: mockLlm([]),
      approvalGate: gate,
    });

    // Concurrently approve the first pending request.
    const approver = (async () => {
      for (let i = 0; i < 100; i++) {
        const pending = await gate.listPending();
        if (pending.length > 0) {
          await gate.resolve(at(pending, 0).id, {
            approved: true,
            by: "tester",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "tool-flow",
      [{ role: "user", content: "do it" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );
    await approver;

    expect(called).toBe(true);
    const approvalChunks = chunks.filter(
      (c) =>
        (c as unknown as { approval_required?: unknown }).approval_required,
    );
    expect(approvalChunks.length).toBe(1);
  });
});

describe("deterministic tool node result visibility", () => {
  test("keeps the tool call visible but suppresses the result payload", async () => {
    const flow: FlowDefinition = {
      id: "private-tool-result-flow",
      name: "Private Tool Result",
      nodes: [
        {
          id: "dossier",
          type: "tool",
          tools: ["fake/lookup"],
          config: { streamToolResultDetails: false },
        },
      ],
      edges: [],
    };
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: registry(flow),
      mcpWrapper: fakeMcp("SECRET_TOOL_RESULT"),
      llmProviderFactory: mockLlm([]),
    });
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "load dossier" }],
      ctx,
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    const serialized = JSON.stringify(chunks);
    expect(serialized).toContain("fake/lookup");
    expect(serialized).not.toContain("SECRET_TOOL_RESULT");
  });
});

describe("groundedness gate (LLM node with retrieval context)", () => {
  // tool node fetches context → llm node answers using (or ignoring) it.
  const flow: FlowDefinition = {
    id: "rag-flow",
    name: "RAG",
    nodes: [
      { id: "rag", type: "tool", tools: ["fake/lookup"] },
      { id: "answer", type: "llm" },
    ],
    edges: [{ source: "rag", target: "answer" }],
  };

  function buildEngine(tokens: string[]) {
    const gate = mustCreateGroundednessGate({
      enabled: true,
      mode: "block",
      passThreshold: 0.9,
    });
    return createGraphEngine(baseConfig, {
      flowRegistry: registry(flow),
      mcpWrapper: fakeMcp(
        "Paris is the capital of France, on the river Seine.",
      ),
      llmProviderFactory: mockLlm(tokens),
      groundednessGate: gate,
    });
  }

  test("emits a groundedness chunk reflecting support", async () => {
    const engine = buildEngine([
      "Paris ",
      "is the capital of France on the Seine.",
    ]);
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "rag-flow",
      [{ role: "user", content: "capital of France?" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );
    const g = chunks
      .map(
        (c) =>
          (c as unknown as { groundedness?: { passed: boolean } }).groundedness,
      )
      .filter((x): x is { passed: boolean } => x !== undefined);
    expect(g.length).toBe(1);
    expect(at(g, 0).passed).toBe(true);
  });

  test("ungrounded answer fails and a warning footer is streamed", async () => {
    const engine = buildEngine([
      "The capital of France is actually Atlantis, ",
      "ruled by sentient dolphins who collect taxes.",
    ]);
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "rag-flow",
      [{ role: "user", content: "capital of France?" }],
      ctx,
      async (c) => {
        chunks.push(c);
      },
      async () => {},
    );
    const g = chunks
      .map(
        (c) =>
          (c as unknown as { groundedness?: { passed: boolean } }).groundedness,
      )
      .filter((x): x is { passed: boolean } => x !== undefined);
    expect(g.length).toBe(1);
    expect(at(g, 0).passed).toBe(false);

    // The block-mode warning footer is streamed as content.
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toContain("Note");
  });
});

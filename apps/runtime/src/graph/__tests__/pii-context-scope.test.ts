// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * PII_VAULT_SCOPE=messages+context (ADR 0036, step 4): personal data in
 * retrieved chunks and tool results is tokenized before it enters the model
 * context, and restored in the answer the caller receives. With the default
 * scope nothing changes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type { AppConfig } from "../../config/index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import { withPiiVault } from "../pii-vault-engine.js";
import { createPiiVault, InMemoryPiiVaultStore } from "../pii-vault.js";
import type { PiiVault } from "../pii-vault.js";
import {
  createPiiContextScope,
  setPiiContextScope,
} from "../pii-tool-boundary.js";
import { InMemoryRagStore } from "../vector-store.js";
import type { Embedder } from "../semantic-cache.js";

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

const usage = {
  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

const SECRET_MAIL = "erika.musterfrau@example.com";

const embedder: Embedder = {
  async embed(): Promise<number[]> {
    return [1, 0];
  },
};

/** A model that answers by quoting every placeholder it was shown. */
function quotingModel(prompts: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async (options: LanguageModelV3CallOptions) => {
      const prompt = JSON.stringify(options.prompt);
      prompts.push(prompt);
      const placeholders = prompt.match(/\[\[PII:[A-Z_]+:[a-f0-9]{16}\]\]/g) ?? [];
      const text = `Contact: ${placeholders[0] ?? "none"}`;
      return {
        stream: new ReadableStream({
          start(controller: ReadableStreamDefaultController<unknown>) {
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: text });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop" as const, raw: "stop" },
              usage,
            });
            controller.close();
          },
        }),
      } as unknown as LanguageModelV3StreamResult;
    },
  });
}

function registry(flow: FlowDefinition): FlowRegistry {
  const map = new Map([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

function newVault(): PiiVault {
  const v = createPiiVault(new InMemoryPiiVaultStore(), { enabled: true });
  if (v === undefined) throw new Error("vault expected");
  return v;
}

async function collect(
  engine: ReturnType<typeof withPiiVault>,
  flowId: string,
  executionId: string,
): Promise<string> {
  let answer = "";
  await engine.executeFlow(
    flowId,
    [{ role: "user", content: "Who is the contact for invoices?" }],
    { ssoToken: "a.b.c", executionId },
    async (chunk: ChatCompletionChunk) => {
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === "string") answer += delta;
    },
    async () => {},
  );
  return answer;
}

afterEach(() => setPiiContextScope(undefined));

describe("retrieved content", () => {
  const flow: FlowDefinition = {
    id: "rag-flow",
    name: "RAG",
    nodes: [
      { id: "retrieve", type: "retrieval", config: { collection: "kb", topK: 1 } },
      { id: "answer", type: "llm", llm: { provider: "openai", model: "mock-model" } },
    ],
    edges: [{ source: "retrieve", target: "answer" }],
  };

  async function run(scoped: boolean): Promise<{ prompts: string[]; answer: string }> {
    const vault = newVault();
    setPiiContextScope(scoped ? createPiiContextScope(vault) : undefined);
    const store = new InMemoryRagStore();
    await store.upsert("kb", [
      {
        id: "d1",
        text: `Invoices are handled by the billing desk, contact ${SECRET_MAIL}.`,
        embedding: [1, 0],
      },
    ]);
    const prompts: string[] = [];
    const engine = withPiiVault(
      createGraphEngine(baseConfig, {
        flowRegistry: registry(flow),
        llmProviderFactory: () => quotingModel(prompts),
        embedder,
        vectorStore: store,
      }),
      vault,
    );
    const answer = await collect(engine, flow.id, `exec-rag-${scoped}`);
    return { prompts, answer };
  }

  test("messages+context: the model sees a placeholder, the caller gets the address", async () => {
    const { prompts, answer } = await run(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(SECRET_MAIL);
    expect(prompts[0]).toMatch(/\[\[PII:EMAIL:[a-f0-9]{16}\]\]/);
    expect(answer).toContain(SECRET_MAIL);
  });

  test("messages (default): retrieved text reaches the model unchanged", async () => {
    const { prompts } = await run(false);
    expect(prompts[0]).toContain(SECRET_MAIL);
  });
});

describe("tool results", () => {
  const flow: FlowDefinition = {
    id: "tool-flow",
    name: "Tool",
    nodes: [
      {
        id: "lookup",
        type: "tool",
        tools: ["crm/contact"],
        // Hand the live result to the responder (otherwise a non-search tool
        // result only lands in state and audit).
        config: { injectResultContext: true },
      },
      { id: "answer", type: "llm", llm: { provider: "openai", model: "mock-model" } },
    ],
    edges: [{ source: "lookup", target: "answer" }],
  };

  const mcp: McpWrapperService = {
    connect: async () => {},
    reconnect: async () => {},
    listTools: async () => ["contact"],
    getFilteredToolSchema: async (_s, t) => ({
      name: t,
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
    }),
    refreshSchemaIfChanged: async () => false,
    callTool: async () => ({
      content: [{ type: "text", text: `{"owner":"${SECRET_MAIL}","open":3}` }],
    }),
    getInstructions: () => undefined,
  };

  async function run(scoped: boolean): Promise<{ prompts: string[]; answer: string }> {
    const vault = newVault();
    setPiiContextScope(scoped ? createPiiContextScope(vault) : undefined);
    const prompts: string[] = [];
    const engine = withPiiVault(
      createGraphEngine(baseConfig, {
        flowRegistry: registry(flow),
        mcpWrapper: mcp,
        llmProviderFactory: () => quotingModel(prompts),
      }),
      vault,
    );
    const answer = await collect(engine, flow.id, `exec-tool-${scoped}`);
    return { prompts, answer };
  }

  test("messages+context: the tool result reaches the model tokenized", async () => {
    const { prompts, answer } = await run(true);
    expect(prompts.join("\n")).not.toContain(SECRET_MAIL);
    expect(prompts.join("\n")).toMatch(/\[\[PII:EMAIL:[a-f0-9]{16}\]\]/);
    expect(answer).toContain(SECRET_MAIL);
  });

  test("messages (default): the tool result reaches the model unchanged", async () => {
    const { prompts } = await run(false);
    expect(prompts.join("\n")).toContain(SECRET_MAIL);
  });
});

describe("fail-closed detection", () => {
  test("a failing detector stops the value instead of passing plaintext", async () => {
    const scope = createPiiContextScope({
      tokenize: async () => {
        throw new Error("detector unavailable");
      },
      detokenize: async (_executionId, text) => text,
    });
    await expect(
      scope.tokenizeValue({ executionId: "e" }, { text: `mail ${SECRET_MAIL}` }),
    ).rejects.toThrow("detector unavailable");
  });

  test("returns the same object when nothing is detected", async () => {
    const scope = createPiiContextScope(newVault());
    const value = { text: "nothing personal here", n: 4 };
    expect(await scope.tokenizeValue({ executionId: "e" }, value)).toBe(value);
  });

  test("restoreValue puts the real text back for what goes to the caller", async () => {
    const vault = newVault();
    const scope = createPiiContextScope(vault);
    const ctx = { executionId: "exec-restore" };
    const tokenized = await scope.tokenizeValue(ctx, {
      title: "Billing desk",
      snippet: `write to ${SECRET_MAIL}`,
    });
    expect(tokenized.snippet).not.toContain(SECRET_MAIL);
    const restored = await scope.restoreValue(ctx, [tokenized]);
    expect(restored[0]?.snippet).toBe(`write to ${SECRET_MAIL}`);
  });
});

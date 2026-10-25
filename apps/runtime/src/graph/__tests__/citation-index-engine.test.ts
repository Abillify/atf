// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Engine tests for the opt-in answer citation index
 * (`CITATION_INDEX_ENABLED`, wired as the `citationIndex` engine store).
 *
 * A self-search registers two sources — [1] carries a `chunk_id`, [2] does
 * not. The answer cites both. The store must receive exactly one row for [1]
 * with `cited` true and the tenant/user/execution stamped from the request
 * context; a failing store must never break the execution; without the store
 * (feature off) the flow completes unchanged.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import {
  InMemoryCitationIndexStore,
} from "../../compliance/citation-index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
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

// [1] is resolvable by the citation check (chunk_id + document_id), [2] is
// not — it must never reach the index.
const SEARCH_PAYLOAD = JSON.stringify({
  results: [
    {
      id: "a1",
      base_ref: "/akte/A",
      document_id: "/akte/A",
      chunk_id: "chunk-a",
      version: "v7",
      title: "Doc A",
      content: "Passage A.",
      score: 0.7,
    },
    {
      id: "b1",
      base_ref: "/akte/B",
      document_id: "/akte/B",
      title: "Doc B",
      content: "Passage B.",
      score: 0.5,
    },
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

const flow: FlowDefinition = {
  id: "citation-index-flow",
  name: "Citation Index",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      tools: ["kb/search"],
      config: { maxToolSteps: 2, suppressToolPreamble: true },
    },
  ],
  edges: [],
};

async function run(
  answer: string,
  executionId: string,
  citationIndex: InMemoryCitationIndexStore | undefined,
) {
  const map = new Map([[flow.id, flow]]);
  const registry: FlowRegistry = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    mcpWrapper: mcp,
    llmProviderFactory: factory(answer),
    ...(citationIndex !== undefined ? { citationIndex } : {}),
  });
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "Bewerte die Meldung" }],
    {
      ssoToken: "a.b.c",
      executionId,
      clientId: "tenant-a",
      userId: "user-1",
    },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  // The index write is fire-and-forget after the answer was delivered.
  await Bun.sleep(10);
  const content = chunks
    .map((chunk) => chunk.choices[0]?.delta.content)
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("");
  return { content };
}

describe("citation index — engine hook", () => {
  test("records the cited chunk with tenant, user, and execution", async () => {
    const store = new InMemoryCitationIndexStore();
    const { content } = await run(
      "Befund [1][2].\n\n## Quellen\n[1] Doc A\n[2] Doc B",
      "exec-cit-idx-1",
      store,
    );
    expect(content).toContain("Befund [1][2].");
    // Only the chunk_id source is recorded; the answer cites it.
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]).toEqual({
      tenantId: "tenant-a",
      userId: "user-1",
      executionId: "exec-cit-idx-1",
      flowId: flow.id,
      flowVersion: null,
      baseRef: "/akte/A",
      chunkId: "chunk-a",
      revision: "v7",
      citationIndex: 1,
      cited: true,
    });
  });

  test("an answer citing nothing still records the chunk as uncited", async () => {
    const store = new InMemoryCitationIndexStore();
    await run("Befund ohne Belege.", "exec-cit-idx-2", store);
    expect(store.recorded).toHaveLength(1);
    expect(store.recorded[0]?.cited).toBe(false);
  });

  test("a failing store does not break the execution", async () => {
    const store = new InMemoryCitationIndexStore();
    store.failWith = new Error("db down");
    const { content } = await run(
      "Befund [1].",
      "exec-cit-idx-3",
      store,
    );
    // The answer still arrives complete even though the write rejected.
    expect(content).toContain("Befund [1].");
  });

  test("without the store (feature off) the flow completes unchanged", async () => {
    const { content } = await run("Befund [1].", "exec-cit-idx-4", undefined);
    expect(content).toContain("Befund [1].");
  });
});

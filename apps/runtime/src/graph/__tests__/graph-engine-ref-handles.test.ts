// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * End-to-end ref-handle round trip through the graph engine.
 *
 * A node with `config.refHandles` sees handles in its tool results and quotes
 * them back; the coverage harness relies on everything DOWNSTREAM of that node
 * (its answer text, its returned/persisted messages that later nodes, the
 * verifier and the synthesizer read) carrying the REAL references again. This
 * pins that contract on a real engine run:
 *   - the model-facing tool result is masked (handle, no path),
 *   - the handle-valued tool call reaches the MCP server as the real reference,
 *   - the streamed answer and the state handed to the next node are unmapped.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import { HashRefHandleRegistry } from "../ref-handles.js";

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

const PDF = "/Spezifikation Alpha_Prozesse/Spezifikation Alpha_Prozesse.pdf";
const R = `${PDF}/73. 9.5 Akteneinheit prüfen`;
const HANDLE = new HashRefHandleRegistry().register(R);

const flow: FlowDefinition = {
  id: "ref-handle-roundtrip",
  name: "Ref handle round trip",
  nodes: [
    {
      id: "researcher",
      type: "llm",
      tools: ["vectorsearch/search", "vectorsearch/get_document"],
      config: { refHandles: true },
    },
    { id: "downstream", type: "llm" },
  ],
  edges: [{ source: "researcher", target: "downstream" }],
};

function registry(def: FlowDefinition): FlowRegistry {
  return { get: (id) => (id === def.id ? def : undefined), list: () => [def] };
}

const usage = {
  inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

describe("graph engine — ref-handle round trip", () => {
  test("masks for the model, resolves for MCP, unmaps for everything downstream", async () => {
    const mcpCalls: Array<{ tool: string; args: unknown }> = [];
    const mcp = {
      connect: async () => {},
      reconnect: async () => {},
      listTools: async () => ["search", "get_document"],
      getFilteredToolSchema: async (_server: string, tool: string) => ({
        name: tool,
        inputSchema: { type: "object", properties: {} },
      }),
      refreshSchemaIfChanged: async () => false,
      callTool: async (_server: string, tool: string, args: unknown) => {
        mcpCalls.push({ tool, args });
        const payload =
          tool === "search"
            ? { results: [{ base_ref: R, link: PDF, title: "9.5", content: "Treffer" }] }
            : { reference: R, content: "Akteneinheit pruefen", totalChars: 20 };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
      getInstructions: () => undefined,
    } as unknown as McpWrapperService;

    const prompts: string[] = [];
    const factory = () =>
      new MockLanguageModelV3({
        doStream: async (options: { prompt: unknown }) => {
          prompts.push(JSON.stringify(options.prompt));
          const call = prompts.length;
          return {
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                if (call === 1 || call === 2) {
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: `c${call}`,
                    toolName:
                      call === 1 ? "vectorsearch__search" : "vectorsearch__get_document",
                    input:
                      call === 1
                        ? JSON.stringify({ query: "Akteneinheit" })
                        : JSON.stringify({ reference: HANDLE }),
                  });
                  controller.enqueue({
                    type: "finish",
                    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                    usage,
                  });
                } else {
                  const text = call === 3 ? `Beleg: ${HANDLE}` : "ok";
                  controller.enqueue({ type: "text-start", id: `t${call}` });
                  controller.enqueue({ type: "text-delta", id: `t${call}`, delta: text });
                  controller.enqueue({ type: "text-end", id: `t${call}` });
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

    const engine = createGraphEngine(baseConfig, {
      flowRegistry: registry(flow),
      mcpWrapper: mcp,
      llmProviderFactory: factory,
    });
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "Wie wird eine Akteneinheit geprueft?" }],
      { ssoToken: "a.b.c", executionId: "exec-ref-handles" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    // MCP saw only real references.
    expect(mcpCalls.map((c) => c.tool)).toEqual(["search", "get_document"]);
    expect(mcpCalls[1]?.args).toEqual({ reference: R });

    // The masking node's model read the handle, never the chapter path.
    expect(prompts.length).toBe(4);
    expect(prompts[1]).toContain(HANDLE);
    expect(prompts[1]).not.toContain("73. 9.5 Akteneinheit");
    // `link` is not a reference and stays visible as the bare file path.
    expect(prompts[1]).toContain("Spezifikation Alpha_Prozesse.pdf");

    // The downstream node receives the researcher's state unmapped: its answer
    // and the tool results carry the real reference, no handle.
    const downstreamPrompt = prompts[3] ?? "";
    expect(downstreamPrompt).toContain(`Beleg: ${R}`);
    expect(downstreamPrompt).not.toContain(HANDLE);

    // The user-facing stream is unmapped as well.
    const content = chunks
      .map((chunk) => chunk.choices[0]?.delta.content)
      .filter((text): text is string => typeof text === "string")
      .join("");
    expect(content).not.toContain(HANDLE);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-loop robustness of the LLM node (local-model traces 01636a1d / f679dbe6).
 *
 * 1. At the tool-step budget the loop runs one extra, tool-free final-answer
 *    round instead of stopping right after the last tool result.
 * 2. A `post_tool_answer_missing` retry continues from the attempt's tool
 *    calls/results without offering tools (no restart with a result excerpt).
 * 3. A tool call written as template text is never released as content; it
 *    is retried as an answer-only continuation.
 * 4. A model that keeps writing text tool calls fails the node.
 * 5. Without `suppressToolPreamble` a text tool call after the tool phase is
 *    held by the per-step lookahead and never streamed live; a text call
 *    before any tool use is retried with tools; the excerpt fallback of
 *    `post_tool_answer_missing` runs without tools as well.
 * 6. Answer-only rounds are valid on every provider's wire (real AI SDK
 *    providers behind a capturing fetch): OpenAI drops the tool list,
 *    Google keeps the declarations with mode NONE, Anthropic and Bedrock
 *    receive the tool exchange as text without any tool definitions.
 */

import { describe, expect, test } from "bun:test";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { MockLanguageModelV3, MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { answerOnlyToolMode, toolHistoryAsText } from "../answer-only-tools.js";
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

const TOOL_OUTPUT = "2026-01-01 10:00";
const ANSWER =
  "Es handelt sich um eine neue Anforderung [1].\n\n## Quellen\n\n[1] Pflichtenheft";
const QWEN_XML =
  "<tool_call>\n<function=inspect_image>\n<parameter=image>\nimg-1\n</parameter>\n" +
  "<parameter=question>\nWas zeigt dieser Screenshot?\n</parameter>\n</function>\n</tool_call>";

const budgetFlow: FlowDefinition = {
  id: "tool-budget-flow",
  name: "Tool Budget",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      tools: ["base/datetime"],
      config: { maxToolSteps: 2, suppressToolPreamble: true },
    },
  ],
  edges: [],
};

/** Same node without `suppressToolPreamble`: text after tool steps streams live. */
const liveFlow: FlowDefinition = {
  ...budgetFlow,
  id: "tool-budget-live-flow",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      tools: ["base/datetime"],
      config: { maxToolSteps: 2 },
    },
  ],
};

const mcp: McpWrapperService = {
  connect: async () => {},
  reconnect: async () => {},
  listTools: async () => ["datetime"],
  getFilteredToolSchema: async (_server: string, tool: string) => ({
    name: tool,
    inputSchema: { type: "object", properties: {} },
  }),
  refreshSchemaIfChanged: async () => false,
  callTool: async () => ({ content: TOOL_OUTPUT }),
  getInstructions: () => undefined,
} as unknown as McpWrapperService;

type Step =
  | { kind: "tool" }
  | { kind: "text"; text: string }
  | { kind: "empty" }
  // Provider-executed result without a preceding call: the step ends after a
  // tool result, but the recorded response holds no tool exchange to continue
  // from (forces the post_tool_answer_missing excerpt fallback).
  | { kind: "orphan-result" };

interface RecordedCall {
  tools: string[];
  toolChoice: string | undefined;
  prompt: LanguageModelV3CallOptions["prompt"];
}

const usage = {
  inputTokens: {
    total: 7,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: undefined, reasoning: undefined },
};

/** Scripted model: call N plays `script[N]` (the last entry repeats). */
function scriptedFactory(script: Step[], calls: RecordedCall[]) {
  return () =>
    new MockLanguageModelV3({
      doStream: async (options: LanguageModelV3CallOptions) => {
        const index = calls.length;
        calls.push({
          tools: (options.tools ?? []).map((tool) => tool.name),
          toolChoice: options.toolChoice?.type,
          prompt: options.prompt,
        });
        const step = script[Math.min(index, script.length - 1)] as Step;
        return {
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              if (step.kind === "tool") {
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: `call-${index + 1}`,
                  toolName: "base__datetime",
                  input: "{}",
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: {
                    unified: "tool-calls" as const,
                    raw: "tool_calls",
                  },
                  usage,
                });
              } else {
                if (step.kind === "orphan-result") {
                  controller.enqueue({
                    type: "tool-result",
                    toolCallId: `orphan-${index + 1}`,
                    toolName: "base__datetime",
                    result: { now: TOOL_OUTPUT },
                    providerExecuted: true,
                  });
                }
                if (step.kind === "text") {
                  controller.enqueue({ type: "text-start", id: "t" });
                  // Split like a real stream so the opener spans deltas.
                  for (let i = 0; i < step.text.length; i += 7) {
                    controller.enqueue({
                      type: "text-delta",
                      id: "t",
                      delta: step.text.slice(i, i + 7),
                    });
                  }
                  controller.enqueue({ type: "text-end", id: "t" });
                }
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

async function run(
  script: Step[],
  executionId: string,
  flow: FlowDefinition = budgetFlow,
) {
  const calls: RecordedCall[] = [];
  const map = new Map([[flow.id, flow]]);
  const registry: FlowRegistry = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    mcpWrapper: mcp,
    llmProviderFactory: scriptedFactory(script, calls),
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
    .filter((text): text is string => typeof text === "string");
  const node = debugStore
    .getTrace(executionId)
    ?.nodes.find((entry) => entry.node_id === "llm-1");
  const diagnostics = node?.diagnostics ?? [];
  return {
    calls,
    deltas,
    content: deltas.join(""),
    node,
    codes: diagnostics.map((entry) => entry.code),
    diagnostics,
  };
}

const promptHasToolResult = (prompt: RecordedCall["prompt"]): boolean =>
  prompt.some(
    (message) =>
      message.role === "tool" && JSON.stringify(message.content).includes(TOOL_OUTPUT),
  );

describe("LLM node — tool-loop robustness", () => {
  test("budget exhausted → final answer round without tools", async () => {
    const r = await run(
      [{ kind: "tool" }, { kind: "tool" }, { kind: "text", text: ANSWER }],
      "exec-budget-final-round",
    );

    expect(r.calls).toHaveLength(3);
    expect(r.calls[0]?.tools).toEqual(["base__datetime"]);
    expect(r.calls[1]?.tools).toEqual(["base__datetime"]);
    // Reserved step past maxToolSteps: no tools offered, explicit guidance.
    expect(r.calls[2]?.tools).toEqual([]);
    expect(promptHasToolResult(r.calls[2]?.prompt ?? [])).toBe(true);
    expect(JSON.stringify(r.calls[2]?.prompt)).toContain(
      "The tool budget for this turn is exhausted",
    );
    expect(r.content).toBe(ANSWER);
    expect(r.node?.status).toBe("completed");
    expect(r.codes).toContain("tool_budget_final_answer_round");
    expect(r.codes).not.toContain("post_tool_answer_missing");
    const round = r.diagnostics.find(
      (entry) => entry.code === "tool_budget_final_answer_round",
    );
    expect(round?.details).toMatchObject({ max_tool_steps: 2, attempt: 1 });
  });

  test("post_tool_answer_missing → continuation retry with tool results and no tools", async () => {
    const r = await run(
      [{ kind: "tool" }, { kind: "empty" }, { kind: "text", text: ANSWER }],
      "exec-post-tool-continuation",
    );

    expect(r.calls).toHaveLength(3);
    const retry = r.calls[2];
    expect(retry?.tools).toEqual([]);
    // The retry continues from the recorded tool exchange …
    expect(promptHasToolResult(retry?.prompt ?? [])).toBe(true);
    expect(
      retry?.prompt.some(
        (message) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes("tool-call"),
      ),
    ).toBe(true);
    // … instead of the former serialized result excerpt.
    expect(JSON.stringify(retry?.prompt)).not.toContain("Tool result: ");
    expect(r.content).toBe(ANSWER);
    expect(r.node?.status).toBe("completed");
    const missing = r.diagnostics.find(
      (entry) => entry.code === "post_tool_answer_missing",
    );
    expect(Number(missing?.details?.continuation_messages)).toBeGreaterThan(0);
  });

  test("text tool call in the final round is rejected and retried without tools", async () => {
    const r = await run(
      [
        { kind: "tool" },
        { kind: "tool" },
        { kind: "text", text: QWEN_XML },
        { kind: "text", text: ANSWER },
      ],
      "exec-text-tool-call-retry",
    );

    expect(r.calls).toHaveLength(4);
    expect(r.calls[2]?.tools).toEqual([]);
    const retry = r.calls[3];
    expect(retry?.tools).toEqual([]);
    expect(promptHasToolResult(retry?.prompt ?? [])).toBe(true);
    // The rejected template text is not replayed to the model.
    expect(JSON.stringify(retry?.prompt)).not.toContain("<function=");
    expect(r.content).toBe(ANSWER);
    expect(r.content).not.toContain("<tool_call");
    for (const delta of r.deltas) {
      expect(delta.trimStart().startsWith("<tool_call")).toBe(false);
      expect(delta.trimStart().startsWith("<function=")).toBe(false);
    }
    expect(r.node?.status).toBe("completed");
    expect(r.node?.full_response).toBe(ANSWER);
    expect(r.codes).toContain("text_tool_call_rejected");
    const rejected = r.diagnostics.find(
      (entry) => entry.code === "text_tool_call_rejected",
    );
    expect(rejected?.details).toMatchObject({
      attempt: 1,
      format: "qwen-xml",
      final_answer_only: true,
    });
  });

  test("text tool call on every attempt → node error, nothing leaks", async () => {
    const r = await run(
      [{ kind: "tool" }, { kind: "tool" }, { kind: "text", text: QWEN_XML }],
      "exec-text-tool-call-unrecoverable",
    );

    // Attempt 1: two tool steps + the final round; attempts 2 and 3: one
    // answer-only step each.
    expect(r.calls).toHaveLength(5);
    for (const call of r.calls.slice(2)) expect(call.tools).toEqual([]);
    expect(r.content).not.toContain("<tool_call");
    expect(r.content).not.toContain("<function=");
    expect(r.node?.status).toBe("error");
    expect(r.codes).toContain("text_tool_call_rejected");
    expect(r.codes).toContain("text_tool_call_unrecoverable");
  });

  test("without suppressToolPreamble a text tool call is held back, not streamed live", async () => {
    const r = await run(
      [{ kind: "text", text: QWEN_XML }, { kind: "text", text: ANSWER }],
      "exec-text-tool-call-live",
      liveFlow,
    );

    expect(r.calls).toHaveLength(2);
    // No tool exchange to continue from yet: the retry keeps the tools and
    // asks for a native call instead of forcing an evidence-free answer.
    expect(r.calls[1]?.tools).toEqual(["base__datetime"]);
    expect(JSON.stringify(r.calls[1]?.prompt)).toContain(
      "native tool-calling interface",
    );
    expect(r.content).toBe(ANSWER);
    expect(r.content).not.toContain("<tool_call");
    expect(r.codes).toContain("text_tool_call_rejected");
    const rejected = r.diagnostics.find(
      (entry) => entry.code === "text_tool_call_rejected",
    );
    expect(rejected?.details).toMatchObject({
      attempt: 1,
      final_answer_only: false,
      continuation_messages: 0,
    });
  });

  test("text tool call before any tool use → tools kept, answer-only only before the final attempt", async () => {
    const r = await run(
      [{ kind: "text", text: QWEN_XML }],
      "exec-text-tool-call-first-step",
      liveFlow,
    );

    // Attempt 1 retries with tools; attempt 2 (last before the final one)
    // switches to answer-only; attempt 3 fails the node.
    expect(r.calls).toHaveLength(3);
    expect(r.calls[0]?.tools).toEqual(["base__datetime"]);
    expect(r.calls[1]?.tools).toEqual(["base__datetime"]);
    expect(r.calls[2]?.tools).toEqual([]);
    const rejected = r.diagnostics.filter(
      (entry) => entry.code === "text_tool_call_rejected",
    );
    expect(rejected.map((entry) => entry.details?.final_answer_only)).toEqual([
      false,
      true,
    ]);
    expect(r.content).not.toContain("<tool_call");
    expect(r.node?.status).toBe("error");
    expect(r.codes).toContain("text_tool_call_unrecoverable");
  });

  test("without suppressToolPreamble a text tool call after the tool phase never reaches content", async () => {
    const r = await run(
      [
        { kind: "tool" },
        { kind: "tool" },
        { kind: "text", text: QWEN_XML },
        { kind: "text", text: ANSWER },
      ],
      "exec-text-tool-call-live-after-tools",
      liveFlow,
    );

    expect(r.calls).toHaveLength(4);
    expect(r.calls[2]?.tools).toEqual([]);
    expect(r.calls[3]?.tools).toEqual([]);
    expect(promptHasToolResult(r.calls[3]?.prompt ?? [])).toBe(true);
    expect(r.content).not.toContain("<tool_call");
    expect(r.content).not.toContain("<function=");
    expect(r.content).toBe(ANSWER);
    expect(r.node?.full_response).toBe(r.content);
    expect(r.node?.status).toBe("completed");
    expect(r.codes).toContain("text_tool_call_rejected");
  });

  test("without suppressToolPreamble a prose answer after the tool phase still streams", async () => {
    const r = await run(
      [{ kind: "tool" }, { kind: "text", text: ANSWER }],
      "exec-live-answer-after-tools",
      liveFlow,
    );

    expect(r.calls).toHaveLength(2);
    expect(r.content).toBe(ANSWER);
    // Released as soon as the step text cannot be a tool call any more.
    expect(r.deltas.length).toBeGreaterThan(1);
    expect(r.node?.full_response).toBe(ANSWER);
    expect(r.codes).not.toContain("text_tool_call_rejected");
  });

  test("post_tool_answer_missing without a recordable exchange → excerpt retry without tools", async () => {
    const r = await run(
      [{ kind: "orphan-result" }, { kind: "text", text: ANSWER }],
      "exec-post-tool-excerpt-fallback",
    );

    expect(r.calls).toHaveLength(2);
    const retry = r.calls[1];
    // The fallback must not keep offering the tool list either.
    expect(retry?.tools).toEqual([]);
    expect(JSON.stringify(retry?.prompt)).toContain("Tool result: ");
    expect(JSON.stringify(retry?.prompt)).toContain(TOOL_OUTPUT);
    expect(r.content).toBe(ANSWER);
    expect(r.node?.status).toBe("completed");
    const missing = r.diagnostics.find(
      (entry) => entry.code === "post_tool_answer_missing",
    );
    expect(missing?.details?.continuation_messages).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider wire shapes of answer-only rounds
// ---------------------------------------------------------------------------

type WireProvider = "openai" | "google" | "anthropic" | "bedrock";

/** Wire request bodies captured from the real provider SDKs. */
type WireBody = Record<string, unknown>;

/**
 * The real AI SDK provider model for `provider`, wired to a fetch that records
 * the request body and then fails, so nothing leaves the process.
 */
function realProviderModel(
  provider: WireProvider,
  bodies: WireBody[],
): LanguageModelV4 {
  const fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    const raw = init?.body;
    const text =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? new TextDecoder().decode(raw)
          : String(raw);
    bodies.push(JSON.parse(text) as WireBody);
    throw new Error("wire request captured");
  }) as unknown as typeof globalThis.fetch;
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: "test-key", fetch }).chat("gpt-4o-mini");
    case "google":
      return createGoogleGenerativeAI({ apiKey: "test-key", fetch })(
        "gemini-2.5-flash",
      );
    case "anthropic":
      return createAnthropic({ apiKey: "test-key", fetch })("claude-sonnet-4-5");
    case "bedrock":
      return createAmazonBedrock({
        region: "eu-central-1",
        accessKeyId: "AKIDTESTONLY",
        secretAccessKey: "test-secret",
        fetch,
      })("anthropic.claude-sonnet-4-5-v1:0");
  }
}

type WireStep = "tool" | "empty" | "wire" | "tool-anyway";

interface WireCall {
  tools: string[];
  toolChoice: string | undefined;
  prompt: LanguageModelV4CallOptions["prompt"];
}

const streamOf = (parts: unknown[]): LanguageModelV4StreamResult =>
  ({
    stream: new ReadableStream({
      start(controller: ReadableStreamDefaultController<unknown>) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  }) as unknown as LanguageModelV4StreamResult;

const toolCallParts = (id: string): unknown[] => [
  {
    type: "tool-call",
    toolCallId: id,
    toolName: "base__datetime",
    input: '{"zone":"Europe/Berlin"}',
  },
  {
    type: "finish",
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage,
  },
];

const textParts = (text: string): unknown[] => [
  ...(text.length > 0
    ? [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: text },
        { type: "text-end", id: "t" },
      ]
    : []),
  {
    type: "finish",
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage,
  },
];

/**
 * Scripted model for the engine. `tool` / `empty` steps are mocked; a `wire`
 * step hands the SDK call options to the real provider (capturing the request
 * body) and then answers with {@link ANSWER}. `tool-anyway` emits a tool call
 * even though none may be made.
 */
async function runWire(
  provider: WireProvider,
  script: WireStep[],
  executionId: string,
  options: { toolOutput?: string; flow?: FlowDefinition } = {},
) {
  const calls: WireCall[] = [];
  const bodies: WireBody[] = [];
  const toolCalls: string[] = [];
  const real = realProviderModel(provider, bodies);
  const flow = options.flow ?? budgetFlow;
  const map = new Map([[flow.id, flow]]);
  const registry: FlowRegistry = {
    get: (id) => map.get(id),
    list: () => [...map.values()],
  };
  const wireMcp = {
    ...mcp,
    callTool: async (_server: string, tool: string) => {
      toolCalls.push(tool);
      return { content: options.toolOutput ?? TOOL_OUTPUT };
    },
  } as unknown as McpWrapperService;
  const engine = createGraphEngine(
    { ...baseConfig, defaultLlm: { provider, model: "wire-model" } },
    {
      flowRegistry: registry,
      mcpWrapper: wireMcp,
      llmProviderFactory: () =>
        new MockLanguageModelV4({
          doStream: async (callOptions: LanguageModelV4CallOptions) => {
            const index = calls.length;
            calls.push({
              tools: (callOptions.tools ?? []).map((tool) => tool.name),
              toolChoice: callOptions.toolChoice?.type,
              prompt: callOptions.prompt,
            });
            const step = script[Math.min(index, script.length - 1)] as WireStep;
            if (step === "tool") return streamOf(toolCallParts(`call-${index + 1}`));
            if (step === "tool-anyway") {
              return streamOf(toolCallParts(`forbidden-${index + 1}`));
            }
            if (step === "empty") return streamOf(textParts(""));
            const before = bodies.length;
            try {
              await real.doStream(callOptions);
            } catch (error) {
              if (bodies.length === before) throw error;
            }
            return streamOf(textParts(ANSWER));
          },
        }) as never,
    },
  );
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
  const node = debugStore
    .getTrace(executionId)
    ?.nodes.find((entry) => entry.node_id === "llm-1");
  return {
    calls,
    bodies,
    toolCalls,
    node,
    content: chunks
      .map((chunk) => chunk.choices[0]?.delta.content)
      .filter((text): text is string => typeof text === "string")
      .join(""),
    codes: (node?.diagnostics ?? []).map((entry) => entry.code),
  };
}

/** True when any object in `value` has `key` (deep, JSON-shaped data). */
const hasKeyDeep = (value: unknown, key: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([k, v]) => k === key || hasKeyDeep(v, key),
    );
  }
  return false;
};

/** True when any object in `value` has `type === typeName` (deep). */
const hasTypeDeep = (value: unknown, typeName: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasTypeDeep(item, typeName));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      record.type === typeName ||
      Object.values(record).some((v) => hasTypeDeep(v, typeName))
    );
  }
  return false;
};

const BUDGET_GUIDANCE = "The tool budget for this turn is exhausted";

describe("LLM node — answer-only rounds on the provider wire", () => {
  test("openai: final round drops the tool list, keeps the structured tool exchange", async () => {
    const r = await runWire("openai", ["tool", "tool", "wire"], "exec-wire-openai");

    expect(r.bodies).toHaveLength(1);
    const body = r.bodies[0] as WireBody;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.some((m) => m.role === "tool")).toBe(true);
    expect(messages.some((m) => m.role === "assistant" && m.tool_calls !== undefined)).toBe(true);
    expect(JSON.stringify(messages)).toContain(TOOL_OUTPUT);
    expect(JSON.stringify(messages)).toContain(BUDGET_GUIDANCE);
    expect(r.content).toBe(ANSWER);
    expect(r.node?.status).toBe("completed");
  });

  test("openai: continuation retry drops the tool list, replays the sanitized exchange", async () => {
    const r = await runWire("openai", ["tool", "empty", "wire"], "exec-wire-openai-cont");

    expect(r.bodies).toHaveLength(1);
    const body = r.bodies[0] as WireBody;
    expect(body.tools).toBeUndefined();
    const messages = body.messages as Array<{
      role: string;
      tool_calls?: Array<{ function: { arguments: string } }>;
    }>;
    const assistant = messages.find((m) => m.tool_calls !== undefined);
    // Recorded exchange replays blanked arguments (reference for the text form).
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe("{}");
    expect(JSON.stringify(messages)).toContain(TOOL_OUTPUT);
  });

  test("google: final round keeps the declarations with function calling mode NONE", async () => {
    const r = await runWire("google", ["tool", "tool", "wire"], "exec-wire-google");

    expect(r.calls[2]?.tools).toEqual(["base__datetime"]);
    expect(r.calls[2]?.toolChoice).toBe("none");
    expect(r.bodies).toHaveLength(1);
    const body = r.bodies[0] as WireBody;
    const tools = body.tools as Array<{
      functionDeclarations?: Array<{ name: string }>;
    }>;
    expect(tools[0]?.functionDeclarations?.map((d) => d.name)).toEqual([
      "base__datetime",
    ]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(hasKeyDeep(body.contents, "functionCall")).toBe(true);
    expect(hasKeyDeep(body.contents, "functionResponse")).toBe(true);
    expect(JSON.stringify(body.contents)).toContain(TOOL_OUTPUT);
    expect(r.content).toBe(ANSWER);
  });

  for (const provider of ["anthropic", "bedrock"] as const) {
    const toolKey = provider === "anthropic" ? "tools" : "toolConfig";
    const assertTextForm = (body: WireBody, expectedArguments: string) => {
      // No tool definitions and no tool choice: a tool call is impossible.
      expect(body[toolKey]).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(hasKeyDeep(body.additionalModelRequestFields, "tool_choice")).toBe(false);
      // No structured tool blocks left that the API would reject (Anthropic)
      // or the SDK would silently strip (Bedrock).
      const messages = body.messages;
      if (provider === "anthropic") {
        expect(hasTypeDeep(messages, "tool_use")).toBe(false);
        expect(hasTypeDeep(messages, "tool_result")).toBe(false);
      } else {
        expect(hasKeyDeep(messages, "toolUse")).toBe(false);
        expect(hasKeyDeep(messages, "toolResult")).toBe(false);
      }
      // The evidence is complete: tool name, call id, arguments and result.
      const text = JSON.stringify(messages);
      expect(text).toContain("Recorded tool call base__datetime (id call-1)");
      expect(text).toContain("Recorded tool result base__datetime (id call-1)");
      expect(text).toContain(
        JSON.stringify(`Arguments: ${expectedArguments}`).slice(1, -1),
      );
      expect(text).toContain(TOOL_OUTPUT);
    };

    test(`${provider}: final round sends the tool exchange as text without tools`, async () => {
      const r = await runWire(provider, ["tool", "tool", "wire"], `exec-wire-${provider}`);

      // SDK level: no tool is offered to the model for the answer round.
      expect(r.calls[0]?.tools).toEqual(["base__datetime"]);
      expect(r.calls[2]?.tools).toEqual([]);
      expect(r.bodies).toHaveLength(1);
      const body = r.bodies[0] as WireBody;
      assertTextForm(body, '{"zone":"Europe/Berlin"}');
      expect(JSON.stringify(body.messages)).toContain("(id call-2)");
      expect(JSON.stringify(body.messages)).toContain(BUDGET_GUIDANCE);
      expect(r.content).toBe(ANSWER);
      expect(r.node?.status).toBe("completed");
      expect(r.codes).toContain("tool_budget_final_answer_round");
    });

    test(`${provider}: post_tool_answer_missing continuation is sent as text without tools`, async () => {
      const r = await runWire(provider, ["tool", "empty", "wire"], `exec-wire-cont-${provider}`);

      expect(r.calls[2]?.tools).toEqual([]);
      expect(r.bodies).toHaveLength(1);
      // The recorded continuation exchange carries the sanitized (blanked)
      // arguments, exactly as its structured form does (see the openai
      // continuation test above): the text form adds nothing unfiltered.
      assertTextForm(r.bodies[0] as WireBody, "{}");
      expect(r.content).toBe(ANSWER);
      expect(r.codes).toContain("post_tool_answer_missing");
    });
  }

  test("anthropic: the text form carries the budget-capped result, not the raw output", async () => {
    const huge = `HEAD-OF-RESULT ${"x".repeat(6000)} TAIL-OF-RESULT`;
    const cappedFlow: FlowDefinition = {
      ...budgetFlow,
      id: "tool-budget-capped-flow",
      nodes: [
        {
          id: "llm-1",
          type: "llm",
          tools: ["base/datetime"],
          config: {
            maxToolSteps: 2,
            suppressToolPreamble: true,
            toolResultBudget: { perResultChars: 400, perTurnChars: 2000 },
          },
        },
      ],
    };
    const r = await runWire("anthropic", ["tool", "tool", "wire"], "exec-wire-capped", {
      toolOutput: huge,
      flow: cappedFlow,
    });

    expect(r.bodies).toHaveLength(1);
    const text = JSON.stringify(r.bodies[0]?.messages);
    expect(text).toContain("HEAD-OF-RESULT");
    expect(text).not.toContain("x".repeat(1000));
  });

  test("anthropic: a tool call emitted in the answer round is never executed", async () => {
    const r = await runWire(
      "anthropic",
      ["tool", "tool", "tool-anyway"],
      "exec-wire-tool-anyway",
    );

    // Only the two budgeted tool steps ran; the answer-only rounds offered no
    // tool, so the stray call had nothing to execute.
    expect(r.toolCalls).toHaveLength(2);
    for (const call of r.calls.slice(2)) expect(call.tools).toEqual([]);
  });
});

describe("answer-only-tools", () => {
  test("answerOnlyToolMode per protocol, text form for unknown providers", () => {
    expect(answerOnlyToolMode("openai")).toBe("strip");
    expect(answerOnlyToolMode("ollama")).toBe("strip");
    expect(answerOnlyToolMode("azure")).toBe("strip");
    expect(answerOnlyToolMode("google")).toBe("declare-none");
    expect(answerOnlyToolMode("anthropic")).toBe("text");
    expect(answerOnlyToolMode("bedrock")).toBe("text");
    expect(answerOnlyToolMode(undefined)).toBe("text");
  });

  test("toolHistoryAsText rewrites calls and results, keeps cache markers and other parts", () => {
    const cache = { anthropic: { cacheControl: { type: "ephemeral" } } };
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "frage" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "denke" },
          { type: "text", text: "Ich prüfe." },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "docs__read",
            input: { id: 7 },
          },
        ],
      },
      {
        role: "tool",
        providerOptions: cache,
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "docs__read",
            output: { type: "json", value: { title: "Doc A" } },
          },
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "docs__read",
            output: { type: "error-text", value: "not found" },
          },
          {
            type: "tool-result",
            toolCallId: "c3",
            toolName: "img__inspect",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Screenshot" },
                { type: "image-data", data: "AAAA", mediaType: "image/png" },
              ],
            },
          },
        ],
      },
    ];

    const out = toolHistoryAsText(messages);

    expect(out[0]).toBe(messages[0] as ModelMessage);
    expect(out[1]).toBe(messages[1] as ModelMessage);
    expect(out[2]).toEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "denke" },
        { type: "text", text: "Ich prüfe." },
        {
          type: "text",
          text:
            "[Recorded tool call docs__read (id c1), already executed]\n" +
            'Arguments: {"id":7}',
        },
      ],
    });
    expect(out[3]).toEqual({
      role: "user",
      providerOptions: cache,
      content: [
        {
          type: "text",
          text: '[Recorded tool result docs__read (id c1)]\n{"title":"Doc A"}',
        },
        {
          type: "text",
          text: "[Recorded tool result docs__read (id c2)]\nError: not found",
        },
        { type: "text", text: "[Recorded tool result img__inspect (id c3)]" },
        { type: "text", text: "Screenshot" },
        {
          type: "file",
          data: { type: "data", data: "AAAA" },
          mediaType: "image/png",
        },
      ],
    });
    expect(JSON.stringify(out)).not.toContain('"tool-call"');
    expect(JSON.stringify(out)).not.toContain('"tool-result"');
  });

  test("toolHistoryAsText returns the same array without tool content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hallo" }] },
    ];
    expect(toolHistoryAsText(messages)).toBe(messages);
  });
});

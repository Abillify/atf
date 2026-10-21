// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * One-shot retry of a provider rejection caused by an oversized prompt.
 *
 * A context-length rejection is deterministic: resending the same prompt fails
 * identically, so the candidate loop gives it exactly one retry against a
 * context budget 25 % smaller, which the existing deterministic truncation
 * applies to the shortened prompt. The retry is announced with the
 * `context_length_retry` diagnostic and is skipped once anything reached the
 * client. A second rejection takes the normal error path.
 */

import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamResult } from "@ai-sdk/provider";
import type { AppConfig } from "../../config/index.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { DebugNodeDiagnostic } from "../../types/debug-trace.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import {
  CONTEXT_RETRY_FACTOR,
  isContextLengthError,
} from "../context-length-retry.js";

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
  // One regular attempt per candidate: any second provider call can only come
  // from the context-length retry. The explicit window makes the truncation
  // real without depending on the capability registry.
  llmMaxAttempts: 1,
  defaultLlm: {
    provider: "openai",
    model: "mock-model",
    parameters: { contextLength: 4000 },
  },
};

const flow: FlowDefinition = {
  id: "context-length-retry-flow",
  name: "Context length retry",
  nodes: [{ id: "responder", type: "llm", config: {} }],
  edges: [],
};

function registry(): FlowRegistry {
  return { get: (id) => (id === flow.id ? flow : undefined), list: () => [flow] };
}

const mcp = {
  connect: async () => {},
  reconnect: async () => {},
  listTools: async () => [],
  getFilteredToolSchema: async () => undefined,
  refreshSchemaIfChanged: async () => false,
  callTool: async () => ({ content: "" }),
  getInstructions: () => undefined,
} as unknown as import("../../mcp/mcp-wrapper.js").McpWrapperService;

const usage = {
  inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

function answerStream(text: string): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller: ReadableStreamDefaultController<unknown>) {
      controller.enqueue({ type: "text-start", id: "1" });
      controller.enqueue({ type: "text-delta", id: "1", delta: text });
      controller.enqueue({ type: "text-end", id: "1" });
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
      });
      controller.close();
    },
  });
}

/**
 * Model that rejects the first `failures` requests with a context-length error
 * and answers afterwards. Records the prompt of every call so the test can
 * compare the prompt the retry actually sent.
 */
function contextLengthModel(
  prompts: Array<Array<{ role: string; content: unknown }>>,
  failures: number,
  message = "This model's maximum context length is 8192 tokens. However, your messages resulted in 12000 tokens.",
) {
  let calls = 0;
  return () =>
    new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        calls += 1;
        prompts.push(prompt as Array<{ role: string; content: unknown }>);
        if (calls <= failures) throw new Error(message);
        return {
          stream: answerStream("Antwort nach Retry."),
        } as unknown as LanguageModelV3StreamResult;
      },
    });
}

function promptChars(prompt: Array<{ role: string; content: unknown }>): number {
  return prompt.reduce(
    (total, message) =>
      total +
      (typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content).length),
    0,
  );
}

async function run(
  model: () => MockLanguageModelV3,
  executionId: string,
): Promise<{
  diagnostics: DebugNodeDiagnostic[];
  status: string | undefined;
  content: string;
}> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry(),
    mcpWrapper: mcp,
    llmProviderFactory: model as never,
  });
  const store = new InMemoryDebugTraceStore();
  engine.setDebugStore?.(store);
  let content = "";
  await engine.executeFlow(
    flow.id,
    [
      // The oversized document must not be the last message — truncation never
      // touches the current question.
      { role: "user", content: "DOKUMENT\n" + "x".repeat(32_000) },
      { role: "user", content: "Fasse zusammen." },
    ],
    { ssoToken: "a.b.c", executionId },
    async (chunk) => {
      const delta = chunk.choices[0]?.delta.content;
      if (typeof delta === "string") content += delta;
    },
    async () => {},
  );
  const node = store
    .getTrace(executionId)
    ?.nodes.find((entry) => entry.node_id === "responder");
  return { diagnostics: node?.diagnostics ?? [], status: node?.status, content };
}

describe("isContextLengthError", () => {
  test("matches the provider wordings it is meant to catch", () => {
    for (const text of [
      "This model's maximum context length is 8192 tokens.",
      "context_length_exceeded",
      "prompt is too long: 210000 tokens > 200000 maximum",
      "too many tokens in the prompt",
      "The context length is 4096 tokens",
      "context length of 8192 tokens exceeded",
    ]) {
      expect(isContextLengthError(text)).toBe(true);
      expect(isContextLengthError(new Error(text))).toBe(true);
    }
  });

  test("finds the wording on a wrapped cause", () => {
    expect(
      isContextLengthError(
        new Error("Request failed", {
          cause: new Error("prompt is too long"),
        }),
      ),
    ).toBe(true);
  });

  test("leaves unrelated errors alone", () => {
    expect(isContextLengthError("Rate limit exceeded")).toBe(false);
    expect(isContextLengthError(new Error("ECONNRESET"))).toBe(false);
    expect(isContextLengthError(undefined)).toBe(false);
    expect(isContextLengthError(null)).toBe(false);
  });

  test("the retry factor shrinks the budget by a quarter", () => {
    expect(CONTEXT_RETRY_FACTOR).toBe(0.75);
  });
});

describe("context-length retry (llm candidate loop)", () => {
  test("a rejection is retried once with a smaller prompt and completes", async () => {
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const outcome = await run(
      contextLengthModel(prompts, 1),
      "exec-context-retry-ok",
    );

    expect(prompts.length).toBe(2);
    expect(outcome.status).toBe("completed");
    expect(outcome.content).toContain("Antwort nach Retry.");

    const retries = outcome.diagnostics.filter(
      (entry) => entry.code === "context_length_retry",
    );
    expect(retries.length).toBe(1);
    expect(retries[0]?.level).toBe("warn");
    expect(retries[0]?.details).toMatchObject({
      attempt: 1,
      provider: "openai",
      model: "mock-model",
      context_length_before: 4000,
      context_length_after: 3000,
    });

    // The retry really sends less: the smaller budget truncates harder.
    expect(promptChars(prompts[1] ?? [])).toBeLessThan(
      promptChars(prompts[0] ?? []),
    );
  });

  test("a second rejection keeps the normal error path", async () => {
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const outcome = await run(
      contextLengthModel(prompts, 5),
      "exec-context-retry-fail",
    );

    // Exactly one retry on top of the single regular attempt.
    expect(prompts.length).toBe(2);
    expect(outcome.status).toBe("error");
    expect(
      outcome.diagnostics.filter((entry) => entry.code === "context_length_retry")
        .length,
    ).toBe(1);
  });

  test("an unrelated error is not retried", async () => {
    const prompts: Array<Array<{ role: string; content: unknown }>> = [];
    const outcome = await run(
      contextLengthModel(prompts, 5, "Rate limit exceeded"),
      "exec-context-retry-unrelated",
    );

    expect(prompts.length).toBe(1);
    expect(outcome.status).toBe("error");
    expect(
      outcome.diagnostics.find((entry) => entry.code === "context_length_retry"),
    ).toBeUndefined();
  });
});

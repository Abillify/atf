// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the empty-response retry guard in the LLM node handler.
 *
 * A stream that finishes without error but produces no usable output (no
 * visible text and no tool call) is treated as a retryable failure so the
 * existing backoff + fallback path re-runs the candidate instead of returning
 * an empty AIMessage as a success.
 *
 * Reasoning-only output (a thinking block with no visible answer) counts as
 * empty as well, since `reasoning-delta` deliberately does not set the
 * "emitted any visible output" flag.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";

/** Total LLM attempts per candidate (1 try + 2 retries). */
const MAX_ATTEMPTS = 3;

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
  // Keep retries fast: 3 attempts, ~1ms base backoff.
  llmMaxAttempts: MAX_ATTEMPTS,
  llmRetryBackoffMs: 1,
};

const FINISH = {
  type: "finish",
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: {
      total: 7,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 5, text: undefined, reasoning: undefined },
  },
} as const;

type Part = Record<string, unknown>;

/** Wraps a list of provider-level stream parts as a MockLanguageModelV3 result. */
function streamOf(parts: Part[]) {
  return {
    stream: new ReadableStream({
      start(controller: ReadableStreamDefaultController<unknown>) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
  } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
}

const textParts = (t: string): Part[] => [
  { type: "text-start", id: "1" },
  { type: "text-delta", id: "1", delta: t },
  { type: "text-end", id: "1" },
  FINISH,
];

const reasoningOnlyParts = (t: string): Part[] => [
  { type: "reasoning-start", id: "r1" },
  { type: "reasoning-delta", id: "r1", delta: t },
  { type: "reasoning-end", id: "r1" },
  FINISH,
];

const emptyParts = (): Part[] => [FINISH];

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

const llmFlow: FlowDefinition = {
  id: "e-flow",
  name: "Empty",
  nodes: [{ id: "llm-1", type: "llm" }],
  edges: [],
};

/**
 * Mock LLM whose per-attempt output is scripted: `attempts[i]` is the part list
 * for the i-th call to doStream. Tracks how many times doStream was invoked.
 */
function scriptedLlm(attempts: Part[][]) {
  const calls = { count: 0 };
  const factory = () =>
    new MockLanguageModelV3({
      doStream: async () => {
        const idx = Math.min(calls.count, attempts.length - 1);
        calls.count += 1;
        const parts = attempts[idx];
        if (parts === undefined) throw new Error(`expected attempts[${idx}]`);
        return streamOf(parts);
      },
    });
  return { factory, calls };
}

async function collectContent(
  factory: () => MockLanguageModelV3,
  executionId: string,
): Promise<string> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(llmFlow),
    llmProviderFactory: factory,
  });
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    "e-flow",
    [{ role: "user", content: "hi" }],
    { ssoToken: "a.b.c", executionId },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  let content = "";
  for (const c of chunks) {
    const delta = c.choices[0]?.delta as
      | { content?: string | null }
      | undefined;
    if (typeof delta?.content === "string") content += delta.content;
  }
  return content;
}

describe("LLM node — empty-response retry guard", () => {
  test("empty first attempt is retried; second attempt's text is returned", async () => {
    const { factory, calls } = scriptedLlm([
      emptyParts(),
      textParts("Recovered"),
    ]);
    const content = await collectContent(factory, "exec-empty-retry");
    expect(content).toBe("Recovered");
    expect(calls.count).toBe(2);
  });

  test("reasoning-only response counts as empty and triggers a retry", async () => {
    const { factory, calls } = scriptedLlm([
      reasoningOnlyParts("Thinking hard but no answer"),
      textParts("Final answer"),
    ]);
    const content = await collectContent(factory, "exec-reasoning-retry");
    expect(content).toBe("Final answer");
    expect(calls.count).toBe(2);
  });

  test("all attempts empty: no content produced and every attempt is used", async () => {
    const { factory, calls } = scriptedLlm([emptyParts()]);
    const content = await collectContent(factory, "exec-empty-exhausted");
    expect(content).toBe("");
    // llmMaxAttempts attempts on the single candidate.
    expect(calls.count).toBe(MAX_ATTEMPTS);
  });
});

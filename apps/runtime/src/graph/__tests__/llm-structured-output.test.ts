// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the `llm` node structured-output path (`handlers/llm-structured.ts`).
 *
 * A `llm` node that declares `config.outputSchema` must emit ONE schema-enforced
 * JSON object as its assistant content (used by non-interactive batch consumers
 * like userstory-classify's syncReorder job, which parses
 * `choices[0].message.content` as JSON). Unlike a `classifier` node it DOES emit
 * an assistant message; unlike the normal `llm` path it does not stream a
 * free-form turn, run a tool-loop, or route `<think>` blocks.
 *
 * The openai provider resolves (via the capability registry) to the
 * `response_format` strategy = `generateText` + an `output` spec, so these
 * tests drive `MockLanguageModelV3.doGenerate` returning the JSON as text.
 */
import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import { parseLlmOutputSchema } from "../handlers/llm-structured.js";
import { mkGenerateResult } from "./v3-mock-helpers.js";

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

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    dev_ready: { type: "boolean" },
    briefing: { type: "string" },
  },
  required: ["score", "dev_ready", "briefing"],
};

function structuredFlow(): FlowDefinition {
  return {
    id: "s-flow",
    name: "Structured",
    nodes: [
      {
        id: "classifier",
        type: "llm",
        systemPrompt: "Bewerte die Story.",
        config: {
          outputSchema: { name: "evaluation", schema: OUTPUT_SCHEMA },
        },
      },
    ],
    edges: [],
  };
}

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

/** Mock provider whose non-streaming generate returns `text`. */
function mockGenerateFactory(
  text: string,
  onGenerate?: (options: { abortSignal?: AbortSignal }) => void,
) {
  return () =>
    new MockLanguageModelV3({
      doGenerate: async (options: { abortSignal?: AbortSignal }) => {
        onGenerate?.(options);
        return mkGenerateResult(text, 11, 7) as never;
      },
    });
}

async function runStructured(
  text: string,
  onGenerate?: (options: { abortSignal?: AbortSignal }) => void,
): Promise<{ content: string; chunks: ChatCompletionChunk[] }> {
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(structuredFlow()),
    llmProviderFactory: mockGenerateFactory(text, onGenerate),
  });
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    "s-flow",
    [{ role: "user", content: "Story X" }],
    { ssoToken: "a.b.c", executionId: "exec-s" },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );
  let content = "";
  for (const c of chunks) {
    const delta = c.choices[0]?.delta as { content?: string | null } | undefined;
    if (typeof delta?.content === "string") content += delta.content;
  }
  return { content, chunks };
}

describe("parseLlmOutputSchema", () => {
  test("returns schema + default name when only schema given", () => {
    const parsed = parseLlmOutputSchema({ outputSchema: { schema: OUTPUT_SCHEMA } });
    expect(parsed).toBeDefined();
    expect(parsed?.name).toBe("output");
    expect(parsed?.schema).toEqual(OUTPUT_SCHEMA);
  });

  test("honours an explicit name", () => {
    const parsed = parseLlmOutputSchema({
      outputSchema: { name: "evaluation", schema: OUTPUT_SCHEMA },
    });
    expect(parsed?.name).toBe("evaluation");
  });

  test("returns undefined when absent or malformed", () => {
    expect(parseLlmOutputSchema(undefined)).toBeUndefined();
    expect(parseLlmOutputSchema({})).toBeUndefined();
    expect(parseLlmOutputSchema({ outputSchema: {} })).toBeUndefined();
    expect(
      parseLlmOutputSchema({ outputSchema: { schema: "nope" } }),
    ).toBeUndefined();
    expect(
      parseLlmOutputSchema({ outputSchema: { schema: [1, 2, 3] } }),
    ).toBeUndefined();
  });
});

describe("llm node — structured output", () => {
  test("emits the schema-conforming JSON object as assistant content", async () => {
    const json = JSON.stringify({
      score: 82,
      dev_ready: true,
      briefing: "Klar umrissene Story.",
    });
    const { content } = await runStructured(json);
    expect(content).toBe(json);
    // Content parses back to the structured object.
    expect(JSON.parse(content)).toEqual({
      score: 82,
      dev_ready: true,
      briefing: "Klar umrissene Story.",
    });
  });

  test("does not run the streaming tool-loop (single content emission)", async () => {
    const json = JSON.stringify({ score: 0, dev_ready: false, briefing: "x" });
    const { chunks } = await runStructured(json);
    // No tool-call deltas should appear for a structured node.
    const hasToolCall = chunks.some((c) => {
      const delta = c.choices[0]?.delta as
        | { tool_calls?: unknown }
        | undefined;
      return delta?.tool_calls !== undefined;
    });
    expect(hasToolCall).toBe(false);
  });

  test("rejects finalAnswerContract instead of bypassing it via outputSchema", async () => {
    let calls = 0;
    const flow = structuredFlow();
    const node = flow.nodes[0];
    if (node === undefined) throw new Error("expected structured node");
    node.config = {
      ...node.config,
      finalAnswerContract: {
        startMarker: "<<<FINAL_ANSWER>>>",
        endMarker: "<<<END_FINAL_ANSWER>>>",
      },
    };
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(flow),
      llmProviderFactory: mockGenerateFactory("{}", () => {
        calls += 1;
      }),
    });
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "Story X" }],
      { ssoToken: "a.b.c", executionId: "exec-conflict" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    expect(calls).toBe(0);
    expect(JSON.stringify(chunks)).toContain("cannot be combined");
  });

  test("binds the flow's execution-deadline signal into the generate call (regression)", async () => {
    let captured: { abortSignal?: AbortSignal } | undefined;
    const json = JSON.stringify({ score: 1, dev_ready: false, briefing: "x" });
    await runStructured(json, (options) => {
      captured = options;
    });
    // The engine always establishes an execution-deadline AbortController per
    // request (executeFlow), so runtime.signal is defined on every run —
    // asserting it is not undefined at the call site is the regression check.
    expect(captured?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("llm node — structured output, empty provider result", () => {
  /** Mock provider whose generate calls yield the given texts in order. */
  function mockSequenceFactory(texts: string[], onCall: () => void) {
    let index = 0;
    return () =>
      new MockLanguageModelV3({
        doGenerate: async () => {
          onCall();
          const text = texts[Math.min(index, texts.length - 1)] ?? "";
          index += 1;
          return mkGenerateResult(text, 11, 7) as never;
        },
      });
  }

  async function runSequence(texts: string[]): Promise<{
    content: string;
    calls: number;
    chunks: ChatCompletionChunk[];
  }> {
    let calls = 0;
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(structuredFlow()),
      llmProviderFactory: mockSequenceFactory(texts, () => {
        calls += 1;
      }),
    });
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "s-flow",
      [{ role: "user", content: "Story X" }],
      { ssoToken: "a.b.c", executionId: "exec-empty" },
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
    return { content, calls, chunks };
  }

  test("retries an empty generation instead of emitting empty content", async () => {
    const json = JSON.stringify({ score: 5, dev_ready: false, briefing: "ok" });
    const { content, calls } = await runSequence(["", json]);
    expect(calls).toBe(2);
    expect(content).toBe(json);
  });

  test("fails the node with model context after exhausting retries", async () => {
    const { content, calls, chunks } = await runSequence([""]);
    // Bounded retries, a reported failure, and never a silent "" answer.
    expect(calls).toBe(3);
    expect(content).toBe("");
    const reported = JSON.stringify(chunks);
    expect(reported).toContain("structured-output generation failed");
    expect(reported).toContain("mock-model");
  });
});
describe("llm node — structured output salvage", () => {
  /**
   * The SDK's strict parse rejects anything that is not bare JSON and throws
   * `NoObjectGeneratedError` — while still carrying the model's raw text on the
   * error. The node must recover the object from that text (and emit it
   * canonically) instead of burning three attempts and failing, which is how the
   * `userstory-cr` flow lost complete documents.
   */
  async function runFenced(
    text: string,
  ): Promise<{ content: string; calls: number; chunks: ChatCompletionChunk[] }> {
    let calls = 0;
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(structuredFlow()),
      llmProviderFactory: () =>
        new MockLanguageModelV3({
          doGenerate: async () => {
            calls += 1;
            return mkGenerateResult(text, 11, 7) as never;
          },
        }) as never,
    });
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "s-flow",
      [{ role: "user", content: "Story X" }],
      { ssoToken: "a.b.c", executionId: "exec-salvage" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );
    let content = "";
    for (const c of chunks) {
      const delta = c.choices[0]?.delta as { content?: string | null } | undefined;
      if (typeof delta?.content === "string") content += delta.content;
    }
    return { content, calls, chunks };
  }
  test("recovers a fenced JSON document on the first attempt", async () => {
    const obj = { score: 42, dev_ready: false, briefing: "Fenced." };
    const { content, calls } = await runFenced(
      `Here you go:\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`,
    );
    // One provider call, and the emitted content is parseable JSON — no fence.
    expect(calls).toBe(1);
    expect(JSON.parse(content)).toEqual(obj);
  });
  test("recovers JSON followed by trailing prose", async () => {
    const obj = { score: 1, dev_ready: true, briefing: "b" };
    const { content, calls } = await runFenced(
      `${JSON.stringify(obj)}\n\nHope that helps!`,
    );
    expect(calls).toBe(1);
    expect(JSON.parse(content)).toEqual(obj);
  });
  test("still fails when the text holds no JSON at all", async () => {
    const { content, calls, chunks } = await runFenced("Sorry, I cannot help.");
    expect(calls).toBe(3);
    expect(content).toBe("");
    expect(JSON.stringify(chunks)).toContain(
      "structured-output generation failed",
    );
  });
});

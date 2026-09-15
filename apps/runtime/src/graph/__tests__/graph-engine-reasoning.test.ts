// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for reasoning_content routing in the LLM node handler.
 *
 * Verifies the three output channels are separated correctly:
 *   1. <think>...</think> blocks  → delta.reasoning_content
 *   2. \x00r-sentinel tokens       → delta.reasoning_content (LM Studio native)
 *   3. plain text                  → delta.content
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { FlowDefinition, LlmConfig } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import { createMetrics } from "../../observability/metrics.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import type { ResponseCache } from "../response-cache.js";

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

function mockLlmFactory(tokens: string[]) {
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

function singleNodeRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

const llmFlow: FlowDefinition = {
  id: "r-flow",
  name: "Reasoning",
  nodes: [{ id: "llm-1", type: "llm" }],
  edges: [],
};

const suppressedToolPreambleFlow: FlowDefinition = {
  id: "suppressed-tool-preamble-flow",
  name: "Suppressed Tool Preamble",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      tools: ["base/datetime"],
      config: { suppressToolPreamble: true },
    },
  ],
  edges: [],
};

const FINAL_START = "<<<AIPERATOR_FINAL_ANSWER>>>";
const FINAL_END = "<<<END_AIPERATOR_FINAL_ANSWER>>>";
const finalAnswerContractFlow: FlowDefinition = {
  id: "final-answer-contract-flow",
  name: "Final Answer Contract",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      config: {
        finalAnswerContract: {
          startMarker: FINAL_START,
          endMarker: FINAL_END,
        },
        reasoningSalvage: false,
        emptyResponseFallback: true,
        emptyResponseFallbackText: "SAFE-FALLBACK",
      },
    },
  ],
  edges: [],
};

const liveFinalAnswerContractFlow: FlowDefinition = {
  ...finalAnswerContractFlow,
  id: "live-final-answer-contract-flow",
  name: "Live Final Answer Contract",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      config: {
        finalAnswerContract: {
          startMarker: FINAL_START,
          endMarker: FINAL_END,
          streamAfterStartMarker: true,
        },
        reasoningSalvage: false,
        emptyResponseFallback: true,
        emptyResponseFallbackText: "SAFE-FALLBACK",
      },
    },
  ],
};

async function runFlow(
  tokens: string[],
  flow: FlowDefinition = llmFlow,
  config: AppConfig = baseConfig,
  debugStore?: InMemoryDebugTraceStore,
  responseCache?: ResponseCache,
): Promise<{
  content: string;
  reasoning: string;
}> {
  const engine = createGraphEngine(config, {
    flowRegistry: singleNodeRegistry(flow),
    llmProviderFactory: mockLlmFactory(tokens),
    ...(responseCache !== undefined ? { responseCache } : {}),
  });
  if (debugStore !== undefined) engine.setDebugStore?.(debugStore);
  const chunks: ChatCompletionChunk[] = [];
  await engine.executeFlow(
    flow.id,
    [{ role: "user", content: "hi" }],
    { ssoToken: "a.b.c", executionId: `exec-${flow.id}` },
    async (chunk) => {
      chunks.push(chunk);
    },
    async () => {},
  );

  let content = "";
  let reasoning = "";
  for (const c of chunks) {
    const delta = c.choices[0]?.delta as
      | { content?: string | null; reasoning_content?: string }
      | undefined;
    if (typeof delta?.content === "string") content += delta.content;
    if (typeof delta?.reasoning_content === "string")
      reasoning += delta.reasoning_content;
  }
  return { content, reasoning };
}

describe("LLM node — reasoning_content routing", () => {
  test("plain text → content only, model reasoning empty", async () => {
    const { content, reasoning } = await runFlow(["Hello ", "world"]);
    expect(content).toBe("Hello world");
    // reasoning only contains the node-start status step, no model thinking
    expect(reasoning).not.toContain("Hello");
  });

  test("<think> block → reasoning_content, answer → content", async () => {
    const { content, reasoning } = await runFlow([
      "<think>",
      "Let me consider this",
      "</think>",
      "Final answer",
    ]);
    expect(reasoning).toContain("Let me consider this");
    expect(content).toBe("Final answer");
  });

  test("<think> split across deltas is still separated", async () => {
    const { content, reasoning } = await runFlow([
      "<th",
      "ink>reasoning here</th",
      "ink>visible answer",
    ]);
    expect(reasoning).toContain("reasoning here");
    expect(content).toBe("visible answer");
  });

  test("\\x00r sentinel tokens (LM Studio native) → reasoning_content", async () => {
    const { content, reasoning } = await runFlow([
      "\x00rThinking",
      "\x00r about it",
      "Actual answer",
    ]);
    expect(reasoning).toContain("Thinking about it");
    expect(content).toBe("Actual answer");
  });

  test("no duplication: model reasoning appears exactly once", async () => {
    const { content, reasoning } = await runFlow([
      "\x00rHere",
      "\x00r's",
      "\x00r a thought",
      "answer",
    ]);
    expect(reasoning).toContain("Here's a thought");
    // Explicitly assert no doubling like "HereHere's's"
    expect(reasoning).not.toContain("HereHere");
    expect(content).toBe("answer");
  });

  test("suppresses a text preamble when a tool call follows", async () => {
    const preamble = "Ich werde zuerst recherchieren. ";
    const factory = () =>
      new MockLanguageModelV3({
        doStream: async () =>
          ({
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({ type: "text-delta", id: "1", delta: preamble });
                controller.enqueue({ type: "text-end", id: "1" });
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "get_weather",
                  input: '{"city":"Berlin"}',
                });
                controller.enqueue({
                  type: "finish",
                  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
                  usage: {
                    inputTokens: { total: 7, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                    outputTokens: { total: 3, text: undefined, reasoning: undefined },
                  },
                });
                controller.close();
              },
            }),
          }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
      });
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(suppressedToolPreambleFlow),
      llmProviderFactory: factory,
    });
    const chunks: ChatCompletionChunk[] = [];

    await engine.executeFlow(
      suppressedToolPreambleFlow.id,
      [{ role: "user", content: "Wie ist das Wetter?" }],
      {
        ssoToken: "a.b.c",
        executionId: "exec-suppressed-preamble",
        clientTools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    const content = chunks
      .map((chunk) => chunk.choices[0]?.delta.content)
      .filter((text): text is string => typeof text === "string")
      .join("");
    const reasoning = chunks
      .map(
        (chunk) =>
          (chunk.choices[0]?.delta as { reasoning_content?: string } | undefined)
            ?.reasoning_content,
      )
      .filter((text): text is string => typeof text === "string")
      .join("");

    expect(content).not.toContain(preamble);
    expect(reasoning).not.toContain(preamble);
  });

  test("native reasoning-delta parts (Gemini 3 / Anthropic / o-series) → reasoning_content", async () => {
    // ai@6.x native reasoning models stream a dedicated reasoning block
    // (reasoning-start → reasoning-delta* → reasoning-end) separate from the
    // visible answer's text block. Verify the thinking is routed to the
    // reasoning channel and the answer to content.
    const factory = () =>
      new MockLanguageModelV3({
        doStream: async () =>
          ({
            stream: new ReadableStream({
              start(controller: ReadableStreamDefaultController<unknown>) {
                controller.enqueue({ type: "reasoning-start", id: "r1" });
                controller.enqueue({
                  type: "reasoning-delta",
                  id: "r1",
                  delta: "Weighing the options",
                });
                controller.enqueue({ type: "reasoning-end", id: "r1" });
                controller.enqueue({ type: "text-start", id: "1" });
                controller.enqueue({
                  type: "text-delta",
                  id: "1",
                  delta: "The answer is 42",
                });
                controller.enqueue({ type: "text-end", id: "1" });
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

    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(llmFlow),
    llmProviderFactory: factory,
  });
    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-rd" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    let content = "";
    let reasoning = "";
    for (const c of chunks) {
      const delta = c.choices[0]?.delta as
        | { content?: string | null; reasoning_content?: string }
        | undefined;
      if (typeof delta?.content === "string") content += delta.content;
      if (typeof delta?.reasoning_content === "string")
        reasoning += delta.reasoning_content;
    }

    expect(reasoning).toContain("Weighing the options");
    expect(content).toBe("The answer is 42");
    // The thinking must NOT leak into the visible answer.
    expect(content).not.toContain("Weighing");
  });
});

describe("LLM node — final-answer contract", () => {
  test("suppresses content-channel planning and persists only the marked final answer", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const finalAnswer =
      "Der Cut-off-Prozess schliesst die Ziel-TE ab; fehlende Positionen werden unterliefert `[1]`.";
    const { content, reasoning } = await runFlow(
      [
        "Ich werde die Antwort basierend auf den Befunden formulieren.\n",
        "Zusammenfassung und Antwortstruktur folgen.\n",
        "(Self-Correction/Refinement during thought)\n",
        "[Output Generation] -> *Siehe Antwort.*\n*(Done.)*\n\n<<<AIPER",
        "ATOR_FINAL_ANSWER>>>\n",
        finalAnswer,
        "\n<<<END_AIPERATOR_FINAL_",
        "ANSWER>>>\nNachpruefung: Alles konsistent.",
      ],
      finalAnswerContractFlow,
      { ...baseConfig, llmRetryBackoffMs: 0 },
      debugStore,
    );

    expect(content).toBe(finalAnswer);
    expect(content).not.toContain("Ich werde");
    expect(content).not.toContain("Self-Correction");
    expect(content).not.toContain("Output Generation");
    expect(content).not.toContain("AIPERATOR_FINAL_ANSWER");
    expect(reasoning).not.toContain("Ich werde");

    const node = debugStore
      .getTrace(`exec-${finalAnswerContractFlow.id}`)
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.full_response).toBe(finalAnswer);
  });

  test("live mode streams only the answer across split markers and discards trailing text", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const finalAnswer =
      "Die live gestreamte Abschlussantwort bleibt vollstaendig und sauber.";
    const { content, reasoning } = await runFlow(
      [
        "\x00rInternes Synthesizer-Reasoning.",
        "Unsichtbare Planung. <<<AIPERATOR_",
        "FINAL_ANSWER>>>\n",
        "Die live gestreamte ",
        "Abschlussantwort bleibt vollstaendig und sauber.\n<<<END_AIPERATOR_",
        "FINAL_ANSWER>>>Nachkontrolle bleibt verborgen.",
      ],
      liveFinalAnswerContractFlow,
      { ...baseConfig, llmRetryBackoffMs: 0 },
      debugStore,
    );

    expect(content).toBe(finalAnswer);
    expect(content).not.toContain("Planung");
    expect(content).not.toContain("AIPERATOR_FINAL_ANSWER");
    expect(content).not.toContain("Nachkontrolle");
    expect(reasoning).not.toContain("Planung");
    expect(reasoning).toContain("Internes Synthesizer-Reasoning");
    const node = debugStore
      .getTrace(`exec-${liveFinalAnswerContractFlow.id}`)
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.full_response).toBe(finalAnswer);
    expect(node?.full_reasoning).toContain("Internes Synthesizer-Reasoning");
  });

  test("live mode buffers answer content until the complete marker pair validates", async () => {
    let releaseEnd!: () => void;
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    let step = 0;
    const answer =
      "Diese ausreichend lange Antwort wird bereits sichtbar, waehrend das Modell noch weiter generiert.";
    const factory = () =>
      new MockLanguageModelV3({
        doStream: async () =>
          ({
            stream: new ReadableStream({
              async pull(controller: ReadableStreamDefaultController<unknown>) {
                if (step === 0) {
                  step += 1;
                  controller.enqueue({ type: "text-start", id: "1" });
                  return;
                }
                if (step === 1) {
                  step += 1;
                  controller.enqueue({
                    type: "text-delta",
                    id: "1",
                    delta: `Interne Planung. ${FINAL_START}\n`,
                  });
                  return;
                }
                if (step === 2) {
                  step += 1;
                  controller.enqueue({
                    type: "text-delta",
                    id: "1",
                    delta: answer,
                  });
                  return;
                }
                if (step === 3) {
                  step += 1;
                  await endGate;
                  controller.enqueue({
                    type: "text-delta",
                    id: "1",
                    delta: `\n${FINAL_END}verborgener Nachlauf`,
                  });
                  return;
                }
                if (step === 4) {
                  step += 1;
                  controller.enqueue({ type: "text-end", id: "1" });
                  return;
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
                      total: 20,
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
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(liveFinalAnswerContractFlow),
      llmProviderFactory: factory,
    });
    let content = "";
    let executionFinished = false;
    let firstContent!: () => void;
    const firstContentSeen = new Promise<void>((resolve) => {
      firstContent = resolve;
    });
    const execution = engine
      .executeFlow(
        liveFinalAnswerContractFlow.id,
        [{ role: "user", content: "hi" }],
        { ssoToken: "a.b.c", executionId: "exec-live-timing" },
        async (chunk) => {
          const delta = chunk.choices[0]?.delta.content;
          if (typeof delta === "string" && delta.length > 0) {
            content += delta;
            firstContent();
          }
        },
        async () => {},
      )
      .then(() => {
        executionFinished = true;
      });

    try {
      await Promise.race([
        firstContentSeen.then(() => {
          throw new Error("unvalidated answer was emitted before the end marker");
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
      expect(content).toBe("");
      expect(executionFinished).toBe(false);
    } finally {
      releaseEnd();
      await execution;
    }

    expect(content).toBe(answer);
    expect(content).not.toContain("Planung");
    expect(content).not.toContain("Nachlauf");
    expect(content).not.toContain("AIPERATOR_FINAL_ANSWER");
  });

  test("live mode rejects an already-visible partial answer when the end marker is missing", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const partialAnswer = "Diese Antwort wurde begonnen, aber nicht markiert beendet.";
    const { content } = await runFlow(
      [`Preamble ${FINAL_START}\n${partialAnswer}`],
      liveFinalAnswerContractFlow,
      { ...baseConfig, llmMaxAttempts: 2, llmRetryBackoffMs: 0 },
      debugStore,
    );

    expect(content).toBe("SAFE-FALLBACK");
    const node = debugStore
      .getTrace(`exec-${liveFinalAnswerContractFlow.id}`)
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.full_response).toBe("SAFE-FALLBACK");
    expect((node?.diagnostics ?? []).map((entry) => entry.code)).toContain(
      "final_answer_contract_rejected",
    );
  });

  test("bypasses legacy response-cache entries while the contract is active", async () => {
    let getCalls = 0;
    let setCalls = 0;
    const legacyCache: ResponseCache = {
      enabled: true,
      isCacheable: () => true,
      get: async () => {
        getCalls += 1;
        return {
          text: "LEAKED-UNFRAMED-CACHE-CONTENT",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
      set: async () => {
        setCalls += 1;
      },
    };
    const finalAnswer = "Saubere Finalantwort.";
    const { content } = await runFlow(
      [`${FINAL_START}${finalAnswer}${FINAL_END}`],
      finalAnswerContractFlow,
      { ...baseConfig, llmRetryBackoffMs: 0 },
      undefined,
      legacyCache,
    );

    expect(content).toBe(finalAnswer);
    expect(content).not.toContain("LEAKED-UNFRAMED-CACHE-CONTENT");
    expect(getCalls).toBe(0);
    expect(setCalls).toBe(0);
  });

  test("missing markers retry and then fail closed to the configured fallback", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const rawPlanning =
      "Ich formuliere erst einen Plan und gebe ihn versehentlich als Content aus.";
    const { content } = await runFlow(
      [rawPlanning],
      finalAnswerContractFlow,
      { ...baseConfig, llmMaxAttempts: 2, llmRetryBackoffMs: 0 },
      debugStore,
    );

    expect(content).toBe("SAFE-FALLBACK");
    expect(content).not.toContain(rawPlanning);
    const node = debugStore
      .getTrace(`exec-${finalAnswerContractFlow.id}`)
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.full_response).toBe("SAFE-FALLBACK");
    const codes = (node?.diagnostics ?? []).map((entry) => entry.code);
    expect(codes).toContain("final_answer_contract_retry");
    expect(codes).toContain("final_answer_contract_rejected");
    expect(codes).toContain("empty_response_fallback");
  });

  test("rejects inline placeholder output from the live final-answer stream", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const { content } = await runFlow(
      [`${FINAL_START}\n\` ... \`${FINAL_END}`],
      liveFinalAnswerContractFlow,
      { ...baseConfig, llmMaxAttempts: 1, llmRetryBackoffMs: 0 },
      debugStore,
    );

    expect(content).toBe("SAFE-FALLBACK");
    expect(content).not.toContain("...");
    const node = debugStore
      .getTrace(`exec-${liveFinalAnswerContractFlow.id}`)
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect((node?.diagnostics ?? []).map((entry) => entry.code)).toContain(
      "final_answer_contract_rejected",
    );
  });

  test("accepts a short meaningful final answer", async () => {
    const { content } = await runFlow(
      [`${FINAL_START}Ja.${FINAL_END}`],
      liveFinalAnswerContractFlow,
      { ...baseConfig, llmMaxAttempts: 1, llmRetryBackoffMs: 0 },
    );

    expect(content).toBe("Ja.");
  });

  test("repetition abort cannot truncate multiple marker pairs into a valid answer", async () => {
    const repeatedAnswer = "repeated final answer block ".repeat(8);
    const framed = `${FINAL_START}${repeatedAnswer}${FINAL_END}`;
    const { content } = await runFlow(
      [framed, framed, framed, framed],
      finalAnswerContractFlow,
      { ...baseConfig, llmMaxAttempts: 1, llmRetryBackoffMs: 0 },
    );

    expect(content).toBe("SAFE-FALLBACK");
    expect(content).not.toContain("repeated final answer block");
  });
  test("overlapping marker occurrences are rejected", async () => {
    const overlappingFlow: FlowDefinition = {
      ...finalAnswerContractFlow,
      id: "overlapping-final-answer-contract-flow",
      nodes: [
        {
          id: "llm-1",
          type: "llm",
          config: {
            finalAnswerContract: {
              startMarker: "aaaaaaaa",
              endMarker: "bbbbbbbb",
            },
            emptyResponseFallback: true,
            emptyResponseFallbackText: "SAFE-FALLBACK",
          },
        },
      ],
    };
    const { content } = await runFlow(
      ["aaaaaaaaaFINALbbbbbbbb"],
      overlappingFlow,
      { ...baseConfig, llmMaxAttempts: 1, llmRetryBackoffMs: 0 },
    );

    expect(content).toBe("SAFE-FALLBACK");
  });
});

// ---------------------------------------------------------------------------
// Debug-trace diagnostics timeline
// ---------------------------------------------------------------------------

/** Mock that emits reasoning only (no visible text, no tool call) every call. */
function reasoningOnlyFactory() {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "reasoning-start", id: "r1" });
              controller.enqueue({
                type: "reasoning-delta",
                id: "r1",
                delta: "Thinking hard but never answering",
              });
              controller.enqueue({ type: "reasoning-end", id: "r1" });
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

/** Mock that emits NOTHING — no text, no reasoning, no tool call (empty completion). */
function emptyStreamFactory() {
  return () =>
    new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
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
                    total: 0,
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

/**
 * Mock whose stream THROWS on every attempt — exercises the retry `catch`
 * path (a provider stream error / empty-completion signal / abort) rather than
 * the clean `!emittedAny` completion path. Used to verify graceful degradation
 * at the terminal exhaustion return.
 */
function throwingStreamFactory() {
  return () =>
    new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("provider stream boom");
      },
    });
}

/** Flow whose LLM node opts into the empty-response fallback. */
const fallbackFlow: FlowDefinition = {
  id: "fb-flow",
  name: "Fallback",
  nodes: [
    {
      id: "llm-1",
      type: "llm",
      config: {
        emptyResponseFallback: true,
        emptyResponseFallbackText: "FALLBACK-ANSWER",
      },
    },
  ],
  edges: [],
};

describe("LLM node — empty-response fallback (config.emptyResponseFallback)", () => {
  test("empty completion + fallback config → node completes with the fallback text", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(fallbackFlow),
    llmProviderFactory: emptyStreamFactory(),
  });
    engine.setDebugStore?.(debugStore);

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "fb-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-fb" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-fb")
      ?.nodes.find((n) => n.node_id === "llm-1");
    expect(node?.status).toBe("completed");
    const codes = (node?.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("empty_response_fallback");

    let content = "";
    for (const c of chunks) {
      const delta = c.choices[0]?.delta as { content?: string | null } | undefined;
      if (typeof delta?.content === "string") content += delta.content;
    }
    expect(content).toContain("FALLBACK-ANSWER");
  });

  test("empty completion WITHOUT fallback config → node errors (strict default)", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(llmFlow),
    llmProviderFactory: emptyStreamFactory(),
  });
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-fb2" },
      async () => {},
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-fb2")
      ?.nodes.find((n) => n.node_id === "llm-1");
    const codes = (node?.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("empty_response");
    expect(node?.status).not.toBe("completed");
  });

  test("retries exhausted via the catch path + fallback config → node completes with the fallback text", async () => {
    // Every attempt's stream throws (provider error / abort / empty-completion
    // signal), so retries are exhausted through the catch path and the handler
    // reaches its terminal return — NOT the clean `!emittedAny` branch. An
    // opted-in node must still degrade gracefully here instead of hard-failing
    // (trace 85a4ebf1: a researcher whose retries were exhausted this way
    // errored the whole orchestrator despite emptyResponseFallback).
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(fallbackFlow),
    llmProviderFactory: throwingStreamFactory(),
  });
    engine.setDebugStore?.(debugStore);

    const chunks: ChatCompletionChunk[] = [];
    await engine.executeFlow(
      "fb-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-fb-catch" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-fb-catch")
      ?.nodes.find((n) => n.node_id === "llm-1");
    expect(node?.status).toBe("completed");
    const codes = (node?.diagnostics ?? []).map((d) => d.code);
    expect(codes).toContain("empty_response_fallback");
    expect(codes).toContain("llm_provider_attempt_started");
    expect(codes).toContain("llm_provider_attempt_completed");
    const started = (node?.diagnostics ?? []).find(
      (diagnostic) => diagnostic.code === "llm_provider_attempt_started",
    );
    expect(started?.details).toMatchObject({
      phase: "provider-call",
      provider: "openai",
      model: "mock-model",
      fallback: false,
      message_count: 1,
    });
    expect(Number(started?.details?.prompt_chars)).toBeGreaterThan(0);
    const terminalFallback = (node?.diagnostics ?? []).find(
      (diagnostic) => diagnostic.code === "empty_response_fallback",
    );
    expect(terminalFallback?.details).toMatchObject({
      phase: "terminal-fallback",
      last_error: "LLM provider request failed.",
      candidates: ["openai/mock-model"],
    });
    expect(JSON.stringify(terminalFallback)).not.toContain(
      "provider stream boom",
    );

    let content = "";
    for (const c of chunks) {
      const delta = c.choices[0]?.delta as
        | { content?: string | null }
        | undefined;
      if (typeof delta?.content === "string") content += delta.content;
    }
    expect(content).toContain("FALLBACK-ANSWER");
  });

  test("retries exhausted via the catch path WITHOUT fallback config → node errors (strict default)", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(llmFlow),
    llmProviderFactory: throwingStreamFactory(),
  });
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-fb-catch2" },
      async () => {},
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-fb-catch2")
      ?.nodes.find((n) => n.node_id === "llm-1");
    expect(node?.status).not.toBe("completed");
    const codes = (node?.diagnostics ?? []).map((d) => d.code);
    expect(codes).not.toContain("empty_response_fallback");
  });

  test("disabled rejects an explicitly configured empty-response fallback", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(
      {
        ...baseConfig,
        llmMaxAttempts: 1,
        llmRetryBackoffMs: 0,
        llmStreamFallbackPolicy: "disabled",
      },
      {
        flowRegistry: singleNodeRegistry(fallbackFlow),
        llmProviderFactory: emptyStreamFactory(),
      },
    );
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "fb-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-fb-disabled" },
      async () => {},
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-fb-disabled")
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.status).not.toBe("completed");
    expect((node?.diagnostics ?? []).map((entry) => entry.code)).not.toContain(
      "empty_response_fallback",
    );
  });
});

describe("LLM provider circuit breaker", () => {
  test("opens on transport failures, falls back, and stays flow-local", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    let primaryCalls = 0;
    let primaryAttempts = 0;
    let fallbackCalls = 0;
    const fallbackFactory = mockLlmFactory(["fallback-ok"]);
    const config: AppConfig = {
      ...baseConfig,
      llmMaxAttempts: 3,
      llmRetryBackoffMs: 0,
      fallbackLlm: { provider: "anthropic", model: "fallback-model" },
    };
    const circuitFlow: FlowDefinition = {
      id: "circuit-flow",
      name: "Circuit flow",
      nodes: [
        { id: "llm-1", type: "llm" },
        { id: "llm-2", type: "llm" },
      ],
      edges: [{ source: "llm-1", target: "llm-2" }],
    };
    const engine = createGraphEngine(config, {
      flowRegistry: singleNodeRegistry(circuitFlow),
      llmProviderFactory: (candidate: LlmConfig) => {
        if (candidate.provider === "anthropic") {
          fallbackCalls += 1;
          return fallbackFactory();
        }
        primaryCalls += 1;
        return new MockLanguageModelV3({
          doStream: async () => {
            primaryAttempts += 1;
            throw Object.assign(new Error("connect failed"), {
              code: "ECONNREFUSED",
            });
          },
        });
      },
    });
    engine.setDebugStore?.(debugStore);

    for (const executionId of ["exec-circuit-1", "exec-circuit-2"]) {
      await engine.executeFlow(
        "circuit-flow",
        [{ role: "user", content: "hi" }],
        { ssoToken: "a.b.c", executionId },
        async () => {},
        async () => {},
      );
      const firstNodeDiagnostics =
        debugStore
          .getTrace(executionId)
          ?.nodes.find((node) => node.node_id === "llm-1")?.diagnostics ?? [];
      expect(
        firstNodeDiagnostics.find(
          (entry) => entry.code === "llm_provider_circuit_opened",
        )?.details,
      ).toMatchObject({
        state: "open",
        failure_count: 2,
        failure_threshold: 2,
        last_transport_error_code: "ECONNREFUSED",
        open_until: expect.any(Number),
        cooldown_ms: 30_000,
      });
      const secondNodeDiagnostics =
        debugStore
          .getTrace(executionId)
          ?.nodes.find((node) => node.node_id === "llm-2")?.diagnostics ?? [];
      expect(
        secondNodeDiagnostics.find(
          (entry) => entry.code === "llm_provider_circuit_open",
        )?.details,
      ).toMatchObject({
        state: "open",
        failure_count: 2,
        failure_threshold: 2,
        last_transport_error_code: "ECONNREFUSED",
        open_until: expect.any(Number),
        cooldown_ms: 30_000,
      });
    }

    expect(primaryCalls).toBe(2);
    expect(primaryAttempts).toBe(4);
    expect(fallbackCalls).toBe(4);
  });
  test("reports zero actual calls when every candidate is already circuit-open", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const flow: FlowDefinition = {
      id: "open-circuit-flow",
      name: "Open circuit flow",
      nodes: [
        {
          id: "llm-1",
          type: "llm",
          config: {
            emptyResponseFallback: true,
            emptyResponseFallbackText: "continue",
          },
        },
        { id: "llm-2", type: "llm" },
      ],
      edges: [{ source: "llm-1", target: "llm-2" }],
    };
    const engine = createGraphEngine(
      { ...baseConfig, llmMaxAttempts: 3, llmRetryBackoffMs: 0 },
      {
        flowRegistry: singleNodeRegistry(flow),
        llmProviderFactory: () =>
          new MockLanguageModelV3({
            doStream: async () => {
              throw Object.assign(new Error("connect failed"), {
                code: "ECONNREFUSED",
              });
            },
          }),
      },
    );
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "open-circuit-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-open-circuit" },
      async () => {},
      async () => {},
    );

    const second = debugStore
      .getTrace("exec-open-circuit")
      ?.nodes.find((node) => node.node_id === "llm-2");
    expect(second?.error_message).toContain("0 actual provider call(s)");
    expect(second?.error_message).toContain("provider circuits were open");
    expect(second?.error_details).toMatchObject({
      actual_provider_attempts: 0,
      circuit_skipped_providers: ["openai/mock-model"],
    });
  });
});

describe("debug trace — diagnostics timeline", () => {
  test("preserves a provider factory error instead of relabeling it", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleNodeRegistry(llmFlow),
      llmProviderFactory: () => {
        throw new Error("credentials unavailable");
      },
    });
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-provider-init" },
      async () => {},
      async () => {},
    );

    const diagnostic = debugStore
      .getTrace("exec-provider-init")
      ?.nodes.find((node) => node.node_id === "llm-1")
      ?.diagnostics?.find(
        (entry) => entry.code === "llm_provider_candidate_failed",
      );
    expect(diagnostic?.details).toMatchObject({
      phase: "provider-initialization",
    });
    expect(diagnostic?.message).toBe(
      "Could not initialize openai/mock-model.",
    );
    expect(JSON.stringify(diagnostic)).not.toContain("credentials unavailable");
  });

  test("reasoning-only response records retries then a salvage on the node", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(baseConfig, {
    flowRegistry: singleNodeRegistry(llmFlow),
    llmProviderFactory: reasoningOnlyFactory(),
  });
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-diag" },
      async () => {},
      async () => {},
    );

    const trace = debugStore.getTrace("exec-diag");
    expect(trace).toBeDefined();
    const node = trace?.nodes.find((n) => n.node_id === "llm-1");
    expect(node).toBeDefined();
    const diags = node?.diagnostics ?? [];
    const codes = diags.map((d) => d.code);
    // maxAttempts default is 3 → two reasoning-only retries, then a salvage.
    expect(codes.filter((c) => c === "reasoning_only_retry").length).toBe(2);
    expect(codes).toContain("reasoning_salvage");
    // Every diagnostic carries a timestamp and a message.
    for (const d of diags) {
      expect(typeof d.at).toBe("string");
      expect(d.message.length).toBeGreaterThan(0);
    }
    // Salvage promotes reasoning → the node completes rather than failing.
    expect(node?.status).toBe("completed");
  });

  test("report records a structured reasoning fallback diagnostic and metric", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const metrics = createMetrics(true);
    const engine = createGraphEngine(
      {
        ...baseConfig,
        llmMaxAttempts: 1,
        llmRetryBackoffMs: 0,
        llmStreamFallbackPolicy: "report",
      },
      {
        flowRegistry: singleNodeRegistry(llmFlow),
        llmProviderFactory: reasoningOnlyFactory(),
        metrics,
      },
    );
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-reasoning-report" },
      async () => {},
      async () => {},
    );

    const diagnostic = debugStore
      .getTrace("exec-reasoning-report")
      ?.nodes.find((entry) => entry.node_id === "llm-1")
      ?.diagnostics?.find((entry) => entry.code === "stream_fallback_report");
    expect(diagnostic?.details).toMatchObject({
      kind: "semantic",
      reason: "reasoning_salvage",
      policy: "report",
    });
    expect(metrics.render()).toContain(
      'aiperator_stream_fallback_total{kind="semantic",reason="reasoning_salvage"} 1',
    );
  });

  test("explicit suppresses implicit reasoning salvage", async () => {
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(
      {
        ...baseConfig,
        llmMaxAttempts: 1,
        llmRetryBackoffMs: 0,
        llmStreamFallbackPolicy: "explicit",
      },
      {
        flowRegistry: singleNodeRegistry(llmFlow),
        llmProviderFactory: reasoningOnlyFactory(),
      },
    );
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      "r-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-reasoning-explicit-off" },
      async () => {},
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-reasoning-explicit-off")
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.status).not.toBe("completed");
    expect((node?.diagnostics ?? []).map((entry) => entry.code)).toContain(
      "reasoning_salvage_suppressed",
    );
  });

  test("explicit allows node-configured reasoning salvage", async () => {
    const flow: FlowDefinition = {
      ...llmFlow,
      id: "reasoning-explicit-flow",
      nodes: [
        {
          id: "llm-1",
          type: "llm",
          config: { reasoningSalvage: true },
        },
      ],
    };
    const debugStore = new InMemoryDebugTraceStore();
    const engine = createGraphEngine(
      {
        ...baseConfig,
        llmMaxAttempts: 1,
        llmRetryBackoffMs: 0,
        llmStreamFallbackPolicy: "explicit",
      },
      {
        flowRegistry: singleNodeRegistry(flow),
        llmProviderFactory: reasoningOnlyFactory(),
      },
    );
    engine.setDebugStore?.(debugStore);

    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-reasoning-explicit-on" },
      async () => {},
      async () => {},
    );

    const node = debugStore
      .getTrace("exec-reasoning-explicit-on")
      ?.nodes.find((entry) => entry.node_id === "llm-1");
    expect(node?.status).toBe("completed");
    expect((node?.diagnostics ?? []).map((entry) => entry.code)).toContain(
      "reasoning_salvage",
    );
  });
});

// ---------------------------------------------------------------------------
// Classifier fallback on provider failure
// ---------------------------------------------------------------------------

import { MockLanguageModelV3 as MockLM } from "ai/test";

function failingClassifierFactory() {
  return () =>
    new MockLM({
      doGenerate: async () => {
        throw new Error("Bad Request");
      },
    });
}

describe("Classifier — fallback on failure", () => {
  test("uses config.fallback classification when generateText fails", async () => {
    const flow: FlowDefinition = {
      id: "cls-flow",
      name: "Classifier",
      nodes: [
        {
          id: "dispatcher",
          type: "classifier",
          classifierSchema: {
            classKey: "route",
            schema: {
              type: "object",
              properties: { route: { type: "string" } },
              required: ["route"],
            },
          },
          config: { fallback: { route: "ALLGEMEINES", needsRag: false } },
        },
        { id: "router", type: "router" },
        { id: "responder", type: "llm" },
      ],
      edges: [
        { source: "dispatcher", target: "router" },
        {
          source: "router",
          target: "responder",
          conditions: "classLabel == 'ALLGEMEINES'",
        },
      ],
    };

    // Two-model factory: classifier fails, responder works.
    let call = 0;
    const factory = () => {
      call += 1;
      if (call === 1) return failingClassifierFactory()();
      return mockLlmFactory(["safe answer"])();
    };

    const engine = createGraphEngine(baseConfig, { flowRegistry: singleNodeRegistry(flow), llmProviderFactory: factory });

    const chunks: ChatCompletionChunk[] = [];
    let errored = false;
    await engine.executeFlow(
      "cls-flow",
      [{ role: "user", content: "hi" }],
      { ssoToken: "a.b.c", executionId: "exec-fb" },
      async (chunk) => {
        chunks.push(chunk);
        if ((chunk as { error?: unknown }).error) errored = true;
      },
      async () => {},
    );

    // The flow should route via the fallback (ALLGEMEINES) to the responder,
    // producing the answer rather than erroring out.
    let content = "";
    for (const c of chunks) {
      const d = c.choices[0]?.delta as { content?: string | null } | undefined;
      if (typeof d?.content === "string") content += d.content;
    }
    expect(errored).toBe(false);
    expect(content).toBe("safe answer");
  });
});

describe("Deep-Research flow progress", () => {
  test("emits safe lifecycle phases and a wall-clock total without model reasoning", async () => {
    const progressFlow: FlowDefinition = {
      id: "progress-flow",
      name: "Progress",
      nodes: [
        {
          id: "dossier",
          type: "llm",
          label: "Internes Dossier-Label",
          config: {
            progress: {
              start: "Dokumentbestand wird erfasst",
              complete: "Dokumentbestand erfasst",
            },
          },
        },
      ],
      edges: [],
    };
    const { content, reasoning } = await runFlow(["Antwort"], progressFlow);

    expect(content).toBe("Antwort");
    expect(reasoning).toContain("🧭 Recherche gestartet");
    expect(reasoning).toContain("⚙️ Dokumentbestand wird erfasst…");
    expect(reasoning).toContain("⚙️ Dokumentbestand erfasst ·");
    expect(reasoning).toMatch(/Gesamtlaufzeit \d+ Sek\./);
    expect(reasoning).not.toContain("<think>");
  });
});

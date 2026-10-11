// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the history summariser.
 *
 * Stubs `runtime.llmProviderFactory` with a MockLanguageModelV3 (the pattern used
 * by the planner tests) so the real code path runs — prompt construction, the
 * provider call, token/cost accounting and the fail-open branches — without a
 * network dependency.
 *
 * The contracts that matter:
 *   - the transcript actually reaches the model (tool calls and results included,
 *     since those carry the identifiers a later turn needs);
 *   - every failure mode returns `undefined` so the caller keeps the full history;
 *   - token usage is accounted even when the provider omits it, which local
 *     models routinely do;
 *   - temperature is pinned to 0, because the summary is cached and re-emitted
 *     verbatim on later turns.
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { ModelMessage } from "ai";
import type { ExecRuntime, UsageAccumulator } from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";
import type { LlmConfig } from "../../types/flow.js";
import { createHistorySummarizer } from "../history-summarizer.js";
import { UnknownProviderError } from "../llm-factory.js";

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
} as AppConfig;

const summarizerLlm: LlmConfig = {
  provider: "openai",
  model: "qwen3.6-35b-a3b",
};

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

interface Harness {
  runtime: ExecRuntime;
  /** Prompts the mock model was called with. */
  seen: { system: string; user: string }[];
  llmCalls: Array<{ promptTokens: number; completionTokens: number }>;
  diagnostics: Array<{ code: string }>;
  callOptions: Array<{ temperature?: number; abortSignal?: AbortSignal }>;
  /** Generic counters recorded via metrics.recordCounter (Req 7.8). */
  counters: Array<{ name: string; labels: Record<string, string> }>;
}

/**
 * Builds a runtime whose model either returns `responseText` or throws.
 * `usageReported: false` simulates a local server that omits usage.
 */
function harness(
  responseText: string | Error,
  opts: { usageReported?: boolean; factoryThrows?: Error } = {},
): Harness {
  const seen: Harness["seen"] = [];
  const llmCalls: Harness["llmCalls"] = [];
  const diagnostics: Harness["diagnostics"] = [];
  const callOptions: Harness["callOptions"] = [];
  const counters: Harness["counters"] = [];

  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = options.prompt as Array<{
        role?: string;
        content?: unknown;
      }>;
      const textOf = (role: string): string => {
        const m = prompt.find((p) => p.role === role);
        if (m === undefined) return "";
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) {
          return c
            .map((p) => (p as { text?: string }).text ?? "")
            .join("");
        }
        return "";
      };
      seen.push({ system: textOf("system"), user: textOf("user") });
      callOptions.push({
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options.abortSignal !== undefined
          ? { abortSignal: options.abortSignal }
          : {}),
      });
      if (responseText instanceof Error) throw responseText;
      return {
        content: [{ type: "text" as const, text: responseText }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage:
          opts.usageReported === false
            ? {
                inputTokens: {
                  total: undefined,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: undefined,
                  text: undefined,
                  reasoning: undefined,
                },
              }
            : {
                inputTokens: {
                  total: 120,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: {
                  total: 40,
                  text: undefined,
                  reasoning: undefined,
                },
              },
        warnings: [],
      };
    },
  });

  const deadlineController = new AbortController();
  const runtime = {
    appConfig: baseConfig,
    ctx: { ssoToken: "t", executionId: "exec-1" },
    usage: mkUsage(),
    signal: deadlineController.signal,
    llmProviderFactory: () => {
      if (opts.factoryThrows !== undefined) throw opts.factoryThrows;
      return model;
    },
    onToken: async () => {},
    onReasoning: async () => {},
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: () => {},
    onNodeEnd: async () => {},
    onNodeDiagnostic: (_nodeId: string, d: { code: string }) => {
      diagnostics.push(d);
    },
    metrics: {
      recordRequest: () => {},
      recordNode: () => {},
      recordLlmCall: (
        _p: string,
        _m: string,
        _s: string,
        promptTokens: number,
        completionTokens: number,
      ) => {
        llmCalls.push({ promptTokens, completionTokens });
      },
      recordLlmRetry: () => {},
      recordLlmFallback: () => {},
      recordRejected: () => {},
      recordCache: () => {},
      recordGuardrail: () => {},
      recordCounter: (name: string, labels: Record<string, string>) => {
        counters.push({ name, labels });
      },
      setActiveExecutions: () => {},
      setQueueDepth: () => {},
      render: () => "",
      summary: () => ({}) as never,
    } as unknown as ExecRuntime["metrics"],
    costTracker: { record: () => {} },
  } as unknown as ExecRuntime;

  return { runtime, seen, llmCalls, diagnostics, callOptions, counters };
}

const middle: ModelMessage[] = [
  { role: "user", content: "Bitte lies /akte/2024/vertrag.pdf" } as ModelMessage,
  {
    role: "assistant",
    content: [
      { type: "text", text: "Ich hole das Dokument." },
      { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: {} },
    ],
  } as unknown as ModelMessage,
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "read_file",
        output: { type: "text", value: "Vertragsnummer AZ-8891" },
      },
    ],
  } as unknown as ModelMessage,
  { role: "assistant", content: "Die Vertragsnummer ist AZ-8891." } as ModelMessage,
];

describe("createHistorySummarizer", () => {
  test("returns the model's summary text, trimmed", async () => {
    const h = harness("  ZUSAMMENFASSUNG  ");
    const summarize = createHistorySummarizer(h.runtime, summarizerLlm, "node-1");
    expect(await summarize(middle)).toBe("ZUSAMMENFASSUNG");
  });

  test("sends the transcript including tool calls and results", async () => {
    // Tool results carry the identifiers later turns need verbatim; a summariser
    // that never sees them cannot preserve them.
    const h = harness("S");
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    expect(h.seen).toHaveLength(1);
    const sent = at(h.seen, 0).user;
    expect(sent).toContain("/akte/2024/vertrag.pdf");
    expect(sent).toContain("read_file");
    expect(sent).toContain("AZ-8891");
  });

  test("instructs the model not to phrase the summary as a task", async () => {
    const h = harness("S");
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    const seen0 = at(h.seen, 0);
    expect(seen0.system).toContain("not");
    expect(seen0.system.toLowerCase()).toContain("instruction");
  });

  test("pins temperature to 0 so the cached summary stays reproducible", async () => {
    const h = harness("S");
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    expect(at(h.callOptions, 0).temperature).toBe(0);
  });

  test("binds runtime.signal into the generateText call (deadline propagation regression)", async () => {
    const h = harness("S");
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    expect(at(h.callOptions, 0).abortSignal).toBe(h.runtime.signal);
  });

  test("accounts token usage reported by the provider", async () => {
    const h = harness("S");
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    expect(h.runtime.usage.promptTokens).toBe(120);
    expect(h.runtime.usage.completionTokens).toBe(40);
    expect(h.runtime.usage.totalTokens).toBe(160);
    expect(h.llmCalls[0]).toEqual({ promptTokens: 120, completionTokens: 40 });
  });

  test("estimates usage when the provider omits it (local models)", async () => {
    const h = harness("EINE ZUSAMMENFASSUNG", { usageReported: false });
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    // Estimated rather than left at zero — otherwise this spend is invisible.
    expect(h.runtime.usage.promptTokens).toBeGreaterThan(0);
    expect(h.runtime.usage.completionTokens).toBeGreaterThan(0);
  });

  test("records a diagnostic describing the compaction", async () => {
    const h = harness("S");
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle);
    expect(h.diagnostics.map((d) => d.code)).toContain("history_summarized");
  });

  test("fails open when the provider throws", async () => {
    // The caller keeps the full history; losing the conversation would be worse
    // than an oversized prompt.
    const h = harness(new Error("provider down"));
    expect(
      await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle),
    ).toBeUndefined();
  });

  test("fails open on an unknown provider", async () => {
    const h = harness("S", { factoryThrows: new UnknownProviderError("nope") });
    expect(
      await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle),
    ).toBeUndefined();
  });

  test("fails open when the model factory throws anything else", async () => {
    const h = harness("S", { factoryThrows: new Error("misconfigured") });
    expect(
      await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle),
    ).toBeUndefined();
  });

  test("fail-open on a model error counts aiperator_degraded_total (Req 7.8)", async () => {
    const hThrow = harness(new Error("provider down"));
    expect(
      await createHistorySummarizer(hThrow.runtime, summarizerLlm, "n")(middle),
    ).toBeUndefined();
    expect(hThrow.counters).toContainEqual({
      name: "aiperator_degraded_total",
      labels: { component: "history_summarizer" },
    });

    const hFactory = harness("S", {
      factoryThrows: new Error("misconfigured"),
    });
    expect(
      await createHistorySummarizer(
        hFactory.runtime,
        summarizerLlm,
        "n",
      )(middle),
    ).toBeUndefined();
    expect(hFactory.counters).toContainEqual({
      name: "aiperator_degraded_total",
      labels: { component: "history_summarizer" },
    });
  });

  test("returns undefined for a blank model response", async () => {
    const h = harness("   \n  ");
    expect(
      await createHistorySummarizer(h.runtime, summarizerLlm, "n")(middle),
    ).toBeUndefined();
    // No success diagnostic for a non-result.
    expect(h.diagnostics.map((d) => d.code)).not.toContain(
      "history_summarized",
    );
  });

  test("returns undefined without calling the model for an empty range", async () => {
    const h = harness("S");
    expect(
      await createHistorySummarizer(h.runtime, summarizerLlm, "n")([]),
    ).toBeUndefined();
    expect(h.seen).toHaveLength(0);
  });

  test("skips messages whose content carries nothing renderable", async () => {
    const h = harness("S");
    const odd = [
      { role: "assistant", content: [] } as unknown as ModelMessage,
      { role: "user", content: "echte frage" } as ModelMessage,
    ];
    await createHistorySummarizer(h.runtime, summarizerLlm, "n")(odd);
    expect(at(h.seen, 0).user).toContain("echte frage");
  });
});

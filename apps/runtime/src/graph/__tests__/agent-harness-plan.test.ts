// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for plan() (src/graph/agent-harness.ts).
 *
 * Stubs `runtime.llmProviderFactory` with a MockLanguageModelV3 so the
 * planner logic is tested independently of any provider.
 *
 * Validates: Requirements 3.3, 12.1
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { plan } from "../agent-harness.js";
import { narrateProgress } from "../agent-harness/tools.js";
import type { ExecRuntime, UsageAccumulator } from "../graph-engine.js";
import type { MetricsSummary } from "../../observability/metrics.js";
import type { AppConfig } from "../../config/index.js";
import type { HarnessProgress } from "../agent-harness.js";
import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
};

const plannerLlm = { provider: "openai", model: "gpt-4o" } as const;

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/**
 * Build a minimal mock ExecRuntime whose `llmProviderFactory` returns a model
 * with a controlled `doGenerate` response. `onGenerate`, when supplied, is
 * called with the raw doGenerate options (used to assert abortSignal binding).
 */
function mockRuntime(
  responseText: string,
  onGenerate?: (options: { abortSignal?: AbortSignal }) => void,
): ExecRuntime {
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { abortSignal?: AbortSignal }) => {
      onGenerate?.(options);
      return {
        content: [{ type: "text" as const, text: responseText }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: {
            total: 10,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  const deadlineController = new AbortController();
  return {
    appConfig: baseConfig,
    ctx: {
      ssoToken: "test-token",
      executionId: "exec-1",
    },
    usage: mkUsage(),
    signal: deadlineController.signal,
    llmProviderFactory: () => model,
    onToken: async () => {},
    onReasoning: async () => {},
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: () => {},
    onNodeEnd: async () => {},
    metrics: {
      recordRequest: () => {},
      recordNode: () => {},
      recordLlmCall: () => {},
      recordLlmRetry: () => {},
      recordLlmFallback: () => {},
      recordRejected: () => {},
      recordCache: () => {},
      recordGuardrail: () => {},
      recordCounter: () => {},
      setActiveExecutions: () => {},
      setQueueDepth: () => {},
      render: () => "",
      summary: () => ({}) as unknown as MetricsSummary,
    } as ExecRuntime["metrics"],
    costTracker: {
      record: () => {},
    },
  } as unknown as ExecRuntime;
}

/** Build a mock runtime whose model throws (simulating LLM failure). */
function mockRuntimeThrowing(error: unknown = new Error("Provider unavailable")): ExecRuntime {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw error;
    },
  });

  return {
    appConfig: baseConfig,
    ctx: {
      ssoToken: "test-token",
      executionId: "exec-1",
    },
    usage: mkUsage(),
    llmProviderFactory: () => model,
    onToken: async () => {},
    onReasoning: async () => {},
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: () => {},
    onNodeEnd: async () => {},
    metrics: {
      recordRequest: () => {},
      recordNode: () => {},
      recordLlmCall: () => {},
      recordLlmRetry: () => {},
      recordLlmFallback: () => {},
      recordRejected: () => {},
      recordCache: () => {},
      recordGuardrail: () => {},
      recordCounter: () => {},
      setActiveExecutions: () => {},
      setQueueDepth: () => {},
      render: () => "",
      summary: () => ({}) as unknown as MetricsSummary,
    } as ExecRuntime["metrics"],
    costTracker: {
      record: () => {},
    },
  } as unknown as ExecRuntime;
}

const sampleMessages: ModelMessage[] = [
  { role: "user", content: "Build a summary pipeline" },
];

const allowlist = ["summarizer", "translator", "reviewer"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plan(runtime, plannerLlm, messages, allowlist, priorProgress)", () => {
  test("initial plan: model returns valid JSON → returns parsed tasks array", async () => {
    const validResponse = JSON.stringify({
      tasks: [
        { description: "Summarize the document", target: "summarizer" },
        { description: "Translate to German", target: "translator" },
      ],
    });

    const runtime = mockRuntime(validResponse);
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toEqual([
      { description: "Summarize the document", target: "summarizer" },
      { description: "Translate to German", target: "translator" },
    ]);
  });

  test("binds runtime.signal into the generateText/generateObject call (deadline propagation regression)", async () => {
    let captured: { abortSignal?: AbortSignal } | undefined;
    const validResponse = JSON.stringify({
      tasks: [{ description: "Summarize the document", target: "summarizer" }],
    });
    const runtime = mockRuntime(validResponse, (options) => {
      captured = options;
    });
    await plan(runtime, plannerLlm, sampleMessages, allowlist);
    expect(captured?.abortSignal).toBe(runtime.signal);
  });

  test("re-plan with prior progress: priorProgress param used → returns new tasks", async () => {
    const replanResponse = JSON.stringify({
      tasks: [
        { description: "Review the translated output", target: "reviewer" },
      ],
    });

    const runtime = mockRuntime(replanResponse);

    const priorProgress: HarnessProgress = {
      tasks: [
        {
          id: "t1",
          description: "Summarize the document",
          target: "summarizer",
          status: "completed",
          result: "Summary done",
        },
        {
          id: "t2",
          description: "Translate to German",
          target: "translator",
          status: "failed",
          error: "Timeout",
        },
      ],
      iterations: 2,
      cost: 0.01,
    };

    const result = await plan(
      runtime,
      plannerLlm,
      sampleMessages,
      allowlist,
      priorProgress,
    );

    expect(result).toEqual([
      { description: "Review the translated output", target: "reviewer" },
    ]);
  });

  test("empty-task output: model returns valid JSON with empty tasks array → returns []", async () => {
    const emptyResponse = JSON.stringify({ tasks: [] });

    const runtime = mockRuntime(emptyResponse);
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toEqual([]);
  });

  test("unparseable output: model returns garbage text → returns null", async () => {
    const runtime = mockRuntime(
      "Sorry, I cannot produce a plan in JSON format. Here is some prose instead...",
    );
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toBeNull();
  });

  test("unparseable output: model returns invalid JSON structure (no tasks key) → returns null", async () => {
    const runtime = mockRuntime(JSON.stringify({ items: ["a", "b"] }));
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toBeNull();
  });

  test("model throws → returns null (planning failure)", async () => {
    const runtime = mockRuntimeThrowing();
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toBeNull();
  });

  test("folds usage into runtime.usage accumulator", async () => {
    const validResponse = JSON.stringify({
      tasks: [{ description: "Do work", target: "summarizer" }],
    });

    const runtime = mockRuntime(validResponse);
    await plan(runtime, plannerLlm, sampleMessages, allowlist);

    // Usage should have been incremented from the mock's 10 input / 5 output tokens
    expect(runtime.usage.promptTokens).toBeGreaterThan(0);
    expect(runtime.usage.completionTokens).toBeGreaterThan(0);
    expect(runtime.usage.totalTokens).toBeGreaterThan(0);
  });

  test("calls metrics.recordLlmCall on success", async () => {
    const validResponse = JSON.stringify({
      tasks: [{ description: "Do work", target: "summarizer" }],
    });

    let recorded = false;
    const runtime = mockRuntime(validResponse);
    (
      runtime.metrics as { recordLlmCall: (...args: unknown[]) => void }
    ).recordLlmCall = (provider: unknown, model: unknown, status: unknown) => {
      recorded = true;
      expect(provider).toBe("openai");
      expect(model).toBe("gpt-4o");
      expect(status).toBe("ok");
    };

    await plan(runtime, plannerLlm, sampleMessages, allowlist);
    expect(recorded).toBe(true);
  });

  test("handles JSON wrapped in markdown code fences", async () => {
    const fencedResponse =
      '```json\n{"tasks": [{"description": "Check output", "target": "reviewer"}]}\n```';

    const runtime = mockRuntime(fencedResponse);
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toEqual([
      { description: "Check output", target: "reviewer" },
    ]);
  });

  test("filters out task items with missing description or target fields", async () => {
    const response = JSON.stringify({
      tasks: [
        { description: "Valid task", target: "summarizer" },
        { description: "Missing target" },
        { target: "reviewer" },
        { description: "Another valid", target: "translator" },
        null,
        42,
      ],
    });

    const runtime = mockRuntime(response);
    const result = await plan(runtime, plannerLlm, sampleMessages, allowlist);

    expect(result).toEqual([
      { description: "Valid task", target: "summarizer" },
      { description: "Another valid", target: "translator" },
    ]);
  });
});

describe("narrateProgress structured output", () => {
  const input = {
    iteration: 2,
    totalIterations: 10,
    finding: "ABGEDECKT: Schriftsaetze [1]\nBEFUNDE:\n- Frist belegt [1]",
    citationCount: 1,
  };

  test("uses native JSON schema output for response-format capable models", async () => {
    let responseFormat: unknown;
    const response = JSON.stringify({
      focus: "finding",
      hypothesisState: null,
      researchStatus:
        "Die Fristangabe wurde gegen den Originalbefund abgeglichen und als belastbarer Befund eingeordnet.",
    });
    const runtime = mockRuntime(response, (options) => {
      responseFormat = (options as { responseFormat?: unknown }).responseFormat;
    });

    const result = await narrateProgress(
      runtime,
      {
        enabled: true,
        llm: {
          provider: "openai",
          model: "gpt-4o",
          parameters: { temperature: 0, maxTokens: 256 },
        },
      },
      input,
      "orchestrator",
    );

    expect(responseFormat).toEqual({
      type: "json",
      name: "progress_selection",
      schema: {
        type: "object",
        properties: {
          focus: {
            type: "string",
            enum: ["coverage", "finding", "hypothesis"],
          },
          hypothesisState: {
            anyOf: [
              {
                type: "string",
                enum: ["active", "confirmed", "rejected"],
              },
              { type: "null" },
            ],
          },
          researchStatus: {
            type: "string",
            minLength: 12,
            maxLength: 280,
            description:
              "Ein kurzer Satz zum aktuellen Recherche- und Entscheidungsstand, ausschliesslich aus den bereitgestellten Artefakten abgeleitet.",
          },
        },
        required: ["focus", "hypothesisState", "researchStatus"],
        additionalProperties: false,
      },
    });
    expect(result?.text).toContain("Step 2/10");
    expect(result?.text).toContain("Fristangabe wurde gegen den Originalbefund");
    expect(result?.researchStatus).toContain("Fristangabe wurde gegen den Originalbefund");
  });

  test("sends the real schema and locally rejects schema-invalid prompt output", async () => {
    let systemPrompt = "";
    const response = JSON.stringify({
      focus: "coverage",
      hypothesisState: null,
      unexpected: true,
    });
    const runtime = mockRuntime(response, (options) => {
      const prompt = (options as { prompt?: Array<{ role: string; content: unknown }> })
        .prompt;
      const systemMessage = prompt?.find((message) => message.role === "system");
      systemPrompt = JSON.stringify(systemMessage?.content ?? "");
    });

    const result = await narrateProgress(
      runtime,
      {
        enabled: true,
        llm: {
          provider: "unknown-provider",
          model: "unknown-model",
          parameters: { temperature: 0, maxTokens: 256 },
        },
      },
      input,
      "orchestrator",
    );

    expect(systemPrompt).toContain("additionalProperties");
    expect(systemPrompt).toContain("hypothesisState");
    expect(systemPrompt).toContain("researchStatus");
    expect(result?.text).toContain("A new evidenced finding");
  });

  test("normalizes an unavailable focus and exposes the step-local hypothesis delta", async () => {
    const runtime = mockRuntime(
      JSON.stringify({
        focus: "finding",
        hypothesisState: null,
        researchStatus:
          "Die offene Fristfrage wird anhand der markierten Hypothese weiter geprüft.",
      }),
    );

    const result = await narrateProgress(
      runtime,
      {
        enabled: true,
        includeHypotheses: { active: true, confirmed: true, rejected: true },
        llm: {
          provider: "openai",
          model: "gpt-4o",
          parameters: { temperature: 0, maxTokens: 256 },
        },
      },
      {
        ...input,
        finding:
          "HYPOTHESEN:\n" +
          "- [AKTIV] Fristlauf ist noch zu pruefen\n" +
          "- [BESTAETIGT] Zugang ist durch Originalbeleg [7] bestätigt\n" +
          "- [VERWORFEN] Frühere Zustellung ist durch Gegenbeleg [8] widerlegt",
      },
      "orchestrator",
    );

    expect(result?.text).toContain("A hypothesis was confirmed by primary evidence");
    expect(result?.hypothesisStatus).toEqual({
      active: 1,
      confirmed: 1,
      rejected: 1,
      detailState: "confirmed",
      detail: "Zugang ist durch Originalbeleg [7] bestätigt",
    });
  });

  test("uses measured usage and cost from a real structured-output decode error", async () => {
    const runtime = mockRuntime("not json");
    const metricCalls: Array<{
      status: string;
      promptTokens: number;
      completionTokens: number;
      cost: number;
    }> = [];
    const costCalls: Array<{ cost: number; detail: unknown }> = [];
    runtime.pricingOverrides = {
      "google/test-model": { prompt: 1, completion: 2 },
    };
    runtime.metrics.recordLlmCall = (
      _provider,
      _model,
      status,
      promptTokens,
      completionTokens,
      cost,
    ) => {
      metricCalls.push({ status, promptTokens, completionTokens, cost });
    };
    runtime.costTracker = {
      record: (_tenant, cost, detail) => {
        costCalls.push({ cost, detail });
      },
    };

    const result = await narrateProgress(
      runtime,
      {
        enabled: true,
        llm: {
          provider: "google",
          model: "test-model",
          parameters: { temperature: 0, maxTokens: 256 },
        },
      },
      input,
      "orchestrator",
    );

    const expectedCost = (10 * 1 + 5 * 2) / 1_000_000;
    expect(runtime.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(metricCalls).toEqual([
      {
        status: "error",
        promptTokens: 10,
        completionTokens: 5,
        cost: expectedCost,
      },
    ]);
    expect(costCalls).toHaveLength(1);
    expect(costCalls[0]?.cost).toBe(expectedCost);
    expect(result).toEqual({
      text: null,
      researchStatus: null,
      cost: expectedCost,
    });
  });
});
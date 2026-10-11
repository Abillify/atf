// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the pure parts of RAG compression: config parsing, tolerant
 * JSON-array extraction, and the fail-open entry-application logic.
 */
import { describe, test, expect } from "bun:test";
import {
  parseRagCompressionConfig,
  extractJsonArray,
  applyCompressionEntries,
  compressRagChunks,
  type RagCompressionConfig,
} from "../rag-compression.js";
import type { RagChunk } from "../reranker.js";
import { MockLanguageModelV3 } from "ai/test";
import type { ExecRuntime, UsageAccumulator } from "../graph-engine.js";
import type { AppConfig } from "../../config/index.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

const chunk = (id: string, content: string): RagChunk => ({
  id,
  title: `T-${id}`,
  url: `https://x/${id}`,
  content,
  retrievalScore: 0.9,
});

describe("parseRagCompressionConfig", () => {
  test("returns undefined when absent or disabled", () => {
    expect(parseRagCompressionConfig(undefined)).toBeUndefined();
    expect(parseRagCompressionConfig({})).toBeUndefined();
    expect(
      parseRagCompressionConfig({ ragCompression: { enabled: false, llm: {} } }),
    ).toBeUndefined();
  });
  test("returns undefined when enabled but no llm", () => {
    expect(
      parseRagCompressionConfig({ ragCompression: { enabled: true } }),
    ).toBeUndefined();
  });
  test("parses enabled config with llm + optional numbers", () => {
    const cfg = parseRagCompressionConfig({
      ragCompression: {
        enabled: true,
        minChars: 500,
        maxTokens: 1024,
        llm: { provider: "openai", model: "m" },
      },
    });
    expect(cfg).toBeDefined();
    if (cfg === undefined) throw new Error("expected a parsed config");
    expect(cfg.minChars).toBe(500);
    expect(cfg.maxTokens).toBe(1024);
    expect(cfg.llm.model).toBe("m");
  });
});

describe("extractJsonArray", () => {
  test("parses a fenced json block", () => {
    const out = extractJsonArray('```json\n[{"i":1,"keep":true,"text":"a"}]\n```');
    expect(out).toEqual([{ i: 1, keep: true, text: "a" }]);
  });
  test("parses a bare array embedded in prose", () => {
    const out = extractJsonArray('Here: [{"i":2,"keep":false,"text":""}] done');
    expect(out).toEqual([{ i: 2, keep: false, text: "" }]);
  });
  test("returns null for non-array / garbage", () => {
    expect(extractJsonArray("not json")).toBeNull();
    expect(extractJsonArray('{"i":1}')).toBeNull();
  });
});

describe("applyCompressionEntries", () => {
  const chunks = [chunk("a", "alpha full"), chunk("b", "beta full"), chunk("c", "gamma full")];

  test("replaces content on keep+extract, drops keep=false, keeps missing", () => {
    const out = applyCompressionEntries(chunks, [
      { i: 1, keep: true, text: "alpha relevant" },
      { i: 2, keep: false, text: "" },
      // no entry for i:3 → keep original
    ]);
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
    expect(at(out, 0).content).toBe("alpha relevant"); // condensed
    expect(at(out, 1).content).toBe("gamma full"); // untouched original
    // identity preserved
    expect(at(out, 0).title).toBe("T-a");
    expect(at(out, 0).url).toBe("https://x/a");
  });

  test("keep=true with empty text keeps original content", () => {
    const out = applyCompressionEntries([chunk("a", "alpha full")], [
      { i: 1, keep: true, text: "   " },
    ]);
    expect(at(out, 0).content).toBe("alpha full");
  });

  test("fail-open: dropping every source returns originals unchanged", () => {
    const out = applyCompressionEntries(chunks, [
      { i: 1, keep: false, text: "" },
      { i: 2, keep: false, text: "" },
      { i: 3, keep: false, text: "" },
    ]);
    expect(out).toBe(chunks); // same reference — originals
  });

  test("does not mutate input chunks", () => {
    applyCompressionEntries(chunks, [{ i: 1, keep: true, text: "x" }]);
    expect(at(chunks, 0).content).toBe("alpha full");
  });
});

// ---------------------------------------------------------------------------
// compressRagChunks — execution-deadline signal propagation (regression)
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
} as AppConfig;

function mkUsage(): UsageAccumulator {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

describe("compressRagChunks — deadline signal propagation", () => {
  test("binds runtime.signal into the generateText call", async () => {
    let captured: { abortSignal?: AbortSignal } | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options: { abortSignal?: AbortSignal }) => {
        captured = options;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify([{ i: 1, keep: true, text: "alpha relevant" }]),
            },
          ],
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: undefined, reasoning: undefined },
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
      llmProviderFactory: () => model,
      metrics: {
        recordLlmCall: () => {},
      } as unknown as ExecRuntime["metrics"],
      costTracker: { record: () => {} },
    } as unknown as ExecRuntime;

    const cfg: RagCompressionConfig = {
      enabled: true,
      llm: { provider: "openai", model: "m" },
      minChars: 1, // force the round-trip regardless of chunk size
    };

    await compressRagChunks(
      runtime,
      "What is alpha?",
      [chunk("a", "alpha full content that is long enough to exceed minChars")],
      cfg,
    );

    expect(captured?.abortSignal).toBe(deadlineController.signal);
  });
});

// ---------------------------------------------------------------------------
// compressRagChunks — fail-open degradations counted (Req 7.8)
// ---------------------------------------------------------------------------

describe("compressRagChunks — degraded metric (Req 7.8)", () => {
  function mkRuntime(
    modelOrFactory: (() => unknown) | unknown,
    counters: Array<{ name: string; labels: Record<string, string> }>,
  ): ExecRuntime {
    const deadlineController = new AbortController();
    return {
      appConfig: baseConfig,
      ctx: { ssoToken: "t", executionId: "exec-1" },
      usage: mkUsage(),
      signal: deadlineController.signal,
      llmProviderFactory:
        typeof modelOrFactory === "function"
          ? (modelOrFactory as () => never)
          : () => modelOrFactory as never,
      metrics: {
        recordLlmCall: () => {},
        recordCounter: (name: string, labels: Record<string, string>) => {
          counters.push({ name, labels });
        },
      } as unknown as ExecRuntime["metrics"],
      costTracker: { record: () => {} },
    } as unknown as ExecRuntime;
  }

  const cfg: RagCompressionConfig = {
    enabled: true,
    llm: { provider: "openai", model: "m" },
    minChars: 1,
  };

  test("model factory throwing counts rag_compression and returns originals", async () => {
    const counters: Array<{ name: string; labels: Record<string, string> }> = [];
    const runtime = mkRuntime(() => {
      throw new Error("misconfigured");
    }, counters);
    const chunks = [chunk("a", "alpha content long enough")];
    const out = await compressRagChunks(runtime, "q", chunks, cfg);
    expect(out).toBe(chunks); // fail-open: originals unchanged
    expect(counters).toContainEqual({
      name: "aiperator_degraded_total",
      labels: { component: "rag_compression" },
    });
  });

  test("unparseable model output counts rag_compression", async () => {
    const counters: Array<{ name: string; labels: Record<string, string> }> = [];
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "kein json hier" }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }),
    });
    const runtime = mkRuntime(model, counters);
    const chunks = [chunk("a", "alpha content long enough")];
    const out = await compressRagChunks(runtime, "q", chunks, cfg);
    expect(out).toBe(chunks); // fail-open: originals unchanged
    expect(counters).toContainEqual({
      name: "aiperator_degraded_total",
      labels: { component: "rag_compression" },
    });
  });

  test("model call throwing counts rag_compression", async () => {
    const counters: Array<{ name: string; labels: Record<string, string> }> = [];
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("provider down");
      },
    });
    const runtime = mkRuntime(model, counters);
    const chunks = [chunk("a", "alpha content long enough")];
    const out = await compressRagChunks(runtime, "q", chunks, cfg);
    expect(out).toBe(chunks);
    expect(counters).toContainEqual({
      name: "aiperator_degraded_total",
      labels: { component: "rag_compression" },
    });
  });
});

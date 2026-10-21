// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Model cascade (`config.cascade`): the pure signal rules, and the engine
 * behaviour with scripted models — a weak first answer is replaced once by the
 * stronger model, a good one is released unchanged, and the dropped answer
 * never reaches the client.
 */
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { FlowRegistry } from "../flow-parser.js";
import { createGraphEngine } from "../graph-engine.js";
import {
  CASCADE_DEFAULTS,
  countCitations,
  evaluateCascadeSignals,
  parseCascadeConfig,
  shouldEscalate,
  topGroundingScore,
} from "../cascade.js";

describe("countCitations", () => {
  test("counts distinct [n], not occurrences", () => {
    expect(countCitations("Befund [1] und [2], nochmals [1].")).toBe(2);
    expect(countCitations("Kein Beleg.")).toBe(0);
    expect(countCitations("[12][12][3]")).toBe(2);
    expect(countCitations("Liste [a] und [1234] sind keine Zitate")).toBe(0);
  });
});

describe("evaluateCascadeSignals", () => {
  const good = { answer: "Befund [1].", sourcesCheckFailed: false, finishReasonLength: false, topScore: 0.9 };

  test("a cited, checked, complete answer stands", () => {
    expect(evaluateCascadeSignals(good)).toEqual([]);
    expect(shouldEscalate([])).toBe(false);
  });

  test("fewer citations than minCitations escalates (default 1)", () => {
    expect(evaluateCascadeSignals({ ...good, answer: "Ohne Beleg." })).toEqual(["citations 0 < 1"]);
    expect(evaluateCascadeSignals({ ...good, answer: "Befund [1]." }, { minCitations: 2 })).toEqual(["citations 1 < 2"]);
    expect(evaluateCascadeSignals({ ...good, answer: "Ohne Beleg." }, { minCitations: 0 })).toEqual([]);
    expect(CASCADE_DEFAULTS.minCitations).toBe(1);
  });

  test("a failed sources check escalates unless switched off", () => {
    expect(evaluateCascadeSignals({ ...good, sourcesCheckFailed: true })).toEqual(["sources_check_failed"]);
    expect(evaluateCascadeSignals({ ...good, sourcesCheckFailed: true }, { sourcesCheckFailed: false })).toEqual([]);
  });

  test("a weak top score escalates only when maxTopScore is set and a score exists", () => {
    expect(evaluateCascadeSignals({ ...good, topScore: 0.2 })).toEqual([]);
    expect(evaluateCascadeSignals({ ...good, topScore: 0.2 }, { maxTopScore: 0.35 })).toEqual(["top_score 0.2 < 0.35"]);
    expect(evaluateCascadeSignals({ ...good, topScore: 0.35 }, { maxTopScore: 0.35 })).toEqual([]);
    expect(evaluateCascadeSignals({ ...good, topScore: undefined }, { maxTopScore: 0.35 })).toEqual([]);
  });

  test("a length cut-off escalates unless switched off", () => {
    expect(evaluateCascadeSignals({ ...good, finishReasonLength: true })).toEqual(["finish_reason_length"]);
    expect(evaluateCascadeSignals({ ...good, finishReasonLength: true }, { finishReasonLength: false })).toEqual([]);
  });

  test("every reason that holds is reported", () => {
    const reasons = evaluateCascadeSignals(
      { answer: "x", sourcesCheckFailed: true, finishReasonLength: true, topScore: 0.1 },
      { maxTopScore: 0.5 },
    );
    expect(reasons).toHaveLength(4);
    expect(shouldEscalate(reasons)).toBe(true);
  });
});

describe("topGroundingScore", () => {
  const citation = (similarity_score: number) => ({ title: "t", url: "u", snippet: "s", similarity_score });
  test("is the best score over the registered sources", () => {
    const sources = [citation(0.4), citation(0.9), citation(0.6)];
    expect(topGroundingScore((index) => sources[index - 1])).toBe(0.9);
  });
  test("is undefined without a registry or without sources", () => {
    expect(topGroundingScore(undefined)).toBeUndefined();
    expect(topGroundingScore(() => undefined)).toBeUndefined();
  });
});

describe("parseCascadeConfig", () => {
  const model = { provider: "openai", model: "pro" };
  test("returns the usable config", () => {
    expect(parseCascadeConfig({ cascade: { escalateTo: model, when: { minCitations: 2 } } })).toEqual({
      escalateTo: model,
      when: { minCitations: 2 },
    });
    expect(parseCascadeConfig({ cascade: { escalateTo: model } })).toEqual({ escalateTo: model });
  });
  test("ignores a missing, empty or unresolved config", () => {
    expect(parseCascadeConfig(undefined)).toBeUndefined();
    expect(parseCascadeConfig({})).toBeUndefined();
    expect(parseCascadeConfig({ cascade: {} })).toBeUndefined();
    expect(parseCascadeConfig({ cascade: { escalateTo: { shortcut: "pro" } } })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Engine behaviour with scripted models
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
  llmRetryBackoffMs: 0,
  defaultLlm: { provider: "openai", model: "default-model" },
};

const SEARCH_PAYLOAD = JSON.stringify({
  results: [
    { id: "a1", base_ref: "/akte/A", title: "Doc A", content: "Passage A.", score: 0.7 },
    { id: "b1", base_ref: "/akte/B", title: "Doc B", content: "Passage B.", score: 0.5 },
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

/** One native search call first, then the scripted answer text. */
function scriptedModel(answer: string, finish: "stop" | "length" = "stop") {
  let calls = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const index = calls++;
      return {
        stream: new ReadableStream({
          start(controller: ReadableStreamDefaultController<unknown>) {
            if (index === 0) {
              controller.enqueue({ type: "tool-call", toolCallId: "call-1", toolName: "kb__search", input: "{}" });
              controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls" as const, raw: "tool_calls" }, usage });
            } else {
              controller.enqueue({ type: "text-start", id: "t" });
              for (let i = 0; i < answer.length; i += 7) {
                controller.enqueue({ type: "text-delta", id: "t", delta: answer.slice(i, i + 7) });
              }
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({ type: "finish", finishReason: { unified: finish, raw: finish }, usage });
            }
            controller.close();
          },
        }),
      } as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult;
    },
  });
}

interface Scenario {
  flash: string;
  pro: string;
  flashFinish?: "stop" | "length";
  config?: Record<string, unknown>;
  noCascade?: boolean;
}

async function run(s: Scenario, executionId: string) {
  const used: string[] = [];
  const cascade = { escalateTo: { provider: "openai", model: "pro" }, ...(s.config?.cascade as object | undefined) };
  const flow: FlowDefinition = {
    id: "cascade-flow",
    name: "Cascade",
    nodes: [
      {
        id: "llm-1",
        type: "llm",
        llm: { provider: "openai", model: "flash" },
        tools: ["kb/search"],
        config: { maxToolSteps: 2, ...s.config, ...(s.noCascade ? {} : { cascade }) },
      },
    ],
    edges: [],
  } as unknown as FlowDefinition;
  const map = new Map([[flow.id, flow]]);
  const registry: FlowRegistry = { get: (id) => map.get(id), list: () => [...map.values()] };
  const engine = createGraphEngine(baseConfig, {
    flowRegistry: registry,
    mcpWrapper: mcp,
    llmProviderFactory: (cfg) => {
      used.push(cfg.model);
      return cfg.model === "pro" ? scriptedModel(s.pro) : scriptedModel(s.flash, s.flashFinish);
    },
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
  const content = chunks
    .map((chunk) => chunk.choices[0]?.delta.content)
    .filter((text): text is string => typeof text === "string")
    .join("");
  const node = debugStore.getTrace(executionId)?.nodes.find((entry) => entry.node_id === "llm-1");
  return {
    used,
    content,
    node,
    escalation: node?.diagnostics?.find((d) => d.code === "cascade_escalated"),
  };
}

describe("LLM node cascade (engine)", () => {
  test("an answer without a citation is regenerated by the stronger model; the weak text never reaches the client", async () => {
    const r = await run({ flash: "Eine Behauptung ganz ohne Beleg.", pro: "Belegter Befund [1][2]." }, "exec-cascade-a");
    expect(r.content).toBe("Belegter Befund [1][2].");
    expect(r.content).not.toContain("ohne Beleg");
    expect(r.node?.full_response).toBe("Belegter Befund [1][2].");
    expect(r.escalation?.level).toBe("info");
    expect(r.escalation?.details).toMatchObject({
      reasons: ["citations 0 < 1"],
      first_model: "openai/flash",
      final_model: "openai/pro",
    });
    expect(r.used.filter((m) => m === "pro")).toHaveLength(1);
    expect(r.node?.status).toBe("completed");
  });

  test("an answer with two citations stays; the stronger model is never built", async () => {
    const r = await run({ flash: "Guter Befund [1][2].", pro: "SOLLTE NICHT KOMMEN" }, "exec-cascade-b");
    expect(r.content).toBe("Guter Befund [1][2].");
    expect(r.escalation).toBeUndefined();
    expect(r.used).not.toContain("pro");
  });

  test("the held answer is released in order, token by token content intact", async () => {
    const answer = "Ein längerer Befund mit mehreren Teilen [1] und [2] bis zum Ende.";
    const r = await run({ flash: answer, pro: "x" }, "exec-cascade-order");
    expect(r.content).toBe(answer);
  });

  test("a failed sources check escalates even with citations present", async () => {
    const r = await run(
      {
        flash: "Befund [2] und [7].",
        pro: "Sauberer Befund [1][2].",
        config: { suppressToolPreamble: true, sourcesCheck: { completeSection: true } },
      },
      "exec-cascade-c",
    );
    expect(r.escalation?.details).toMatchObject({ reasons: ["sources_check_failed"] });
    // The escalated attempt is checked too: it gets its sources section completed.
    expect(r.content.startsWith("Sauberer Befund [1][2].")).toBe(true);
    expect(r.content).not.toContain("[7]");
  });

  test("an answer cut off for length escalates", async () => {
    const r = await run({ flash: "Abgebrochener Befund [1]", flashFinish: "length", pro: "Vollständiger Befund [1][2]." }, "exec-cascade-d");
    expect(r.escalation?.details).toMatchObject({ reasons: ["finish_reason_length"] });
    expect(r.content).toBe("Vollständiger Befund [1][2].");
    expect(r.node?.diagnostics?.some((d) => d.code === "llm_output_length_limit")).toBe(true);
  });

  test("maxTopScore escalates only when the best source is weaker", async () => {
    const weak = await run(
      { flash: "Befund [1][2].", pro: "Stärker [1][2].", config: { cascade: { when: { maxTopScore: 0.8 } } } },
      "exec-cascade-e1",
    );
    expect(weak.escalation?.details?.reasons).toEqual(["top_score 0.7 < 0.8"]);
    const strong = await run(
      { flash: "Befund [1][2].", pro: "Stärker [1][2].", config: { cascade: { when: { maxTopScore: 0.6 } } } },
      "exec-cascade-e2",
    );
    expect(strong.escalation).toBeUndefined();
    expect(strong.content).toBe("Befund [1][2].");
  });

  test("minCitations 0 and the other defaults off switch the cascade off in effect", async () => {
    const r = await run(
      {
        flash: "Ohne Beleg.",
        pro: "x",
        config: { cascade: { when: { minCitations: 0, sourcesCheckFailed: false, finishReasonLength: false } } },
      },
      "exec-cascade-f",
    );
    expect(r.escalation).toBeUndefined();
    expect(r.content).toBe("Ohne Beleg.");
  });

  test("a node without cascade behaves as before", async () => {
    const r = await run({ flash: "Ohne Beleg.", pro: "x", noCascade: true }, "exec-cascade-g");
    expect(r.content).toBe("Ohne Beleg.");
    expect(r.escalation).toBeUndefined();
    expect(r.used).not.toContain("pro");
  });
});

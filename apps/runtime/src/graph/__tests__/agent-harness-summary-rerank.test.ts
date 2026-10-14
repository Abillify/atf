// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Harness integration of the reranker-backed summary triage: the one-time
 * rerank pass runs between the coverage seed and the first staged assignment,
 * reports its outcome as a trace diagnostic and a reasoning status line, and
 * falls back to full LLM triage in ledger order whenever the reranker is
 * missing or fails.
 */
import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { MockLanguageModelV3 } from "ai/test";
import type { AppConfig } from "../../config/index.js";
import type { FlowNode } from "../../types/flow.js";
import type { ToolResultEntry } from "../../types/monitoring.js";
import { createAgentHarnessNodeHandler } from "../agent-harness.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import { RerankError, type Reranker } from "../reranker.js";

const SOURCE = "vectorsearch/get_summaries";
const N = 30;
const LONG =
  "Ausführliche Zusammenfassung mit genug Inhalt, um als belastbare Summary zu gelten — deutlich über achtzig Zeichen.";
const ref = (i: number) => `/Ordner/Dokument-${String(i).padStart(3, "0")}.pdf/0`;

const seed: ToolResultEntry = {
  tool_call_id: "seed",
  tool_name: SOURCE,
  result: {
    summaries: Array.from({ length: N }, (_, i) => ({
      reference: ref(i),
      title: `Dokument ${i}`,
      summary: LONG,
    })),
    count: N,
    total: N,
  },
  execution_time_seconds: 0,
};

/** Score rises with the document number: Dokument 29 is the best match. */
const ascendingReranker = (): Reranker => ({
  rerank: async () => [],
  rerankOrThrow: async (_query, documents) =>
    documents.map((text, index) => {
      const i = Number(/Dokument (\d+)/.exec(text)?.[1] ?? 0);
      return { index, score: i >= 20 ? 0.5 + i / 100 : i >= 10 ? 0.02 : 0.0001 };
    }),
});

interface Diagnostic {
  code: string;
  level?: string;
  details?: Record<string, unknown>;
}

const harnessNode = (summaryTriage?: Record<string, unknown>): FlowNode =>
  ({
    id: "orchestrator",
    type: "agent-harness",
    llm: { provider: "openai", model: "test-model" },
    config: {
      allowlist: ["worker"],
      plannerless: true,
      maxIterations: 1,
      coverageQueue: {
        enabled: true,
        mode: "staged",
        sourceTool: SOURCE,
        batchSize: 5,
        assignmentCharBudget: 100000,
        searchDiscovery: { rounds: 1, maxAttemptsPerRound: 2, maxHitsPerPass: 5 },
        markers: { start: "<COVERAGE>", end: "</COVERAGE>" },
        ...(summaryTriage !== undefined ? { summaryTriage } : {}),
      },
    },
  }) as unknown as FlowNode;

async function run(node: FlowNode, reranker: Reranker | undefined) {
  const diagnostics: Diagnostic[] = [];
  const reasoning: string[] = [];
  const workerPrompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: JSON.stringify({ tasks: [] }) }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: undefined, reasoning: undefined },
      },
      warnings: [],
    }),
  });
  const runtime = {
    appConfig: {
      port: 3000,
      flowsDir: "./flows",
      monitoringTransport: "sse",
      mcpServers: [],
      corsOrigins: ["*"],
      monitoringAuthRequired: false,
      logLevel: "error",
      maxToolSteps: 5,
      maxConcurrentExecutions: 50,
    } as AppConfig,
    ctx: { ssoToken: "t", executionId: "exec-1" },
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    llmProviderFactory: () => model,
    onToken: async () => {},
    onReasoning: async (_nodeId: string, text: string) => {
      reasoning.push(text);
    },
    onToolCall: async () => {},
    onToolResult: async () => {},
    onNodeStart: () => {},
    onNodeEnd: async () => {},
    onNodeIo: () => {},
    onNodeDiagnostic: (_n: string, d: Diagnostic) => diagnostics.push(d),
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
      summary: () => ({}) as never,
    } as unknown as ExecRuntime["metrics"],
    costTracker: { record: () => {} },
    ...(reranker !== undefined ? { reranker } : {}),
  } as unknown as ExecRuntime;
  const registry = {
    get: (_type: string) => ({
      factory:
        (_target: FlowNode) =>
        async (state: AgentState): Promise<Partial<AgentState>> => {
          workerPrompts.push(
            state.messages
              .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
              .join("\n"),
          );
          return { messages: [new AIMessage("kein Report")] };
        },
    }),
  };
  const nodeMap = new Map<string, FlowNode>([
    ["orchestrator", node],
    ["worker", { id: "worker", type: "llm", llm: { provider: "openai", model: "m" } } as unknown as FlowNode],
  ]);
  const handler = createAgentHarnessNodeHandler(node, nodeMap, { registry });
  const state = {
    messages: [new HumanMessage("Gibt es einen NIO-Arbeitsplatz?")],
    context: { ssoToken: "t", executionId: "exec-1" },
    citations: [],
    toolResults: [seed],
    errors: [],
    turns: [],
  } as unknown as AgentState;
  const update = (await handler(state, {
    configurable: { runtime },
  } as LangGraphRunnableConfig)) as {
    harness?: {
      tasks: Array<{ coverageRefs?: string[]; coverageAssignmentMode?: string }>;
      coverage?: {
        documents: Array<{ ref: string; status: string; triageSource?: string; rerankRank?: number }>;
        summaryRerank?: Record<string, unknown>;
      };
    };
  };
  return { update, diagnostics, reasoning, workerPrompts };
}

const firstAssignmentRefs = (update: Awaited<ReturnType<typeof run>>["update"]) =>
  update.harness?.tasks[0]?.coverageRefs;

const summaryDiagnostics = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((d) => d.code.startsWith("summary_triage_rerank"));

describe("agent-harness summary rerank", () => {
  test("(a) hybrid + reranker: first assignment holds only gray-zone refs in rank order", async () => {
    const { update, diagnostics, reasoning, workerPrompts } = await run(
      harnessNode({ mode: "hybrid" }),
      ascendingReranker(),
    );
    // N=30: acceptCut 3 (docs 29, 28, 27), excludeCut 11; docs 0–9 (score
    // 0.0001, ranks 21–30) are excluded; docs 26..10 form the gray zone.
    expect(firstAssignmentRefs(update)).toEqual([26, 25, 24, 23, 22].map(ref));
    expect(workerPrompts[0]).toContain(ref(26));
    expect(workerPrompts[0]).not.toContain(ref(29));
    const [diagnostic] = summaryDiagnostics(diagnostics);
    expect(diagnostic).toMatchObject({
      code: "summary_triage_rerank_scored",
      level: "info",
      details: { mode: "hybrid", accepted: 3, excluded: 10, gray: 17, document_count: 30 },
    });
    const documents = update.harness?.coverage?.documents ?? [];
    expect(documents.find((d) => d.ref === ref(29))).toMatchObject({
      status: "summary-reviewed",
      triageSource: "rerank",
      rerankRank: 1,
    });
    expect(documents.find((d) => d.ref === ref(0))).toMatchObject({
      status: "excluded",
      triageSource: "rerank",
    });
    expect(update.harness?.coverage?.summaryRerank).toMatchObject({ status: "scored" });
    expect(reasoning.some((line) => line.startsWith("Summary rerank: 30 scored"))).toBe(true);
  });

  test("(b) hybrid + failing reranker: ledger order, fallback diagnostic, nothing excluded", async () => {
    const failing: Reranker = {
      rerank: async () => [],
      rerankOrThrow: async () => {
        throw new RerankError("http", "HTTP 422", { status: 422, batchIndex: 1 });
      },
    };
    const { update, diagnostics, reasoning } = await run(harnessNode({ mode: "hybrid" }), failing);
    expect(firstAssignmentRefs(update)).toEqual([0, 1, 2, 3, 4].map(ref));
    const [diagnostic] = summaryDiagnostics(diagnostics);
    expect(diagnostic).toMatchObject({
      code: "summary_triage_rerank_fallback",
      level: "warn",
      details: { reason: "reranker_error", status: 422 },
    });
    expect(
      (update.harness?.coverage?.documents ?? []).some((d) => d.status === "excluded"),
    ).toBe(false);
    expect(reasoning.some((line) => line.includes("all summaries go to LLM triage"))).toBe(true);
  });

  test("(c) llm (option absent) + reranker: score-ordered batches, no deterministic decisions", async () => {
    const { update, diagnostics } = await run(harnessNode(), ascendingReranker());
    expect(firstAssignmentRefs(update)).toEqual([29, 28, 27, 26, 25].map(ref));
    expect(summaryDiagnostics(diagnostics)[0]?.code).toBe("summary_triage_rerank_scored");
    const documents = update.harness?.coverage?.documents ?? [];
    expect(documents.every((d) => d.triageSource === undefined)).toBe(true);
    expect(documents.filter((d) => d.status !== "open")).toHaveLength(0);
  });

  test("(d) llm without reranker: behavior identical to the feature being absent", async () => {
    const { update, diagnostics, reasoning } = await run(harnessNode(), undefined);
    expect(firstAssignmentRefs(update)).toEqual([0, 1, 2, 3, 4].map(ref));
    expect(summaryDiagnostics(diagnostics)).toHaveLength(0);
    expect(update.harness?.coverage?.summaryRerank).toBeUndefined();
    expect(reasoning.some((line) => line.includes("Summary rerank"))).toBe(false);
  });

  test("(e) hybrid without reranker: reranker_not_configured, full LLM triage", async () => {
    const { update, diagnostics } = await run(harnessNode({ mode: "hybrid" }), undefined);
    expect(firstAssignmentRefs(update)).toEqual([0, 1, 2, 3, 4].map(ref));
    expect(summaryDiagnostics(diagnostics)[0]).toMatchObject({
      code: "summary_triage_rerank_fallback",
      details: { reason: "reranker_not_configured" },
    });
    expect(
      (update.harness?.coverage?.documents ?? []).every((d) => d.status === "open"),
    ).toBe(true);
  });

  test("(f) invalid summaryTriage config: summary_triage_config_invalid, mode llm", async () => {
    const { update, diagnostics } = await run(harnessNode({ mode: "bogus" }), undefined);
    const configDiagnostic = diagnostics.find(
      (d) => d.code === "summary_triage_config_invalid",
    );
    expect(configDiagnostic).toMatchObject({ level: "warn" });
    expect(String(configDiagnostic?.details?.error)).toContain("invalid mode 'bogus'");
    // Fallback is mode llm without reranker: no rerank diagnostic, ledger order.
    expect(summaryDiagnostics(diagnostics)).toHaveLength(0);
    expect(firstAssignmentRefs(update)).toEqual([0, 1, 2, 3, 4].map(ref));
  });
});

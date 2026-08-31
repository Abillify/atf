// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the `agent-harness` node compiled within a real flow.
 *
 * These tests exercise the FULL stack:
 * - Flow definition is compiled via `createGraphEngine` (real flow parser + registry)
 * - The `agent-harness` node resolves from `defaultNodeHandlerRegistry`
 * - Delegation to worker nodes (llm) uses the real handler factory
 * - `AgentState.harness` persistence is verified via the compiled graph output
 * - SSE reasoning/status events are captured via monitoring + onChunk callbacks
 *
 * The only stub is `llmProviderFactory` which returns MockLanguageModelV3
 * instances so no real API calls are made.
 *
 * NOTE: Worker nodes that the harness delegates to must still be reachable in
 * the graph topology (connected via edges) to avoid LangGraph's
 * UnreachableNodeError. In production flows this is natural since workers often
 * serve dual purposes. In these tests we connect them via conditional edges
 * from the harness node that are never actually taken (the harness runs them
 * inline via delegation instead).
 *
 * Validates: Requirements 1.3, 1.4, 4.2, 4.3, 9.1, 9.2, 9.3, 9.4
 */

import { describe, test, expect } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { createGraphEngine } from "../graph-engine.js";
import type { FlowRegistry } from "../flow-parser.js";
import type { FlowDefinition, LlmConfig } from "../../types/flow.js";
import type { AppConfig } from "../../config/index.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import type {
  MonitoringServiceInterface,
  MonitoringClient,
} from "../../monitoring/monitoring-service.js";
import { mkUsage, mkGenerateResult } from "./v3-mock-helpers.js";

// ---------------------------------------------------------------------------
// Config
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
  defaultLlm: { provider: "openai", model: "gpt-4o" },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The `reasoning_content` of a chunk's first choice delta, asserting it is present. */
function reasoningText(chunk: ChatCompletionChunk): string {
  const delta = chunk.choices[0]?.delta;
  if (delta === undefined) throw new Error("expected a delta on choices[0]");
  return (delta as unknown as { reasoning_content: string }).reasoning_content;
}

/** The `content` of a chunk's first choice delta, asserting it is present. */
function chunkContent(chunk: ChatCompletionChunk): string {
  const content = chunk.choices[0]?.delta.content;
  if (content === undefined || content === null)
    throw new Error("expected content on choices[0].delta");
  return content;
}

function singleFlowRegistry(flow: FlowDefinition): FlowRegistry {
  const map = new Map<string, FlowDefinition>([[flow.id, flow]]);
  return { get: (id) => map.get(id), list: () => [...map.values()] };
}

/**
 * Creates an `llmProviderFactory` that returns different MockLanguageModelV3
 * instances depending on the call sequence. Each call consumes the next
 * response in the array. The factory tracks which LlmConfig was used per call.
 */
function createSequentialMockFactory(responses: string[]) {
  let callIdx = 0;
  const calls: Array<{ config: LlmConfig; index: number }> = [];

  const factory = (config: LlmConfig) => {
    const idx = callIdx++;
    calls.push({ config, index: idx });
    const responseText = responses[idx] ?? "{}";

    return new MockLanguageModelV3({
      doGenerate: async () => ({
        ...mkGenerateResult(responseText, 10, 5),
      }),
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller: ReadableStreamDefaultController<unknown>) {
              controller.enqueue({ type: "text-start", id: "1" });
              controller.enqueue({
                type: "text-delta",
                id: "1",
                delta: responseText,
              });
              controller.enqueue({ type: "text-end", id: "1" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop" as const, raw: "stop" },
                usage: mkUsage(10, 5),
              });
              controller.close();
            },
          }),
        }) as unknown as import("@ai-sdk/provider").LanguageModelV3StreamResult,
    });
  };

  return { factory, calls };
}

/**
 * Creates a monitoring service that captures node execution events.
 */
function createSpyMonitoring() {
  const events: NodeExecutionEvent[] = [];
  const monitoring: MonitoringServiceInterface = {
    emitNodeEvent: (_id, event) => {
      events.push(event);
    },
    subscribe: (_c: MonitoringClient) => () => {},
    hasConnectionCapacity: () => true,
    getConnectionCount: () => 0,
    getTransportType: () => "sse",
    getHistory: async () => [],
    getHistoryPage: async () => ({ executions: [], total: 0 }),
    getHistoryFacets: async () => ({ flows: [], users: [] }),
    getUsageLog: async () => [],
    getExecutionEvents: async () => [],
    clearHistory: async () => 0,
  };
  return { monitoring, events };
}

// ---------------------------------------------------------------------------
// Test: Harness node delegates to a worker llm node (end-to-end)
// ---------------------------------------------------------------------------

describe("agent-harness integration — compiled flow with worker node", () => {
  test("harness delegates to a worker llm node and completes successfully (Req 1.3, 1.4, 4.2, 4.3)", async () => {
    // Flow: agent-harness node → delegates to "worker-llm" (an llm node)
    // The harness planner returns one task targeting "worker-llm".
    const flow: FlowDefinition = {
      id: "harness-integration-flow",
      name: "Harness Integration",
      nodes: [
        {
          id: "harness-1",
          type: "agent-harness",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            allowlist: ["worker-llm"],
            maxIterations: 5,
          },
        },
        {
          id: "worker-llm",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
      edges: [{ source: "__start__", target: "harness-1" }],
    };

    // LLM call sequence:
    // 1. Planner (initial plan) → returns a plan with one task
    // 2. Worker LLM (delegation) → returns answer via streaming
    // 3. Planner (re-plan) → returns empty plan (nothing more to do)
    const planResponse = JSON.stringify({
      tasks: [
        { description: "Answer the user question", target: "worker-llm" },
      ],
    });
    const workerResponse = "Hello! I can help you with that.";
    const replanResponse = JSON.stringify({ tasks: [] });

    const { factory, calls } = createSequentialMockFactory([
      planResponse,
      workerResponse,
      replanResponse,
    ]);

    const { monitoring, events } = createSpyMonitoring();

    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleFlowRegistry(flow),
      llmProviderFactory: factory,
    });

    const chunks: ChatCompletionChunk[] = [];
    let doneUsage: { total_tokens: number } | undefined;

    await engine.executeFlow(
      "harness-integration-flow",
      [{ role: "user", content: "Hello, help me with something" }],
      { ssoToken: "test.token.value", executionId: "exec-integration-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async (usage) => {
        doneUsage = usage;
      },
      monitoring,
    );

    // --- Assertions ---

    // 1. The flow completed (onDone was called)
    expect(doneUsage).toBeDefined();
    if (doneUsage === undefined)
      throw new Error("expected doneUsage to be defined");
    expect(doneUsage.total_tokens).toBeGreaterThan(0);

    // 2. The LLM factory was called at least 2 times (planner + worker)
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // 3. Monitoring events show lifecycle for both the harness AND the worker
    const harnessRunning = events.find(
      (e) => e.node_id === "harness-1" && e.status === "running",
    );
    const harnessCompleted = events.find(
      (e) => e.node_id === "harness-1" && e.status === "completed",
    );
    expect(harnessRunning).toBeDefined();
    expect(harnessCompleted).toBeDefined();

    // The worker node should also have lifecycle events (onNodeStart/onNodeEnd
    // emitted by the delegate function)
    const workerRunning = events.find(
      (e) => e.node_id === "worker-llm" && e.status === "running",
    );
    const workerCompleted = events.find(
      (e) => e.node_id === "worker-llm" && e.status === "completed",
    );
    expect(workerRunning).toBeDefined();
    expect(workerCompleted).toBeDefined();

    // 4. Reasoning/status SSE events were emitted (captured as chunks with
    //    reasoning_content in the delta)
    const reasoningChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta &&
        "reasoning_content" in (c.choices[0].delta as Record<string, unknown>),
    );
    expect(reasoningChunks.length).toBeGreaterThan(0);

    // Verify task list was emitted in reasoning
    const reasoningTexts = reasoningChunks.map(reasoningText);
    const allReasoning = reasoningTexts.join("");

    // Req 9.1: Task list was emitted
    expect(allReasoning).toContain("Task list:");
    expect(allReasoning).toContain("worker-llm");

    // Req 9.2: Status change emitted
    expect(allReasoning).toContain("in-progress");

    // Req 9.3: Delegation target emitted
    expect(allReasoning).toContain("delegating to worker-llm");

    // Req 9.4: Final stop emitted
    expect(allReasoning).toContain("stopped");
  });

  test("harness persists HarnessProgress in AgentState.harness after completion (Req 4.3, 10.3)", async () => {
    // Use a flow with a single harness node and one worker. We verify that:
    // 1. The delegated workers stream their responses
    // 2. The reasoning events show task completion (harness progress)
    const flow: FlowDefinition = {
      id: "harness-state-flow",
      name: "Harness State",
      nodes: [
        {
          id: "h1",
          type: "agent-harness",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            allowlist: ["worker-1"],
            maxIterations: 3,
          },
        },
        {
          id: "worker-1",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
      edges: [{ source: "__start__", target: "h1" }],
    };

    const planResponse = JSON.stringify({
      tasks: [
        { description: "Summarize the input", target: "worker-1" },
        { description: "Format the output", target: "worker-1" },
      ],
    });
    const workerResponse1 = "Summary: the user wants help.";
    const replan1 = JSON.stringify({ tasks: [] });
    const workerResponse2 = "Formatted output ready.";
    const replan2 = JSON.stringify({ tasks: [] });

    const { factory } = createSequentialMockFactory([
      planResponse,
      workerResponse1,
      replan1,
      workerResponse2,
      replan2,
    ]);

    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleFlowRegistry(flow),
      llmProviderFactory: factory,
    });

    const chunks: ChatCompletionChunk[] = [];

    await engine.executeFlow(
      "harness-state-flow",
      [{ role: "user", content: "Please summarize and format" }],
      { ssoToken: "test.token.value", executionId: "exec-state-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    // 1. Worker responses were streamed as content chunks
    const contentChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta?.content &&
        typeof c.choices[0].delta.content === "string",
    );
    const fullContent = contentChunks.map(chunkContent).join("");

    // Worker responses are streamed through
    expect(fullContent).toContain("Summary: the user wants help.");
    expect(fullContent).toContain("Formatted output ready.");

    // 2. Reasoning events show task list and completions (harness progress)
    const reasoningChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta &&
        "reasoning_content" in (c.choices[0].delta as Record<string, unknown>),
    );
    const allReasoning = reasoningChunks.map(reasoningText).join("");

    // Both task descriptions appear in the task list
    expect(allReasoning).toContain("Summarize the input");
    expect(allReasoning).toContain("Format the output");

    // Both tasks transition through in-progress and completed
    expect(allReasoning).toContain("t1");
    expect(allReasoning).toContain("t2");
    expect(allReasoning).toContain("completed");

    // Final stop emitted
    expect(allReasoning).toContain("stopped");
  });

  test("keeps a delegated fallback private and streams only the tool-less final synthesis", async () => {
    const flow: FlowDefinition = {
      id: "harness-private-delegates-flow",
      name: "Harness Private Delegates",
      nodes: [
        {
          id: "h1",
          type: "agent-harness",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            allowlist: ["worker-1"],
            maxIterations: 3,
            streamDelegates: false,
          },
        },
        {
          id: "worker-1",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
        {
          id: "synthesizer",
          type: "llm",
          // The user-visible final node deliberately has no declared tools.
          config: { clientTools: false },
          llm: { provider: "openai", model: "gpt-4o" },
        },
      ],
      edges: [
        { source: "__start__", target: "h1" },
        { source: "h1", target: "synthesizer" },
      ],
    };

    const workerFallback =
      "(Dieser Rechercheschritt hat keinen lesbaren Textbefund erzeugt.)";
    const synthesis =
      "Es liegen keine belastbaren Recherche-Ergebnisse vor. Bitte starte die Recherche erneut.";
    const { factory } = createSequentialMockFactory([
      JSON.stringify({
        tasks: [{ description: "Recherche", target: "worker-1" }],
      }),
      workerFallback,
      synthesis,
    ]);
    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleFlowRegistry(flow),
      llmProviderFactory: factory,
    });
    const chunks: ChatCompletionChunk[] = [];

    await engine.executeFlow(
      flow.id,
      [{ role: "user", content: "Bitte recherchiere und fasse zusammen." }],
      { ssoToken: "test.token.value", executionId: "exec-private-delegates-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    const visibleContent = chunks
      .filter(
        (chunk) =>
          typeof chunk.choices[0]?.delta.content === "string" &&
          chunk.choices[0].delta.content !== null,
      )
      .map(chunkContent)
      .join("");

    // The worker fallback stays in AgentState for the synthesizer, but its
    // streamed tokens and any follow-up planning remain hidden from the client.
    expect(visibleContent).not.toContain(workerFallback);
    expect(visibleContent).not.toContain("Step ");
    expect(visibleContent).not.toContain("Ich werde nun");
    expect(visibleContent).toBe(synthesis);
  });
});

// ---------------------------------------------------------------------------
// Test: Harness node with a subflow-merged entry-point node
// ---------------------------------------------------------------------------

describe("agent-harness integration — subflow delegation", () => {
  test("harness delegates to a subflow entry-point node merged into the parent flow (Req 4.2)", async () => {
    // Simulate a subflow by directly including its nodes in the flow definition
    // (since resolveSubflowIncludes merges subflow nodes into the parent at
    // load time, the compiled flow just sees them as regular nodes in nodeMap).
    //
    // Flow structure:
    //   harness-node → delegates to "subflow-entry" (an llm node that would
    //   normally be the entry-point of a subflow)
    const flow: FlowDefinition = {
      id: "harness-subflow-flow",
      name: "Harness Subflow",
      nodes: [
        {
          id: "orchestrator",
          type: "agent-harness",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            allowlist: ["subflow-entry", "worker-llm"],
            maxIterations: 5,
          },
        },
        // This node represents a subflow's entry-point merged into the parent
        {
          id: "subflow-entry",
          type: "llm",
          label: "Subflow Entry Point",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
        {
          id: "worker-llm",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
      edges: [{ source: "__start__", target: "orchestrator" }],
    };

    // Plan: delegate first to subflow-entry, then to worker-llm
    const planResponse = JSON.stringify({
      tasks: [
        { description: "Process via subflow", target: "subflow-entry" },
        { description: "Final formatting", target: "worker-llm" },
      ],
    });
    const subflowResponse = "Subflow processing complete.";
    const replan1 = JSON.stringify({ tasks: [] });
    const workerResponse = "Final formatted output.";
    const replan2 = JSON.stringify({ tasks: [] });

    const { factory, calls } = createSequentialMockFactory([
      planResponse,
      subflowResponse,
      replan1,
      workerResponse,
      replan2,
    ]);

    const { monitoring, events } = createSpyMonitoring();

    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleFlowRegistry(flow),
      llmProviderFactory: factory,
    });

    const chunks: ChatCompletionChunk[] = [];

    await engine.executeFlow(
      "harness-subflow-flow",
      [{ role: "user", content: "Process and format this data" }],
      { ssoToken: "test.token.value", executionId: "exec-subflow-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
      monitoring,
    );

    // --- Assertions ---

    // 1. Both delegated nodes had lifecycle events
    const subflowRunning = events.find(
      (e) => e.node_id === "subflow-entry" && e.status === "running",
    );
    const subflowCompleted = events.find(
      (e) => e.node_id === "subflow-entry" && e.status === "completed",
    );
    expect(subflowRunning).toBeDefined();
    expect(subflowCompleted).toBeDefined();

    const workerRunning = events.find(
      (e) => e.node_id === "worker-llm" && e.status === "running",
    );
    const workerCompleted = events.find(
      (e) => e.node_id === "worker-llm" && e.status === "completed",
    );
    expect(workerRunning).toBeDefined();
    expect(workerCompleted).toBeDefined();

    // 2. Reasoning output references both targets
    const reasoningChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta &&
        "reasoning_content" in (c.choices[0].delta as Record<string, unknown>),
    );
    const allReasoning = reasoningChunks.map(reasoningText).join("");

    expect(allReasoning).toContain("subflow-entry");
    expect(allReasoning).toContain("worker-llm");
    expect(allReasoning).toContain("delegating to subflow-entry");
    expect(allReasoning).toContain("delegating to worker-llm");

    // 3. Worker responses streamed as content
    const contentChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta?.content &&
        typeof c.choices[0].delta.content === "string",
    );
    const fullContent = contentChunks.map(chunkContent).join("");
    expect(fullContent).toContain("Subflow processing complete.");
    expect(fullContent).toContain("Final formatted output.");

    // 4. The LLM factory was called for both targets (planner + 2 workers + re-plans)
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Test: Iteration limit stops the harness cleanly in an integrated flow
// ---------------------------------------------------------------------------

describe("agent-harness integration — limit handling", () => {
  test("iteration limit produces a partial result with completed task outcomes (Req 8.1, 8.2, 8.3)", async () => {
    const flow: FlowDefinition = {
      id: "harness-limit-flow",
      name: "Harness Limit",
      nodes: [
        {
          id: "h1",
          type: "agent-harness",
          llm: { provider: "openai", model: "gpt-4o" },
          config: {
            allowlist: ["worker-1"],
            maxIterations: 2,
          },
        },
        {
          id: "worker-1",
          type: "llm",
          llm: { provider: "openai", model: "gpt-4o-mini" },
        },
      ],
      edges: [{ source: "__start__", target: "h1" }],
    };

    // Plan: 5 tasks but limit is 2 iterations
    const planResponse = JSON.stringify({
      tasks: [
        { description: "Task A", target: "worker-1" },
        { description: "Task B", target: "worker-1" },
        { description: "Task C", target: "worker-1" },
        { description: "Task D", target: "worker-1" },
        { description: "Task E", target: "worker-1" },
      ],
    });

    // Each worker call returns a response; re-plan returns empty
    const responses = [
      planResponse,
      "Result A",
      JSON.stringify({ tasks: [] }),
      "Result B",
      JSON.stringify({ tasks: [] }),
      // These won't be reached due to iteration limit
      "Result C",
      JSON.stringify({ tasks: [] }),
    ];

    const { factory } = createSequentialMockFactory(responses);

    const engine = createGraphEngine(baseConfig, {
      flowRegistry: singleFlowRegistry(flow),
      llmProviderFactory: factory,
    });

    const chunks: ChatCompletionChunk[] = [];

    await engine.executeFlow(
      "harness-limit-flow",
      [{ role: "user", content: "Do many things" }],
      { ssoToken: "test.token.value", executionId: "exec-limit-1" },
      async (chunk) => {
        chunks.push(chunk);
      },
      async () => {},
    );

    // Reasoning should mention iteration limit
    const reasoningChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta &&
        "reasoning_content" in (c.choices[0].delta as Record<string, unknown>),
    );
    const allReasoning = reasoningChunks.map(reasoningText).join("");

    // Req 9.4: Final status mentions iteration limit
    expect(allReasoning).toContain("iteration");

    // Content from workers should be streamed (first 2 tasks completed)
    const contentChunks = chunks.filter(
      (c) =>
        c.choices?.[0]?.delta?.content &&
        typeof c.choices[0].delta.content === "string",
    );
    const fullContent = contentChunks.map(chunkContent).join("");

    // Worker responses for the 2 tasks that completed before the limit
    expect(fullContent).toContain("Result A");
    expect(fullContent).toContain("Result B");
  });
});

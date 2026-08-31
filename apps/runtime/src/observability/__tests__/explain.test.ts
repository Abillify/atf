// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the Decision-Provenance Explainability Card aggregator
 * (`src/observability/explain.ts`).
 */

import { describe, it, expect } from "bun:test";
import {
  buildExplainCard,
  renderExplainCardMarkdown,
  type ExplainHistorySource,
} from "../explain.js";
import type { ExecutionSummary } from "../../monitoring/execution-store.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";
import { InMemoryDebugTraceStore } from "../../monitoring/debug-trace-store.js";
import { InMemoryAuditLog } from "../audit-log.js";
import { createPiiVault, InMemoryPiiVaultStore } from "../../graph/pii-vault.js";

function makeHistory(
  summaries: ExecutionSummary[],
  events: Record<string, NodeExecutionEvent[]>,
): ExplainHistorySource {
  return {
    async listRecent(limit) {
      return summaries.slice(0, limit);
    },
    async listEvents(executionId) {
      return events[executionId] ?? [];
    },
  };
}

const baseEvent = (over: Partial<NodeExecutionEvent>): NodeExecutionEvent => ({
  execution_id: "exec-1",
  node_id: "router",
  status: "completed",
  start_time: "2026-01-01T00:00:00.000Z",
  end_time: "2026-01-01T00:00:01.000Z",
  latency_ms: 1000,
  ...over,
});

describe("buildExplainCard", () => {
  it("returns undefined when the execution has no recorded events", async () => {
    const history = makeHistory([], {});
    const card = await buildExplainCard({ history }, "unknown-exec");
    expect(card).toBeUndefined();
  });

  it("assembles the node path, models used, and routing decisions", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({
        node_id: "router",
        sequence: 1,
        routing_decision: {
          target: "responder",
          candidates: [
            { target: "responder", matched: true },
            { target: "fallback", matched: false },
          ],
        },
      }),
      baseEvent({
        node_id: "responder",
        sequence: 2,
        model: "openai/gpt-4o-mini",
        input_tokens: 100,
        output_tokens: 50,
        cost: 0.001,
      }),
    ];
    const summary: ExecutionSummary = {
      execution_id: "exec-1",
      flow_id: "my-flow",
      tenant_id: null,
      status: "completed",
      node_count: 2,
      error_count: 0,
      total_latency_ms: 2000,
      total_cost: 0.001,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:02.000Z",
      user_name: "alice",
      user_prompt: "hello",
    };
    const history = makeHistory([summary], { "exec-1": events });

    const card = await buildExplainCard({ history }, "exec-1");
    expect(card).toBeDefined();
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.flowId).toBe("my-flow");
    expect(card.status).toBe("completed");
    expect(card.steps).toHaveLength(2);
    expect(card.modelsUsed).toHaveLength(1);
    const firstModel = card.modelsUsed[0];
    if (firstModel === undefined) throw new Error("expected a first model");
    expect(firstModel.model).toBe("openai/gpt-4o-mini");
    expect(firstModel.inputTokens).toBe(100);
    expect(card.routingDecisions).toHaveLength(1);
    const firstRouting = card.routingDecisions[0];
    if (firstRouting === undefined) throw new Error("expected a first routing decision");
    expect(firstRouting.decision.target).toBe("responder");
    expect(card.totalCost).toBe(0.001);
    expect(card.userName).toBe("alice");
  });

  it("collapses the engine's running+terminal event pair into ONE step per node", async () => {
    // The engine emits a `running` event at node start and a terminal event at
    // the end (same node_id + sequence). The card must show one step per node,
    // preferring the terminal event's model/tokens/cost.
    const events: NodeExecutionEvent[] = [
      baseEvent({
        node_id: "responder",
        sequence: 1,
        status: "running",
        end_time: null,
        latency_ms: null,
      }),
      baseEvent({
        node_id: "responder",
        sequence: 1,
        status: "completed",
        model: "openai/gpt-4o-mini",
        input_tokens: 100,
        output_tokens: 50,
        cost: 0.001,
      }),
    ];
    const history = makeHistory([], { "exec-dup": events });
    const card = await buildExplainCard({ history }, "exec-dup");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.steps).toHaveLength(1);
    const firstStep = card.steps[0];
    if (firstStep === undefined) throw new Error("expected a first step");
    expect(firstStep.status).toBe("completed");
    expect(firstStep.model).toBe("openai/gpt-4o-mini");
    // Two distinct tool calls (different sequence) must stay separate.
    expect(card.status).toBe("completed");
  });

  it("keeps distinct nodes with different sequences as separate steps", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({ node_id: "search", kind: "tool", sequence: 1, status: "running", end_time: null, latency_ms: null }),
      baseEvent({ node_id: "search", kind: "tool", sequence: 1, status: "completed" }),
      baseEvent({ node_id: "search", kind: "tool", sequence: 2, status: "running", end_time: null, latency_ms: null }),
      baseEvent({ node_id: "search", kind: "tool", sequence: 2, status: "completed" }),
    ];
    const history = makeHistory([], { "exec-2tools": events });
    const card = await buildExplainCard({ history }, "exec-2tools");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.steps).toHaveLength(2);
  });

  it("derives status from events when no summary row exists", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({ node_id: "n1", status: "error", error_message: "boom" }),
    ];
    const history = makeHistory([], { "exec-2": events });
    const card = await buildExplainCard({ history }, "exec-2");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.status).toBe("error");
    const firstStep = card.steps[0];
    if (firstStep === undefined) throw new Error("expected a first step");
    expect(firstStep.errorMessage).toBe("boom");
  });

  it("flags debug_trace_unavailable when no debug trace store is given", async () => {
    const events: NodeExecutionEvent[] = [baseEvent({ node_id: "n1" })];
    const history = makeHistory([], { "exec-3": events });
    const card = await buildExplainCard({ history }, "exec-3");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.degraded.some((d) => d.startsWith("debug_trace_unavailable"))).toBe(
      true,
    );
  });

  it("overlays groundedness from the debug trace when available", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({ node_id: "responder", sequence: 1 }),
    ];
    const history = makeHistory([], { "exec-4": events });
    const debugTraceStore = new InMemoryDebugTraceStore();
    debugTraceStore.startTrace({
      execution_id: "exec-4",
      flow_id: "f",
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      context: {},
      input_messages: [],
      nodes: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      errors: [],
    });
    debugTraceStore.upsertNode("exec-4", {
      node_id: "responder",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      latency_ms: 1000,
      tool_calls: [],
      groundedness: {
        score: 0.4,
        passed: false,
        checked_sentences: 3,
        unsupported: [{ sentence: "unverified claim", support: 0.1 }],
      },
    });

    const card = await buildExplainCard({ history, debugTraceStore }, "exec-4");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.groundedness).toBeDefined();
    if (card.groundedness === undefined) throw new Error("expected groundedness to be defined");
    expect(card.groundedness.nodeId).toBe("responder");
    expect(card.groundedness.passed).toBe(false);
    expect(
      card.degraded.some((d) => d.startsWith("debug_trace_unavailable")),
    ).toBe(false);
  });

  it("picks the LOWEST-scoring node when multiple ran the groundedness gate", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({ node_id: "n1", sequence: 1 }),
      baseEvent({ node_id: "n2", sequence: 2 }),
    ];
    const history = makeHistory([], { "exec-5": events });
    const debugTraceStore = new InMemoryDebugTraceStore();
    debugTraceStore.startTrace({
      execution_id: "exec-5",
      flow_id: "f",
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      context: {},
      input_messages: [],
      nodes: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      errors: [],
    });
    for (const [id, score] of [["n1", 0.9], ["n2", 0.3]] as const) {
      debugTraceStore.upsertNode("exec-5", {
        node_id: id,
        status: "completed",
        started_at: "2026-01-01T00:00:00.000Z",
        finished_at: "2026-01-01T00:00:01.000Z",
        latency_ms: 1000,
        tool_calls: [],
        groundedness: {
          score,
          passed: score >= 0.7,
          checked_sentences: 2,
          unsupported: [],
        },
      });
    }
    const card = await buildExplainCard({ history, debugTraceStore }, "exec-5");
    if (card === undefined) throw new Error("expected card to be defined");
    if (card.groundedness === undefined) throw new Error("expected groundedness to be defined");
    expect(card.groundedness.nodeId).toBe("n2");
    expect(card.groundedness.score).toBe(0.3);
  });

  it("includes PII vault action summary when the vault tokenized anything", async () => {
    const events: NodeExecutionEvent[] = [baseEvent({ node_id: "n1" })];
    const history = makeHistory([], { "exec-6": events });
    const piiVault = createPiiVault(new InMemoryPiiVaultStore(), {
      enabled: true,
    });
    if (piiVault === undefined) throw new Error("expected piiVault to be defined");
    await piiVault.tokenize("exec-6", undefined, "contact a@b.com");

    const card = await buildExplainCard({ history, piiVault }, "exec-6");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.piiActions).toBeDefined();
    if (card.piiActions === undefined) throw new Error("expected piiActions to be defined");
    expect(card.piiActions.totalTokenized).toBe(1);
    expect(card.piiActions.byType.email).toBe(1);
  });

  it("filters audit entries to the ones targeting this execution", async () => {
    const events: NodeExecutionEvent[] = [baseEvent({ node_id: "n1" })];
    const history = makeHistory([], { "exec-7": events });
    const auditLog = new InMemoryAuditLog();
    auditLog.record({
      actor: "alice",
      action: "approvals.resolve",
      target: "exec-7",
      outcome: "success",
    });
    auditLog.record({
      actor: "bob",
      action: "flows.publish",
      target: "some-other-execution",
      outcome: "success",
    });

    const card = await buildExplainCard({ history, auditLog }, "exec-7");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.auditEntries).toHaveLength(1);
    const firstEntry = card.auditEntries[0];
    if (firstEntry === undefined) throw new Error("expected a first audit entry");
    expect(firstEntry.actor).toBe("alice");
  });

  it("overlays the objective-solver attempt trace from the debug trace's diagnostics", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({ node_id: "responder", sequence: 1 }),
    ];
    const history = makeHistory([], { "exec-obj": events });
    const debugTraceStore = new InMemoryDebugTraceStore();
    debugTraceStore.startTrace({
      execution_id: "exec-obj",
      flow_id: "f",
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      context: {},
      input_messages: [],
      nodes: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      errors: [],
    });
    debugTraceStore.upsertNode("exec-obj", {
      node_id: "responder",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      latency_ms: 1000,
      tool_calls: [],
      diagnostics: [
        {
          at: "2026-01-01T00:00:00.500Z",
          level: "info",
          code: "objective_solver_attempt",
          message: "Objective-driven routing selected google/gemini-2.0-flash.",
          details: {
            selected: "google/gemini-2.0-flash",
            satisfiedObjective: true,
            fallbackUsed: false,
            attempts: [
              { candidate: "google/gemini-2.0-flash", satisfied: true, clauses: [] },
            ],
          },
        },
      ],
    });

    const card = await buildExplainCard({ history, debugTraceStore }, "exec-obj");
    if (card === undefined) throw new Error("expected card to be defined");
    const step = card.steps[0];
    if (step === undefined) throw new Error("expected a first step");
    expect(step.objectiveSolver).toBeDefined();
    expect(step.objectiveSolver?.selected).toBe("google/gemini-2.0-flash");
    expect(step.objectiveSolver?.satisfiedObjective).toBe(true);
    expect(step.objectiveSolver?.fallbackUsed).toBe(false);
    expect(step.objectiveSolver?.attempts).toHaveLength(1);

    const md = renderExplainCardMarkdown(card);
    expect(md).toContain("objective-driven routing");
    expect(md).toContain("google/gemini-2.0-flash");
  });

  it("omits objectiveSolver when the node has other diagnostics but no objective_solver_attempt", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({ node_id: "responder", sequence: 1 }),
    ];
    const history = makeHistory([], { "exec-obj2": events });
    const debugTraceStore = new InMemoryDebugTraceStore();
    debugTraceStore.startTrace({
      execution_id: "exec-obj2",
      flow_id: "f",
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: null,
      context: {},
      input_messages: [],
      nodes: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      errors: [],
    });
    debugTraceStore.upsertNode("exec-obj2", {
      node_id: "responder",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      latency_ms: 1000,
      tool_calls: [],
      diagnostics: [
        {
          at: "2026-01-01T00:00:00.500Z",
          level: "warn",
          code: "fallback",
          message: "fell back to another model",
        },
      ],
    });

    const card = await buildExplainCard({ history, debugTraceStore }, "exec-obj2");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(card.steps[0]?.objectiveSolver).toBeUndefined();
  });

  it("flags audit_log_unconfigured when no audit log is passed", async () => {
    const events: NodeExecutionEvent[] = [baseEvent({ node_id: "n1" })];
    const history = makeHistory([], { "exec-8": events });
    const card = await buildExplainCard({ history }, "exec-8");
    if (card === undefined) throw new Error("expected card to be defined");
    expect(
      card.degraded.some((d) => d.startsWith("audit_log_unconfigured")),
    ).toBe(true);
  });
});

describe("renderExplainCardMarkdown", () => {
  it("renders a readable markdown document with all sections", async () => {
    const events: NodeExecutionEvent[] = [
      baseEvent({
        node_id: "responder",
        model: "openai/gpt-4o-mini",
        input_tokens: 10,
        output_tokens: 5,
        cost: 0.0001,
      }),
    ];
    const summary: ExecutionSummary = {
      execution_id: "exec-9",
      flow_id: "f",
      tenant_id: null,
      status: "completed",
      node_count: 1,
      error_count: 0,
      total_latency_ms: 1000,
      total_cost: 0.0001,
      started_at: "2026-01-01T00:00:00.000Z",
      finished_at: "2026-01-01T00:00:01.000Z",
      user_name: "alice",
      user_prompt: "hi",
    };
    const history = makeHistory([summary], { "exec-9": events });
    const card = await buildExplainCard({ history }, "exec-9");
    if (card === undefined) throw new Error("expected card to be defined");
    const md = renderExplainCardMarkdown(card);
    expect(md).toContain("# Decision-Provenance Card — exec-9");
    expect(md).toContain("## Execution path");
    expect(md).toContain("## Models used");
    expect(md).toContain("openai/gpt-4o-mini");
    expect(md).toContain("## Operator actions");
  });
});

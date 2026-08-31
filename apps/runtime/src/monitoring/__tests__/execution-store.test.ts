// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the in-memory execution audit/history store
 * (src/monitoring/execution-store.ts).
 */

import { describe, test, expect } from "bun:test";
import { InMemoryExecutionStore } from "../execution-store.js";
import type { NodeExecutionEvent } from "../../types/monitoring.js";

function ev(
  execId: string,
  nodeId: string,
  status: NodeExecutionEvent["status"],
  latency: number | null = 10,
): NodeExecutionEvent {
  return {
    execution_id: execId,
    node_id: nodeId,
    status,
    start_time: new Date().toISOString(),
    end_time: status === "running" ? null : new Date().toISOString(),
    latency_ms: status === "running" ? null : latency,
  };
}

describe("InMemoryExecutionStore", () => {
  test("rolls up node events into an execution summary", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e1", "n1", "running"), {
      flowId: "flow-x",
      tenantId: "acme",
    });
    store.recordEvent(ev("e1", "n1", "completed", 12));
    store.recordEvent(ev("e1", "n2", "running"));
    store.recordEvent(ev("e1", "n2", "completed", 8));

    const [summary] = await store.listRecent(10);
    expect(summary?.execution_id).toBe("e1");
    expect(summary?.flow_id).toBe("flow-x");
    expect(summary?.tenant_id).toBe("acme");
    expect(summary?.node_count).toBe(2);
    expect(summary?.error_count).toBe(0);
    expect(summary?.total_latency_ms).toBe(20);
    expect(summary?.status).toBe("completed");
  });

  test("accumulates a permanent per-request usage record", async () => {
    const store = new InMemoryExecutionStore();
    // Request boundary carries identity + prompt preview.
    store.recordEvent(
      {
        ...ev("u1", "__request__", "completed", 0),
        user_name: "Alice",
        user_id: "user-42",
        user_prompt: "How much does this cost?",
        flow_id: "billing-flow",
      },
      { flowId: "billing-flow", tenantId: "acme" },
    );
    // Two priced LLM nodes with tokens/model/cost.
    store.recordEvent({
      ...ev("u1", "classify", "completed", 30),
      model: "openai/gpt-4o-mini",
      input_tokens: 100,
      output_tokens: 20,
      cost: 0.001,
    });
    store.recordEvent({
      ...ev("u1", "respond", "completed", 70),
      model: "anthropic/claude-sonnet",
      input_tokens: 400,
      output_tokens: 150,
      cost: 0.012,
    });

    const [usage] = await store.listRecentUsage(10);
    expect(usage?.execution_id).toBe("u1");
    expect(usage?.flow_id).toBe("billing-flow");
    expect(usage?.tenant_id).toBe("acme");
    expect(usage?.user_id).toBe("user-42");
    expect(usage?.user_label).toBe("Alice");
    expect(usage?.prompt_preview).toBe("How much does this cost?");
    // Tokens summed across all priced nodes.
    expect(usage?.prompt_tokens).toBe(500);
    expect(usage?.completion_tokens).toBe(170);
    expect(usage?.total_tokens).toBe(670);
    // Cost summed; last model wins.
    expect(usage?.cost).toBeCloseTo(0.013, 6);
    expect(usage?.model).toBe("anthropic/claude-sonnet");
    // Duration = summed node latency of the boundary + two nodes.
    expect(usage?.duration_ms).toBe(100);
  });

  test("marks the execution as error when any node errors", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e2", "n1", "running"), { flowId: "f" });
    store.recordEvent(ev("e2", "n1", "error", 5));
    const [summary] = await store.listRecent(10);
    expect(summary?.status).toBe("error");
    expect(summary?.error_count).toBe(1);
  });

  test("lists most recent executions first", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("a", "n", "completed"), { flowId: "f" });
    store.recordEvent(ev("b", "n", "completed"), { flowId: "f" });
    const recent = await store.listRecent(10);
    expect(recent.map((e) => e.execution_id)).toEqual(["b", "a"]);
  });

  test("evicts the oldest execution past capacity", async () => {
    const store = new InMemoryExecutionStore(2);
    store.recordEvent(ev("a", "n", "completed"), { flowId: "f" });
    store.recordEvent(ev("b", "n", "completed"), { flowId: "f" });
    store.recordEvent(ev("c", "n", "completed"), { flowId: "f" });
    const recent = await store.listRecent(10);
    expect(recent.map((e) => e.execution_id)).toEqual(["c", "b"]);
  });

  test("returns the raw event trail for an execution", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e3", "n1", "running"), { flowId: "f" });
    store.recordEvent(ev("e3", "n1", "completed"));
    const events = await store.listEvents("e3");
    expect(events.length).toBe(2);
    expect(events[0]?.status).toBe("running");
  });
});

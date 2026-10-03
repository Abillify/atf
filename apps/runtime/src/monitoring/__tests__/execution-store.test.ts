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
    // The engine's terminal marker is what flips the execution status —
    // node completions alone must not (see FLOW_END_NODE_ID).
    store.recordEvent(ev("e1", "__flow_end__", "completed", 0));

    const [summary] = await store.listRecent(10);
    expect(summary?.execution_id).toBe("e1");
    expect(summary?.flow_id).toBe("flow-x");
    expect(summary?.tenant_id).toBe("acme");
    expect(summary?.node_count).toBe(2);
    expect(summary?.error_count).toBe(0);
    expect(summary?.total_latency_ms).toBe(20);
    expect(summary?.status).toBe("completed");
  });

  test("stays running until the terminal marker arrives", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e1b", "n1", "running"), { flowId: "flow-x" });
    store.recordEvent(ev("e1b", "n1", "completed", 12));
    store.recordEvent(ev("e1b", "n2", "running"));

    const [summary] = await store.listRecent(10);
    // A finished node inside a still-running multi-node flow must NOT report
    // the whole execution as completed — this was the "lying history" bug.
    expect(summary?.status).toBe("running");
    expect(summary?.finished_at).toBeNull();
    // Counters still roll forward honestly.
    expect(summary?.node_count).toBe(1);
    expect(summary?.total_latency_ms).toBe(12);

    store.recordEvent(ev("e1b", "n2", "completed", 8));
    store.recordEvent(ev("e1b", "__flow_end__", "completed", 0));
    const [done] = await store.listRecent(10);
    expect(done?.status).toBe("completed");
    expect(done?.finished_at).not.toBeNull();
  });

  test("the terminal marker is not counted as a node", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e1c", "n1", "completed", 5), { flowId: "f" });
    store.recordEvent(ev("e1c", "__flow_end__", "completed", 0));
    const [summary] = await store.listRecent(10);
    expect(summary?.node_count).toBe(1);
    expect(summary?.status).toBe("completed");
  });

  test("an error terminal marker flips the status to error", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e1d", "n1", "completed", 5), { flowId: "f" });
    store.recordEvent(ev("e1d", "__flow_end__", "error", 0));
    const [summary] = await store.listRecent(10);
    expect(summary?.status).toBe("error");
    // The marker itself is not a failed node.
    expect(summary?.error_count).toBe(0);
  });

  test("the response boundary flips status for non-flow requests", async () => {
    const store = new InMemoryExecutionStore();
    // Direct LLM request: no graph engine, so no __flow_end__ — the chat
    // route's __response__ boundary is the terminal marker.
    store.recordEvent(ev("e1e", "__request__", "completed", 0), {
      flowId: undefined,
    });
    let [summary] = await store.listRecent(10);
    expect(summary?.status).toBe("running");
    store.recordEvent(ev("e1e", "__response__", "completed", 0));
    [summary] = await store.listRecent(10);
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

  test("marks the execution as error when the flow ends on an error", async () => {
    const store = new InMemoryExecutionStore();
    store.recordEvent(ev("e2", "n1", "running"), { flowId: "f" });
    store.recordEvent(ev("e2", "n1", "error", 5));
    // The node failure is counted, but the execution is only terminal once
    // the engine seals the run — a flow that recovers from a node error
    // (errorStrategy) must not be reported as failed while it still runs.
    let [summary] = await store.listRecent(10);
    expect(summary?.status).toBe("running");
    expect(summary?.error_count).toBe(1);
    store.recordEvent(ev("e2", "__flow_end__", "error", 0));
    [summary] = await store.listRecent(10);
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

/** Build a completed execution with explicit start/finish, latency, cost, flow and user. */
function histExec(
  store: InMemoryExecutionStore,
  id: string,
  opts: {
    started: string;
    finished: string;
    latency: number;
    cost?: number;
    flow?: string;
    user?: string;
  },
): void {
  const base = {
    execution_id: id,
    node_id: "n1",
    status: "completed" as const,
    start_time: opts.started,
    end_time: opts.finished,
    latency_ms: opts.latency,
    user_name: opts.user,
  };
  store.recordEvent(
    { ...ev(id, "__request__", "completed", 0), start_time: opts.started, user_name: opts.user },
    { flowId: opts.flow ?? "f" },
  );
  store.recordEvent(
    opts.cost !== undefined ? { ...base, cost: opts.cost } : base,
  );
  // Terminal marker: without it the execution stays "running" and
  // finished_at is never set (see FLOW_END_NODE_ID).
  store.recordEvent(
    {
      ...ev(id, "__flow_end__", "completed", 0),
      start_time: opts.finished,
      end_time: opts.finished,
    },
    { flowId: opts.flow ?? "f" },
  );
}

describe("InMemoryExecutionStore.listHistory sorting", () => {
  function seeded(): InMemoryExecutionStore {
    const store = new InMemoryExecutionStore();
    histExec(store, "slow", {
      started: "2026-01-03T00:00:00Z",
      finished: "2026-01-03T00:00:09Z",
      latency: 9000,
      cost: 0.3,
      flow: "zeta",
      user: "Bob",
    });
    histExec(store, "fast", {
      started: "2026-01-01T00:00:00Z",
      finished: "2026-01-01T00:00:01Z",
      latency: 1000,
      cost: 0.1,
      flow: "alpha",
      user: "Carol",
    });
    histExec(store, "mid", {
      started: "2026-01-02T00:00:00Z",
      finished: "2026-01-02T00:00:05Z",
      latency: 5000,
      cost: 0.2,
      flow: "mid",
      user: "Alice",
    });
    return store;
  }

  const ids = (rows: { execution_id: string }[]) => rows.map((r) => r.execution_id);

  test("defaults to started_at desc (newest first)", async () => {
    const page = await seeded().listHistory({ limit: 10 });
    expect(ids(page.executions)).toEqual(["slow", "mid", "fast"]);
  });

  test("sorts by total_latency_ms asc", async () => {
    const page = await seeded().listHistory({
      limit: 10,
      sortColumn: "total_latency_ms",
      sortDir: "asc",
    });
    expect(ids(page.executions)).toEqual(["fast", "mid", "slow"]);
  });

  test("sorts by total_cost desc", async () => {
    const page = await seeded().listHistory({
      limit: 10,
      sortColumn: "total_cost",
      sortDir: "desc",
    });
    expect(ids(page.executions)).toEqual(["slow", "mid", "fast"]);
  });

  test("sorts by derived runtime (finished - started)", async () => {
    const page = await seeded().listHistory({
      limit: 10,
      sortColumn: "runtime",
      sortDir: "asc",
    });
    expect(ids(page.executions)).toEqual(["fast", "mid", "slow"]);
  });

  test("sorts flow_id and user_name alphabetically", async () => {
    const byFlow = await seeded().listHistory({
      limit: 10,
      sortColumn: "flow_id",
      sortDir: "asc",
    });
    expect(ids(byFlow.executions)).toEqual(["fast", "mid", "slow"]);
    const byUser = await seeded().listHistory({
      limit: 10,
      sortColumn: "user_name",
      sortDir: "asc",
    });
    expect(ids(byUser.executions)).toEqual(["mid", "slow", "fast"]);
  });

  test("sorting applies before pagination", async () => {
    const store = seeded();
    const page = await store.listHistory({
      limit: 2,
      offset: 1,
      sortColumn: "total_latency_ms",
      sortDir: "asc",
    });
    // Sorted asc = [fast, mid, slow]; window (offset 1, limit 2) = [mid, slow].
    expect(ids(page.executions)).toEqual(["mid", "slow"]);
    expect(page.total).toBe(3);
  });

  test("null values sort last in both directions", async () => {
    const store = seeded();
    // A still-running execution: no finished_at, no cost.
    store.recordEvent(
      { ...ev("running", "__request__", "completed", 0), start_time: "2026-01-04T00:00:00Z" },
      { flowId: "f" },
    );
    store.recordEvent({
      ...ev("running", "n1", "running"),
      start_time: "2026-01-04T00:00:00Z",
    });
    const asc = await store.listHistory({
      limit: 10,
      sortColumn: "total_cost",
      sortDir: "asc",
    });
    expect(ids(asc.executions).at(-1)).toBe("running");
    const desc = await store.listHistory({
      limit: 10,
      sortColumn: "total_cost",
      sortDir: "desc",
    });
    expect(ids(desc.executions).at(-1)).toBe("running");
  });
});

describe("historySortClause", () => {
  test("whitelists columns and never interpolates raw input", async () => {
    const { historySortClause, parseHistorySortColumn } = await import(
      "../execution-store.js"
    );
    expect(historySortClause({})).toBe(
      "ORDER BY started_at DESC NULLS LAST, started_at DESC",
    );
    expect(
      historySortClause({ sortColumn: "total_cost", sortDir: "asc" }),
    ).toBe("ORDER BY total_cost ASC NULLS LAST, started_at DESC");
    expect(
      historySortClause({ sortColumn: "runtime", sortDir: "desc" }),
    ).toBe(
      "ORDER BY (finished_at - started_at) DESC NULLS LAST, started_at DESC",
    );
    // Unknown / hostile column names are rejected by the parser.
    expect(parseHistorySortColumn("1; DROP TABLE executions")).toBeUndefined();
    expect(parseHistorySortColumn("started_at")).toBe("started_at");
    expect(parseHistorySortColumn("runtime")).toBe("runtime");
    expect(parseHistorySortColumn(undefined)).toBeUndefined();
  });
});

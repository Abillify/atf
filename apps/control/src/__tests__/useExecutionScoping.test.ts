// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for useExecutionScoping.
 *
 * Focuses on the scoping memo: displayEvents must be filtered to the
 * currently effective execution_id.
 *
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useExecutionScoping } from "../hooks/useExecutionScoping";
import type { NodeExecutionEvent } from "../types/monitoring";
import type { PersistedExecution } from "../types/history";

// ---------------------------------------------------------------------------
// Mock useExecutionEvents — we don't want real network calls in unit tests
// ---------------------------------------------------------------------------

const mockLoad = vi.fn();
let mockHistoric: { executionId: string | null; events: NodeExecutionEvent[] } =
  { executionId: null, events: [] };

vi.mock("../hooks/useExecutionEvents", () => ({
  useExecutionEvents: () => ({
    load: mockLoad,
    executionId: mockHistoric.executionId,
    events: mockHistoric.events,
    loading: false,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  executionId: string,
  nodeId: string,
  status: NodeExecutionEvent["status"] = "completed",
): NodeExecutionEvent {
  return {
    execution_id: executionId,
    node_id: nodeId,
    status,
    start_time: new Date(1_700_000_000_000).toISOString(),
    end_time: new Date(1_700_000_001_000).toISOString(),
    latency_ms: 1000,
  };
}

const NO_EXECUTIONS: PersistedExecution[] = [];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useExecutionScoping — displayEvents scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoric = { executionId: null, events: [] };
  });

  test("displayEvents is empty when events array is empty", () => {
    const { result } = renderHook(() =>
      useExecutionScoping({ events: [], executions: NO_EXECUTIONS }),
    );
    expect(result.current.displayEvents).toEqual([]);
  });

  test("displayEvents returns only events for the latest execution when following=true", () => {
    // Two separate executions in the buffer
    const events: NodeExecutionEvent[] = [
      makeEvent("exec-1", "node-a"),
      makeEvent("exec-1", "node-b"),
      makeEvent("exec-2", "node-c"),
    ];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    // Following is true by default; latest execution is whichever comes first
    // after sorting by startedAt (all have the same time here but exec-2
    // will be "latest" depending on iteration order — we check the filtering
    // is tight: no event from a different execution leaks through).
    const displayedExecId = result.current.effectiveExecutionId;
    for (const ev of result.current.displayEvents) {
      expect(ev.execution_id).toBe(displayedExecId);
    }
  });

  test("displayEvents filters correctly after handleSelectExecution", () => {
    const events: NodeExecutionEvent[] = [
      makeEvent("exec-a", "n1"),
      makeEvent("exec-a", "n2"),
      makeEvent("exec-b", "n3"),
      makeEvent("exec-b", "n4"),
    ];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    // Select exec-a explicitly
    act(() => {
      result.current.handleSelectExecution("exec-a");
    });

    expect(result.current.effectiveExecutionId).toBe("exec-a");
    expect(result.current.following).toBe(false);

    for (const ev of result.current.displayEvents) {
      expect(ev.execution_id).toBe("exec-a");
    }
    // exec-b events must NOT appear
    expect(
      result.current.displayEvents.some((e) => e.execution_id === "exec-b"),
    ).toBe(false);
  });

  test("displayEvents filters correctly for exec-b when selected", () => {
    const events: NodeExecutionEvent[] = [
      makeEvent("exec-a", "n1"),
      makeEvent("exec-b", "n2"),
      makeEvent("exec-b", "n3"),
    ];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    act(() => {
      result.current.handleSelectExecution("exec-b");
    });

    expect(result.current.displayEvents).toHaveLength(2);
    expect(
      result.current.displayEvents.every((e) => e.execution_id === "exec-b"),
    ).toBe(true);
  });

  test("handleFollowLive resumes live following and clears selected id", () => {
    const events: NodeExecutionEvent[] = [
      makeEvent("exec-a", "n1"),
      makeEvent("exec-b", "n2"),
    ];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    act(() => result.current.handleSelectExecution("exec-a"));
    expect(result.current.following).toBe(false);

    act(() => result.current.handleFollowLive());
    expect(result.current.following).toBe(true);
    expect(result.current.selectedExecutionId).toBeNull();
  });

  test("effectiveExecutionId is null when no events and no executions", () => {
    const { result } = renderHook(() =>
      useExecutionScoping({ events: [], executions: [] }),
    );
    expect(result.current.effectiveExecutionId).toBeNull();
    expect(result.current.displayEvents).toHaveLength(0);
  });

  test("liveExecutions contains one entry per unique execution_id", () => {
    const events: NodeExecutionEvent[] = [
      makeEvent("exec-x", "n1"),
      makeEvent("exec-x", "n2"),
      makeEvent("exec-y", "n3"),
    ];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    const ids = result.current.liveExecutions.map((e) => e.executionId);
    expect(ids).toContain("exec-x");
    expect(ids).toContain("exec-y");
    // No duplicates
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Deep-linking via `?execution=<id>` (History "View" button)
// ---------------------------------------------------------------------------

describe("useExecutionScoping — ?execution= deep link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoric = { executionId: null, events: [] };
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/graph");
  });

  test("a deep-linked execution id selects that run and stops following", () => {
    window.history.replaceState(null, "", "/graph?execution=exec-deep");

    const events: NodeExecutionEvent[] = [makeEvent("exec-live", "n1")];
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    expect(result.current.following).toBe(false);
    expect(result.current.effectiveExecutionId).toBe("exec-deep");
  });

  test("without ?execution= the hook defaults to following live", () => {
    window.history.replaceState(null, "", "/graph");

    const events: NodeExecutionEvent[] = [makeEvent("exec-live", "n1")];
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    expect(result.current.following).toBe(true);
    expect(result.current.effectiveExecutionId).toBe("exec-live");
  });

  test("selecting an execution writes ?execution= into the URL", () => {
    window.history.replaceState(null, "", "/graph");
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1")];
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    act(() => result.current.handleSelectExecution("exec-a"));

    expect(new URL(window.location.href).searchParams.get("execution")).toBe(
      "exec-a",
    );
  });

  test("resuming Follow Live removes ?execution= from the URL", () => {
    window.history.replaceState(null, "", "/graph?execution=exec-a");
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1")];
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    act(() => result.current.handleFollowLive());

    expect(
      new URL(window.location.href).searchParams.has("execution"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Merging persisted (durable) events with the live SSE buffer
// ---------------------------------------------------------------------------

describe("useExecutionScoping — persisted + live event merge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoric = { executionId: null, events: [] };
    window.history.replaceState(null, "", "/graph");
  });

  test("a persisted __request__ boundary event missing from the live buffer still surfaces", () => {
    // Persisted log has the request boundary that the live SSE buffer (this
    // tab's connection) never received.
    mockHistoric = {
      executionId: "exec-a",
      events: [makeEvent("exec-a", "__request__")],
    };
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "answer-fast")];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    const nodeIds = result.current.displayEvents.map((e) => e.node_id);
    expect(nodeIds).toContain("__request__");
    expect(nodeIds).toContain("answer-fast");
  });

  test("live events for a node not yet in the persisted set are still shown", () => {
    mockHistoric = {
      executionId: "exec-a",
      events: [makeEvent("exec-a", "triage")],
    };
    const events: NodeExecutionEvent[] = [
      makeEvent("exec-a", "triage"),
      makeEvent("exec-a", "answer-fast", "running"),
    ];

    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );

    const nodeIds = result.current.displayEvents.map((e) => e.node_id);
    expect(nodeIds).toEqual(["triage", "answer-fast"]);
  });

  test("requests the durable log for the effective execution on mount", () => {
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1")];
    renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS }),
    );
    expect(mockLoad).toHaveBeenCalledWith("exec-a");
  });
});

// ---------------------------------------------------------------------------
// Free-text keyword filter (flowQuery)
// ---------------------------------------------------------------------------

describe("useExecutionScoping — keyword filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoric = { executionId: null, events: [] };
    window.history.replaceState(null, "", "/graph");
  });

  function makeRichEvent(
    executionId: string,
    nodeId: string,
    extra: Partial<NodeExecutionEvent>,
  ): NodeExecutionEvent {
    return { ...makeEvent(executionId, nodeId), ...extra };
  }

  const events: NodeExecutionEvent[] = [
    makeRichEvent("exec-alpha", "n1", {
      flow_id: "route-auto",
      user_name: "anonymous",
      user_prompt: "Was ist 2+2?",
    }),
    makeRichEvent("exec-beta", "n1", {
      flow_id: "route-flash",
      user_name: "jdoe",
      user_prompt: "Untersuche die Meldung des Kunden.",
    }),
  ];

  function idsFor(query: string): string[] {
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS, flowQuery: query }),
    );
    return result.current.pickerItems.map((p) => p.executionId);
  }

  test("matches the user prompt case-insensitively", () => {
    expect(idsFor("unt")).toEqual(["exec-beta"]);
    expect(idsFor("UNTERSUCHE")).toEqual(["exec-beta"]);
  });

  test("matches the flow id and the flow display name", () => {
    expect(idsFor("flash")).toEqual(["exec-beta"]);
    expect(idsFor("auto")).toEqual(["exec-alpha"]);
  });

  test("matches the user name", () => {
    expect(idsFor("jdoe")).toEqual(["exec-beta"]);
  });

  test("matches the execution (request) id", () => {
    expect(idsFor("exec-alpha")).toEqual(["exec-alpha"]);
    // Partial id match works too (prefix of one, substring of none other).
    expect(idsFor("alpha")).toEqual(["exec-alpha"]);
  });

  test("empty query keeps every row", () => {
    expect(idsFor("")).toHaveLength(2);
    expect(idsFor("   ")).toHaveLength(2);
  });

  test("non-matching query hides every row", () => {
    expect(idsFor("zzzz")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// User filter (Live Graph parity with History)
// ---------------------------------------------------------------------------

describe("useExecutionScoping — user filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoric = { executionId: null, events: [] };
    window.history.replaceState(null, "", "/graph");
  });

  function makeRichEvent(
    executionId: string,
    nodeId: string,
    extra: Partial<NodeExecutionEvent>,
  ): NodeExecutionEvent {
    return { ...makeEvent(executionId, nodeId), ...extra };
  }

  const events: NodeExecutionEvent[] = [
    makeRichEvent("exec-alpha", "n1", {
      flow_id: "route-auto",
      user_name: "Example User",
    }),
    makeRichEvent("exec-beta", "n1", {
      flow_id: "route-flash",
      user_name: "Second User",
    }),
  ];

  function idsFor(userFilter: string): string[] {
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: NO_EXECUTIONS, userFilter }),
    );
    return result.current.pickerItems.map((p) => p.executionId);
  }

  test("empty user filter keeps every row", () => {
    expect(idsFor("")).toHaveLength(2);
    expect(idsFor("   ")).toHaveLength(2);
  });

  test("selects only rows of the chosen user", () => {
    expect(idsFor("Example User")).toEqual(["exec-alpha"]);
    expect(idsFor("Second User")).toEqual(["exec-beta"]);
  });

  test("matching is case-insensitive and trims whitespace", () => {
    expect(idsFor("example user")).toEqual(["exec-alpha"]);
    expect(idsFor("  EXAMPLE USER  ")).toEqual(["exec-alpha"]);
  });

  test("unknown user hides every row", () => {
    expect(idsFor("Niemand Hier")).toEqual([]);
  });

  test("rows whose user is not yet known are hidden while filtering", () => {
    const eventsNoUser: NodeExecutionEvent[] = [
      makeEvent("exec-anon", "n1"),
      makeRichEvent("exec-known", "n1", { user_name: "jdoe" }),
    ];
    const { result } = renderHook(() =>
      useExecutionScoping({
        events: eventsNoUser,
        executions: NO_EXECUTIONS,
        userFilter: "jdoe",
      }),
    );
    expect(result.current.pickerItems.map((p) => p.executionId)).toEqual([
      "exec-known",
    ]);
  });

  test("durable rows are filtered by user too", () => {
    const executions: PersistedExecution[] = [
      {
        execution_id: "hist-1",
        flow_id: "route-auto",
        tenant_id: null,
        status: "completed",
        node_count: 1,
        error_count: 0,
        total_latency_ms: 10,
        total_cost: null,
        started_at: new Date(1_700_000_002_000).toISOString(),
        finished_at: null,
        user_name: "Example User",
        user_prompt: null,
      },
      {
        execution_id: "hist-2",
        flow_id: "route-flash",
        tenant_id: null,
        status: "completed",
        node_count: 1,
        error_count: 0,
        total_latency_ms: 10,
        total_cost: null,
        started_at: new Date(1_700_000_001_000).toISOString(),
        finished_at: null,
        user_name: "Second User",
        user_prompt: null,
      },
    ];
    const { result } = renderHook(() =>
      useExecutionScoping({
        events: [],
        executions,
        userFilter: "second user",
      }),
    );
    expect(result.current.pickerItems.map((p) => p.executionId)).toEqual([
      "hist-2",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Durable backfill of identity fields on live rows
// ---------------------------------------------------------------------------

describe("useExecutionScoping — live row identity backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoric = { executionId: null, events: [] };
    window.history.replaceState(null, "", "/graph");
  });

  function makePersisted(
    executionId: string,
    extra: Partial<PersistedExecution> = {},
  ): PersistedExecution {
    return {
      execution_id: executionId,
      flow_id: "route-flash",
      tenant_id: null,
      status: "running",
      node_count: 3,
      error_count: 0,
      total_latency_ms: null,
      total_cost: null,
      started_at: new Date(1_700_000_000_000).toISOString(),
      finished_at: null,
      user_name: "jdoe",
      user_prompt: "Untersuche die Meldung des Kunden.",
      ...extra,
    };
  }

  function rowFor(
    events: NodeExecutionEvent[],
    executions: PersistedExecution[],
  ) {
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions }),
    );
    return result.current.pickerItems.find((p) => p.executionId === "exec-a");
  }

  test("live row built only from tool events gets user/prompt/flow from history", () => {
    // Simulates joining a run in progress: the live buffer only holds a
    // synthetic tool-node event without any identity fields.
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1::tool::t1")];
    const row = rowFor(events, [makePersisted("exec-a")]);
    expect(row?.live).toBe(true);
    expect(row?.user).toBe("jdoe");
    expect(row?.prompt).toBe("Untersuche die Meldung des Kunden.");
    expect(row?.flowId).toBe("route-flash");
  });

  test("live identity fields win over the durable row", () => {
    const events: NodeExecutionEvent[] = [
      {
        ...makeEvent("exec-a", "n1"),
        user_name: "live-user",
        user_prompt: "Live-Prompt",
        flow_id: "route-auto",
      },
    ];
    const row = rowFor(events, [makePersisted("exec-a")]);
    expect(row?.user).toBe("live-user");
    expect(row?.prompt).toBe("Live-Prompt");
    expect(row?.flowId).toBe("route-auto");
  });

  test("live row without a durable counterpart stays as-is", () => {
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1")];
    const row = rowFor(events, NO_EXECUTIONS);
    expect(row?.live).toBe(true);
    expect(row?.user).toBeUndefined();
    expect(row?.prompt).toBeUndefined();
  });

  test("backfilled identity fields participate in the keyword filter", () => {
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1::tool::t1")];
    const { result } = renderHook(() =>
      useExecutionScoping({
        events,
        executions: [makePersisted("exec-a")],
        flowQuery: "untersuche",
      }),
    );
    expect(result.current.pickerItems.map((p) => p.executionId)).toEqual([
      "exec-a",
    ]);
  });

  test("backfill never duplicates the row (durable row stays hidden)", () => {
    const events: NodeExecutionEvent[] = [makeEvent("exec-a", "n1")];
    const { result } = renderHook(() =>
      useExecutionScoping({ events, executions: [makePersisted("exec-a")] }),
    );
    expect(
      result.current.pickerItems.filter((p) => p.executionId === "exec-a"),
    ).toHaveLength(1);
  });
});

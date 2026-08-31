// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for useExecutionScoping.
 *
 * Focuses on the scoping memo: displayEvents must be filtered to the
 * currently effective execution_id.
 *
 * Requirements: 11.1
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

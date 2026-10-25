// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for useFlowTopology.
 *
 * Verifies:
 *   - exact flow_id match is preferred
 *   - node-ID overlap fallback when no flow_id match
 *   - no match returns null
 *
 */

import { describe, test, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useFlowTopology } from "../hooks/useFlowTopology";
import type { NodeExecutionEvent } from "../types/monitoring";
import type { FlowDefinition } from "../types/flow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(nodeId: string, flowId?: string): NodeExecutionEvent {
  return {
    execution_id: "exec-1",
    node_id: nodeId,
    status: "completed",
    start_time: new Date().toISOString(),
    end_time: new Date().toISOString(),
    latency_ms: 100,
    ...(flowId !== undefined ? { flow_id: flowId } : {}),
  };
}

function makeFlow(id: string, nodeIds: string[]): FlowDefinition {
  return {
    id,
    name: `Flow ${id}`,
    nodes: nodeIds.map((nid) => ({ id: nid, type: "llm" as const })),
    edges: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFlowTopology", () => {
  test("returns null flowDefinition when no flows and no events", () => {
    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [],
        getFlow: vi.fn(),
        displayEvents: [],
      }),
    );
    expect(result.current.flowDefinition).toBeNull();
  });

  test("resolves exact flow_id match", async () => {
    const flowA = makeFlow("flow-a", ["n1", "n2"]);
    const flowB = makeFlow("flow-b", ["n3", "n4"]);

    const getFlow = vi.fn(async (id: string) => ({
      published: id === "flow-a" ? flowA : flowB,
    }));

    const displayEvents = [
      makeEvent("n1", "flow-a"),
      makeEvent("n2", "flow-a"),
    ];

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [
          { id: "flow-a", name: "Flow A" },
          { id: "flow-b", name: "Flow B" },
        ],
        getFlow,
        displayEvents,
      }),
    );

    await waitFor(() => expect(result.current.flowDefinition).not.toBeNull());
    expect(result.current.flowDefinition!.id).toBe("flow-a");
  });

  test("falls back to node-ID overlap when no flow_id in events", async () => {
    const flowA = makeFlow("flow-a", ["node-alpha", "node-beta"]);
    const flowB = makeFlow("flow-b", ["node-gamma", "node-delta"]);

    const getFlow = vi.fn(async (id: string) => ({
      published: id === "flow-a" ? flowA : flowB,
    }));

    // Events carry nodes matching flow-a — no flow_id set
    const displayEvents = [makeEvent("node-alpha"), makeEvent("node-beta")];

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [
          { id: "flow-a", name: "Flow A" },
          { id: "flow-b", name: "Flow B" },
        ],
        getFlow,
        displayEvents,
      }),
    );

    await waitFor(() => expect(result.current.flowDefinition).not.toBeNull());
    expect(result.current.flowDefinition!.id).toBe("flow-a");
  });

  test("returns null when no overlap between events and any flow", async () => {
    const flowA = makeFlow("flow-a", ["n1", "n2"]);

    const getFlow = vi.fn(async () => ({ published: flowA }));

    const displayEvents = [makeEvent("completely-unknown-node")];

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [{ id: "flow-a", name: "Flow A" }],
        getFlow,
        displayEvents,
      }),
    );

    // Wait for getFlow to be called and state to settle
    await waitFor(() => expect(getFlow).toHaveBeenCalled());
    // bestScore = 0, so flowDefinition stays null
    expect(result.current.flowDefinition).toBeNull();
  });

  test("loadedFlowDefs contains all successfully fetched flows", async () => {
    const flowA = makeFlow("flow-a", ["n1"]);
    const flowB = makeFlow("flow-b", ["n2"]);

    const getFlow = vi.fn(async (id: string) => ({
      published: id === "flow-a" ? flowA : flowB,
    }));

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [
          { id: "flow-a", name: "Flow A" },
          { id: "flow-b", name: "Flow B" },
        ],
        getFlow,
        displayEvents: [],
      }),
    );

    await waitFor(() => expect(result.current.loadedFlowDefs.size).toBe(2));
    expect(result.current.loadedFlowDefs.has("flow-a")).toBe(true);
    expect(result.current.loadedFlowDefs.has("flow-b")).toBe(true);
  });

  test("prefers best-matching flow when multiple have overlap", async () => {
    const flowA = makeFlow("flow-a", ["shared-1", "shared-2", "shared-3"]);
    const flowB = makeFlow("flow-b", ["shared-1"]);

    const getFlow = vi.fn(async (id: string) => ({
      published: id === "flow-a" ? flowA : flowB,
    }));

    const displayEvents = [
      makeEvent("shared-1"),
      makeEvent("shared-2"),
      makeEvent("shared-3"),
    ];

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [
          { id: "flow-a", name: "Flow A" },
          { id: "flow-b", name: "Flow B" },
        ],
        getFlow,
        displayEvents,
      }),
    );

    await waitFor(() => expect(result.current.flowDefinition).not.toBeNull());
    // flow-a has 3 overlapping nodes vs flow-b's 1
    expect(result.current.flowDefinition!.id).toBe("flow-a");
  });

  test("refuses to guess (returns null) when the node-ID overlap fallback ties between flows", async () => {
    // Regression test: several single-node passthrough flows can legitimately
    // share a generic node id (e.g. "responder"). When no event carries
    // `flow_id` (legacy data) and the overlap score ties across flows, picking
    // an arbitrary winner previously mislabelled the run with the wrong flow's
    // node labels/model. The resolver must refuse to guess instead.
    const flowA = makeFlow("flow-a", ["responder"]);
    const flowB = makeFlow("flow-b", ["responder"]);

    const getFlow = vi.fn(async (id: string) => ({
      published: id === "flow-a" ? flowA : flowB,
    }));

    const displayEvents = [makeEvent("responder")]; // no flow_id

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [
          { id: "flow-a", name: "Flow A" },
          { id: "flow-b", name: "Flow B" },
        ],
        getFlow,
        displayEvents,
      }),
    );

    await waitFor(() => expect(getFlow).toHaveBeenCalledTimes(2));
    // Both flows score 1 on overlap — a tie, so no guess is made.
    expect(result.current.flowDefinition).toBeNull();
  });

  test("resolves to null (not a guess) when flow_id is present but not (yet) loaded", async () => {
    // With flow_id present but the matching definition unavailable (still
    // loading, or the flow was deleted/renamed), the resolver must NOT fall
    // back to node-ID overlap — that heuristic could only pick a WRONG flow
    // once the correct id is already known.
    const flowB = makeFlow("flow-b", ["responder"]);

    const getFlow = vi.fn(async (id: string) => ({
      published: id === "flow-b" ? flowB : null,
    }));

    const displayEvents = [makeEvent("responder", "flow-a")];

    const { result } = renderHook(() =>
      useFlowTopology({
        flows: [
          { id: "flow-a", name: "Flow A" },
          { id: "flow-b", name: "Flow B" },
        ],
        getFlow,
        displayEvents,
      }),
    );

    await waitFor(() => expect(getFlow).toHaveBeenCalledTimes(2));
    expect(result.current.flowDefinition).toBeNull();
  });
});

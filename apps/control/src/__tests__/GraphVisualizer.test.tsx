// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import type { NodeExecutionEvent } from "../types/monitoring";
import type React from "react";

// Mock @xyflow/react before importing the component.
vi.mock("@xyflow/react", () => {
  type NodeItem = {
    id: string;
    type?: string;
    data: Record<string, unknown>;
  };
  type NodeTypes = Record<
    string,
    (props: { data: Record<string, unknown> }) => React.ReactElement
  >;

  const ReactFlow = ({
    nodes,
    nodeTypes,
  }: {
    nodes: NodeItem[];
    nodeTypes?: NodeTypes;
  }) => (
    <ul data-testid="react-flow">
      {nodes.map((n) => {
        const NodeComponent = n.type && nodeTypes?.[n.type];
        if (NodeComponent) {
          return (
            <li key={n.id} data-testid={`node-${n.id}`}>
              <NodeComponent data={n.data} />
            </li>
          );
        }
        return (
          <li key={n.id} data-testid={`node-${n.id}`}>
            {String(n.data.label ?? n.id)}
          </li>
        );
      })}
    </ul>
  );

  return {
    ReactFlow,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    MarkerType: { ArrowClosed: "arrowclosed" },
    Handle: ({ type, position }: { type: string; position: string }) => (
      <div data-handle-type={type} data-handle-position={position} />
    ),
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    getBezierPath: () => ["M0 0", 0, 0],
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useNodesState: () => [[], vi.fn()],
    useEdgesState: () => [[], vi.fn()],
  };
});

// Import AFTER the mock is set up
import { GraphVisualizer } from "../components/GraphVisualizer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  node_id: string,
  status: NodeExecutionEvent["status"],
  latency_ms: number | null = null,
  error_message?: string,
  extra: Partial<NodeExecutionEvent> = {},
): NodeExecutionEvent {
  return {
    execution_id: "exec-1",
    node_id,
    status,
    start_time: "2024-01-01T00:00:00Z",
    end_time: latency_ms !== null ? "2024-01-01T00:00:01Z" : null,
    latency_ms,
    ...(error_message !== undefined ? { error_message } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphVisualizer", () => {
  // --- Status → indicator (dot), independent of node-type fill colour --------

  describe("status indicator (corner dot)", () => {
    test("renders a rotating border instead of a dot for a running node", () => {
      render(<GraphVisualizer events={[makeEvent("node-a", "running")]} />);
      const nodeEl = screen.getByTestId("node-node-a");
      expect(nodeEl.querySelector(".node-running-border")).toBeTruthy();
      expect(nodeEl.querySelector(".bg-info-solid")).toBeNull();
    });

    test("renders a green dot for a completed node", () => {
      render(
        <GraphVisualizer events={[makeEvent("node-b", "completed", 120)]} />,
      );
      const nodeEl = screen.getByTestId("node-node-b");
      expect(nodeEl.querySelector(".bg-success-solid")).toBeTruthy();
    });

    test("renders a red dot for an error node", () => {
      render(
        <GraphVisualizer
          events={[makeEvent("node-c", "error", null, "timeout")]}
        />,
      );
      const nodeEl = screen.getByTestId("node-node-c");
      expect(nodeEl.querySelector(".bg-danger-solid")).toBeTruthy();
    });
  });

  // --- Node type → fill colour -----------------------------------------------

  describe("node-type fill colour", () => {
    test("colours an LLM node with the LLM (indigo) fill", () => {
      render(
        <GraphVisualizer
          events={[makeEvent("llm-node", "completed", 100)]}
          flowDefinition={{
            id: "f1",
            name: "Flow",
            nodes: [{ id: "llm-node", type: "llm" }],
            edges: [],
          }}
        />,
      );
      const nodeEl = screen.getByTestId("node-llm-node");
      expect(nodeEl.querySelector(".bg-node-llm")).toBeTruthy();
    });

    test("colours a retrieval node differently from an LLM node", () => {
      render(
        <GraphVisualizer
          events={[makeEvent("rag-node", "completed", 100)]}
          flowDefinition={{
            id: "f2",
            name: "Flow",
            nodes: [{ id: "rag-node", type: "retrieval" }],
            edges: [],
          }}
        />,
      );
      const nodeEl = screen.getByTestId("node-rag-node");
      expect(nodeEl.querySelector(".bg-node-retrieval")).toBeTruthy();
      expect(nodeEl.querySelector(".bg-node-llm")).toBeFalsy();
    });
  });

  describe("latency display (Req 9.4)", () => {
    test("renders latency text when latency_ms is provided", () => {
      render(
        <GraphVisualizer events={[makeEvent("node-lat", "completed", 42)]} />,
      );
      expect(screen.getByText("42ms")).toBeInTheDocument();
    });

    test("does NOT render a latency value when latency_ms is null", () => {
      render(
        <GraphVisualizer
          events={[makeEvent("node-nulllat", "running", null)]}
        />,
      );
      expect(screen.queryByText(/^\d+ms$/)).not.toBeInTheDocument();
    });
  });

  // --- Req 9.6: Error highlight and message ------------------------------------

  describe("error highlight (Req 9.6)", () => {
    test("renders the error message for an error node", () => {
      render(
        <GraphVisualizer
          events={[makeEvent("node-err", "error", null, "timeout")]}
        />,
      );
      expect(screen.getByText("timeout")).toBeInTheDocument();
    });

    test("hides error message when a subsequent running event arrives for the same node", () => {
      const errorEvent = makeEvent("node-x", "error", null, "connection lost");
      const runningEvent = makeEvent("node-x", "running", null);
      render(<GraphVisualizer events={[errorEvent, runningEvent]} />);
      expect(screen.queryByText("connection lost")).not.toBeInTheDocument();
    });
  });

  // --- Detail fields -----------------------------------------------------------

  describe("detail fields", () => {
    test("renders model name in node when provided", () => {
      render(
        <GraphVisualizer
          events={[
            makeEvent("node-m", "completed", 50, undefined, {
              model: "openai/gpt-4o",
            }),
          ]}
        />,
      );
      // The model's short name (after "/") appears in the node
      expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    });

    test("shows node detail panel on click", () => {
      render(
        <GraphVisualizer
          events={[
            makeEvent("node-click", "completed", 100, undefined, {
              model: "openai/gpt-4o",
              input_tokens: 200,
              output_tokens: 50,
            }),
          ]}
        />,
      );
      const nodeEl = screen.getByTestId("node-node-click");
      const btn = nodeEl.querySelector("[role=button]");
      expect(btn).toBeTruthy();
      fireEvent.click(btn!);
      // Detail panel should appear with token info
      expect(screen.getByText("Model, Tokens & Cost")).toBeInTheDocument();
      expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
    });
  });

  // --- Empty events ------------------------------------------------------------

  describe("empty events", () => {
    test("renders react-flow canvas when events are present", () => {
      render(<GraphVisualizer events={[makeEvent("n1", "running")]} />);
      expect(screen.getByTestId("react-flow")).toBeInTheDocument();
    });

    test("renders empty message when no events are provided", () => {
      render(<GraphVisualizer events={[]} />);
      expect(screen.getByText(/No execution events yet/)).toBeInTheDocument();
    });
  });

  // --- Regression: stale duplicate "running" must not un-complete a node ------
  // A node must never appear stuck "running" once its "completed" event has
  // been received, even if a duplicate/stale "running" event for the SAME
  // invocation (identical start_time) is merged afterwards — e.g. from an SSE
  // Last-Event-ID resume replaying an already-delivered event.
  describe("stale duplicate running event (Req: stuck-running regression)", () => {
    test("ignores a duplicate running event with the same start_time after completion", () => {
      render(
        <GraphVisualizer
          events={[
            makeEvent("router", "running"),
            makeEvent("router", "completed", 5),
            // Stale re-delivery of the SAME "running" event (same start_time).
            makeEvent("router", "running"),
          ]}
        />,
      );
      const nodeEl = screen.getByTestId("node-router");
      expect(nodeEl.querySelector(".bg-success-solid")).toBeTruthy();
      expect(nodeEl.querySelector(".node-running-border")).toBeFalsy();
    });

    test("a genuinely new invocation (different start_time) still restarts the node", () => {
      render(
        <GraphVisualizer
          events={[
            makeEvent("router", "running"),
            makeEvent("router", "completed", 5),
            makeEvent("router", "running", null, undefined, {
              start_time: "2024-01-01T00:05:00Z",
            }),
          ]}
        />,
      );
      const nodeEl = screen.getByTestId("node-router");
      expect(nodeEl.querySelector(".node-running-border")).toBeTruthy();
    });
  });

  // --- Regression: unresolved {{vars.x}} must never reach the dashboard -------
  describe("unresolved template placeholder cleanup", () => {
    test("substitutes an unresolved {{vars.x}} label with the node's actual resolved model", () => {
      render(
        <GraphVisualizer
          events={[
            makeEvent("clienten-responder", "completed", 200, undefined, {
              model: "bedrock/eu.anthropic.claude-sonnet-5",
              label: "Client Agent ({{vars.model_responder}})",
            }),
          ]}
        />,
      );
      expect(
        screen.getByText(
          /Client Agent \(bedrock\/eu\.anthropic\.claude-sonnet-5\)/,
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
    });

    test("strips an unresolved placeholder entirely when no model is available", () => {
      render(
        <GraphVisualizer
          events={[
            makeEvent("router", "completed", 5, undefined, {
              label: "Routen-Verteiler ({{vars.unknown_var}})",
            }),
          ]}
        />,
      );
      expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
      expect(screen.getByText(/Routen-Verteiler/)).toBeInTheDocument();
    });
  });

  // --- SSE throttling: rapid event bursts must still converge to the final
  // state, without requiring every intermediate re-render (useThrottledValue).
  describe("SSE update throttling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test("a burst of rapid updates eventually converges to the final node state", () => {
      const { rerender } = render(
        <GraphVisualizer events={[makeEvent("burst-node", "running")]} />,
      );
      expect(screen.getByTestId("node-burst-node")).toBeTruthy();

      // Simulate a fast SSE burst: several updates within one throttle window.
      for (let i = 0; i < 5; i++) {
        rerender(
          <GraphVisualizer
            events={[
              makeEvent("burst-node", "running", null, undefined, {
                latency_ms: i,
              }),
            ]}
          />,
        );
        act(() => vi.advanceTimersByTime(20));
      }

      // Final completion event, then let the trailing throttle flush fire.
      rerender(
        <GraphVisualizer events={[makeEvent("burst-node", "completed", 99)]} />,
      );
      act(() => vi.advanceTimersByTime(200));

      const nodeEl = screen.getByTestId("node-burst-node");
      expect(nodeEl.querySelector(".bg-success-solid")).toBeTruthy();
      expect(screen.getByText("99ms")).toBeInTheDocument();
    });
  });
});

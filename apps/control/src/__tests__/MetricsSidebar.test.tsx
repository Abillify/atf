// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { MetricsSidebar } from "../components/MetricsSidebar";
import type { NodeExecutionEvent } from "../types/monitoring";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  node_id: string,
  status: NodeExecutionEvent["status"],
  latency_ms: number | null = null,
  error_message?: string,
): NodeExecutionEvent {
  return {
    execution_id: "exec-1",
    node_id,
    status,
    start_time: "2024-01-01T00:00:00Z",
    end_time: latency_ms !== null ? "2024-01-01T00:00:01Z" : null,
    latency_ms,
    error_message,
  };
}

// ---------------------------------------------------------------------------
// Tests — Requirement 9.5
// ---------------------------------------------------------------------------

describe("MetricsSidebar", () => {
  test("renders without crashing with empty events", () => {
    render(<MetricsSidebar events={[]} />);
    expect(screen.getByText("Active Requests")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Errors")).toBeInTheDocument();
  });

  test("shows correct Active Requests count for running nodes", () => {
    const events = [
      makeEvent("node-1", "running"),
      makeEvent("node-2", "running"),
      makeEvent("node-3", "running"),
    ];
    render(<MetricsSidebar events={events} />);

    // The "Active Requests" label is in one card; its sibling value should be 3
    const activeCard = screen.getByText("Active Requests").closest("div");
    expect(activeCard).toBeTruthy();
    expect(activeCard?.textContent).toContain("3");
  });

  test("shows correct Completed count", () => {
    const events = [
      makeEvent("node-1", "completed", 100),
      makeEvent("node-2", "completed", 200),
    ];
    render(<MetricsSidebar events={events} />);

    const completedCard = screen.getByText("Completed").closest("div");
    expect(completedCard?.textContent).toContain("2");
  });

  test("shows correct Errors count", () => {
    const events = [
      makeEvent("node-1", "error", null, "fail"),
      makeEvent("node-2", "error", null, "timeout"),
    ];
    render(<MetricsSidebar events={events} />);

    const errorsCard = screen.getByText("Errors").closest("div");
    expect(errorsCard?.textContent).toContain("2");
  });

  test("counts only the latest status per node_id (no double-counting)", () => {
    // node-1 goes running → completed; only the last event counts
    // node-2 goes running → error; only error is counted
    const events = [
      makeEvent("node-1", "running"),
      makeEvent("node-2", "running"),
      makeEvent("node-1", "completed", 50),
      makeEvent("node-2", "error", null, "oops"),
    ];
    render(<MetricsSidebar events={events} />);

    const activeCard = screen.getByText("Active Requests").closest("div");
    const completedCard = screen.getByText("Completed").closest("div");
    const errorsCard = screen.getByText("Errors").closest("div");

    // node-1 latest: completed → 1 completed
    expect(completedCard?.textContent).toContain("1");
    // node-2 latest: error → 1 error
    expect(errorsCard?.textContent).toContain("1");
    // No nodes still running → 0 active
    expect(activeCard?.textContent).toContain("0");
  });

  test("shows mixed statuses correctly for multiple nodes", () => {
    const events = [
      makeEvent("node-a", "running"),
      makeEvent("node-b", "completed", 80),
      makeEvent("node-c", "error", null, "bad"),
      makeEvent("node-d", "running"),
    ];
    render(<MetricsSidebar events={events} />);

    const activeCard = screen.getByText("Active Requests").closest("div");
    const completedCard = screen.getByText("Completed").closest("div");
    const errorsCard = screen.getByText("Errors").closest("div");

    expect(activeCard?.textContent).toContain("2");
    expect(completedCard?.textContent).toContain("1");
    expect(errorsCard?.textContent).toContain("1");
  });

  test("shows 0 active requests when all events are initially 0", () => {
    render(<MetricsSidebar events={[]} />);

    const activeCard = screen.getByText("Active Requests").closest("div");
    expect(activeCard?.textContent).toContain("0");
  });
});

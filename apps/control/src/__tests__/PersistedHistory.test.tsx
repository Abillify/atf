// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { PersistedHistory } from "../components/PersistedHistory";
import type { PersistedExecution } from "../types/history";

function exec(
  id: string,
  status: PersistedExecution["status"] = "completed",
  overrides: Partial<PersistedExecution> = {},
): PersistedExecution {
  return {
    execution_id: id,
    flow_id: "example-flow",
    status,
    node_count: 3,
    error_count: 0,
    total_latency_ms: 412,
    started_at: "2025-01-01T00:00:00Z",
    finished_at: "2025-01-01T00:00:01Z",
    ...overrides,
  } as PersistedExecution;
}

describe("PersistedHistory", () => {
  test("renders the empty state when there are no executions", () => {
    render(<PersistedHistory executions={[]} />);
    expect(screen.getByText("No executions recorded yet.")).toBeInTheDocument();
  });

  test("shows a loading state only while loading with no data", () => {
    render(<PersistedHistory executions={[]} isLoading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("renders rows with shortened id, flow, node count and latency", () => {
    render(<PersistedHistory executions={[exec("abcdef1234567890")]} />);
    expect(screen.getByText("abcdef12")).toBeInTheDocument(); // first 8 chars
    expect(screen.getByText("example-flow")).toBeInTheDocument();
    expect(screen.getByText("412 ms")).toBeInTheDocument();
  });

  test("maps status to a badge label", () => {
    render(
      <PersistedHistory
        executions={[
          exec("e1", "completed"),
          exec("e2", "error"),
          exec("e3", "running"),
        ]}
      />,
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  test("shows the count and an error message", () => {
    render(<PersistedHistory executions={[exec("e1")]} error="HTTP 401" />);
    expect(screen.getByText("(1)")).toBeInTheDocument();
    expect(screen.getByText("HTTP 401")).toBeInTheDocument();
  });

  test("invokes onRefresh when the refresh button is clicked", () => {
    const onRefresh = vi.fn();
    render(<PersistedHistory executions={[]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByText("Refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("renders a dash for an invalid started_at", () => {
    render(
      <PersistedHistory
        executions={[exec("e1", "completed", { started_at: "not-a-date" })]}
      />,
    );
    // The started column falls back to an em dash.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

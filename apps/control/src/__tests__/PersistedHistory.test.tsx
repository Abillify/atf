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

  test("a lone request renders without a collapsible group header", () => {
    render(<PersistedHistory executions={[exec("solo123456789000")]} />);
    expect(screen.getByText("solo1234")).toBeInTheDocument();
    // No disclosure row at all — a single request is just a plain row.
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
    expect(screen.queryByText("1 Request")).toBeNull();
  });

  test("requests without a conversation id each render as plain rows", () => {
    render(
      <PersistedHistory
        executions={[exec("aaaaaaaaaaaaaaa"), exec("bbbbbbbbbbbbbbb")]}
      />,
    );
    expect(screen.getByText("aaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("bbbbbbbb")).toBeInTheDocument();
    expect(
      screen.queryAllByRole("button", { expanded: true }),
    ).toHaveLength(0);
  });

  test("two requests of one conversation get a collapsible group", () => {
    render(
      <PersistedHistory
        executions={[
          exec("aaaaaaaaaaaaaaa", "completed", {
            conversation_id: "conv-1",
            started_at: "2025-01-01T00:01:00Z",
          }),
          exec("bbbbbbbbbbbbbbb", "completed", {
            conversation_id: "conv-1",
            started_at: "2025-01-01T00:02:00Z",
          }),
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { expanded: true });
    expect(toggle).toHaveTextContent("conv-1");
    expect(toggle).toHaveTextContent("2 Requests");
    expect(screen.getByText("aaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("bbbbbbbb")).toBeInTheDocument();

    // Collapsing hides both request rows.
    fireEvent.click(toggle);
    expect(screen.queryByText("aaaaaaaa")).toBeNull();
    expect(screen.queryByText("bbbbbbbb")).toBeNull();
  });

  test("renders no action column when no action callbacks are wired", () => {
    render(<PersistedHistory executions={[exec("e1")]} />);
    expect(screen.queryByText("Aktionen")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /trace viewer/i }),
    ).toBeNull();
  });

  test("renders compact icon buttons with accessible names", () => {
    render(
      <PersistedHistory
        executions={[exec("e1")]}
        onViewEvents={vi.fn()}
        onDownloadDebug={vi.fn()}
        onAnalyze={vi.fn()}
        onOpenTrace={vi.fn()}
        onReplay={vi.fn()}
      />,
    );
    expect(screen.getByText("Aktionen")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open in Live Graph" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open in Trace Viewer" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download debug trace/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /analyse this run/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /replay this run/i }),
    ).toBeInTheDocument();
    // The old text-button labels are gone — the actions are icon-only now.
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
    expect(screen.queryByRole("button", { name: "JSON" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Analyze" })).toBeNull();
  });

  test("the Trace icon button opens the trace viewer for its execution", () => {
    const onOpenTrace = vi.fn();
    render(
      <PersistedHistory
        executions={[exec("trace-me-12345")]}
        onOpenTrace={onOpenTrace}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open in Trace Viewer" }),
    );
    expect(onOpenTrace).toHaveBeenCalledWith("trace-me-12345");
  });

  test("icon buttons inside a collapsed thread group fire per request", () => {
    const onOpenTrace = vi.fn();
    render(
      <PersistedHistory
        executions={[
          exec("aaaaaaaaaaaaaaa", "completed", {
            conversation_id: "conv-1",
            started_at: "2025-01-01T00:01:00Z",
          }),
          exec("bbbbbbbbbbbbbbb", "completed", {
            conversation_id: "conv-1",
            started_at: "2025-01-01T00:02:00Z",
          }),
        ]}
        onOpenTrace={onOpenTrace}
      />,
    );
    const traceButtons = screen.getAllByRole("button", {
      name: "Open in Trace Viewer",
    });
    expect(traceButtons).toHaveLength(2);
    const secondButton = traceButtons.at(1);
    if (secondButton !== undefined) {
      fireEvent.click(secondButton);
    }
    expect(onOpenTrace).toHaveBeenCalledWith("bbbbbbbbbbbbbbb");
  });

  test("headers are plain (not sortable) without onSortChange", () => {
    render(<PersistedHistory executions={[exec("e1")]} />);
    expect(
      screen.queryByRole("button", { name: /sort by cost/i }),
    ).toBeNull();
    expect(screen.getByText("Cost")).toBeInTheDocument();
  });

  test("renders sortable header buttons with aria-sort state", () => {
    render(
      <PersistedHistory
        executions={[exec("e1")]}
        sortBy="started_at"
        sortDir="desc"
        onSortChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Sort by Cost" }),
    ).toBeInTheDocument();
    // jsdom computes the th's accessible name from its text content, not the
    // nested button's aria-label — match on the visible label.
    const startedHeader = screen.getByRole("columnheader", {
      name: "Started",
    });
    expect(startedHeader).toHaveAttribute("aria-sort", "descending");
    const costHeader = screen.getByRole("columnheader", { name: "Cost" });
    expect(costHeader).toHaveAttribute("aria-sort", "none");
  });

  test("clicking a header reports its column key", () => {
    const onSortChange = vi.fn();
    render(
      <PersistedHistory
        executions={[exec("e1")]}
        sortBy="started_at"
        sortDir="desc"
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sort by Cost" }));
    expect(onSortChange).toHaveBeenCalledWith("total_cost");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Runtime" }));
    expect(onSortChange).toHaveBeenCalledWith("runtime");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Flow" }));
    expect(onSortChange).toHaveBeenCalledWith("flow_id");
  });
});

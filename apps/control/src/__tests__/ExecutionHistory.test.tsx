// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, within } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { ExecutionHistory } from "../components/ExecutionHistory";
import type { NodeExecutionEvent } from "../types/monitoring";

function ev(
  execution_id: string,
  node_id: string,
  status: NodeExecutionEvent["status"],
  latency_ms: number | null = null,
  start_time = "2024-01-01T00:00:00Z",
): NodeExecutionEvent {
  return {
    execution_id,
    node_id,
    status,
    start_time,
    end_time: latency_ms !== null ? "2024-01-01T00:00:01Z" : null,
    latency_ms,
  };
}

describe("ExecutionHistory", () => {
  test("renders empty state when there are no events", () => {
    render(<ExecutionHistory events={[]} />);
    expect(screen.getByText("No executions yet.")).toBeInTheDocument();
  });

  test("groups events by execution_id", () => {
    render(
      <ExecutionHistory
        events={[
          ev("exec-aaaa1111", "n1", "completed", 100),
          ev("exec-aaaa1111", "n2", "completed", 50),
          ev("exec-bbbb2222", "n1", "completed", 30),
        ]}
      />,
    );
    // Two executions → two short ids rendered
    expect(screen.getByText("exec-aaa")).toBeInTheDocument();
    expect(screen.getByText("exec-bbb")).toBeInTheDocument();
  });

  test("counts only the latest status per node and sums latency", () => {
    render(
      <ExecutionHistory
        events={[
          ev("exec-1", "n1", "running"),
          ev("exec-1", "n1", "completed", 120),
          ev("exec-1", "n2", "completed", 80),
        ]}
      />,
    );
    const row = screen.getByText("exec-1").closest("tr")!;
    // 2 nodes, total latency 200 ms, status ok (no running/error left)
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("200 ms")).toBeInTheDocument();
    expect(within(row).getByText("ok")).toBeInTheDocument();
  });

  test("marks an execution as error when any node errored", () => {
    render(
      <ExecutionHistory
        events={[
          ev("exec-err1", "n1", "completed", 10),
          ev("exec-err1", "n2", "error"),
        ]}
      />,
    );
    const row = screen.getByText("exec-err").closest("tr")!;
    expect(within(row).getByText("error")).toBeInTheDocument();
  });

  test("marks an execution as running while a node is still running", () => {
    render(
      <ExecutionHistory
        events={[
          ev("exec-run1", "n1", "completed", 10),
          ev("exec-run1", "n2", "running"),
        ]}
      />,
    );
    const row = screen.getByText("exec-run").closest("tr")!;
    expect(within(row).getByText("running")).toBeInTheDocument();
  });

  test("orders the most recently started execution first", () => {
    render(
      <ExecutionHistory
        events={[
          ev("exec-old0", "n1", "completed", 10, "2024-01-01T00:00:00Z"),
          ev("exec-new0", "n1", "completed", 10, "2024-01-01T01:00:00Z"),
        ]}
      />,
    );
    const ids = screen.getAllByText(/^exec-/).map((el) => el.textContent);
    expect(ids[0]).toBe("exec-new");
  });
});

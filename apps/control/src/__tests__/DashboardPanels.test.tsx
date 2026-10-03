// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { StatsBar } from "../components/StatsBar";
import { CostPanel } from "../components/CostPanel";
import { ExecutionHistory } from "../components/ExecutionHistory";
import { EMPTY_SUMMARY, type MetricsSummary } from "../types/metrics";
import type { NodeExecutionEvent } from "../types/monitoring";

function summary(overrides: Partial<MetricsSummary> = {}): MetricsSummary {
  return { ...EMPTY_SUMMARY, ...overrides };
}

function ev(
  execution_id: string,
  node_id: string,
  status: NodeExecutionEvent["status"],
  latency_ms: number | null = null,
): NodeExecutionEvent {
  return {
    execution_id,
    node_id,
    status,
    start_time: "2024-01-01T00:00:00Z",
    end_time: latency_ms !== null ? "2024-01-01T00:00:01Z" : null,
    latency_ms,
  };
}

describe("StatsBar", () => {
  test("renders KPI labels and formatted values", () => {
    render(
      <StatsBar
        summary={summary({
          requestsTotal: 1500,
          activeExecutions: 2,
          llmCallsTotal: 10,
          tokensPrompt: 1200,
          tokensCompletion: 800,
          costTotal: 1.2345,
        })}
      />,
    );
    expect(screen.getByText("Requests")).toBeInTheDocument();
    expect(screen.getByText("1.5k")).toBeInTheDocument();
    expect(screen.getByText("\u20ac1.23")).toBeInTheDocument();
  });

  test("computes error rate from llm calls", () => {
    render(
      <StatsBar summary={summary({ llmCallsTotal: 10, llmErrorsTotal: 2 })} />,
    );
    expect(screen.getByText("20.0%")).toBeInTheDocument();
  });
});

describe("CostPanel", () => {
  test("shows empty states when no data", () => {
    render(<CostPanel summary={summary()} />);
    expect(screen.getByText("No cost recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No tenant spend recorded.")).toBeInTheDocument();
  });

  test("renders per-tenant spend rows", () => {
    render(
      <CostPanel
        summary={summary({
          costByModel: { "openai/gpt-4o": 0.5 },
          tenants: [
            {
              tenant: "acme",
              spent: 0.5,
              cap: 1,
              resetAt: Date.now() + 1000,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("acme")).toBeInTheDocument();
    expect(screen.getByText("\u20ac0.5000")).toBeInTheDocument();
  });
});

describe("ExecutionHistory", () => {
  test("empty state with no events", () => {
    render(<ExecutionHistory events={[]} />);
    expect(screen.getByText("No executions yet.")).toBeInTheDocument();
  });

  test("groups events by execution and shows status", () => {
    const events = [
      ev("exec-aaaaaaaa", "n1", "completed", 100),
      ev("exec-aaaaaaaa", "n2", "error"),
      ev("exec-bbbbbbbb", "n1", "completed", 50),
    ];
    render(<ExecutionHistory events={events} />);
    expect(screen.getByText("exec-aaa".slice(0, 8))).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });
});

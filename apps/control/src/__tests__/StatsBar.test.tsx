// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { StatsBar } from "../components/StatsBar";
import { EMPTY_SUMMARY, type MetricsSummary } from "../types/metrics";

function summary(overrides?: Partial<MetricsSummary>): MetricsSummary {
  return { ...EMPTY_SUMMARY, ...overrides };
}

describe("StatsBar", () => {
  test("renders all KPI labels", () => {
    render(<StatsBar summary={summary()} />);
    for (const label of [
      "Requests",
      "Active",
      "LLM calls",
      "Tokens",
      "Est. cost",
      "Avg node",
      "Error rate",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  test("formats large numbers with k/M suffixes", () => {
    render(
      <StatsBar
        summary={summary({ requestsTotal: 12_500, llmCallsTotal: 2_000_000 })}
      />,
    );
    expect(screen.getByText("12.5k")).toBeInTheDocument();
    expect(screen.getByText("2.00M")).toBeInTheDocument();
  });

  test("computes error rate from llm calls/errors", () => {
    render(
      <StatsBar
        summary={summary({ llmCallsTotal: 200, llmErrorsTotal: 20 })}
      />,
    );
    expect(screen.getByText("10.0%")).toBeInTheDocument();
  });

  test("shows queued backlog hint when queueDepth > 0", () => {
    render(
      <StatsBar summary={summary({ activeExecutions: 3, queueDepth: 7 })} />,
    );
    expect(screen.getByText("7 queued")).toBeInTheDocument();
  });

  test("shows 'no backlog' when queue is empty", () => {
    render(
      <StatsBar summary={summary({ activeExecutions: 1, queueDepth: 0 })} />,
    );
    expect(screen.getByText("no backlog")).toBeInTheDocument();
  });

  test("formats small costs with micro precision in the configured currency", () => {
    render(<StatsBar summary={summary({ costTotal: 0.00042 })} />);
    expect(screen.getByText("\u20ac0.00042")).toBeInTheDocument();
  });
});

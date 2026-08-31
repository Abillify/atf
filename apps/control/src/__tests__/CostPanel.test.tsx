// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, within } from "@testing-library/react";
import { describe, test, expect } from "vitest";
import { CostPanel } from "../components/CostPanel";
import { EMPTY_SUMMARY, type MetricsSummary } from "../types/metrics";

function summary(overrides?: Partial<MetricsSummary>): MetricsSummary {
  return { ...EMPTY_SUMMARY, ...overrides };
}

describe("CostPanel", () => {
  test("renders empty states when no data", () => {
    render(<CostPanel summary={summary()} />);
    expect(screen.getByText("No cost recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("No token usage yet.")).toBeInTheDocument();
    expect(screen.getByText("No tenant spend recorded.")).toBeInTheDocument();
  });

  test("renders per-tenant spend rows sorted by spend", () => {
    render(
      <CostPanel
        summary={summary({
          tenants: [
            { tenant: "tenant-low", spent: 1.0, cap: 50, resetAt: 0 },
            { tenant: "tenant-high", spent: 40.0, cap: 50, resetAt: 0 },
          ],
        })}
      />,
    );
    const rows = screen.getAllByText(/^tenant-/);
    expect(rows[0]?.textContent).toBe("tenant-high");
    expect(rows[1]?.textContent).toBe("tenant-low");
  });

  test("shows 'unlimited' when a tenant has no cap", () => {
    render(
      <CostPanel
        summary={summary({
          tenants: [{ tenant: "t1", spent: 5, cap: 0, resetAt: 0 }],
        })}
      />,
    );
    const row = screen.getByText("t1").closest("tr")!;
    expect(within(row).getByText("unlimited")).toBeInTheDocument();
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  test("renders spent amount with 4-decimal precision", () => {
    render(
      <CostPanel
        summary={summary({
          tenants: [
            { tenant: "t1", spent: 1.23456, cap: 10, resetAt: 0 },
          ],
        })}
      />,
    );
    expect(screen.getByText("$1.2346")).toBeInTheDocument();
  });
});

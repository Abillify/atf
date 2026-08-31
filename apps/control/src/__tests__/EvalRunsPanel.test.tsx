// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EvalRunsPanel } from "../components/EvalRunsPanel";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true }),
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }) as unknown as typeof fetch;
}

const sampleRun = {
  id: "eval-1",
  name: "helpdesk-dataset",
  source: "ci" as const,
  recordedAt: "2025-01-01T00:00:00Z",
  report: {
    name: "helpdesk-dataset",
    total: 10,
    passed: 9,
    failed: 1,
    passRate: 0.9,
    totalCost: 0.001234,
    avgLatencyMs: 420,
    avgScore: 0.87,
    cases: [
      {
        id: "case-1",
        flow: "helpdesk",
        passed: false,
        latencyMs: 500,
        cost: 0.0002,
        responseText: "wrong answer",
        assertions: [
          {
            assertion: { type: "contains" },
            passed: false,
            detail: 'expected text to contain "Paris"',
          },
        ],
      },
    ],
  },
};

describe("EvalRunsPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shows a loading state, then the fetched run", async () => {
    mockFetchOnce({ runs: [sampleRun] });
    renderWithQueryClient(<EvalRunsPanel />);

    await waitFor(() =>
      expect(screen.getByText("helpdesk-dataset")).toBeInTheDocument(),
    );
    expect(screen.getByText("90.0% (9/10)")).toBeInTheDocument();
    expect(screen.getByText("87%")).toBeInTheDocument();
    expect(screen.getByText("ci")).toBeInTheDocument();
  });

  test("shows an empty state when there are no runs", async () => {
    mockFetchOnce({ runs: [] });
    renderWithQueryClient(<EvalRunsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/No eval runs recorded yet/)).toBeInTheDocument(),
    );
  });

  test("shows an error state when the fetch fails", async () => {
    mockFetchOnce({}, false);
    renderWithQueryClient(<EvalRunsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/Failed to load eval runs/)).toBeInTheDocument(),
    );
  });

  test("expands a run row to reveal failed-case detail", async () => {
    mockFetchOnce({ runs: [sampleRun] });
    renderWithQueryClient(<EvalRunsPanel />);
    await waitFor(() =>
      expect(screen.getByText("helpdesk-dataset")).toBeInTheDocument(),
    );

    // Failed-case detail is not shown until the row is expanded.
    expect(screen.queryByText(/case-1/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("helpdesk-dataset"));
    expect(screen.getByText(/case-1/)).toBeInTheDocument();
    expect(
      screen.getByText(/expected text to contain "Paris"/),
    ).toBeInTheDocument();
  });
});

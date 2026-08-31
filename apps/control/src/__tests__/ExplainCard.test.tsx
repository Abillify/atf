// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExplainCard } from "../components/ExplainCard";

function renderWithQueryClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

const CARD = {
  executionId: "exec-1",
  flowId: "flow-a",
  status: "completed",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:05.000Z",
  totalLatencyMs: 5000,
  totalCost: 0.001234,
  userName: "alice",
  userPrompt: "What is the capital of France?",
  steps: [
    { nodeId: "n1", kind: "node", status: "completed", latencyMs: 100 },
  ],
  modelsUsed: [],
  routingDecisions: [],
  auditEntries: [],
  degraded: [],
};

function mockFetchSequence(responses: Array<{ ok?: boolean; status?: number; body: unknown; asText?: boolean }>): void {
  const calls = [...responses];
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
    const next = calls.shift() ?? responses[responses.length - 1];
    const ok = next?.ok ?? true;
    return Promise.resolve({
      ok,
      status: next?.status ?? (ok ? 200 : 500),
      json: async () => next?.body,
      text: async () =>
        typeof next?.body === "string" ? next.body : JSON.stringify(next?.body),
    } as unknown as Response);
  }));
}

describe("ExplainCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders the decision-provenance card once loaded", async () => {
    mockFetchSequence([{ body: { card: CARD } }]);
    renderWithQueryClient(
      <ExplainCard executionId="exec-1" token="test-token" enabled={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Decision-Provenance Card")).toBeInTheDocument(),
    );
    expect(screen.getByText(/flow-a/)).toBeInTheDocument();
    expect(
      screen.getByText("What is the capital of France?"),
    ).toBeInTheDocument();
  });

  test("shows an error message on fetch failure", async () => {
    mockFetchSequence([{ body: {}, ok: false, status: 500 }]);
    renderWithQueryClient(
      <ExplainCard executionId="exec-1" token="test-token" enabled={true} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to load explainability card/),
      ).toBeInTheDocument(),
    );
  });

  test("renders both the Markdown and Evidence Bundle download buttons", async () => {
    mockFetchSequence([{ body: { card: CARD } }]);
    renderWithQueryClient(
      <ExplainCard executionId="exec-1" token="test-token" enabled={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Decision-Provenance Card")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Download Markdown" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download Evidence Bundle" }),
    ).toBeInTheDocument();
  });

  test("clicking 'Download Evidence Bundle' fetches the /bundle endpoint with the auth header and triggers a download", async () => {
    mockFetchSequence([
      { body: { card: CARD } },
      { body: JSON.stringify({ bundle: {}, contentHash: "h", signature: "s" }) },
    ]);

    // jsdom lacks URL.createObjectURL/revokeObjectURL — stub them so the
    // download path can run without throwing, and so we can assert it ran.
    const createObjectURL = vi.fn().mockReturnValue("blob:mock");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    renderWithQueryClient(
      <ExplainCard executionId="exec-1" token="test-token" enabled={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText("Decision-Provenance Card")).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Download Evidence Bundle" }),
    );

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const bundleCall = (fetchMock.mock.calls as Array<[string, RequestInit]>).find(
      ([url]) => url.includes("/bundle"),
    );
    expect(bundleCall).toBeDefined();
    const [, init] = bundleCall as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-token");
  });

  test("shows a placeholder when no card is available", async () => {
    mockFetchSequence([{ body: { card: null } }]);
    renderWithQueryClient(
      <ExplainCard executionId="exec-1" token="test-token" enabled={true} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "No explainability card available for this execution.",
        ),
      ).toBeInTheDocument(),
    );
  });

  test("renders the objective-solver attempt trace when a step has one", async () => {
    const cardWithSolver = {
      ...CARD,
      steps: [
        {
          ...CARD.steps[0],
          objectiveSolver: {
            selected: "google/gemini-2.0-flash",
            satisfiedObjective: true,
            fallbackUsed: false,
            attempts: [
              {
                candidate: "google/gemini-2.0-flash",
                estimatedCostUsd: 0.0002,
                observedQuality: 0.85,
                qualitySamples: 12,
                satisfied: true,
                clauses: [],
              },
            ],
          },
        },
      ],
    };
    mockFetchSequence([{ body: { card: cardWithSolver } }]);
    renderWithQueryClient(
      <ExplainCard executionId="exec-1" token="test-token" enabled={true} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/objective-driven routing/)).toBeInTheDocument(),
    );
    expect(screen.getByText("objective satisfied")).toBeInTheDocument();
    expect(screen.getAllByText(/google\/gemini-2.0-flash/).length).toBeGreaterThan(0);
  });
});

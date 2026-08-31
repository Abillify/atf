// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { AutopilotPanel } from "../components/AutopilotPanel";

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true }),
}));

function mockFetchSequence(responses: Array<{ ok?: boolean; body: unknown }>): void {
  let call = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return Promise.resolve({
      ok: r.ok ?? true,
      status: (r.ok ?? true) ? 200 : 500,
      json: async () => r.body,
    });
  }) as unknown as typeof fetch;
}

describe("AutopilotPanel — governance display", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shows human-approval-required badge and drift-guard window", async () => {
    mockFetchSequence([
      { body: { runs: [] } },
      {
        body: {
          config: {
            requireHumanApproval: true,
            maxAutoPromotionsPerWindow: 3,
            driftWindowMs: 86_400_000,
          },
        },
      },
    ]);
    render(<AutopilotPanel />);
    await waitFor(() =>
      expect(screen.getByText("Human approval required")).toBeInTheDocument(),
    );
    expect(screen.getByText(/max 3 auto-promotion\(s\) \/ 24h/)).toBeInTheDocument();
  });

  test("shows auto-promote-enabled badge when governance is relaxed", async () => {
    mockFetchSequence([
      { body: { runs: [] } },
      {
        body: {
          config: {
            requireHumanApproval: false,
            maxAutoPromotionsPerWindow: 5,
            driftWindowMs: 43_200_000,
          },
        },
      },
    ]);
    render(<AutopilotPanel />);
    await waitFor(() =>
      expect(screen.getByText("Auto-promote enabled")).toBeInTheDocument(),
    );
    expect(screen.getByText(/max 5 auto-promotion\(s\) \/ 12h/)).toBeInTheDocument();
  });

  test("does not render a governance badge when /autopilot/config fails", async () => {
    mockFetchSequence([{ body: { runs: [] } }, { ok: false, body: {} }]);
    render(<AutopilotPanel />);
    await waitFor(() =>
      expect(
        screen.getByText(/No autopilot runs yet/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Human approval required")).not.toBeInTheDocument();
    expect(screen.queryByText("Auto-promote enabled")).not.toBeInTheDocument();
  });
});

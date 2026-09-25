// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { AutopilotPanel } from "../components/AutopilotPanel";

const auth = vi.hoisted(() => ({
  current: {
    token: "test-token" as string | undefined,
    ready: true,
    isAuthenticated: true,
  },
}));

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => auth.current,
}));

function mockFetchSequence(
  responses: Array<{ ok?: boolean; status?: number; body: unknown }>,
): void {
  let call = 0;
  global.fetch = vi.fn().mockImplementation(() => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? ((r.ok ?? true) ? 200 : 500),
      json: async () => r.body,
    });
  }) as unknown as typeof fetch;
}

describe("AutopilotPanel — governance display", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    auth.current = { token: "test-token", ready: true, isAuthenticated: true };
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

  test("loads without a token when operator auth is open (AUTHN_MODE=disabled)", async () => {
    auth.current = { token: undefined, ready: true, isAuthenticated: true };
    mockFetchSequence([{ body: { runs: [] } }, { ok: false, body: {} }]);
    render(<AutopilotPanel />);
    await waitFor(() =>
      expect(screen.getByText(/No autopilot runs yet/)).toBeInTheDocument(),
    );
    const init = vi.mocked(global.fetch).mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({});
  });

  test("explains why autopilot is unavailable instead of loading forever", async () => {
    mockFetchSequence([
      {
        ok: false,
        status: 503,
        body: { error: { message: "Autopilot requires RED_TEAM_ENABLED=true." } },
      },
    ]);
    render(<AutopilotPanel />);
    await waitFor(() =>
      expect(
        screen.getByText(/Autopilot requires RED_TEAM_ENABLED=true/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trigger" })).toBeDisabled();
  });

  test("offers a flow picker that follows the selected flow", () => {
    mockFetchSequence([{ body: { runs: [] } }]);
    render(
      <AutopilotPanel
        flowId="b"
        flows={[
          { id: "a", name: "Alpha" },
          { id: "b", name: "Beta" },
        ]}
      />,
    );
    const picker = screen.getByRole("button", { name: "Flow for manual autopilot trigger" });
    expect(picker).toHaveTextContent("Beta (b)");
  });

  test("shows the host page's flow instead of another selector when fixed", () => {
    mockFetchSequence([{ body: { runs: [] } }]);
    render(<AutopilotPanel flowId="abby-pii" fixedFlow />);
    expect(screen.queryByLabelText("Flow for manual autopilot trigger")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Flow ID for manual autopilot trigger")).not.toBeInTheDocument();
    expect(screen.getByText("abby-pii")).toBeInTheDocument();
  });
});

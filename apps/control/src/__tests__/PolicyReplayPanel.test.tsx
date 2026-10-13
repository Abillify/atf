// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Component tests for the PolicyReplayPanel (Req 16, task 22.3).
 *
 * The panel is asserted at the wiring level: the replay POST goes to
 * `/admin/policy-replay` with the parsed candidate policies, the summary +
 * diff table render from the API result, and backend validation errors
 * surface as an alert.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { PolicyReplayPanel } from "../components/PolicyReplayPanel";

function replayBody(overrides: Record<string, unknown> = {}) {
  return {
    errors: [],
    results: [
      {
        execution_id: "exec-11112222333344",
        flow_id: "helpdesk",
        tenant_id: "acme",
        started_at: "2026-10-05T10:00:00Z",
        user_name: "alice",
        old_outcome: "allow",
        new_outcome: "deny",
        changed: true,
        tool_calls: [
          {
            tool: "db.write",
            oldAllowed: true,
            newAllowed: false,
            oldRuleId: "default",
            newRuleId: "deny-write",
            changed: true,
          },
          {
            tool: "db.read",
            oldAllowed: true,
            newAllowed: true,
            oldRuleId: "read-all",
            newRuleId: "read-all",
            changed: false,
          },
        ],
      },
      {
        execution_id: "exec-55556666777788",
        flow_id: "fds",
        tenant_id: "acme",
        started_at: "2026-10-05T11:00:00Z",
        user_name: "bob",
        old_outcome: "allow",
        new_outcome: "allow",
        changed: false,
        tool_calls: [],
      },
    ],
    summary: {
      evaluated: 2,
      changed: 1,
      newlyDenied: 1,
      newlyAllowed: 0,
      toolCallsEvaluated: 2,
      toolCallFlips: 1,
      highlights: ["1 execution newly denied by the candidate policy"],
      ...overrides,
    },
  };
}

function mockFetch(
  response: { ok?: boolean; status?: number; body: unknown },
): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? ((response.ok ?? true) ? 200 : 400),
    json: async () => response.body,
  });
}

function lastRequestInit(): RequestInit {
  const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls;
  return calls[calls.length - 1][1] as RequestInit;
}

function lastRequestUrl(): string {
  const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock
    .calls;
  return String(calls[calls.length - 1][0]);
}

describe("PolicyReplayPanel — dry-run replay UI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("posts candidate tool-authz policy to /admin/policy-replay", async () => {
    mockFetch({ body: replayBody() });
    render(<PolicyReplayPanel token="test-token" />);

    fireEvent.change(screen.getByLabelText(/Candidate tool-authz/i), {
      target: { value: '{"rules":[{"id":"deny-write"}]}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run replay/i }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(lastRequestUrl()).toContain("/admin/policy-replay");
    const body = JSON.parse(String(lastRequestInit().body)) as Record<
      string,
      unknown
    >;
    expect(body["candidateToolAuthzPolicy"]).toEqual({
      rules: [{ id: "deny-write" }],
    });
    expect(body["maxExecutions"]).toBe(50);
  });

  test("renders summary highlights and the flipped tool-call diff", async () => {
    mockFetch({ body: replayBody() });
    render(<PolicyReplayPanel token="test-token" />);

    fireEvent.click(screen.getByRole("button", { name: /Run replay/i }));

    await waitFor(() =>
      expect(
        screen.getByText("1 execution newly denied by the candidate policy"),
      ).toBeInTheDocument(),
    );
    // The changed execution row is visible by default (only-changed filter on).
    expect(screen.getByText("helpdesk")).toBeInTheDocument();
    expect(screen.queryByText("fds")).not.toBeInTheDocument();
    expect(screen.getByText("db.write")).toBeInTheDocument();
    expect(screen.getByText(/deny-write/)).toBeInTheDocument();
  });

  test("only-changed filter off shows unchanged executions too", async () => {
    mockFetch({ body: replayBody() });
    render(<PolicyReplayPanel token="test-token" />);

    fireEvent.click(screen.getByRole("button", { name: /Run replay/i }));
    await waitFor(() => expect(screen.getByText("helpdesk")).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText(/Only changed/i));
    expect(screen.getByText("fds")).toBeInTheDocument();
  });

  test("invalid candidate JSON is rejected before the request", async () => {
    mockFetch({ body: {} });
    render(<PolicyReplayPanel token="test-token" />);

    fireEvent.change(screen.getByLabelText(/Candidate tool-authz/i), {
      target: { value: "{not json" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run replay/i }));

    await waitFor(() =>
      expect(
        screen.getByText("Candidate tool-authz policy is not valid JSON."),
      ).toBeInTheDocument(),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("backend validation error surfaces as an alert", async () => {
    mockFetch({
      ok: false,
      status: 400,
      body: {
        error: {
          message: "toolAuthz: rules.0.action: Invalid enum value",
          type: "invalid_request_error",
        },
      },
    });
    render(<PolicyReplayPanel token="test-token" />);

    fireEvent.change(screen.getByLabelText(/Candidate tool-authz/i), {
      target: { value: '{"rules":[{"id":"x","action":"maybe"}]}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run replay/i }));

    await waitFor(() =>
      expect(
        screen.getByText("toolAuthz: rules.0.action: Invalid enum value"),
      ).toBeInTheDocument(),
    );
  });
});

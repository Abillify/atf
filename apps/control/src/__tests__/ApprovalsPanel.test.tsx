// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { ApprovalsPanel } from "../components/ApprovalsPanel";
import type { PendingApproval } from "../types/control";

const auth = vi.hoisted(() => ({
  current: { role: "operator" as string | undefined },
}));

vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => auth.current,
}));

/**
 * Fixtures are deliberately generic (no customer, tenant or flow reference) so
 * the test runs without private deployment material.
 */
const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "ap-1",
  executionId: "exec-1",
  nodeId: "case-responder",
  tool: "demo-mcp/case_lookup",
  args: { caseRef: "A-123" },
  tenantId: "tenant-a",
  requestedAt: new Date().toISOString(),
  ...over,
});

describe("ApprovalsPanel", () => {
  test("a viewer sees the request but no Approve/Deny buttons", () => {
    auth.current = { role: "viewer" };
    try {
      render(<ApprovalsPanel pending={[approval()]} onResolve={() => {}} />);
      expect(screen.getByText("demo-mcp/case_lookup")).toBeInTheDocument();
      expect(screen.queryByText("Approve")).toBeNull();
      expect(screen.queryByText("Deny")).toBeNull();
      expect(screen.getByText("An operator decides this request.")).toBeInTheDocument();
    } finally {
      auth.current = { role: "operator" };
    }
  });

  test("shows an empty state when nothing is pending", () => {
    render(<ApprovalsPanel pending={[]} onResolve={() => {}} />);
    expect(
      screen.getByText("No tool calls are awaiting approval."),
    ).toBeInTheDocument();
  });

  test("renders pending approvals with tool, node and args", () => {
    render(<ApprovalsPanel pending={[approval()]} onResolve={() => {}} />);
    expect(screen.getByText("demo-mcp/case_lookup")).toBeInTheDocument();
    expect(screen.getByText(/case-responder/)).toBeInTheDocument();
    expect(screen.getByText(/A-123/)).toBeInTheDocument();
  });

  test("Approve invokes onResolve(id, true)", () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(<ApprovalsPanel pending={[approval()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(onResolve).toHaveBeenCalledWith("ap-1", true, expect.anything());
  });

  test("Deny invokes onResolve(id, false)", () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(<ApprovalsPanel pending={[approval()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Deny"));
    expect(onResolve).toHaveBeenCalledWith("ap-1", false, expect.anything());
  });

  test("shows a role-specific message when the decision is answered with 403", async () => {
    const onResolve = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    render(<ApprovalsPanel pending={[approval()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your role is not allowed to decide approvals.",
    );
  });

  test("shows a generic message when the decision fails", async () => {
    const onResolve = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    render(<ApprovalsPanel pending={[approval()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Deny"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The decision could not be saved. Please try again.",
    );
  });

  test("a failed request (false or a thrown error) is reported, success clears it", async () => {
    const onResolve = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    render(<ApprovalsPanel pending={[approval()]} onResolve={onResolve} />);
    fireEvent.click(screen.getByText("Approve"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Approve"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("shows the pending count", () => {
    render(
      <ApprovalsPanel
        pending={[approval(), approval({ id: "ap-2" })]}
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  // ── Critical-path: button disabled while resolving ──────────────────────
  test("buttons are disabled while an approval action is in-flight", async () => {
    // onResolve returns a never-resolving promise to keep the action in flight.
    let resolveOuter: () => void;
    const pending = new Promise<boolean>((res) => {
      resolveOuter = () => res(true);
    });
    const onResolve = vi.fn().mockReturnValue(pending);
    render(<ApprovalsPanel pending={[approval()]} onResolve={onResolve} />);
    const approveBtn = screen.getByText("Approve");
    const denyBtn = screen.getByText("Deny");
    // Fire the action — buttons should immediately go disabled.
    fireEvent.click(approveBtn);
    await waitFor(() => {
      expect(approveBtn).toBeDisabled();
      expect(denyBtn).toBeDisabled();
    });
    // Resolve the action — buttons re-enable.
    await act(async () => {
      resolveOuter();
      await pending;
    });
    await waitFor(() => {
      expect(approveBtn).not.toBeDisabled();
    });
  });

  // ── Critical-path: loading state ─────────────────────────────────────────
  test("shows a loading indicator when isLoading=true and no items", () => {
    render(
      <ApprovalsPanel pending={[]} isLoading={true} onResolve={() => {}} />,
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  test("does not show loading indicator when items are already rendered", () => {
    render(
      <ApprovalsPanel
        pending={[approval()]}
        isLoading={true}
        onResolve={() => {}}
      />,
    );
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.getByText("demo-mcp/case_lookup")).toBeInTheDocument();
  });

  // ── Critical-path: error display ──────────────────────────────────────────
  test("shows an error message when error prop is set", () => {
    render(
      <ApprovalsPanel
        pending={[]}
        error="Failed to load approvals"
        onResolve={() => {}}
      />,
    );
    expect(screen.getByText("Failed to load approvals")).toBeInTheDocument();
  });

  // ── Critical-path: multiple pending items ─────────────────────────────────
  test("renders all pending items and invokes the correct onResolve for each", () => {
    const onResolve = vi.fn().mockResolvedValue(true);
    render(
      <ApprovalsPanel
        pending={[
          approval({ id: "ap-1", tool: "billing/refund" }),
          approval({ id: "ap-2", tool: "db/delete_record" }),
        ]}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText("billing/refund")).toBeInTheDocument();
    expect(screen.getByText("db/delete_record")).toBeInTheDocument();
    // Click Approve on the second card
    const approveBtns = screen.getAllByText("Approve");
    fireEvent.click(approveBtns[1]);
    expect(onResolve).toHaveBeenCalledWith("ap-2", true, expect.anything());
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the SecurityPanel — the dashboard UI for the AI Security Posture
 * features (red-team, tool-authz, flow-as-MCP).
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { SecurityPanel } from "../components/SecurityPanel";
import type {
  RedTeamRunSummary,
  AttackInfo,
  PostureResponse,
  ToolAuthzPolicyView,
  McpServerInfo,
} from "../types/security";

// The panel gates its write controls by role (useCanWrite); admin by default.
const auth = vi.hoisted(() => ({ role: "admin" as string }));
vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({ token: "test-token", ready: true, isAuthenticated: true, role: auth.role }),
}));

const posture: PostureResponse = {
  enabled: true,
  posture: { helpdesk: 0.95, dispatch: 0.6 },
  guardrailThreshold: 0.8,
};

const runs: RedTeamRunSummary[] = [
  {
    id: "run-1",
    flowId: "helpdesk",
    triggeredBy: "manual",
    startedAt: new Date().toISOString(),
    status: "completed",
    bypassRate: 0.1,
    postureScore: 0.9,
    trials: 10,
    bypasses: 1,
    blocks: 9,
    errors: 0,
    regressionCasesGenerated: 1,
  },
];

const attacks: AttackInfo[] = [
  {
    id: "pi-ignore-instructions",
    category: "prompt_injection",
    severity: 0.9,
    description: "Ignore prior instructions",
  },
  {
    id: "jb-dan",
    category: "jailbreak",
    severity: 0.9,
    description: "DAN jailbreak",
  },
];

const toolAuthz: ToolAuthzPolicyView = {
  active: true,
  ruleCount: 1,
  defaultAction: "allow",
  rules: [
    {
      id: "block-refund",
      tool: "billing/refund",
      action: "deny",
      match: { role: "operator" },
      reason: "too risky",
    },
  ],
};

const mcp: McpServerInfo = {
  endpoint: "/mcp",
  transport: "streamable-http",
  flows: [
    { id: "helpdesk", name: "Helpdesk", description: "Support assistant" },
  ],
};

function baseProps() {
  return {
    posture,
    runs,
    attacks,
    toolAuthz,
    mcp,
    redTeamEnabled: true,
    flows: [
      { id: "helpdesk", name: "Helpdesk" },
      { id: "dispatch", name: "Dispatch" },
    ],
    onRun: vi.fn(),
    onViewRun: vi.fn().mockResolvedValue(null),
  };
}

describe("SecurityPanel — posture section", () => {
  test("renders posture scores per flow", () => {
    render(<SecurityPanel {...baseProps()} />);
    expect(screen.getAllByText("helpdesk").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("dispatch")).toBeInTheDocument();
    // helpdesk 95/100
    expect(screen.getByText("95")).toBeInTheDocument();
  });

  test("shows the current guardrail threshold", () => {
    render(<SecurityPanel {...baseProps()} />);
    expect(screen.getByText("0.80")).toBeInTheDocument();
  });

  test("Run Red-Team button is disabled until a flow is selected", () => {
    render(<SecurityPanel {...baseProps()} />);
    const btn = screen.getByText("Run Red-Team");
    expect(btn).toBeDisabled();
  });

  test("a viewer or operator cannot start a red-team run, even with a flow selected", () => {
    for (const role of ["viewer", "operator"]) {
      auth.role = role;
      const { unmount } = render(<SecurityPanel {...baseProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "Flow to red-team" }));
      fireEvent.change(screen.getByLabelText("Search flows"), { target: { value: "helpdesk" } });
      fireEvent.keyDown(screen.getByLabelText("Search flows"), { key: "Enter" });
      const btn = screen.getByText("Run Red-Team").closest("button");
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute("title", "Requires the admin role");
      unmount();
    }
    auth.role = "admin";
  });

  test("selecting a flow enables the run button and onRun is called", () => {
    const props = baseProps();
    render(<SecurityPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Flow to red-team" }));
    fireEvent.change(screen.getByLabelText("Search flows"), { target: { value: "helpdesk" } });
    fireEvent.keyDown(screen.getByLabelText("Search flows"), { key: "Enter" });
    const btn = screen.getByText("Run Red-Team");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(props.onRun).toHaveBeenCalledWith("helpdesk");
  });

  test("lists recent runs with bypass counts and posture", () => {
    render(<SecurityPanel {...baseProps()} />);
    expect(screen.getByText("1/10 bypassed")).toBeInTheDocument();
    expect(screen.getByText("+1 regression")).toBeInTheDocument();
  });

  test("shows disabled hint when red-team engine is off", () => {
    render(<SecurityPanel {...baseProps()} redTeamEnabled={false} />);
    expect(screen.getByText(/RED_TEAM_ENABLED=true/)).toBeInTheDocument();
    expect(screen.getByText("Run Red-Team")).toBeDisabled();
  });
});

describe("SecurityPanel — attack library", () => {
  test("shows all attacks with category and severity", () => {
    render(<SecurityPanel {...baseProps()} />);
    fireEvent.click(screen.getByText(/Attack Library/));
    expect(screen.getByText("pi-ignore-instructions")).toBeInTheDocument();
    expect(screen.getByText("jb-dan")).toBeInTheDocument();
    expect(screen.getAllByText(/sev 0.90/).length).toBe(2);
  });
});

describe("SecurityPanel — tool authorization", () => {
  test("renders active policy rules", () => {
    render(<SecurityPanel {...baseProps()} />);
    fireEvent.click(screen.getByText("Tool Authorization"));
    expect(screen.getByText("block-refund")).toBeInTheDocument();
    expect(screen.getByText("deny")).toBeInTheDocument();
  });

  test("shows empty hint when no policy is active", () => {
    render(
      <SecurityPanel
        {...baseProps()}
        toolAuthz={{
          active: false,
          ruleCount: 0,
          defaultAction: "allow",
          rules: [],
        }}
      />,
    );
    fireEvent.click(screen.getByText("Tool Authorization"));
    expect(
      screen.getByText(/No tool-authorization policy is active/),
    ).toBeInTheDocument();
  });

  test("Edit policy opens a JSON editor prefilled with current rules", () => {
    const props = { ...baseProps(), onSaveToolAuthz: vi.fn() };
    render(<SecurityPanel {...props} />);
    fireEvent.click(screen.getByText("Tool Authorization"));
    fireEvent.click(screen.getByText("Edit policy"));
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(textarea.value).toContain("block-refund");
    expect(textarea.value).toContain("billing/refund");
  });

  test("Save calls onSaveToolAuthz with the parsed policy", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, policy: toolAuthz });
    const props = { ...baseProps(), onSaveToolAuthz: onSave };
    render(<SecurityPanel {...props} />);
    fireEvent.click(screen.getByText("Tool Authorization"));
    fireEvent.click(screen.getByText("Edit policy"));

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ defaultAction: "deny", rules: [] }) },
    });
    fireEvent.click(screen.getByText("Save & reload"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ defaultAction: "deny", rules: [] });
    });
  });

  test("Save surfaces a validation error from the backend", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "rules.0.action: invalid" });
    const props = { ...baseProps(), onSaveToolAuthz: onSave };
    render(<SecurityPanel {...props} />);
    fireEvent.click(screen.getByText("Tool Authorization"));
    fireEvent.click(screen.getByText("Edit policy"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: JSON.stringify({ defaultAction: "allow", rules: [] }) },
    });
    fireEvent.click(screen.getByText("Save & reload"));

    await waitFor(() => {
      expect(screen.getByText(/rules.0.action: invalid/)).toBeInTheDocument();
    });
  });

  test("Save shows a client-side error on malformed JSON without calling the backend", async () => {
    const onSave = vi.fn();
    const props = { ...baseProps(), onSaveToolAuthz: onSave };
    render(<SecurityPanel {...props} />);
    fireEvent.click(screen.getByText("Tool Authorization"));
    fireEvent.click(screen.getByText("Edit policy"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "{ not valid" },
    });
    fireEvent.click(screen.getByText("Save & reload"));

    await waitFor(() => {
      expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  test("no Edit button when onSaveToolAuthz is not provided (read-only)", () => {
    render(<SecurityPanel {...baseProps()} />);
    fireEvent.click(screen.getByText("Tool Authorization"));
    expect(screen.queryByText("Edit policy")).not.toBeInTheDocument();
  });
});

describe("SecurityPanel — flow-as-MCP", () => {
  test("shows the MCP endpoint and exposed flow tools", () => {
    render(<SecurityPanel {...baseProps()} />);
    fireEvent.click(screen.getByText("Flow-as-MCP"));
    expect(screen.getByText(/POST/)).toBeInTheDocument();
    expect(screen.getByText("Support assistant")).toBeInTheDocument();
  });
});

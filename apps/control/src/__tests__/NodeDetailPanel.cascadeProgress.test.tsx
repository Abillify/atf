// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { NodeDetailContent } from "../components/graph/NodeDetailPanel";
import { CascadeSection } from "../components/graph/nodedetail/CascadeSection";
import { ProgressSection } from "../components/graph/nodedetail/ProgressSection";
import type { NodeState } from "../components/graph/graphUtils";
import type {
  DebugNodeDiagnostic,
  HarnessProgress,
} from "../types/debug-trace";

function baseState(overrides: Partial<NodeState> = {}): NodeState {
  return {
    id: "llm-1",
    label: "LLM",
    status: "completed",
    latency_ms: 10,
    nodeType: "llm",
    ...overrides,
  };
}

describe("CascadeSection", () => {
  test("renders nothing without a cascade", () => {
    const { container } = render(<CascadeSection cascade={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("shows an escalated cascade with reasons and both models", () => {
    render(
      <CascadeSection
        cascade={{
          escalated: true,
          reasons: ["groundedness_below_threshold", "repetition_detected"],
          firstModel: "openai/gpt-4o-mini",
          finalModel: "openai/gpt-4o",
        }}
      />,
    );
    expect(screen.getByText("escalated")).toBeInTheDocument();
    expect(screen.getByText("groundedness_below_threshold")).toBeInTheDocument();
    expect(screen.getByText("repetition_detected")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("openai/gpt-4o")).toBeInTheDocument();
  });

  test("shows a kept cascade without a reasons list", () => {
    render(
      <CascadeSection
        cascade={{
          escalated: false,
          reasons: [],
          firstModel: "openai/gpt-4o-mini",
          finalModel: "openai/gpt-4o-mini",
        }}
      />,
    );
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.queryByText("Reasons")).not.toBeInTheDocument();
  });
});

describe("ProgressSection", () => {
  const progress: HarnessProgress = {
    phase: "research",
    tasksDone: 3,
    tasksTotal: 4,
    coverage: { covered: 6, total: 8, open: 2 },
    elapsedMs: 4200,
    etaMs: 1400,
    message: "reviewing document set",
  };

  test("renders nothing without progress", () => {
    const { container } = render(<ProgressSection progress={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("shows phase, task percent, coverage, elapsed and ETA", () => {
    render(<ProgressSection progress={progress} />);
    expect(screen.getByTestId("progress-phase")).toHaveTextContent("research");
    expect(screen.getByTestId("progress-tasks")).toHaveTextContent(
      "3 / 4 (75%)",
    );
    expect(screen.getByTestId("progress-coverage")).toHaveTextContent(
      "6 of 8 covered, 2 open",
    );
    expect(screen.getByTestId("progress-message")).toHaveTextContent(
      "reviewing document set",
    );
  });

  test("omits coverage and ETA when absent", () => {
    render(
      <ProgressSection
        progress={{
          phase: "planning",
          tasksDone: 0,
          tasksTotal: 0,
          elapsedMs: 900,
        }}
      />,
    );
    expect(screen.getByTestId("progress-tasks")).toHaveTextContent("0 / 0 (0%)");
    expect(screen.queryByTestId("progress-coverage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("progress-message")).not.toBeInTheDocument();
  });
});

describe("NodeDetailContent budget stop", () => {
  const budgetDiag: DebugNodeDiagnostic = {
    at: "2026-01-01T00:00:00.000Z",
    level: "warn",
    code: "budget_exceeded",
    message: "Execution budget reached: token limit 1000 (used 1002).",
    details: { kind: "tokens", limit: 1000, used: 1002 },
  };

  test("marks a node whose run was stopped by an execution budget", () => {
    render(<NodeDetailContent state={baseState({ diagnostics: [budgetDiag] })} />);
    const banner = screen.getByTestId("budget-stop-banner");
    expect(banner).toHaveTextContent("Stopped by execution budget");
    expect(banner).toHaveTextContent("token limit 1000");
  });

  test("shows no budget hint for a node without the diagnostic", () => {
    render(<NodeDetailContent state={baseState()} />);
    expect(screen.queryByTestId("budget-stop-banner")).not.toBeInTheDocument();
  });
});

describe("NodeDetailContent cascade and progress wiring", () => {
  test("renders both sections when the trace provided them", () => {
    render(
      <NodeDetailContent
        state={baseState({
          cascade: {
            escalated: true,
            reasons: ["groundedness_below_threshold"],
            firstModel: "openai/gpt-4o-mini",
            finalModel: "openai/gpt-4o",
          },
          progress: {
            phase: "synthesis",
            tasksDone: 4,
            tasksTotal: 4,
            elapsedMs: 9000,
          },
        })}
      />,
    );
    expect(screen.getByText("escalated")).toBeInTheDocument();
    expect(screen.getByTestId("progress-phase")).toHaveTextContent("synthesis");
  });

  test("renders neither section for a plain node", () => {
    render(<NodeDetailContent state={baseState()} />);
    expect(screen.queryByText("escalated")).not.toBeInTheDocument();
    expect(screen.queryByTestId("progress-phase")).not.toBeInTheDocument();
  });
});

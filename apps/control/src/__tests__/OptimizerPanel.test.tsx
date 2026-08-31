// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { OptimizerPanel } from "../components/OptimizerPanel";
import type { OptimizationRun } from "../types/optimizer";

const flows = [
  { id: "helpdesk", name: "Helpdesk" },
  { id: "dispatch", name: "Dispatch" },
];

function doneRun(over: Partial<OptimizationRun> = {}): OptimizationRun {
  return {
    id: "opt-1",
    flowId: "helpdesk",
    targetNodeId: "responder",
    startedAt: new Date().toISOString(),
    status: "done",
    sampleCount: 4,
    baselineScore: 0.7,
    baselineSystemPrompt: "You are helpful.",
    baselineCases: [
      {
        caseId: "auto-1",
        userPrompt: "What is X?",
        responseText: "Baseline answer.",
        score: 0.7,
        passed: true,
      },
    ],
    variants: [
      {
        label: "more-direct",
        systemPrompt: "Answer directly.",
        avgScore: 0.85,
        passRate: 0.9,
        avgLatencyMs: 420,
        totalCost: 0.0012,
        cases: [
          {
            caseId: "auto-1",
            userPrompt: "What is X?",
            responseText: "Variant answer.",
            score: 0.85,
            passed: true,
          },
        ],
      },
    ],
    ...over,
  };
}

describe("OptimizerPanel", () => {
  const noop = () => {};

  test("prompts to select a flow when none is selected", () => {
    render(
      <OptimizerPanel
        flows={flows}
        selectedFlowId=""
        onSelectFlow={noop}
        runs={[]}
        onRun={noop}
        onPromote={noop}
      />,
    );
    expect(
      screen.getByText("Select a flow to view and run optimizations."),
    ).toBeInTheDocument();
  });

  test("shows empty state when a flow is selected but has no runs", () => {
    render(
      <OptimizerPanel
        flows={flows}
        selectedFlowId="helpdesk"
        onSelectFlow={noop}
        runs={[]}
        onRun={noop}
        onPromote={noop}
      />,
    );
    expect(
      screen.getByText(/No optimization runs yet for this flow/),
    ).toBeInTheDocument();
  });

  test("renders a run with baseline + variant scores", () => {
    render(
      <OptimizerPanel
        flows={flows}
        selectedFlowId="helpdesk"
        onSelectFlow={noop}
        runs={[doneRun()]}
        onRun={noop}
        onPromote={noop}
      />,
    );
    expect(screen.getByText("done")).toBeInTheDocument();
    // baseline 70% shown in the run header (visible while collapsed)
    expect(screen.getByText("baseline 70%")).toBeInTheDocument();
    // Variant detail is revealed on expanding the (collapsed-by-default) run card.
    fireEvent.click(screen.getByText("done"));
    expect(screen.getByText("more-direct")).toBeInTheDocument();
  });

  test("triggers onRun with the form options", () => {
    const onRun = vi.fn();
    render(
      <OptimizerPanel
        flows={flows}
        selectedFlowId="helpdesk"
        onSelectFlow={noop}
        runs={[]}
        onRun={onRun}
        onPromote={noop}
      />,
    );
    fireEvent.click(screen.getByText("Run optimization"));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0]![0]).toBe("helpdesk");
    expect(onRun.mock.calls[0]![1]).toMatchObject({
      variantCount: 3,
      minSamples: 5,
      autoPromote: false,
    });
  });

  test("promote button calls onPromote with run id + variant label", () => {
    const onPromote = vi.fn();
    render(
      <OptimizerPanel
        flows={flows}
        selectedFlowId="helpdesk"
        onSelectFlow={noop}
        runs={[doneRun()]}
        onRun={noop}
        onPromote={onPromote}
      />,
    );
    // The run card is open by default for done runs? No — done runs start collapsed.
    // Expand the run card first.
    fireEvent.click(screen.getByText("done"));
    fireEvent.click(screen.getByText("Promote"));
    expect(onPromote).toHaveBeenCalledWith("opt-1", "more-direct");
  });

  test("does not show Promote once a variant was already promoted", () => {
    render(
      <OptimizerPanel
        flows={flows}
        selectedFlowId="helpdesk"
        onSelectFlow={noop}
        runs={[doneRun({ promotedVariant: "more-direct", promotedVersion: 2 })]}
        onRun={noop}
        onPromote={noop}
      />,
    );
    fireEvent.click(screen.getByText("done"));
    expect(screen.queryByText("Promote")).not.toBeInTheDocument();
    expect(screen.getByText("promoted")).toBeInTheDocument();
  });
});

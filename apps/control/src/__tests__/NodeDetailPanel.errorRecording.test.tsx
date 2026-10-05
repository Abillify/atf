// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { NodeDetailContent } from "../components/graph/NodeDetailPanel";
import type { NodeState } from "../components/graph/graphUtils";

function errorState(overrides: Partial<NodeState> = {}): NodeState {
  return {
    id: "llm-1",
    label: "LLM",
    status: "error",
    latency_ms: 12,
    nodeType: "llm",
    error_message: "provider returned 500",
    ...overrides,
  };
}

describe("NodeDetailContent — full error recording", () => {
  test("renders the plain error message when no trace fields are present", () => {
    render(<NodeDetailContent state={errorState()} />);
    expect(screen.getByTestId("node-error-recording")).toBeInTheDocument();
    expect(screen.getByText("provider returned 500")).toBeInTheDocument();
    // no type badge, no diagnostics section
    expect(screen.queryByText("provider_error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("node-diagnostics")).not.toBeInTheDocument();
  });

  test("shows the machine-readable error type badge", () => {
    render(
      <NodeDetailContent
        state={errorState({ error_type: "provider_error" })}
      />,
    );
    expect(screen.getByText("provider_error")).toBeInTheDocument();
  });

  test("renders structured error details", () => {
    render(
      <NodeDetailContent
        state={errorState({ error_details: { status_code: 503 } })}
      />,
    );
    expect(screen.getByText("Details")).toBeInTheDocument();
    // JsonTree renders the key with a trailing colon in the same span
    expect(screen.getByText(/^status_code/)).toBeInTheDocument();
    expect(screen.getByText("503")).toBeInTheDocument();
  });

  test("renders the failing tool result payload", () => {
    render(
      <NodeDetailContent
        state={errorState({
          kind: "tool",
          tool_error_result: { error: "upstream 500" },
        })}
      />,
    );
    expect(screen.getByText("Tool result")).toBeInTheDocument();
    expect(screen.getByText(/upstream 500/)).toBeInTheDocument();
  });

  test("renders the diagnostics timeline (open for an errored node)", () => {
    render(
      <NodeDetailContent
        state={errorState({
          diagnostics: [
            {
              at: "2026-01-01T00:00:01Z",
              level: "warn",
              code: "provider_retry",
              message: "attempt 1 failed, retrying",
            },
            {
              at: "2026-01-01T00:00:02Z",
              level: "error",
              code: "provider_error",
              message: "all retries exhausted",
            },
          ],
        })}
      />,
    );
    const list = screen.getByTestId("node-diagnostics");
    expect(list).toBeInTheDocument();
    expect(screen.getByText("Diagnostics (2)")).toBeInTheDocument();
    expect(screen.getByText("provider_retry")).toBeInTheDocument();
    expect(screen.getByText("attempt 1 failed, retrying")).toBeInTheDocument();
    expect(screen.getByText("all retries exhausted")).toBeInTheDocument();
    // level labels rendered uppercased
    expect(screen.getByText("warn")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  test("a node with only diagnostics (no error) still shows the timeline", () => {
    render(
      <NodeDetailContent
        state={errorState({
          status: "completed",
          error_message: undefined,
          diagnostics: [
            {
              at: "2026-01-01T00:00:01Z",
              level: "warn",
              code: "fallback_model",
              message: "primary model unavailable",
            },
          ],
        })}
      />,
    );
    // no red error block; the accordion is collapsed for a completed node,
    // so expand it before looking for the timeline
    expect(screen.queryByTestId("node-error-recording")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Diagnostics \(1\)/ }));
    expect(screen.getByTestId("node-diagnostics")).toBeInTheDocument();
    expect(screen.getByText("fallback_model")).toBeInTheDocument();
  });

  test("a healthy node renders no error recording at all", () => {
    render(
      <NodeDetailContent
        state={errorState({
          status: "completed",
          error_message: undefined,
        })}
      />,
    );
    expect(screen.queryByTestId("node-error-recording")).not.toBeInTheDocument();
    expect(screen.queryByTestId("node-diagnostics")).not.toBeInTheDocument();
  });
});

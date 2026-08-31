// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { NodeDetailContent } from "../components/graph/NodeDetailPanel";
import type { NodeState } from "../components/graph/graphUtils";

function state(response: string): NodeState {
  return {
    id: "llm-1",
    label: "LLM",
    status: "completed",
    latency_ms: 10,
    nodeType: "llm",
    response,
  };
}

describe("NodeDetailContent markdown links", () => {
  test("renders web and relative links with appropriate navigation behavior", () => {
    render(
      <NodeDetailContent
        state={state("[Docs](https://example.com/docs) [Run](/graph)")}
      />,
    );

    const external = screen.getByRole("link", { name: "Docs" });
    expect(external).toHaveAttribute("href", "https://example.com/docs");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");

    const internal = screen.getByRole("link", { name: "Run" });
    expect(internal).toHaveAttribute("href", "/graph");
    expect(internal).not.toHaveAttribute("target");
  });

  test("renders active-scheme targets as non-clickable text", () => {
    render(
      <NodeDetailContent
        state={state("[Unsafe](javascript:alert(1)) [Data](data:text/html,x)")}
      />,
    );

    expect(screen.getByText("Unsafe")).toBeInTheDocument();
    expect(screen.getByText("Data")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { NodeState } from "../components/graph/graphUtils";
import { NodeCard } from "../components/graph/NodeRenderer";

function state(overrides: Partial<NodeState> = {}): NodeState {
  return { id: "n", label: "Node", status: "error", latency_ms: null, ...overrides };
}

describe("NodeCard error hover tooltip", () => {
  test("a healthy card carries no title attribute", () => {
    const { container } = render(
      <NodeCard state={state({ status: "completed" })} />,
    );
    const root = container.querySelector("[role='button']");
    expect(root?.getAttribute("title")).toBeNull();
  });

  test("an errored card exposes the full recording as a hover title", () => {
    const { container } = render(
      <NodeCard
        state={state({
          error_message: "boom",
          error_type: "provider_error",
          diagnostics: [
            {
              at: "2026-01-01T00:00:01Z",
              level: "warn",
              code: "retry",
              message: "attempt 1 failed",
            },
          ],
        })}
      />,
    );
    const root = container.querySelector("[role='button']");
    expect(root?.getAttribute("title")).toBe(
      "provider_error: boom\n[warn] retry: attempt 1 failed",
    );
  });

  test("the error snippet line repeats the tooltip for a precise hover target", () => {
    const { container } = render(
      <NodeCard state={state({ error_message: "boom" })} />,
    );
    const snippet = container.querySelector(
      "[data-testid='node-error-snippet']",
    );
    expect(snippet?.getAttribute("title")).toBe("boom");
  });

  test("an error node with only a type (no message) still tooltips on the card", () => {
    const { container } = render(
      <NodeCard state={state({ error_type: "timeout" })} />,
    );
    const root = container.querySelector("[role='button']");
    expect(root?.getAttribute("title")).toBe("timeout: no message");
    // no snippet line without a message
    expect(
      container.querySelector("[data-testid='node-error-snippet']"),
    ).toBeNull();
  });
});

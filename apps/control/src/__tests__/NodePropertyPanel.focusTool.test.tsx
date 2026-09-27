// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { NodePropertyPanel } from "../components/NodePropertyPanel";
import type { FlowNode } from "../types/flow";

const node: FlowNode = { id: "assist", type: "llm", tools: ["parking/status", "parking/book_space"] };

describe("NodePropertyPanel focusTool", () => {
  test("opens the Tools section and emphasises the clicked tool", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { container } = render(
      <NodePropertyPanel
        node={node}
        edge={null}
        onNodeChange={() => {}}
        onDeleteNode={() => {}}
        onEdgeChange={() => {}}
        onDeleteEdge={() => {}}
        focusTool={{ tool: "parking/book_space", nonce: 1 }}
      />,
    );
    const section = container.querySelector<HTMLDetailsElement>('[data-section="tools"]');
    expect(section).not.toBeNull();
    const item = container.querySelector('[data-list-item="parking/book_space"]');
    expect(item).toHaveAttribute("data-highlighted", "true");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(section?.open).toBe(true);
    // Jumps to the tool's static arguments and opens them.
    const args = container.querySelector<HTMLDetailsElement>('[data-tool-args="parking/book_space"]');
    expect(args?.open).toBe(true);
    expect(scrollIntoView.mock.contexts[0]).toBe(args);
  });

  test("edits a tool's static arguments in config.toolArgs", () => {
    const onNodeChange = vi.fn();
    const { container } = render(
      <NodePropertyPanel
        node={{ ...node, config: { toolArgs: { "parking/status": { site: "HQ" } } } }}
        edge={null}
        onNodeChange={onNodeChange}
        onDeleteNode={() => {}}
        onEdgeChange={() => {}}
        onDeleteEdge={() => {}}
      />,
    );
    expect(container.querySelector('[data-tool-args="parking/status"] summary')).toHaveTextContent("site");
    const area = container.querySelector<HTMLTextAreaElement>('[data-tool-args="parking/book_space"] textarea');
    if (!area) throw new Error("no editor");
    fireEvent.change(area, { target: { value: '{ "floor": 2 }' } });
    expect(onNodeChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: { toolArgs: { "parking/status": { site: "HQ" }, "parking/book_space": { floor: 2 } } },
      }),
    );
  });
});

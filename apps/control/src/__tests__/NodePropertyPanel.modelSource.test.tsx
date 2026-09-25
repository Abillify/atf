// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import { NodePropertyPanel } from "../components/NodePropertyPanel";
import type { FlowNode } from "../types/flow";

/** Panel with the node held in state, so edits re-render like in the Studio. */
function renderLive(initial: FlowNode) {
  const seen = vi.fn();
  function Host() {
    const [node, setNode] = useState(initial);
    return (
      <NodePropertyPanel
        node={node}
        edge={null}
        onNodeChange={(n) => {
          seen(n);
          setNode(n);
        }}
        onDeleteNode={vi.fn()}
        onEdgeChange={vi.fn()}
        onDeleteEdge={vi.fn()}
      />
    );
  }
  render(<Host />);
  return () => seen.mock.calls.at(-1)?.[0] as FlowNode;
}

describe("model source: shortcut OR provider + model", () => {
  test("a shortcut node shows only the shortcut", () => {
    renderLive({ id: "a", type: "llm", llm: { shortcut: "fast-pool" } as FlowNode["llm"] });
    expect(screen.getByRole("tab", { name: "Shortcut" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Shortcut")).toHaveValue("fast-pool");
    expect(screen.queryByLabelText("Provider")).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();
  });

  test("an explicit node shows only provider + model", () => {
    renderLive({ id: "a", type: "llm", llm: { provider: "openai", model: "gpt" } });
    expect(screen.getByRole("tab", { name: "Provider + model" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Provider")).toHaveValue("openai");
    expect(screen.queryByLabelText("Shortcut")).toBeNull();
  });

  test("switching drops the other side from the node and restores it when switching back", () => {
    const last = renderLive({
      id: "a",
      type: "llm",
      llm: { shortcut: "fast-pool", parameters: { temperature: 0.2 } } as FlowNode["llm"],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Provider + model" }));
    expect(last().llm).toEqual({ parameters: { temperature: 0.2 } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "openai" } });
    expect(last().llm).toMatchObject({ provider: "openai" });
    expect(last().llm).not.toHaveProperty("shortcut");

    fireEvent.click(screen.getByRole("tab", { name: "Shortcut" }));
    expect(last().llm).toEqual({ shortcut: "fast-pool", parameters: { temperature: 0.2 } });
    fireEvent.click(screen.getByRole("tab", { name: "Provider + model" }));
    expect(last().llm).toMatchObject({ provider: "openai" });
  });

  test("a node carrying both is flagged and can be cleaned up", () => {
    const last = renderLive({ id: "a", type: "llm", llm: { shortcut: "fast-pool", provider: "openai", model: "gpt" } as FlowNode["llm"] });
    expect(screen.getByRole("alert")).toHaveTextContent("openai · gpt");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(last().llm).toEqual({ shortcut: "fast-pool" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

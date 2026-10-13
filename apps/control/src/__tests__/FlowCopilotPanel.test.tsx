// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import { FlowCopilotPanel, describeCopilotFocus } from "../components/FlowCopilotPanel";
import type { FlowDefinition } from "../types/flow";

const definition: FlowDefinition = {
  id: "f1",
  name: "Flow 1",
  nodes: [{ id: "router", type: "router" }],
  edges: [],
};

function mockFetchOnce(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 422,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("FlowCopilotPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("shows the explanation and accept/reject controls on a successful proposal", async () => {
    const proposed: FlowDefinition = {
      ...definition,
      nodes: [...definition.nodes, { id: "guard", type: "tool" }],
    };
    mockFetchOnce({
      ok: true,
      proposed,
      diff: {
        changed: true,
        metadataChanged: false,
        nodes: { added: ["guard"], removed: [], changed: [] },
        edges: { added: [], removed: [], changed: [] },
        summary: "+1 node(s)",
      },
      explanation: "Added a guard tool node.",
    });

    const onAccept = vi.fn();
    const onPreviewChange = vi.fn();

    render(
      <FlowCopilotPanel
        flowId="f1"
        getDefinition={() => definition}
        nodes={[]}
        edges={[]}
        onPreviewChange={onPreviewChange}
        onAccept={onAccept}
      />,
    );

    fireEvent.change(screen.getByLabelText("Copilot instruction"), {
      target: { value: "add a guard node" },
    });
    fireEvent.click(screen.getByText("Ask"));

    await waitFor(() =>
      expect(screen.getByText("Added a guard tool node.")).toBeInTheDocument(),
    );
    expect(onPreviewChange).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Accept"));
    expect(onAccept).toHaveBeenCalledWith(proposed);
    // Accepting clears the preview overlay.
    expect(onPreviewChange).toHaveBeenLastCalledWith(undefined);
  });

  test("shows the refusal message and validation detail without offering accept", async () => {
    mockFetchOnce(
      {
        ok: false,
        message: "The proposed edit would make the flow invalid — nothing was changed.",
        validation: {
          valid: false,
          errors: [{ path: "edges[0]", message: "unknown target" }],
          warnings: [],
          meta: { nodeCount: 1, edgeCount: 1 },
        },
      },
      false,
    );

    render(
      <FlowCopilotPanel
        flowId="f1"
        getDefinition={() => definition}
        nodes={[]}
        edges={[]}
        onPreviewChange={vi.fn()}
        onAccept={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Copilot instruction"), {
      target: { value: "wire it up" },
    });
    fireEvent.click(screen.getByText("Ask"));

    await waitFor(() =>
      expect(
        screen.getByText(/nothing was changed/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/unknown target/)).toBeInTheDocument();
    expect(screen.queryByText("Accept")).not.toBeInTheDocument();
  });

  test("prefill prop fills and focuses the instruction field", () => {
    render(
      <FlowCopilotPanel
        flowId="f1"
        getDefinition={() => definition}
        nodes={[]}
        edges={[]}
        onPreviewChange={vi.fn()}
        onAccept={vi.fn()}
        prefill={{ instruction: "Fix this issue: bad edge", nonce: 1 }}
      />,
    );
    expect(screen.getByLabelText("Copilot instruction")).toHaveValue(
      "Fix this issue: bad edge",
    );
  });
});

describe("FlowCopilotPanel — selection", () => {
  const renderWithFocus = () =>
    render(
      <FlowCopilotPanel
        flowId="f1"
        getDefinition={() => definition}
        nodes={[]}
        edges={[]}
        onPreviewChange={() => {}}
        onAccept={() => {}}
        focus={{ nodeIds: ["router"], field: "systemPrompt", fieldSelection: "be brief" }}
      />,
    );
  const ask = () => {
    fireEvent.change(screen.getByLabelText("Copilot instruction"), { target: { value: "shorten this" } });
    fireEvent.click(screen.getByText("Ask"));
  };
  const sentBody = () =>
    JSON.parse(String(((global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit).body));

  test("shows and sends the selection", async () => {
    mockFetchOnce({ ok: false, message: "No change" }, false);
    renderWithFocus();
    expect(screen.getByTestId("copilot-focus")).toHaveTextContent("node router · field systemPrompt · selected “be brief”");
    ask();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody().focus).toEqual({ nodeIds: ["router"], field: "systemPrompt", fieldSelection: "be brief" });
  });

  test("can be switched off", async () => {
    mockFetchOnce({ ok: false, message: "No change" }, false);
    renderWithFocus();
    fireEvent.click(screen.getByRole("checkbox"));
    ask();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody().focus).toBeUndefined();
  });

  test("describes several nodes and an edge", () => {
    expect(describeCopilotFocus({ nodeIds: ["a", "b"], edge: { source: "a", target: "b" } })).toBe(
      "2 nodes (a, b) · edge a → b",
    );
  });
});

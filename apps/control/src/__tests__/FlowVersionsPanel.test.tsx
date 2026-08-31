// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { FlowVersionsPanel } from "../components/FlowVersionsPanel";
import type { FlowVersionEntry, FlowDiffResponse } from "../types/flow";
import type { useFlows } from "../hooks/useFlows";

const versions: FlowVersionEntry[] = [
  {
    flowId: "helpdesk",
    version: 2,
    definition: { id: "helpdesk", name: "v2", nodes: [], edges: [] },
    publishedAt: "2026-02-01T10:00:00.000Z",
    publishedBy: "alice",
  },
  {
    flowId: "helpdesk",
    version: 1,
    definition: { id: "helpdesk", name: "v1", nodes: [], edges: [] },
    publishedAt: "2026-01-01T10:00:00.000Z",
    publishedBy: null,
  },
];

const diffResponse: FlowDiffResponse = {
  from: { kind: "version", version: 1 },
  to: { kind: "version", version: 2 },
  diff: {
    changed: true,
    metadataChanged: false,
    nodes: {
      added: ["new-node"],
      removed: [],
      changed: [{ id: "answer", changedFields: ["llm"] }],
    },
    edges: { added: [], removed: [], changed: [] },
    summary: "+1 node(s), ~1 node(s)",
  },
};

function mockActions(
  over: Partial<ReturnType<typeof useFlows>> = {},
): ReturnType<typeof useFlows> {
  return {
    flows: [],
    onlineEditing: true,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
    get: vi.fn(),
    validate: vi.fn(),
    saveDraft: vi.fn(),
    publish: vi.fn(),
    remove: vi.fn(),
    listVersions: vi.fn().mockResolvedValue(versions),
    rollback: vi.fn().mockResolvedValue(true),
    diff: vi.fn().mockResolvedValue(diffResponse),
    ...over,
  } as unknown as ReturnType<typeof useFlows>;
}

describe("FlowVersionsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("lists published versions", async () => {
    render(
      <FlowVersionsPanel
        flowId="helpdesk"
        editable
        actions={mockActions()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText(/alice/)).toBeInTheDocument();
  });

  test("shows a structural diff when Diff is clicked", async () => {
    const actions = mockActions();
    render(
      <FlowVersionsPanel
        flowId="helpdesk"
        editable
        actions={actions}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    await waitFor(() =>
      expect(screen.getByTestId("flow-diff")).toBeInTheDocument(),
    );
    expect(actions.diff).toHaveBeenCalledWith("helpdesk", { from: 1, to: 2 });
    expect(screen.getByText("+ new-node")).toBeInTheDocument();
    expect(screen.getByText("~ answer (llm)")).toBeInTheDocument();
  });

  test("rolls back to a version after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onRolledBack = vi.fn();
    const actions = mockActions();
    render(
      <FlowVersionsPanel
        flowId="helpdesk"
        editable
        actions={actions}
        onClose={() => {}}
        onRolledBack={onRolledBack}
      />,
    );
    await waitFor(() => expect(screen.getByText("v1")).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("Rollback")[0]!);
    await waitFor(() =>
      expect(actions.rollback).toHaveBeenCalledWith("helpdesk", 2),
    );
    expect(onRolledBack).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test("hides rollback buttons when not editable", async () => {
    render(
      <FlowVersionsPanel
        flowId="helpdesk"
        editable={false}
        actions={mockActions()}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    expect(screen.queryByText("Rollback")).not.toBeInTheDocument();
  });

  test("compares published → draft", async () => {
    const actions = mockActions();
    render(
      <FlowVersionsPanel
        flowId="helpdesk"
        editable
        actions={actions}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText("v2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Diff published → draft"));
    await waitFor(() =>
      expect(actions.diff).toHaveBeenCalledWith("helpdesk", { draft: true }),
    );
  });
});

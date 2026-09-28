// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { describe, test, expect, vi, afterEach } from "vitest";
import type React from "react";
import { StudioBuilder } from "../components/StudioBuilder";
import type { FlowDefinition, FlowListEntry } from "../types/flow";

// AUTHN_MODE=disabled: no token, but the operator plane is open.
vi.mock("../lib/auth/useAuth", () => ({
  useAuth: () => ({
    token: undefined,
    ready: true,
    isAuthenticated: true,
    renewNow: async () => null,
  }),
}));

// The real React Flow canvas needs layout APIs jsdom lacks; list node ids instead.
vi.mock("../components/FlowCanvas", () => ({
  FlowCanvas: ({
    nodes,
    edges,
    nodeOrigins,
    onSelectionChange,
    onSelectSubflow,
    nodeValidation,
  }: {
    nodes: { id: string }[];
    edges: { source: string; target: string }[];
    nodeOrigins?: Record<string, string>;
    onSelectionChange?: (n: string[], e: string[]) => void;
    onSelectSubflow?: (path: string) => void;
    nodeValidation?: Map<string, unknown>;
  }) => (
    <div data-testid="canvas">
      <ul>
        {nodes.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onSelectionChange?.([n.id], [])}>
              {n.id}
            </button>
          </li>
        ))}
      </ul>
      <ul>
        {edges.map((e) => (
          <li key={`${e.source}-${e.target}`}>{`edge:${e.source}->${e.target}`}</li>
        ))}
      </ul>
      {/* Selecting a whole sub-flow group (mirrors clicking its box label).
          Real React Flow also fires onSelectionChange for the group's nodes
          when they get programmatically selected, so the mock does too. */}
      <ul>
        {[...new Set(Object.values(nodeOrigins ?? {}))].map((p) => {
          const groupIds = Object.entries(nodeOrigins ?? {})
            .filter(([, path]) => path === p)
            .map(([id]) => id);
          return (
            <li key={p}>
              <button
                type="button"
                onClick={() => {
                  onSelectSubflow?.(p);
                  onSelectionChange?.(groupIds, []);
                }}
              >{`select-group:${p}`}</button>
            </li>
          );
        })}
      </ul>
      <span data-testid="ringed">{nodeValidation?.size ?? 0}</span>
    </div>
  ),
}));
vi.mock("../components/FlowCopilotPanel", () => ({
  FlowCopilotPanel: (): React.JSX.Element | null => null,
}));
vi.mock("../components/FlowRunDrawer", () => ({
  FlowRunDrawer: (): React.JSX.Element | null => null,
}));
vi.mock("../components/FlowVersionBar", () => ({
  FlowVersionBar: (): React.JSX.Element | null => null,
}));

const definition = {
  id: "casework",
  name: "Casework",
  variables: { collection: "cases" },
  pricing: { "gpt-4o-mini": { prompt: 0.15, completion: 0.6 } },
  nodes: [
    { id: "router", type: "router" },
    { id: "answer", type: "llm", llm: { provider: "openai", model: "m" } },
  ],
  edges: [{ source: "router", target: "answer" }],
} as FlowDefinition;

const entry: FlowListEntry = {
  id: "casework",
  name: "Casework",
  source: "file",
  status: "file",
  version: 0,
  hasDraft: false,
  draftDirty: false,
  editable: false,
  nodeCount: 2,
  edgeCount: 1,
};

function mockBackend(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const body = (() => {
      if (url.endsWith("/flows/validate")) {
        return { valid: true, errors: [], warnings: [], meta: { nodeCount: 2, edgeCount: 1 } };
      }
      if (url.endsWith("/flows/casework/draft") && init?.method === "PUT") {
        return {
          record: { version: 0 },
          validation: { valid: true, errors: [], warnings: [], meta: { nodeCount: 2, edgeCount: 1 } },
        };
      }
      if (url.endsWith("/flows/casework")) {
        return { id: "casework", source: "file", editable: false, version: 0, published: definition, draft: null };
      }
      return {};
    })();
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("StudioBuilder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loads the selected flow onto the canvas without an auth token", async () => {
    mockBackend();
    render(<StudioBuilder flow={entry} onlineEditing />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    expect(screen.getByText("router")).toBeInTheDocument();
    expect(screen.getByText("file")).toBeInTheDocument();
  });

  test("Save draft stores the canvas via PUT /draft and keeps flow-level fields", async () => {
    const fetchMock = mockBackend();
    const onSaved = vi.fn();
    render(<StudioBuilder flow={entry} onlineEditing onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("casework"));

    const call = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith("/flows/casework/draft") && init?.method === "PUT",
    );
    expect(call).toBeDefined();
    const sent = JSON.parse(String(call![1].body)) as Record<string, unknown>;
    expect(sent["variables"]).toEqual({ collection: "cases" });
    expect(sent["pricing"]).toEqual(definition["pricing" as keyof FlowDefinition]);
    expect(screen.getByText(/Draft saved/)).toBeInTheDocument();
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  test("a freshly opened flow is not reported as having unsaved changes", async () => {
    mockBackend();
    const onDirtyChange = vi.fn();
    const { rerender } = render(
      <StudioBuilder flow={null} onlineEditing onDirtyChange={onDirtyChange} />,
    );
    await waitFor(() => expect(screen.getByText("llm-1")).toBeInTheDocument());
    expect(screen.queryByText("● unsaved")).not.toBeInTheDocument();

    rerender(<StudioBuilder flow={entry} onlineEditing onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    expect(screen.queryByText("● unsaved")).not.toBeInTheDocument();
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  test("hides draft/publish when the backend has no flow store", async () => {
    mockBackend();
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Save draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write to file" })).toBeInTheDocument();
  });

  test("includes a sub-flow from the palette; saving writes its nodes with their origin", async () => {
    const fetchMock = mockBackend();
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/flows/subflows")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ subflows: [{ path: "subflows/lib.yaml", nodeIds: ["recall"], edgeCount: 1, usedBy: [] }] }),
        });
      }
      if (String(url).includes("/flows/subflows/content")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            path: "subflows/lib.yaml",
            nodes: [{ id: "recall", type: "memory" }],
            edges: [{ source: "answer", target: "recall" }],
            edgeOrigins: { "answer->recall": "subflows/lib.yaml" },
          }),
        });
      }
      if (String(url).endsWith("/flows/write")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, fileName: "casework.yaml" }) });
      }
      return base?.(url, init);
    });
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Include/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Include" }));
    await waitFor(() => expect(screen.getByText("recall")).toBeInTheDocument());
    expect(screen.getByText("edge:answer->recall")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    vi.spyOn(window, "confirm").mockReturnValue(true); // "write into casework.yaml?"
    fireEvent.click(screen.getByRole("button", { name: "Write to file" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/flows/write"))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/flows/write"));
    const sent = JSON.parse(String(call?.[1]?.body)) as { definition: FlowDefinition };
    expect(sent.definition.metadata?.["$includeOrigins"]).toEqual({ recall: "subflows/lib.yaml" });
    expect(sent.definition.metadata?.["$includeEdgeOrigins"]).toEqual({ "answer->recall": "subflows/lib.yaml" });
  });

  test("offers no file write when the runtime has file writing disabled", async () => {
    mockBackend();
    render(<StudioBuilder flow={entry} onlineEditing />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Write to file" })).not.toBeInTheDocument();
  });

  test("edits the source form of a file flow, not the expanded one", async () => {
    const fetchMock = mockBackend();
    const source = {
      ...definition,
      nodes: [
        { id: "router", type: "router" },
        { id: "answer", type: "llm", llm: { shortcut: "{{vars.model_main}}" } },
      ],
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const body = url.endsWith("/flows/casework")
        ? {
            id: "casework",
            source: "file",
            published: definition,
            draft: null,
            sourceDefinition: source,
            file: { name: "casework.yaml", format: "yaml" },
          }
        : url.endsWith("/flows/casework/draft") && init?.method === "PUT"
          ? { record: { version: 0 } }
          : { valid: true, errors: [], warnings: [], meta: { nodeCount: 2, edgeCount: 1 } };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    });
    const onSaved = vi.fn();
    render(<StudioBuilder flow={entry} onlineEditing onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(
      ([u, i]) => String(u).endsWith("/draft") && (i as RequestInit)?.method === "PUT",
    )!;
    const sent = JSON.parse(String((put[1] as RequestInit).body)) as {
      nodes: Array<{ id: string; llm?: unknown }>;
    };
    expect(sent.nodes.find((n) => n.id === "answer")?.llm).toEqual({
      shortcut: "{{vars.model_main}}",
    });
  });

  test("renaming a node follows edges and parallel references", async () => {
    mockBackend();
    render(<StudioBuilder flow={entry} onlineEditing />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    fireEvent.click(screen.getByText("answer"));
    fireEvent.click(await screen.findByRole("button", { name: "rename" }));
    const input = screen.getByLabelText("Node id");
    fireEvent.change(input, { target: { value: "reply" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("edge:router->reply")).toBeInTheDocument());
    expect(screen.queryByText("answer")).not.toBeInTheDocument();
    expect(screen.getByText(/Renamed answer → reply/)).toBeInTheDocument();
  });

  test("rejects a rename to an existing id", async () => {
    mockBackend();
    render(<StudioBuilder flow={entry} onlineEditing />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    fireEvent.click(screen.getByText("answer"));
    fireEvent.click(await screen.findByRole("button", { name: "rename" }));
    const input = screen.getByLabelText("Node id");
    fireEvent.change(input, { target: { value: "router" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
  });

  test("keyboard delete only acts while working in the builder", async () => {
    mockBackend();
    const outside = document.createElement("p");
    outside.textContent = "sidebar text";
    document.body.appendChild(outside);
    render(<StudioBuilder flow={entry} onlineEditing />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());

    const canvas = () => within(screen.getByTestId("canvas"));
    const answerBtn = canvas().getByText("answer");
    fireEvent.pointerDown(answerBtn);
    fireEvent.click(answerBtn);
    // …then the operator clicks elsewhere on the page: Backspace must not delete.
    fireEvent.pointerDown(outside);
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(canvas().getByText("answer")).toBeInTheDocument();

    fireEvent.pointerDown(answerBtn);
    fireEvent.keyDown(document.body, { key: "Backspace" });
    await waitFor(() => expect(canvas().queryByText("answer")).not.toBeInTheDocument());
    outside.remove();
  });

  test("unknown MCP tools are summarised per server instead of ringing nodes", async () => {
    const fetchMock = mockBackend();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url.endsWith("/flows/validate")
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              valid: true,
              errors: [],
              warnings: [
                { path: "nodes[1](answer).tools", message: 'tool "taiga/detail" is not known to any connected MCP server' },
                { path: "nodes[1](answer).tools", message: 'tool "taiga/list" is not known to any connected MCP server' },
              ],
              meta: { nodeCount: 2, edgeCount: 1 },
            }),
          })
        : base(url, init),
    );
    render(<StudioBuilder flow={entry} onlineEditing />);
    await waitFor(() =>
      expect(screen.getByText("1 MCP server(s) not connected")).toBeInTheDocument(),
    );
    expect(screen.queryByText(/warning\(s\)/)).not.toBeInTheDocument();
    expect(screen.getByTestId("ringed").textContent).toBe("0");
  });

  // A backend that also serves the sub-flow include/content/write endpoints.
  function mockBackendWithSubflows(): ReturnType<typeof vi.fn> {
    const fetchMock = mockBackend();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/flows/subflows")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ subflows: [{ path: "subflows/lib.yaml", nodeIds: ["recall"], edgeCount: 1, usedBy: [] }] }),
        });
      }
      if (u.includes("/flows/subflows/content")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            path: "subflows/lib.yaml",
            nodes: [{ id: "recall", type: "memory" }],
            edges: [{ source: "answer", target: "recall" }],
            edgeOrigins: { "answer->recall": "subflows/lib.yaml" },
          }),
        });
      }
      if (u.endsWith("/flows/subflows/write")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ hash: "abc123" }) });
      }
      return base(u, init);
    });
    return fetchMock;
  }

  /** Include subflows/lib.yaml, then select its group as a whole. */
  async function includeAndSelectGroup(): Promise<void> {
    fireEvent.click(screen.getByRole("button", { name: /Include/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Include" }));
    await waitFor(() => expect(screen.getByText("recall")).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    fireEvent.click(screen.getByText("select-group:subflows/lib.yaml"));
    await screen.findByTestId("subflow-group-panel");
  }

  test("selecting a sub-flow group shows its action panel", async () => {
    mockBackendWithSubflows();
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    await includeAndSelectGroup();
    const panel = within(screen.getByTestId("subflow-group-panel"));
    expect(panel.getByRole("heading")).toHaveTextContent("lib.yaml");
    expect(panel.getByRole("button", { name: /Save this sub-flow/ })).toBeInTheDocument();
    expect(panel.getByRole("button", { name: /Remove from this flow/ })).toBeInTheDocument();
  });

  test("clicking the single node of a one-node sub-flow edits the node, not the group", async () => {
    mockBackendWithSubflows();
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());

    // Include the one-node sub-flow (its only node is "recall").
    fireEvent.click(screen.getByRole("button", { name: /Include/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Include" }));
    await waitFor(() => expect(screen.getByText("recall")).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));

    // Clicking the node itself must open the node's property panel, NOT the
    // sub-flow group panel — even though the node IS the whole sub-flow.
    const canvas = within(screen.getByTestId("canvas"));
    fireEvent.click(canvas.getByText("recall"));
    expect(await screen.findByRole("button", { name: "rename" })).toBeInTheDocument();
    expect(screen.queryByTestId("subflow-group-panel")).not.toBeInTheDocument();
  });

  test("selecting a group then clicking a node inside it returns to the node panel", async () => {
    mockBackendWithSubflows();
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    await includeAndSelectGroup();
    expect(screen.getByTestId("subflow-group-panel")).toBeInTheDocument();

    // Clicking the node clears the explicit group selection.
    fireEvent.click(within(screen.getByTestId("canvas")).getByText("recall"));
    await waitFor(() => expect(screen.queryByTestId("subflow-group-panel")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "rename" })).toBeInTheDocument();
  });

  test("Save this sub-flow writes just its file via /flows/subflows/write", async () => {
    const fetchMock = mockBackendWithSubflows();
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    await includeAndSelectGroup();

    // A freshly included sub-flow is dirty (not yet on disk in this flow), so
    // "Save this sub-flow" is enabled.
    fireEvent.click(within(screen.getByTestId("subflow-group-panel")).getByRole("button", { name: /Save this sub-flow/ }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/flows/subflows/write"))).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/flows/subflows/write"));
    const sent = JSON.parse(String(call?.[1]?.body)) as { path: string; nodes: { id: string }[]; edges: unknown[] };
    expect(sent.path).toBe("subflows/lib.yaml");
    expect(sent.nodes.map((n) => n.id)).toEqual(["recall"]);
    // answer->recall was recorded in $includeEdgeOrigins for this file on
    // include, so it is written back into the sub-flow file (matching how the
    // runtime resolves it on the next load).
    expect(sent.edges).toEqual([{ source: "answer", target: "recall" }]);
    await waitFor(() => expect(screen.getByText(/Saved lib.yaml to its file/)).toBeInTheDocument());
  });

  test("Remove from this flow drops the group's nodes but keeps the parent", async () => {
    mockBackendWithSubflows();
    render(<StudioBuilder flow={entry} onlineEditing={false} fileWriting />);
    await waitFor(() => expect(screen.getByText("answer")).toBeInTheDocument());
    await includeAndSelectGroup();
    const canvas = () => within(screen.getByTestId("canvas"));
    expect(canvas().getByText("recall")).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId("subflow-group-panel")).getByRole("button", { name: /Remove from this flow/ }));
    await waitFor(() => expect(canvas().queryByText("recall")).not.toBeInTheDocument());
    // Parent nodes stay.
    expect(canvas().getByText("answer")).toBeInTheDocument();
    expect(canvas().getByText("router")).toBeInTheDocument();
    expect(screen.getByText(/Removed sub-flow lib.yaml/)).toBeInTheDocument();
  });
});

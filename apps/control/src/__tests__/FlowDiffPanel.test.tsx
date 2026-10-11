// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, test, expect, vi, afterEach } from "vitest";
import { FlowDiffPanel } from "../components/FlowDiffPanel";

// Req 9.2: Das Panel nutzt TanStack Query — frischer Client pro Test.
function renderPanel(ui: React.ReactElement): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function mockDiff(diff: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ from: { kind: "file", file: "n8n.yaml" }, to: { kind: "draft" }, diff }),
  }) as unknown as typeof fetch;
}

const base = {
  changed: true,
  metadataChanged: false,
  edges: { added: [], removed: [], changed: [] },
  summary: "~1 node(s)",
};

describe("FlowDiffPanel details", () => {
  afterEach(() => vi.restoreAllMocks());

  test("a changed node expands to what changed in its config", async () => {
    mockDiff({
      ...base,
      nodes: {
        added: [],
        removed: [],
        changed: [
          {
            id: "n8n-responder",
            changedFields: ["config"],
            details: [
              { path: "config.routing.strategy", kind: "changed", from: "cheapest", to: "balanced" },
              { path: "config.routing.candidates[1]", kind: "added", to: { shortcut: "sonnet" } },
            ],
          },
        ],
      },
    });
    renderPanel(<FlowDiffPanel flowId="n8n" draftMode />);
    const row = (await screen.findByText("node: n8n-responder")).closest("details");
    expect(row).not.toBeNull();
    const values = within(row as HTMLElement).getAllByTestId("diff-value");
    expect(values).toHaveLength(2);
    expect(values[0]).toHaveTextContent("config.routing.strategy");
    expect(
      within(values[0] as HTMLElement).getByLabelText("Change of config.routing.strategy").querySelector("ins"),
    ).toHaveTextContent("balanced");
    expect(values[1]).toHaveTextContent('"shortcut": "sonnet"');
  });

  test("an added node expands to its definition; an older runtime's diff stays a plain row", async () => {
    mockDiff({
      ...base,
      nodes: { added: ["extra"], removed: [], changed: [{ id: "old", changedFields: ["label"] }] },
      values: { nodes: { added: { extra: { id: "extra", type: "tool" } }, removed: {} }, edges: { added: {}, removed: {} } },
    });
    renderPanel(<FlowDiffPanel flowId="n8n" draftMode />);
    const added = (await screen.findByText("node: extra")).closest("details");
    expect(added).toHaveTextContent('"type": "tool"');
    expect(screen.getByText("node: old").closest("details")).toBeNull();
  });
});

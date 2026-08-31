// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FlowsTab } from "../components/FlowsTab";

function mockList(onlineEditing: boolean) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      flows: [
        {
          id: "file-flow",
          name: "File Flow",
          source: "file",
          status: "file",
          version: 0,
          hasDraft: false,
          draftDirty: false,
          editable: false,
          nodeCount: 3,
          edgeCount: 2,
        },
        {
          id: "online-flow",
          name: "Online Flow",
          source: "online",
          status: "published",
          version: 2,
          hasDraft: false,
          draftDirty: false,
          editable: true,
          nodeCount: 1,
          edgeCount: 0,
        },
      ],
      onlineEditing,
    }),
  });
}

describe("FlowsTab", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  test("renders file and online flows with the right actions", async () => {
    vi.stubGlobal("fetch", mockList(true));
    render(<FlowsTab />);
    await waitFor(() =>
      expect(screen.getByText("File Flow")).toBeInTheDocument(),
    );
    expect(screen.getByText("Online Flow")).toBeInTheDocument();
    // file flow → Inspect, online flow → Edit
    expect(screen.getByText("Inspect")).toBeInTheDocument();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    // New flow button visible when online editing is enabled
    expect(screen.getByText("+ New flow")).toBeInTheDocument();
  });

  test("shows the disabled hint and no New-flow button when online editing is off", async () => {
    vi.stubGlobal("fetch", mockList(false));
    render(<FlowsTab />);
    await waitFor(() =>
      expect(screen.getByText("File Flow")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Online editing is disabled/)).toBeInTheDocument();
    expect(screen.queryByText("+ New flow")).not.toBeInTheDocument();
  });
});

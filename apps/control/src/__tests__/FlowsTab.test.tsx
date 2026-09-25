// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FlowsTab, studioHref } from "../components/FlowsTab";

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
    // file flow → Inspect, online flow → Edit; both open the flow in Studio
    expect(screen.getByText("Inspect").closest("a")).toHaveAttribute(
      "href",
      "/studio?flow=file-flow",
    );
    expect(screen.getByText("Edit").closest("a")).toHaveAttribute(
      "href",
      "/studio?flow=online-flow",
    );
    // New flow opens an empty Studio canvas
    expect(screen.getByText("+ New flow").closest("a")).toHaveAttribute(
      "href",
      "/studio",
    );
    expect(screen.getByText("Import")).toBeInTheDocument();
    // Only the online flow can be deleted
    expect(screen.getAllByText("Delete")).toHaveLength(1);
    expect(screen.getAllByText("Export")).toHaveLength(2);
  });

  test("shows the disabled hint and no New-flow button when online editing is off", async () => {
    vi.stubGlobal("fetch", mockList(false));
    render(<FlowsTab />);
    await waitFor(() =>
      expect(screen.getByText("File Flow")).toBeInTheDocument(),
    );
    expect(screen.getByText(/Online editing is disabled/)).toBeInTheDocument();
    expect(screen.queryByText("+ New flow")).not.toBeInTheDocument();
    expect(screen.queryByText("Import")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  test("studioHref encodes the flow id", () => {
    expect(studioHref()).toBe("/studio");
    expect(studioHref("a b/c")).toBe("/studio?flow=a%20b%2Fc");
  });
});

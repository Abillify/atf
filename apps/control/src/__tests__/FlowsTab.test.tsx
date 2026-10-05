// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { FlowsTab, formatDuration, studioHref } from "../components/FlowsTab";

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

/** Routes the flows list and the /monitoring/flow-stats call to separate mocks. */
function mockListAndStats(onlineEditing: boolean) {
  const list = mockList(onlineEditing);
  return vi.fn((input: unknown) =>
    String(input).includes("flow-stats")
      ? Promise.resolve({
          ok: true,
          json: async () => ({
            stats: [
              {
                flow_id: "file-flow",
                runs: 7,
                avg_latency_ms: 1234,
                avg_cost: 0.0125,
                total_cost: 0.0375,
              },
            ],
          }),
        })
      : list(),
  );
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

  test("renders per-flow stats columns and dashes for flows without runs", async () => {
    vi.stubGlobal("fetch", mockListAndStats(true));
    render(<FlowsTab />);
    await waitFor(() =>
      expect(screen.getByText("File Flow")).toBeInTheDocument(),
    );
    expect(screen.getByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("Avg runtime")).toBeInTheDocument();
    expect(screen.getByText("Avg cost")).toBeInTheDocument();
    expect(screen.getByText("Total cost")).toBeInTheDocument();
    // file-flow has stats: 7 runs, 1234 ms → 1.2 s, costs trimmed of zeros
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("1.2 s")).toBeInTheDocument();
    expect(screen.getByText("\u20ac0.0125")).toBeInTheDocument();
    expect(screen.getByText("\u20ac0.0375")).toBeInTheDocument();
    // online-flow has no runs in the window → four em-dash cells
    expect(screen.getAllByText("\u2014")).toHaveLength(4);
  });

  test("range selector defaults to 1d and refetches stats on change", async () => {
    const fetchMock = mockListAndStats(true);
    vi.stubGlobal("fetch", fetchMock);
    render(<FlowsTab />);
    await waitFor(() =>
      expect(screen.getByText("File Flow")).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("group", { name: "Stats time range" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1d" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const statsCalls = (): string[] =>
      fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("flow-stats"));
    expect(statsCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
    expect(screen.getByRole("button", { name: "1h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "1d" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The 1h window starts later than the 1d window's did.
    const sinceOf = (u: string): number =>
      Date.parse(
        new URL(u, "http://localhost").searchParams.get("since") ?? "",
      );
    expect(sinceOf(statsCalls()[1])).toBeGreaterThan(sinceOf(statsCalls()[0]));
  });
});

describe("formatDuration", () => {
  test("formats ms, seconds and minutes", () => {
    expect(formatDuration(999)).toBe("999 ms");
    expect(formatDuration(1000)).toBe("1.0 s");
    expect(formatDuration(59_999)).toBe("60.0 s");
    expect(formatDuration(60_000)).toBe("1.0 min");
    expect(formatDuration(90_000)).toBe("1.5 min");
  });
});

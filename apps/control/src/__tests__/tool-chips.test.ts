// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, test } from "vitest";
import type { NodeState } from "../components/graph/graphUtils";
import { matchesToolRef, toolCallsByParent, toolChipsFor, toolRailSize } from "../lib/tool-chips";

const call = (label: string, status: NodeState["status"], sequence: number, parent = "assist"): NodeState => ({
  id: `${parent}::tool::${sequence}`,
  label,
  status,
  latency_ms: status === "running" ? null : 40,
  kind: "tool",
  parent_node_id: parent,
  sequence,
});

describe("matchesToolRef", () => {
  test("matches the runtime's tool key of a server/tool ref", () => {
    expect(matchesToolRef("tickets/lookup", "tickets__lookup")).toBe(true);
    expect(matchesToolRef("my-mcp.io/get doc", "my-mcp_io__get_doc")).toBe(true);
    expect(matchesToolRef("tickets/lookup", "tickets__lookup_2")).toBe(true);
    expect(matchesToolRef("tickets/lookup", "tickets__create")).toBe(false);
  });
  test("matches a ref without a server part and patterns", () => {
    expect(matchesToolRef("gate:ticket_lookup", "gate_ticket_lookup__gate_ticket_lookup")).toBe(true);
    expect(matchesToolRef("gate:ticket_lookup", "gate:ticket_lookup")).toBe(true);
    expect(matchesToolRef("docs/*", "docs__search")).toBe(true);
    expect(matchesToolRef("docs/get_*", "docs__get_page")).toBe(true);
    expect(matchesToolRef("docs/get_*", "docs__search")).toBe(false);
  });
});

describe("toolChipsFor", () => {
  test("declared tools in order, with the run's calls, then undeclared calls", () => {
    const chips = toolChipsFor(
      ["tickets/lookup", "tickets/create"],
      [call("tickets__lookup", "completed", 2), call("tickets__lookup", "running", 4), call("select_tools", "error", 3)],
    );
    // Running first, then called (latest first), then the untouched ones.
    expect(chips.map((c) => [c.name, c.declared, c.status, c.calls])).toEqual([
      ["tickets/lookup", true, "running", 2],
      ["select_tools", false, "error", 1],
      ["tickets/create", true, "idle", 0],
    ]);
    expect(chips[0]?.lastLatencyMs).toBe(40);
  });

  test("tools that ran move up; untouched ones keep the flow order", () => {
    const chips = toolChipsFor(["a/one", "a/two", "a/three", "a/four"], [call("a__three", "completed", 5), call("a__four", "completed", 7)]);
    expect(chips.map((c) => c.name)).toEqual(["a/four", "a/three", "a/one", "a/two"]);
  });

  test("marks the arguments pinned in config.toolArgs", () => {
    const chips = toolChipsFor(["vs/search", "vs/get"], [], { "vs/search": { collection: "cases", limit: 5 } });
    expect(chips.map((c) => c.staticArgs)).toEqual([["collection", "limit"], []]);
  });
});

describe("toolRailSize", () => {
  test("stops growing after the visible chips and scrolls", () => {
    const six = toolRailSize(Array.from({ length: 6 }, (_, i) => `srv/t${i}`));
    const twenty = toolRailSize(Array.from({ length: 20 }, (_, i) => `srv/t${i}`));
    expect(six.scrolls).toBe(false);
    expect(twenty.scrolls).toBe(true);
    expect(twenty.height).toBeLessThan(six.height + 40);
  });

  test("groups a run's tool states by the node that called them", () => {
    const states = new Map<string, NodeState>([
      ["assist", { id: "assist", label: "assist", status: "completed", latency_ms: 1 }],
      ["a::tool::1", call("x", "completed", 1)],
      ["b::tool::2", call("y", "completed", 2, "other")],
    ]);
    const by = toolCallsByParent(states);
    expect(by.get("assist")?.map((s) => s.label)).toEqual(["x"]);
    expect(by.get("other")?.map((s) => s.label)).toEqual(["y"]);
  });
});

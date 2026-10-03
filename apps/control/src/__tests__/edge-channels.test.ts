// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";
import {
  CHANNEL_EDGE_PREFIX,
  channelEdgeId,
  channelLogicalEdgeId,
  isChannelEdgeId,
  latestFlowsByPair,
  pairKey,
} from "../lib/edge-channels";
import {
  boundaryEndEdgeId,
  boundaryStartEdgeId,
  parseBoundaryEdgeId,
} from "../lib/flow-boundaries";
import type { EdgeFlowItem, EdgeFlowRecord } from "../lib/run-samples";

const item = (label: string): EdgeFlowItem => ({
  kind: "text",
  label,
  status: "passed",
});

const record = (
  source: string,
  target: string,
  sequence: number,
  labels: string[] = ["Query"],
): EdgeFlowRecord => ({
  source,
  target,
  sequence,
  items: labels.map(item),
});

describe("channel edge ids", () => {
  test("round-trips the logical edge id, also when it contains colons", () => {
    const logical = boundaryStartEdgeId("entry");
    const id = channelEdgeId(logical, 3);
    expect(id.startsWith(CHANNEL_EDGE_PREFIX)).toBe(true);
    expect(isChannelEdgeId(id)).toBe(true);
    expect(channelLogicalEdgeId(id)).toBe(logical);
  });

  test("a node id containing '::' still round-trips (index splits last)", () => {
    const logical = "sub::deep:node→other";
    expect(channelLogicalEdgeId(channelEdgeId(logical, 0))).toBe(logical);
  });

  test("ordinary edge ids are not channel ids", () => {
    expect(isChannelEdgeId("router→answer")).toBe(false);
    expect(isChannelEdgeId(boundaryEndEdgeId("answer"))).toBe(false);
  });
});

describe("parseBoundaryEdgeId", () => {
  test("recognises start and end links", () => {
    expect(parseBoundaryEdgeId(boundaryStartEdgeId("entry"))).toEqual({
      kind: "start",
      nodeId: "entry",
    });
    expect(parseBoundaryEdgeId(boundaryEndEdgeId("answer"))).toEqual({
      kind: "end",
      nodeId: "answer",
    });
  });

  test("definition edges and unknown prefixes are not boundary links", () => {
    expect(parseBoundaryEdgeId("router→answer")).toBeNull();
    expect(parseBoundaryEdgeId("boundary:middle-x")).toBeNull();
  });
});

describe("latestFlowsByPair", () => {
  test("keys by (source, target)", () => {
    const map = latestFlowsByPair([record("a", "b", 1), record("b", "c", 2)]);
    expect(map.get(pairKey("a", "b"))?.sequence).toBe(1);
    expect(map.get(pairKey("b", "c"))?.sequence).toBe(2);
    expect(map.get(pairKey("c", "a"))).toBeUndefined();
  });

  test("a looped edge keeps only the newest traversal", () => {
    const map = latestFlowsByPair([
      record("a", "b", 1, ["alt"]),
      record("a", "b", 5, ["neu"]),
      record("a", "b", 3, ["mittel"]),
    ]);
    const latest = map.get(pairKey("a", "b"));
    expect(latest?.sequence).toBe(5);
    expect(latest?.items.map((i) => i.label)).toEqual(["neu"]);
  });

  test("equal sequence: the later record wins (stream order)", () => {
    const map = latestFlowsByPair([record("a", "b", 2, ["alt"]), record("a", "b", 2, ["neu"])]);
    expect(map.get(pairKey("a", "b"))?.items[0]?.label).toBe("neu");
  });

  test("empty input yields an empty map", () => {
    expect(latestFlowsByPair([]).size).toBe(0);
  });
});

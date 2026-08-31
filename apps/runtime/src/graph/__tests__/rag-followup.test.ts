// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the pure follow-up down-weighting helpers.
 */
import { describe, test, expect } from "bun:test";
import {
  docKeyOf,
  parseFollowupDownweightConfig,
  applySeenDownweight,
  mergeSeenRefs,
} from "../rag-followup.js";
import type { RagChunk } from "../reranker.js";

const chunk = (over: Partial<RagChunk>): RagChunk => ({
  id: "id",
  title: "Title",
  url: "",
  content: "c",
  retrievalScore: 0.9,
  ...over,
});

describe("docKeyOf", () => {
  test("prefers baseRef, then url, then title", () => {
    expect(docKeyOf(chunk({ baseRef: "doc1", url: "u", title: "t" }))).toBe("doc1");
    expect(docKeyOf(chunk({ url: "u", title: "t" }))).toBe("u");
    expect(docKeyOf(chunk({ title: "t" }))).toBe("t");
  });
});

describe("parseFollowupDownweightConfig", () => {
  test("undefined when absent/disabled", () => {
    expect(parseFollowupDownweightConfig(undefined)).toBeUndefined();
    expect(parseFollowupDownweightConfig({})).toBeUndefined();
    expect(
      parseFollowupDownweightConfig({ followupDownweight: { enabled: false } }),
    ).toBeUndefined();
  });
  test("defaults factor 0.5 / cap 100", () => {
    const cfg = parseFollowupDownweightConfig({
      followupDownweight: { enabled: true },
    });
    expect(cfg).toEqual({ enabled: true, factor: 0.5, cap: 100 });
  });
  test("clamps factor to [0,1] and floors cap", () => {
    expect(
      parseFollowupDownweightConfig({
        followupDownweight: { enabled: true, factor: 2, cap: 10.9 },
      }),
    ).toEqual({ enabled: true, factor: 1, cap: 10 });
    const cfg = parseFollowupDownweightConfig({
      followupDownweight: { enabled: true, factor: -1 },
    });
    if (cfg === undefined) throw new Error("expected a parsed config");
    expect(cfg.factor).toBe(0);
  });
});

describe("applySeenDownweight", () => {
  test("multiplies scoreWeight (default 1) for seen docs only", () => {
    const seenChunk = chunk({ baseRef: "seen" });
    const freshChunk = chunk({ baseRef: "fresh", scoreWeight: 0.8 });
    const n = applySeenDownweight(
      [seenChunk, freshChunk],
      new Set(["seen"]),
      0.5,
    );
    expect(n).toBe(1);
    expect(seenChunk.scoreWeight).toBe(0.5); // 1 * 0.5
    expect(freshChunk.scoreWeight).toBe(0.8); // untouched
  });
  test("compounds with an existing scoreWeight", () => {
    const c = chunk({ baseRef: "seen", scoreWeight: 0.4 });
    applySeenDownweight([c], new Set(["seen"]), 0.5);
    expect(c.scoreWeight).toBeCloseTo(0.2); // 0.4 * 0.5
  });
  test("empty seen set is a no-op", () => {
    const c = chunk({ baseRef: "x", scoreWeight: 1 });
    expect(applySeenDownweight([c], new Set(), 0.5)).toBe(0);
    expect(c.scoreWeight).toBe(1);
  });
});

describe("mergeSeenRefs", () => {
  test("accumulates and dedupes shown refs", () => {
    const out = mergeSeenRefs(
      ["a"],
      [chunk({ baseRef: "b" }), chunk({ baseRef: "a" })],
      100,
    );
    expect(new Set(out)).toEqual(new Set(["a", "b"]));
  });
  test("caps to most-recent N (older dropped first)", () => {
    const out = mergeSeenRefs(
      ["old1", "old2"],
      [chunk({ baseRef: "new1" }), chunk({ baseRef: "new2" })],
      2,
    );
    expect(out).toEqual(["new1", "new2"]); // old1/old2 trimmed
  });
  test("re-shown ref moves to the end (survives cap)", () => {
    const out = mergeSeenRefs(["a", "b"], [chunk({ baseRef: "a" })], 2);
    expect(out).toEqual(["b", "a"]); // a re-inserted at end
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-selection config + helpers (`src/graph/tool-selection.ts`)
 *
 * Pure parsing/matching logic behind Dynamic Tool Retrieval — no AI SDK or
 * runtime dependencies, so exhaustively unit-testable.
 */

import { describe, test, expect } from "bun:test";
import {
  parseToolSelection,
  expandPatterns,
  buildGroupSummary,
} from "../tool-selection.js";

describe("parseToolSelection", () => {
  test("returns undefined when config is absent", () => {
    expect(parseToolSelection(undefined)).toBeUndefined();
  });

  test("returns undefined when toolSelection is null or not an object", () => {
    expect(parseToolSelection({ toolSelection: null })).toBeUndefined();
    expect(parseToolSelection({ toolSelection: "nope" })).toBeUndefined();
  });

  test("applies defaults for an empty block", () => {
    const cfg = parseToolSelection({ toolSelection: {} });
    expect(cfg).toEqual({
      mode: "static",
      topK: 5,
      alwaysInclude: [],
      metaTool: true,
      metaToolName: "select_tools",
      metaTopK: 2,
      cacheStable: false,
    });
  });

  test("parses a fully-specified semantic block", () => {
    const cfg = parseToolSelection({
      toolSelection: {
        mode: "semantic",
        topK: 8.9,
        minScore: 0.3,
        alwaysInclude: ["base/*", 42, "helper"],
        metaTool: false,
        metaToolName: "  find_tools  ",
        metaTopK: 3.7,
        cacheStable: true,
      },
    });
    expect(cfg).toEqual({
      mode: "semantic",
      topK: 8, // floored
      minScore: 0.3,
      alwaysInclude: ["base/*", "helper"], // non-strings dropped
      metaTool: false,
      metaToolName: "find_tools", // trimmed
      metaTopK: 3, // floored
      cacheStable: true,
    });
  });

  test("falls back to defaults for invalid numeric fields", () => {
    const cfg = parseToolSelection({
      toolSelection: {
        topK: -1,
        minScore: Number.NaN,
        metaTopK: 0,
        metaToolName: "   ",
      },
    });
    expect(cfg?.topK).toBe(5);
    expect(cfg?.minScore).toBeUndefined();
    expect(cfg?.metaTopK).toBe(2);
    expect(cfg?.metaToolName).toBe("select_tools");
  });

  test("treats a non-array alwaysInclude as empty", () => {
    const cfg = parseToolSelection({
      toolSelection: { alwaysInclude: "base/*" },
    });
    expect(cfg?.alwaysInclude).toEqual([]);
  });
});

describe("expandPatterns", () => {
  const pool = ["hr/vacation_create", "hr/vacation_cancel", "billing/invoice"];

  test("returns [] for no patterns", () => {
    expect(expandPatterns([], pool)).toEqual([]);
  });

  test("'*' matches the entire pool in order", () => {
    expect(expandPatterns(["*"], pool)).toEqual(pool);
  });

  test("matches a full ref, a bare name, and a server wildcard", () => {
    expect(expandPatterns(["billing/invoice"], pool)).toEqual([
      "billing/invoice",
    ]);
    expect(expandPatterns(["invoice"], pool)).toEqual(["billing/invoice"]);
    expect(expandPatterns(["hr/*"], pool)).toEqual([
      "hr/vacation_create",
      "hr/vacation_cancel",
    ]);
  });

  test("ignores blank patterns and de-duplicates matches", () => {
    expect(expandPatterns(["  ", "hr/*", "hr/vacation_create"], pool)).toEqual([
      "hr/vacation_create",
      "hr/vacation_cancel",
    ]);
  });

  test("returns [] when nothing matches", () => {
    expect(expandPatterns(["does/not-exist"], pool)).toEqual([]);
  });
});

describe("buildGroupSummary", () => {
  test("groups refs by server with short descriptions", () => {
    const describe_ = (ref: string): string | undefined =>
      ({
        "hr/vacation_create":
          "Create a vacation request. Extra detail ignored.",
        "billing/invoice": undefined,
      })[ref];
    const summary = buildGroupSummary(
      ["hr/vacation_create", "billing/invoice"],
      describe_,
    );
    expect(summary).toContain(
      "• hr: vacation_create — Create a vacation request.",
    );
    // No description → just the bare name.
    expect(summary).toContain("• billing: invoice");
    expect(summary.split("\n")).toHaveLength(2);
  });

  test("uses (local) for refs without a server segment", () => {
    const summary = buildGroupSummary(["localtool"], () => undefined);
    expect(summary).toBe("• (local): localtool");
  });

  test("caps a very long description to ~140 chars with an ellipsis", () => {
    const long = "x".repeat(300);
    const summary = buildGroupSummary(["srv/tool"], () => long);
    const line = summary.split(" — ")[1] ?? "";
    expect(line.endsWith("...")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(140);
  });

  test("returns an empty string for no refs", () => {
    expect(buildGroupSummary([], () => "x")).toBe("");
  });
});

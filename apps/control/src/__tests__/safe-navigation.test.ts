// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import { safeMarkdownHref, safeReturnTo } from "../lib/safe-navigation";

describe("safeReturnTo", () => {
  // The fallback is the dashboard's own start page: `/` redirects to
  // `/overview` (review follow-up F1), so a sign-in without a `returnTo` must
  // land in the same place rather than two clicks away from it.
  test.each([
    ["/graph", "/graph"],
    ["/traces?execution=x#detail", "/traces?execution=x#detail"],
    ["https://evil.example/path", "/overview"],
    ["//evil.example/path", "/overview"],
    ["javascript:alert(1)", "/overview"],
    ["/\\evil.example", "/overview"],
    ["/graph\nignored", "/overview"],
    ["", "/overview"],
    [null, "/overview"],
  ])("normalizes %s to %s", (candidate, expected) => {
    expect(safeReturnTo(candidate)).toBe(expected);
  });
});

describe("safeMarkdownHref", () => {
  test.each([
    ["https://example.com/docs", "https://example.com/docs"],
    ["http://example.com", "http://example.com"],
    ["/internal/path", "/internal/path"],
    ["../relative", "../relative"],
    ["#section", "#section"],
    ["javascript:alert(1)", null],
    ["data:text/html,unsafe", null],
    ["vbscript:msgbox(1)", null],
    ["//evil.example", null],
  ])("filters %s", (candidate, expected) => {
    expect(safeMarkdownHref(candidate)).toBe(expected);
  });
});

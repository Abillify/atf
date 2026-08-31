// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "vitest";
import { safeMarkdownHref, safeReturnTo } from "../lib/safe-navigation";

describe("safeReturnTo", () => {
  test.each([
    ["/graph", "/graph"],
    ["/traces?execution=x#detail", "/traces?execution=x#detail"],
    ["https://evil.example/path", "/graph"],
    ["//evil.example/path", "/graph"],
    ["javascript:alert(1)", "/graph"],
    ["/\\evil.example", "/graph"],
    ["/graph\nignored", "/graph"],
    ["", "/graph"],
    [null, "/graph"],
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

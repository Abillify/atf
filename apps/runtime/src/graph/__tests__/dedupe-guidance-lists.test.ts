// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "bun:test";
import { dedupeGuidanceListLines } from "../exec-runtime.js";

describe("dedupeGuidanceListLines", () => {
  test("dedupes a comma-separated list line, preserving order + first text", () => {
    const input =
      "Known epics:\nExample Alpha EA, Example Beta EB, Internal Development ID, Example Gamma EG, Internal Development ID, Example Gamma EG, Example Delta ED";
    const out = dedupeGuidanceListLines(input);
    expect(out).toBe(
      "Known epics:\nExample Alpha EA, Example Beta EB, Internal Development ID, Example Gamma EG, Example Delta ED",
    );
  });

  test("leaves a duplicate-free list unchanged", () => {
    const line = "Archived, Done, New, OPS Abnahmetest, TECH Umsetzung";
    expect(dedupeGuidanceListLines(line)).toBe(line);
  });

  test("does NOT touch JSON array lines (parking user list)", () => {
    const json =
      '[{"login":"a@x","name":"Ann"}, {"login":"b@x","name":"Bob"}, {"login":"c@x","name":"Cy"}, {"login":"a@x","name":"Ann"}]';
    expect(dedupeGuidanceListLines(json)).toBe(json);
  });

  test("does NOT touch prose (sentence punctuation / few commas)", () => {
    const prose =
      "By default a request is about the caller, resolve relative ranges, and never invent dates.";
    expect(dedupeGuidanceListLines(prose)).toBe(prose);
  });

  test("ignores lines with fewer than 4 items", () => {
    const line = "New, New, Done";
    expect(dedupeGuidanceListLines(line)).toBe(line);
  });

  test("only rewrites the list line, not surrounding text", () => {
    const input =
      "### taiga\nSome intro sentence about tickets.\nStatus, Status, Foo, Bar, Baz, Foo\nTrailing note.";
    const out = dedupeGuidanceListLines(input);
    expect(out).toBe(
      "### taiga\nSome intro sentence about tickets.\nStatus, Foo, Bar, Baz\nTrailing note.",
    );
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, test } from "bun:test";
import { findUnmarkedCasts } from "./check-jsonb-casts.ts";

describe("findUnmarkedCasts", () => {
  test("reports a bare $n::jsonb cast", () => {
    const src = "await db.query(\n  `INSERT INTO t (c) VALUES ($1::jsonb)`,\n  [JSON.stringify(x)],\n);";
    expect(findUnmarkedCasts("a.ts", src)).toEqual([
      { file: "a.ts", line: 2, text: "`INSERT INTO t (c) VALUES ($1::jsonb)`," },
    ]);
  });

  test("accepts ::text::jsonb", () => {
    expect(findUnmarkedCasts("a.ts", "VALUES ($1::text::jsonb)")).toEqual([]);
  });

  test("accepts a marked cast within five lines", () => {
    const src = "// jsonb-cast-ok: object parameter\nawait db.query(\n  `INSERT INTO t\n   (c)\n   VALUES ($1::jsonb)`,";
    expect(findUnmarkedCasts("a.ts", src)).toEqual([]);
  });

  test("ignores comments that mention the pattern", () => {
    expect(findUnmarkedCasts("a.ts", "  // a bare `$1::jsonb` is a string scalar")).toEqual([]);
    expect(findUnmarkedCasts("a.ts", "   * `$1::jsonb` example")).toEqual([]);
  });
});

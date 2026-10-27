// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, test } from "bun:test";
import { jsonColumn, repairStringScalarJsonSql } from "../json-column.js";

describe("jsonColumn", () => {
  test("objects and arrays pass through", () => {
    const obj = { a: 1 };
    expect(jsonColumn<typeof obj>(obj)).toBe(obj);
    expect(jsonColumn<number[]>([1, 2])).toEqual([1, 2]);
  });

  test("a string scalar holding an object or array is parsed", () => {
    expect(jsonColumn<Record<string, number>>('{"a":1}')).toEqual({ a: 1 });
    expect(jsonColumn<unknown[]>('  [1,"x"]')).toEqual([1, "x"]);
  });

  test("null and undefined become undefined", () => {
    expect(jsonColumn(null)).toBeUndefined();
    expect(jsonColumn(undefined)).toBeUndefined();
  });

  test("other strings, and strings that are not valid JSON, stay as they are", () => {
    expect(jsonColumn<string>("plain")).toBe("plain");
    expect(jsonColumn<string>("{not json")).toBe("{not json");
  });
});

describe("repairStringScalarJsonSql", () => {
  test("only rewrites string scalars that hold an object or array", () => {
    const sql = repairStringScalarJsonSql("erasure_requests", "receipt");
    expect(sql).toContain("UPDATE erasure_requests");
    expect(sql).toContain("jsonb_typeof(receipt) = 'string'");
    expect(sql).toContain("IN ('{', '[')");
  });
});

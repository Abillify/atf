// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  blockSchema,
  isDocumentBegin,
  isDocumentEnd,
  isPage,
  pageRecordSchema,
  recordSchema,
  transcriptionSchema,
} from "../../src/index.js";
import { beginRecord, endRecord, figureBlock, pageRecord } from "./fixtures.js";

describe("record schemas", () => {
  test("accept the three record types", () => {
    expect(recordSchema.safeParse(beginRecord()).success).toBe(true);
    expect(recordSchema.safeParse(pageRecord(1)).success).toBe(true);
    expect(recordSchema.safeParse(endRecord()).success).toBe(true);
  });

  test("reject an unknown record type", () => {
    expect(recordSchema.safeParse({ type: "page.begin" }).success).toBe(false);
  });

  test("page defaults assets and warnings to empty", () => {
    const parsed = pageRecordSchema.parse({
      type: "page",
      page: 1,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [],
    });
    expect(parsed.assets).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("block model", () => {
  test("discriminates on type", () => {
    expect(blockSchema.safeParse(figureBlock(1, 1)).success).toBe(true);
    expect(
      blockSchema.safeParse({ type: "heading", id: "h", page: 1, level: 2, text: "T" }).success,
    ).toBe(true);
    expect(
      blockSchema.safeParse({ type: "list", id: "l", page: 1, items: ["a", "b"] }).success,
    ).toBe(true);
  });

  test("a table block carries header rows and continuation flags", () => {
    const table = blockSchema.safeParse({
      type: "table",
      id: "t1",
      page: 1,
      tableId: "T1",
      headerRows: [["A", "B"]],
      rows: [["1", "2"]],
      continues: true,
    });
    expect(table.success).toBe(true);
  });

  test("rejects a heading with no text", () => {
    expect(
      blockSchema.safeParse({ type: "heading", id: "h", page: 1, level: 2 }).success,
    ).toBe(false);
  });
});

describe("transcription union", () => {
  test("accepts every format", () => {
    const cases = [
      { format: "process", mermaid: "graph TD", nodes: [], edges: [], steps: ["a"] },
      { format: "fields", areas: [], actions: [] },
      { format: "drawing", titleBlock: { Nr: "A-1" } },
      { format: "data", table: [["x", "y"]] },
      { format: "markdown", text: "frei" },
    ];
    for (const c of cases) {
      expect(transcriptionSchema.safeParse(c).success).toBe(true);
    }
  });

  test("rejects an unknown format", () => {
    expect(transcriptionSchema.safeParse({ format: "svg", data: "x" }).success).toBe(false);
  });
});

describe("record guards", () => {
  test("narrow by type", () => {
    expect(isDocumentBegin(beginRecord())).toBe(true);
    expect(isPage(pageRecord(1))).toBe(true);
    expect(isDocumentEnd(endRecord())).toBe(true);
    expect(isPage(beginRecord())).toBe(false);
  });
});

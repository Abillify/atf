// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * page-selection.test.ts
 *
 * Contract 2.4: `pages` on the job request is one contiguous window of source
 * page numbers, and `document.begin` and `document.end` carry the
 * optional `firstPage` of the stream. The selection used to be accepted as any string
 * and silently ignored; these tests pin the four accepted shapes, the rejected
 * ones, and that a 2.3-shaped stream (no `firstPage`) still parses.
 */
import { describe, expect, test } from "bun:test";
import {
  documentBeginRecordSchema,
  documentEndRecordSchema,
  jobRequestSchema,
  parsePageSelection,
  resolvePageWindow,
  selectionFromConfig,
} from "../../src/v2/index.js";
import { EXTRACT_CONTRACT_VERSION, isCompatibleContract } from "../../src/version.js";

const SHA = "b".repeat(64);

describe("parsePageSelection", () => {
  test.each([
    ["5", { from: 5, to: 5 }],
    ["3-10", { from: 3, to: 10 }],
    ["5-", { from: 5 }],
    ["-8", { to: 8 }],
    [" 3 - 10 ", { from: 3, to: 10 }],
    ["7-7", { from: 7, to: 7 }],
  ])("accepts %p", (input, expected) => {
    expect(parsePageSelection(input)).toEqual(expected);
  });

  test.each([
    "",
    "-",
    "0",
    "0-3",
    "-0",
    "10-3",
    "1-10,15",
    "1,2",
    "a-b",
    "1--3",
    "+3",
    "1 0",
    "3.5",
    "12345678",
    "1000001",
  ])("rejects %p", (input) => {
    expect(parsePageSelection(input)).toBeNull();
  });
});

describe("jobRequestSchema.pages", () => {
  const base = { reference: "doc", sourceSha256: SHA };

  test("accepts a window", () => {
    expect(jobRequestSchema.parse({ ...base, pages: "3-10" }).pages).toBe("3-10");
  });

  test("is still optional", () => {
    expect(jobRequestSchema.parse(base).pages).toBeUndefined();
  });

  test("rejects a list with the documented hint", () => {
    const result = jobRequestSchema.safeParse({ ...base, pages: "1-10,15" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("contiguous window");
  });
});

describe("selectionFromConfig", () => {
  test("reads the normalised object", () => {
    expect(selectionFromConfig({ from: 3, to: 9 })).toEqual({ from: 3, to: 9 });
  });

  test("reads the raw string a pre-2.4 job stored", () => {
    expect(selectionFromConfig("4-")).toEqual({ from: 4 });
  });

  test("falls back to all pages for null, junk and reversed bounds", () => {
    expect(selectionFromConfig(null)).toEqual({});
    expect(selectionFromConfig("1,2")).toEqual({});
    expect(selectionFromConfig({ from: "x", to: 0 })).toEqual({});
    expect(selectionFromConfig({ from: 9, to: 3 })).toEqual({ from: 9 });
  });
});

describe("resolvePageWindow", () => {
  test("whole source without a selection", () => {
    expect(resolvePageWindow({}, 12)).toEqual({ first: 1, last: 12, count: 12 });
  });

  test("clamps `to` to the source", () => {
    expect(resolvePageWindow({ to: 99 }, 12)).toEqual({ first: 1, last: 12, count: 12 });
  });

  test("keeps source numbering for a window", () => {
    expect(resolvePageWindow({ from: 5, to: 7 }, 12)).toEqual({ first: 5, last: 7, count: 3 });
  });

  test("open `to` runs to the last page", () => {
    expect(resolvePageWindow({ from: 10 }, 12)).toEqual({ first: 10, last: 12, count: 3 });
  });

  test("`from` beyond the source is an empty window", () => {
    expect(resolvePageWindow({ from: 13 }, 12)).toEqual({ first: 13, last: 12, count: 0 });
  });
});

describe("firstPage on the stream records", () => {
  const begin = {
    type: "document.begin",
    contract: `atf-extract/${EXTRACT_CONTRACT_VERSION}`,
    reference: "doc",
    source: { filename: "doc.pdf", mimeType: "application/pdf", bytes: 10, sha256: SHA },
    pipeline: { extractor: "poppler", ocr: false },
    pageCount: 7,
  };

  test("document.begin carries firstPage next to the last page", () => {
    const parsed = documentBeginRecordSchema.parse({ ...begin, firstPage: 5 });
    expect(parsed.firstPage).toBe(5);
    expect(parsed.pageCount).toBe(7);
  });

  test("a 2.3 document.begin without firstPage still parses", () => {
    expect(documentBeginRecordSchema.parse(begin).firstPage).toBeUndefined();
  });

  test("document.end repeats firstPage", () => {
    const parsed = documentEndRecordSchema.parse({
      type: "document.end",
      reference: "doc",
      pageCount: 7,
      firstPage: 5,
    });
    expect(parsed.firstPage).toBe(5);
    expect(documentEndRecordSchema.parse({ type: "document.end", reference: "doc", pageCount: 7 }).firstPage).toBeUndefined();
  });

  test("firstPage 0 is rejected", () => {
    expect(documentBeginRecordSchema.safeParse({ ...begin, firstPage: 0 }).success).toBe(false);
  });

  test("a 2.3 producer is still compatible with a 2.4 consumer", () => {
    expect(isCompatibleContract("atf-extract/2.3.0")).toBe(true);
    expect(EXTRACT_CONTRACT_VERSION).toBe("2.4.0");
  });
});

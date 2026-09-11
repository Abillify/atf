// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  EXTRACT_CONTRACT_ID,
  FIGURE_ID_PATTERN,
  boundingBoxFromPixels,
  boundingBoxToPixels,
  buildFigureId,
  buildFigurePlaceholder,
  buildFigureTag,
  buildFiguresBlock,
  buildPageMarker,
  buildSummaryTag,
  escapeFigureDescription,
  formatBoundingBox,
  isCompatibleContract,
  isValidBoundingBox,
  normalizeBoundingBox,
  parseBoundingBoxAttribute,
  parseContractId,
  parseFigureIdAttribute,
  parsePageAttribute,
  type BoundingBox,
} from "../src/index.js";

describe("contract version", () => {
  test("parses and gates on the major", () => {
    expect(parseContractId(EXTRACT_CONTRACT_ID)).toEqual({
      name: "atf-extract",
      version: "1.1.0",
      major: 1,
      minor: 1,
      patch: 0,
    });
    expect(isCompatibleContract("atf-extract/1.7.2")).toBe(true);
    expect(isCompatibleContract("atf-extract/2.0.0")).toBe(false);
    expect(isCompatibleContract("something-else/1.0.0")).toBe(false);
    expect(isCompatibleContract("atf-extract")).toBe(false);
    expect(parseContractId("nonsense")).toBeNull();
  });
});

describe("page markers", () => {
  test("renders both labels", () => {
    expect(buildPageMarker(3)).toBe("## Seite 3");
    expect(buildPageMarker(3, "Page")).toBe("## Page 3");
  });
});

describe("figure ids", () => {
  test("are page-scoped and document-unique", () => {
    expect(buildFigureId(1, 1)).toBe("p1-f1");
    expect(buildFigureId(12, 4)).toBe("p12-f4");
    // The whole point: two figures on different pages never collide.
    expect(buildFigureId(1, 1)).not.toBe(buildFigureId(2, 1));
  });

  test("survive Search's id normalisation unchanged", () => {
    const id = buildFigureId(7, 2);
    const asSearchWouldRewriteIt = id
      .replace(/^figure_/i, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-");
    expect(asSearchWouldRewriteIt).toBe(id);
    expect(FIGURE_ID_PATTERN.test(id)).toBe(true);
  });

  test("placeholder round-trips the id", () => {
    expect(buildFigurePlaceholder("p1-f1")).toBe("![figure_p1-f1]");
  });
});

describe("bounding boxes", () => {
  test("clamps, orders and rounds", () => {
    expect(normalizeBoundingBox([0.6, 0.75, 0.1, 0.2])).toEqual([0.1, 0.2, 0.6, 0.75]);
    expect(normalizeBoundingBox([-0.5, 2, 0.5, 0.5])).toEqual([0, 0.5, 0.5, 1]);
    expect(normalizeBoundingBox([0.123456, 0, 0.987654, 1])).toEqual([0.1235, 0, 0.9877, 1]);
  });

  test("rejects degenerate boxes", () => {
    expect(isValidBoundingBox([0.1, 0.2, 0.6, 0.75])).toBe(true);
    expect(isValidBoundingBox([0.5, 0.2, 0.5, 0.75])).toBe(false);
    expect(isValidBoundingBox([0.1, 0.2, 0.6, 0.2])).toBe(false);
    expect(isValidBoundingBox([0, 0, 1, 1])).toBe(true);
  });

  test("formats with fixed precision", () => {
    expect(formatBoundingBox([0.1, 0.2, 0.6, 0.75])).toBe("[0.1000, 0.2000, 0.6000, 0.7500]");
  });

  test("converts to pixels as x1/y1/x2/y2, never x/y/w/h", () => {
    // The defect this replaces: the previous cropper computed
    // (left, upper, left + right, upper + lower), i.e. it read the third and
    // fourth numbers as width and height. For a box starting at x=0.5 that
    // produced a crop extending past the page edge.
    const box: BoundingBox = [0.5, 0.25, 1, 0.75];
    expect(boundingBoxToPixels(box, 1000, 800)).toEqual({
      left: 500,
      top: 200,
      width: 500,
      height: 400,
    });
  });

  test("never produces a zero-sized or out-of-page crop", () => {
    const tiny = boundingBoxToPixels([0.5, 0.5, 0.5001, 0.5001], 100, 100);
    expect(tiny.width).toBeGreaterThanOrEqual(1);
    expect(tiny.height).toBeGreaterThanOrEqual(1);
    const full = boundingBoxToPixels([0, 0, 1, 1], 640, 480);
    expect(full.left + full.width).toBeLessThanOrEqual(640);
    expect(full.top + full.height).toBeLessThanOrEqual(480);
  });

  test("round-trips through pixel space", () => {
    expect(boundingBoxFromPixels([250, 100, 750, 400], 1000, 800)).toEqual([
      0.25, 0.125, 0.75, 0.5,
    ]);
    expect(boundingBoxFromPixels([0, 0, 10, 10], 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("figure tags", () => {
  test("put id first and quote every attribute", () => {
    const tag = buildFigureTag({
      id: "p1-f1",
      page: 1,
      description: "Ein Diagramm",
      bbox: [0.1, 0.2, 0.6, 0.75],
    });
    expect(tag).toBe(
      '<figure id="p1-f1" bbox="[0.1000, 0.2000, 0.6000, 0.7500]" page="1">Ein Diagramm</figure>',
    );
  });

  test("cannot be broken out of by the description", () => {
    const tag = buildFigureTag({
      id: "p1-f1",
      page: 1,
      description: 'Text </figure><script>alert("x")</script> mehr',
      bbox: [0, 0, 1, 1],
    });
    expect(tag.match(/<\/figure\s*>/g)).toHaveLength(1);
    expect(tag).not.toContain("<script");
  });

  test("escapes quotes in attribute values", () => {
    const tag = buildFigureTag({
      id: 'p1-f1" onload="x',
      page: 1,
      description: "d",
      bbox: [0, 0, 1, 1],
    });
    expect(tag).toContain("&quot;");
    expect(parseFigureIdAttribute(tag.slice("<figure".length))).toBe("p1-f1&quot; onload=&quot;x");
  });

  test("figures block is empty for a figure-free page", () => {
    expect(buildFiguresBlock([])).toBe("");
  });

  test("normalises whitespace in descriptions", () => {
    expect(escapeFigureDescription("a\n\n  b\tc ")).toBe("a b c");
  });
});

describe("summary tags", () => {
  test("collapse whitespace and skip empty input", () => {
    expect(buildSummaryTag("  Zwei\nZeilen  ")).toBe("<summary>Zwei Zeilen</summary>");
    expect(buildSummaryTag("   ")).toBe("");
  });

  test("cannot be closed early by their content", () => {
    const tag = buildSummaryTag("Text </summary> mehr");
    expect(tag.match(/<\/summary>/g)).toHaveLength(1);
  });
});

describe("attribute parsing tolerance", () => {
  test("reads the canonical quoted form", () => {
    const attrs = ' id="p1-f1" bbox="[0.1, 0.2, 0.6, 0.75]" page="1"';
    expect(parseFigureIdAttribute(attrs)).toBe("p1-f1");
    expect(parseBoundingBoxAttribute(attrs)).toEqual([0.1, 0.2, 0.6, 0.75]);
    expect(parsePageAttribute(attrs)).toBe(1);
  });

  test("reads the legacy unquoted comma-separated form", () => {
    // Produced by the pre-contract pipeline: <figure id=0, bbox=[10, 20, 30, 40]>
    const attrs = " id=0, bbox=[10, 20, 30, 40]";
    expect(parseFigureIdAttribute(attrs)).toBe("0");
    expect(parseBoundingBoxAttribute(attrs)).toEqual([10, 20, 30, 40]);
  });

  test("reads single quotes and data- prefixes", () => {
    expect(parseFigureIdAttribute(" data-figure-id='x1'")).toBe("x1");
    expect(parseBoundingBoxAttribute(" data-bbox='0 0 1 1'")).toEqual([0, 0, 1, 1]);
  });

  test("returns undefined rather than a partial box", () => {
    expect(parseBoundingBoxAttribute(" bbox=\"[1, 2, 3]\"")).toBeUndefined();
    expect(parseBoundingBoxAttribute(' bbox="[a, b, c, d]"')).toBeUndefined();
    expect(parseBoundingBoxAttribute(' bbox=""')).toBeUndefined();
    expect(parseBoundingBoxAttribute(" page=\"1\"")).toBeUndefined();
    expect(parseFigureIdAttribute(" page=\"1\"")).toBeUndefined();
    expect(parsePageAttribute(' page="0"')).toBeUndefined();
  });
});

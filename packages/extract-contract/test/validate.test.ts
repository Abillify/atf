// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  ExtractContractError,
  assertValidDocument,
  isValidDocument,
  validateDocument,
} from "../src/v1/index.js";
import { document, figure, page } from "./fixtures.js";

function errorsFor(doc: Parameters<typeof validateDocument>[0]): string[] {
  return validateDocument(doc)
    .filter((issue) => issue.severity === "error")
    .map((issue) => `${issue.path}: ${issue.message}`);
}

describe("validateDocument", () => {
  test("accepts a well-formed document", () => {
    const doc = document({
      pages: [page(1, { figures: [figure(1, 1)] }), page(2, { figures: [figure(2, 1)] })],
    });
    expect(validateDocument(doc)).toEqual([]);
    expect(isValidDocument(doc)).toBe(true);
    expect(() => assertValidDocument(doc)).not.toThrow();
  });

  test("rejects an incompatible contract version", () => {
    expect(errorsFor(document({ contract: "atf-extract/2.0.0" })).join(" ")).toContain(
      "not a compatible atf-extract version",
    );
  });

  test("rejects a page-count mismatch", () => {
    expect(errorsFor(document({ pageCount: 7 })).join(" ")).toContain(
      "declares 7 page(s) but carries 2",
    );
  });

  test("rejects a duplicated page number", () => {
    expect(errorsFor(document({ pages: [page(1), page(1)] })).join(" ")).toContain(
      "page 1 appears more than once",
    );
  });

  test("rejects duplicate figure ids across pages", () => {
    // The defect that motivates document-unique ids: Search renames the second
    // one, so its uploaded crop is never found again.
    const doc = document({
      pages: [
        page(1, { figures: [figure(1, 1, { id: "shared" })] }),
        page(2, { figures: [figure(2, 1, { id: "shared", page: 2 })] }),
      ],
    });
    expect(errorsFor(doc).join(" ")).toContain('duplicate figure id "shared"');
  });

  test("rejects an id Search would rewrite", () => {
    const doc = document({
      pages: [page(1, { figures: [figure(1, 1, { id: "figure_1" })] })],
    });
    expect(errorsFor(doc).join(" ")).toContain('reserved "figure_" prefix');
  });

  test("rejects a stale asset id", () => {
    const doc = document({
      pages: [page(1, { figures: [figure(1, 1, { assetId: "0".repeat(64) })] })],
    });
    expect(errorsFor(doc).join(" ")).toContain("does not match sha256");
  });

  test("rejects a figure attached to the wrong page", () => {
    const doc = document({
      pages: [page(1, { figures: [figure(1, 1, { page: 5 })] })],
    });
    expect(errorsFor(doc).join(" ")).toContain("claims page 5 but is attached to page 1");
  });

  test("rejects a degenerate bounding box", () => {
    const doc = document({
      pages: [page(1, { figures: [figure(1, 1, { bbox: [0.5, 0.5, 0.5, 0.9] })] })],
    });
    expect(errorsFor(doc).join(" ")).toContain("not an ordered box inside [0,1] with area");
  });

  test("rejects a page marker inside a body", () => {
    // Would make Search split one page into two and misattribute every
    // following figure.
    const doc = document({
      pages: [page(1, { markdown: "Text\n\n## Seite 2\n\nMehr" })],
    });
    expect(errorsFor(doc).join(" ")).toContain("contains a page marker");
  });

  test("rejects residual structural markup in a body", () => {
    const withFigure = document({
      pages: [page(1, { markdown: '<figure id="x" bbox="[0,0,1,1]">d</figure>' })],
    });
    expect(errorsFor(withFigure).join(" ")).toContain("residual <figure> element");

    const withSummary = document({
      pages: [page(1, { markdown: "<summary>doppelt</summary>" })],
    });
    expect(errorsFor(withSummary).join(" ")).toContain("residual <summary> element");
  });

  test("rejects NUL bytes", () => {
    const doc = document({ pages: [page(1, { markdown: "Text\u0000mehr" })] });
    expect(errorsFor(doc).join(" ")).toContain("contains NUL bytes");
  });

  test("warns about an empty page without failing it", () => {
    const doc = document({ pages: [page(1, { markdown: "   ", summary: undefined })] });
    const issues = validateDocument(doc);
    expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
    expect(issues.map((i) => i.message).join(" ")).toContain("neither text nor figures");
    expect(isValidDocument(doc)).toBe(true);
  });

  test("warns about an empty figure description", () => {
    const doc = document({
      pages: [page(1, { figures: [figure(1, 1, { description: "  " })] })],
    });
    const issues = validateDocument(doc);
    expect(issues.map((i) => i.message).join(" ")).toContain("only retrievable text");
    expect(isValidDocument(doc)).toBe(true);
  });

  test("collects every issue instead of stopping at the first", () => {
    const doc = document({
      pageCount: 9,
      pages: [
        page(1, {
          markdown: "## Seite 2",
          figures: [figure(1, 1, { assetId: "0".repeat(64), bbox: [1, 1, 0, 0] })],
        }),
      ],
    });
    expect(errorsFor(doc).length).toBeGreaterThanOrEqual(4);
  });
});

describe("assertValidDocument", () => {
  test("throws with every issue attached", () => {
    const doc = document({ pageCount: 5 });
    let caught: unknown;
    try {
      assertValidDocument(doc);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExtractContractError);
    expect((caught as ExtractContractError).issues.length).toBeGreaterThan(0);
    expect((caught as ExtractContractError).message).toContain("pageCount");
  });

  test("does not throw for warning-only documents", () => {
    expect(() =>
      assertValidDocument(document({ pages: [page(1, { markdown: "", summary: undefined })] })),
    ).not.toThrow();
  });
});

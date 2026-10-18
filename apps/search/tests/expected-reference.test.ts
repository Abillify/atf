// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { expectedReferenceMatches, referenceBase } from "../src/expected-reference.ts";

describe("expected-reference", () => {
  it("referenceBase strips a #fragment", () => {
    expect(referenceBase("docs/a.pdf#unit:abc123")).toBe("docs/a.pdf");
    expect(referenceBase("docs/a.pdf")).toBe("docs/a.pdf");
    expect(referenceBase("#weird")).toBe("");
  });

  it("matches identical references", () => {
    expect(expectedReferenceMatches("docs/a.pdf", "docs/a.pdf")).toBe(true);
  });

  it("tolerates a #unit: suffix on the expected side (hit refs are suffixed)", () => {
    expect(expectedReferenceMatches("docs/a.pdf", "docs/a.pdf#unit:e8091f11")).toBe(true);
  });

  it("tolerates a #unit: suffix on the stored side (v2 unit refs)", () => {
    expect(expectedReferenceMatches("docs/a.pdf#unit:e8091f11", "docs/a.pdf")).toBe(true);
  });

  it("never matches a different document reference", () => {
    expect(expectedReferenceMatches("docs/a.pdf", "docs/OTHER.pdf")).toBe(false);
    expect(expectedReferenceMatches("docs/a.pdf", "docs/OTHER.pdf#unit:abc")).toBe(false);
    expect(expectedReferenceMatches("docs/a.pdf#unit:abc", "docs/b.pdf#unit:abc")).toBe(false);
    // Prefix attacks must not match: "docs/a.pdf2" is a different document.
    expect(expectedReferenceMatches("docs/a.pdf", "docs/a.pdf2")).toBe(false);
    expect(expectedReferenceMatches("docs/a.pdf", "docs/a.pdfx#unit:abc")).toBe(false);
  });
});

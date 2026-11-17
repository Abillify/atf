// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, it, expect } from "vitest";
import {
  normalizeReference,
  normalizePathPrefix,
} from "../src/postgres-client.js";

// NFD (decomposed) source strings as they arrive from a macOS filesystem:
// "ä" = "a" + U+0308 (combining diaeresis).
const NFD_UMLAUT = "Qualita\u0308tsmanagement"; // decomposed
const NFC_UMLAUT = "Qualitätsmanagement"; // precomposed (U+00E4)

describe("normalizeReference (NFC canonicalization)", () => {
  it("composes an NFD reference into the precomposed NFC form", () => {
    const ref = `/ExampleRecords/Unterlagen ${NFD_UMLAUT}/doc.pdf`;
    const out = normalizeReference(ref);
    expect(out).toBe(`/ExampleRecords/Unterlagen ${NFC_UMLAUT}/doc.pdf`);
    // Idempotent + already-NFC input unchanged.
    expect(normalizeReference(out)).toBe(out);
  });

  it("maps NFD and NFC inputs onto the identical key", () => {
    const nfd = `/a/${NFD_UMLAUT}/x.pdf`;
    const nfc = `/a/${NFC_UMLAUT}/x.pdf`;
    expect(nfd).not.toBe(nfc); // distinct byte sequences...
    expect(normalizeReference(nfd)).toBe(normalizeReference(nfc)); // ...same key
  });

  it("is a no-op for ASCII references", () => {
    const ref = "/ExampleRecords/Records Part 1/doc.pdf";
    expect(normalizeReference(ref)).toBe(ref);
  });

  it("roots a reference that lacks the leading slash", () => {
    // Producers are inconsistent: some send "docs/a.pdf", others "/docs/a.pdf".
    // The stored key is always rooted so the folder browser's direct-child
    // listing (base_ref LIKE '/%') finds it.
    expect(normalizeReference("docs/a.pdf")).toBe("/docs/a.pdf");
    expect(normalizeReference("a.pdf")).toBe("/a.pdf");
    // Rooted and unrooted spellings of one document collapse to one key.
    expect(normalizeReference("docs/a.pdf")).toBe(normalizeReference("/docs/a.pdf"));
  });

  it("roots and NFC-composes in one step", () => {
    expect(normalizeReference(`a/${NFD_UMLAUT}/x.pdf`)).toBe(`/a/${NFC_UMLAUT}/x.pdf`);
  });

  it("is idempotent for unrooted input", () => {
    const once = normalizeReference("docs/a.pdf");
    expect(normalizeReference(once)).toBe(once);
  });

  it("keeps the root marker and the empty string unchanged", () => {
    expect(normalizeReference("/")).toBe("/");
    expect(normalizeReference("")).toBe("");
  });
});

describe("normalizePathPrefix (NFC + shape)", () => {
  it("NFC-normalizes and canonicalizes the prefix shape", () => {
    expect(normalizePathPrefix(`/a/Unterlagen ${NFD_UMLAUT}/`)).toBe(
      `/a/Unterlagen ${NFC_UMLAUT}`,
    );
    // NFC and NFD prefixes of the same path collapse to one normalized value.
    expect(normalizePathPrefix(`/a/${NFD_UMLAUT}`)).toBe(
      normalizePathPrefix(`/a/${NFC_UMLAUT}`),
    );
  });

  it("still returns '' for root/empty", () => {
    expect(normalizePathPrefix(undefined)).toBe("");
    expect(normalizePathPrefix("")).toBe("");
    expect(normalizePathPrefix("/")).toBe("");
  });
});

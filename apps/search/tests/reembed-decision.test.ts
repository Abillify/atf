// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * reembed-decision.test.ts
 *
 * The pure selective re-embedding decision core.
 * These tests exercise {@link shouldReembed} and {@link parseStoredVector} in
 * isolation — no database, no embedding model — so the branch that governs
 * whether the expensive embed call runs is nailed down directly. The batched DB
 * lookup and the embed-call-count assertion live in the batch-worker
 * integration suite (guarded by TEST_POSTGRES_URL).
 */

import { describe, expect, it } from "vitest";
import {
  parseStoredVector,
  sectionPathsEqual,
  shouldReembed,
} from "../src/reembed-decision.js";

describe("shouldReembed — selective re-embedding decision (requirement 9.6)", () => {
  const incoming = { sectionPath: ["4 Antragseingang", "4.2 Anmeldung"], content: "Der Inhalt." };

  it("re-embeds a NEW unit (no stored row)", () => {
    expect(shouldReembed(incoming, null)).toBe(true);
  });

  it("REUSES the stored vector when both section_path and content are unchanged", () => {
    const stored = { sectionPath: ["4 Antragseingang", "4.2 Anmeldung"], content: "Der Inhalt." };
    expect(shouldReembed(incoming, stored)).toBe(false);
  });

  it("re-embeds when the section_path changed (the header, hence the vector, is stale)", () => {
    const stored = { sectionPath: ["4 Antragseingang"], content: "Der Inhalt." };
    expect(shouldReembed(incoming, stored)).toBe(true);
  });

  it("re-embeds when only a deeper level of the path changed", () => {
    const stored = { sectionPath: ["4 Antragseingang", "4.1 Voranmeldung"], content: "Der Inhalt." };
    expect(shouldReembed(incoming, stored)).toBe(true);
  });

  it("re-embeds when the content changed even though the path is identical", () => {
    const stored = { sectionPath: ["4 Antragseingang", "4.2 Anmeldung"], content: "Anderer Text." };
    expect(shouldReembed(incoming, stored)).toBe(true);
  });

  it("treats an empty path on both sides as unchanged", () => {
    expect(shouldReembed({ sectionPath: [], content: "x" }, { sectionPath: [], content: "x" })).toBe(
      false,
    );
  });
});

describe("sectionPathsEqual", () => {
  it("is order-sensitive and length-sensitive", () => {
    expect(sectionPathsEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(sectionPathsEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(sectionPathsEqual(["a"], ["a", "b"])).toBe(false);
    expect(sectionPathsEqual([], [])).toBe(true);
  });
});

describe("parseStoredVector — round-trip of a pgvector text rendering", () => {
  it("parses a normal vector", () => {
    expect(parseStoredVector("[1,0.5,-0.25]")).toEqual([1, 0.5, -0.25]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseStoredVector("  [1, 2, 3]  ")).toEqual([1, 2, 3]);
  });

  it("returns null for empty / missing / malformed text (forcing a re-embed)", () => {
    expect(parseStoredVector(null)).toBeNull();
    expect(parseStoredVector(undefined)).toBeNull();
    expect(parseStoredVector("")).toBeNull();
    expect(parseStoredVector("[]")).toBeNull();
    expect(parseStoredVector("[1,foo,3]")).toBeNull();
  });
});

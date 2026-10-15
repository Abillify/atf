// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * identifier.ts — Search-side identifier normalization and recognition
 * (task 3.4, Requirements 12.1–12.3).
 *
 * The two guarantees under test:
 *   1. `normalizeIdentifier` collapses casing and the separators a writer adds
 *      or drops freely, so `WE-01/A`, `we 01/a` and `WE01A` are the SAME
 *      `value_norm` — the equality the ingest and query sides both rely on.
 *   2. `recognizeIdentifiers` finds identifier-shaped tokens in a query (and not
 *      ordinary prose), most-specific class first, so the query side knows when
 *      to run the third RRF list and with which value_norm(s).
 */

import { describe, expect, it } from "vitest";
import {
  buildIdentifierTsQuery,
  queryIdentifierValueNorms,
  MAX_QUERY_IDENTIFIERS,
  buildIdentifierText,
  normalizeIdentifier,
  recognizeIdentifiers,
} from "../src/identifier.js";

describe("normalizeIdentifier", () => {
  it("makes WE-01/A, we 01/a and WE01A compare equal", () => {
    const a = normalizeIdentifier("WE-01/A");
    const b = normalizeIdentifier("we 01/a");
    const c = normalizeIdentifier("WE01A");
    expect(a).toBe("WE01A");
    expect(b).toBe("WE01A");
    expect(c).toBe("WE01A");
  });

  it("collapses standards like DIN EN 1090-2 to a separator-free upper form", () => {
    expect(normalizeIdentifier("DIN EN 1090-2")).toBe("DINEN10902");
    expect(normalizeIdentifier("din en 1090-2")).toBe("DINEN10902");
    expect(normalizeIdentifier("DIN  EN  1090 - 2")).toBe("DINEN10902");
  });

  it("strips dots, non-breaking spaces and slashes", () => {
    expect(normalizeIdentifier("Art. 815-2")).toBe("ART8152");
    expect(normalizeIdentifier("WE\u00a001")).toBe("WE01");
  });

  it("is idempotent", () => {
    const once = normalizeIdentifier("ZG-100");
    expect(normalizeIdentifier(once)).toBe(once);
  });
});

describe("recognizeIdentifiers", () => {
  it("recognises a mask code with a suffix as one identifier", () => {
    const hits = recognizeIdentifiers("Bitte Maske WE-01/A prüfen");
    const norms = hits.map((h) => h.valueNorm);
    expect(norms).toContain("WE01A");
  });

  it("recognises a standard as a single most-specific identifier", () => {
    const hits = recognizeIdentifiers("gemäß DIN EN 1090-2 ausführen");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("standard");
    expect(hits[0]?.valueNorm).toBe("DINEN10902");
  });

  it("recognises a drawing number and a mask code distinctly", () => {
    const hits = recognizeIdentifiers("Zeichnung ZG-100, Transaktion VA01");
    const byKind = new Map(hits.map((h) => [h.kind, h.valueNorm]));
    expect(byKind.get("drawing_number")).toBe("ZG100");
    expect(byKind.get("mask_code")).toBe("VA01");
  });

  it("recognises a composite module code whole, keeping its prefix", () => {
    // "QAP-MDE-03" must NOT collapse to the drawing-number tail "MDE-03" —
    // every WMS section has an "…-MDE-03", and only the prefix (QAP vs QAB
    // vs QAV) tells them apart.
    const hits = recognizeIdentifiers("Wie in QAP-MDE-03 beschrieben");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("composite_code");
    expect(hits[0]?.valueNorm).toBe("QAPMDE03");
  });

  it("keeps sibling composite codes distinct and leaves single-dash codes alone", () => {
    const hits = recognizeIdentifiers(
      "QAB-MDE-03, QAP-MDE-03, QAV-MDE-03 sowie Zeichnung ZG-100",
    );
    const norms = hits.map((h) => h.valueNorm).sort();
    expect(norms).toEqual(["QABMDE03", "QAPMDE03", "QAVMDE03", "ZG100"]);
    expect(hits.find((h) => h.valueNorm === "ZG100")?.kind).toBe(
      "drawing_number",
    );
  });

  it("returns nothing for ordinary prose without codes", () => {
    expect(recognizeIdentifiers("Der Vertrag wird in drei Schritten geschlossen.")).toEqual([]);
    expect(recognizeIdentifiers("")).toEqual([]);
  });

  it("deduplicates a repeated identifier to one entry", () => {
    const hits = recognizeIdentifiers("WE01 und nochmal we-01 sowie WE 01");
    expect(hits.filter((h) => h.valueNorm === "WE01")).toHaveLength(1);
  });
});

describe("buildIdentifierText", () => {
  it("emits the space-joined value_norm tokens of a content's identifiers", () => {
    const text = buildIdentifierText("Maske WE-01/A nach DIN EN 1090-2");
    // Order follows text position; both codes present as normalized tokens.
    expect(text.split(" ").sort()).toEqual(["DINEN10902", "WE01A"]);
  });

  it("returns an empty string for prose with no identifier", () => {
    expect(buildIdentifierText("nur Fließtext ohne Codes")).toBe("");
  });
});

describe("queryIdentifierValueNorms", () => {
  it("combines explicit identifiers (first) with recognized ones, deduplicated", () => {
    expect(queryIdentifierValueNorms("Maske WE01 und WE-01/A", ["we-01/a"])).toEqual(["WE01A", "WE01"]);
  });
  it("accepts an explicit identifier that no recognizer class matches", () => {
    expect(queryIdentifierValueNorms("prose only", ["abc 12.x"])).toEqual(["ABC12X"]);
  });
  it("returns [] for plain prose and ignores blank explicit values", () => {
    expect(queryIdentifierValueNorms("der wareneingang", ["", "   "])).toEqual([]);
  });
  it("caps the number of identifiers", () => {
    const many = Array.from({ length: 40 }, (_, i) => `ZG-${100 + i}`).join(" ");
    expect(queryIdentifierValueNorms(many)).toHaveLength(MAX_QUERY_IDENTIFIERS);
  });
});

describe("buildIdentifierTsQuery", () => {
  it("ORs single-quoted operands", () => {
    expect(buildIdentifierTsQuery(["WE01A", "DINEN10902"])).toBe("'WE01A' | 'DINEN10902'");
  });
  it("escapes quotes and backslashes so no operand can break out", () => {
    expect(buildIdentifierTsQuery(["A'B", "C\\D"])).toBe("'A''B' | 'C\\\\D'");
  });
  it("returns null when nothing is left to match", () => {
    expect(buildIdentifierTsQuery([])).toBeNull();
    expect(buildIdentifierTsQuery(["", " "])).toBeNull();
  });
});

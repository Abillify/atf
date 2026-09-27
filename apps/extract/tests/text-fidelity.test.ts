// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the text-layer fidelity check.
 *
 * The check exists to catch the one failure mode the wording-authority prompt
 * cannot prevent on its own: a vision model silently altering a number or an
 * article code. The tests fix the behaviour that matters — a genuine loss is
 * flagged, a faithful transcription is not, separator noise does not count as a
 * change, and the false-positive guards keep an incidental dropped footer from
 * tripping the warning.
 */

import { describe, expect, it } from "vitest";
import {
  checkTextFidelity,
  extractRiskyTokens,
  textFidelityWarning,
  MIN_MISSING,
} from "../src/pipeline/text-fidelity.js";

describe("extractRiskyTokens", () => {
  it("picks up numbers and mixed identifiers but not plain words", () => {
    const tokens = extractRiskyTokens("Artikel BA2b, Menge 1.234 Stück, Version zwei");
    const kinds = tokens.map((t) => t.kind);
    expect(tokens.some((t) => t.kind === "identifier" && t.key === "ba2b")).toBe(true);
    expect(tokens.some((t) => t.kind === "number" && t.key === "1234")).toBe(true);
    // "zwei" and "Artikel"/"Menge"/"Stück" are plain words — not risky.
    expect(kinds).not.toContain(undefined);
    expect(tokens.every((t) => t.key !== "zwei")).toBe(true);
  });

  it("normalises thousands separators to the digit core", () => {
    const tokens = extractRiskyTokens("1.234,56 und 1 234");
    expect(tokens.map((t) => t.key)).toContain("123456");
    expect(tokens.map((t) => t.key)).toContain("1234");
  });
});

describe("checkTextFidelity", () => {
  it("returns nothing when the text layer is empty (an OCR page)", () => {
    const result = checkTextFidelity("", "## Seite\nirgendein Modelltext 123");
    expect(result.totalTokens).toBe(0);
    expect(result.flagged).toBe(false);
    expect(result.missing).toEqual([]);
  });

  it("does not flag a faithful transcription", () => {
    const raw = "Position 10, Artikel BA2b, Menge 1.234, Datum 15.09.2023";
    const markdown = "Position 10 — Artikel BA2b, Menge 1234, am 15.09.2023 geliefert.";
    const result = checkTextFidelity(raw, markdown);
    expect(result.flagged).toBe(false);
    expect(result.missing).toEqual([]);
  });

  it("treats separator differences as equal, not as a change", () => {
    const result = checkTextFidelity("Betrag 1.234.567,89 EUR", "Betrag 1234567,89 EUR");
    expect(result.missing).toEqual([]);
    expect(result.flagged).toBe(false);
  });

  it("flags a page that lost many risky tokens", () => {
    const raw = "Codes: AB12 CD34 EF56 GH78 IJ90 KL12 und Menge 4711";
    // The model dropped every identifier and the quantity.
    const markdown = "Eine Tabelle mit Codes und einer Menge.";
    const result = checkTextFidelity(raw, markdown);
    expect(result.flagged).toBe(true);
    expect(result.missing.length).toBeGreaterThanOrEqual(MIN_MISSING);
    const warning = textFidelityWarning(result);
    expect(warning).toBeDefined();
    expect(warning).toMatch(/Textschicht/);
    expect(warning).toMatch(/nicht automatisch korrigiert/);
  });

  it("does not flag when only a single token is missing (a dropped footer)", () => {
    // A page whose footer page-number the prompt tells the model to omit.
    const raw = "Inhalt mit vielen Zahlen 10 20 30 40 50 und Fußzeile 99";
    const markdown = "Inhalt mit vielen Zahlen 10 20 30 40 50.";
    const result = checkTextFidelity(raw, markdown);
    // One missing out of six is below both thresholds.
    expect(result.missing).toEqual(["99"]);
    expect(result.flagged).toBe(false);
  });

  it("produces no warning string when not flagged", () => {
    const result = checkTextFidelity("Menge 100", "Menge 100");
    expect(textFidelityWarning(result)).toBeUndefined();
  });
});

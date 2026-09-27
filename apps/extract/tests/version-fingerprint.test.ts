// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  detectVersionInText,
  explicitVersion,
  parseLlmVersion,
  sourceModifiedVersion,
} from "../src/jobs/version-detect.js";
import { fingerprintTokens, minhashOf, textFingerprint } from "../src/jobs/fingerprint.js";

const NOW = new Date("2026-09-27T12:00:00Z");

describe("detectVersionInText", () => {
  const cases: Array<[string, string, ReturnType<typeof detectVersionInText>]> = [
    ["German version with date", "Betriebshandbuch\nVersion 2.1 vom 12.03.2024\nSeite 1", { label: "2.1", date: "2024-03-12", source: "page_label" }],
    ["English revision letter", "Installation Guide\nRev. C\nMarch 4, 2025", { label: "Rev. C", date: "2025-03-04", source: "page_label" }],
    ["bare v-token", "Produktbeschreibung v3.0.1\n", { label: "3.0.1", source: "page_label" }],
    ["Fassung", "Richtlinie IT-Sicherheit\nFassung 4\n", { label: "4", source: "page_label" }],
    ["Stand date only", "Preisliste\nStand: 01.02.2025\n", { date: "2025-02-01", source: "page_date" }],
    ["label on the previous line", "Richtlinie\nStand:\n15. Januar 2025", { date: "2025-01-15", source: "page_date" }],
    ["month precision", "Newsletter\nMärz 2024", { date: "2024-03-01", source: "page_date" }],
    ["ISO date", "Report\nDate: 2025-11-30", { date: "2025-11-30", source: "page_date" }],
  ];
  for (const [name, text, expected] of cases) {
    it(name, () => {
      expect(detectVersionInText(text, NOW)).toEqual(expected);
    });
  }

  it("ignores standard numbers, validity dates, future dates and dated 'Ausgabe'", () => {
    expect(detectVersionInText("Zertifikat nach ISO 9001:2015", NOW)).toBeUndefined();
    expect(detectVersionInText("Vertrag\ngültig ab 01.01.2026\n", NOW)).toBeUndefined();
    expect(detectVersionInText("Einladung\nTermin 12.12.2030", NOW)).toBeUndefined();
    expect(detectVersionInText("Kundenmagazin\nAusgabe 12.03.2024", NOW)).toEqual({
      date: "2024-03-12",
      source: "page_date",
    });
  });

  it("does not guess between several unlabelled dates far down the page", () => {
    const lines = ["Protokoll", ...Array.from({ length: 30 }, (_, i) => `Punkt ${i}`)];
    lines.push("Beschluss 01.02.2025", "Nächste Prüfung 01.02.2026");
    expect(detectVersionInText(lines.join("\n"), NOW)).toBeUndefined();
  });

  it("returns undefined for an empty page", () => {
    expect(detectVersionInText("  \n\n", NOW)).toBeUndefined();
  });
});

describe("explicit / source-modified / LLM versions", () => {
  it("an explicit date is a date, anything else a label", () => {
    expect(explicitVersion("2025-01-31")).toEqual({ date: "2025-01-31", source: "explicit" });
    expect(explicitVersion("2.4")).toEqual({ label: "2.4", source: "explicit" });
    expect(explicitVersion(" ")).toBeUndefined();
  });

  it("the file time is the weakest source", () => {
    expect(sourceModifiedVersion("2025-01-31T10:00:00+01:00")).toEqual({
      date: "2025-01-31T09:00:00.000Z",
      source: "source_modified",
    });
    expect(sourceModifiedVersion("yesterday")).toBeUndefined();
  });

  it("parses a model answer defensively", () => {
    expect(parseLlmVersion('Sure: {"version": "Version 2.0", "date": "2024-05-01"}', NOW)).toEqual({
      label: "2.0",
      date: "2024-05-01",
      source: "llm",
    });
    expect(parseLlmVersion('{"version": null, "date": "2031-01-01"}', NOW)).toBeUndefined();
    expect(parseLlmVersion("no json", NOW)).toBeUndefined();
  });
});

describe("text fingerprint", () => {
  const body =
    "Dieses Handbuch beschreibt die Installation, den Betrieb und die Wartung der Anlage. " +
    "Lesen Sie es vollständig, bevor Sie mit der Arbeit beginnen, und bewahren Sie es auf.";

  it("tolerates whitespace, hyphenation, ligatures, case and page numbers", () => {
    const pdf = [`${body.replace("Installation", "Instal-\nlation")}\n\nSeite 1 von 2`, "  3  "];
    const docx = [body.toUpperCase().replace(/ /g, "   ").replace("fi", "ﬁ")];
    const a = textFingerprint(pdf);
    const b = textFingerprint(docx);
    expect(a).not.toBeNull();
    expect(a?.textHash).toBe(b?.textHash);
    expect(a?.minhash).toEqual(b?.minhash);
  });

  it("near-identical texts share most MinHash slots, different texts few", () => {
    const base = fingerprintTokens([body.repeat(4)]);
    const edited = fingerprintTokens([`${body.repeat(4)} Ergänzung zur Revision.`]);
    const other = fingerprintTokens(["Ein völlig anderer Text über Buchhaltung, Rechnungen und Mahnwesen im Mittelstand."]);
    const same = (x: number[], y: number[]) => x.filter((v, i) => v === y[i]).length / x.length;
    expect(same(minhashOf(base), minhashOf(edited))).toBeGreaterThan(0.75);
    expect(same(minhashOf(base), minhashOf(other))).toBeLessThan(0.2);
  });

  it("returns null for too little text and signed 32-bit slots otherwise", () => {
    expect(textFingerprint(["Seite 1"])).toBeNull();
    const fp = textFingerprint([body]);
    expect(fp?.minhash).toHaveLength(64);
    expect(fp?.minhash.every((v) => Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31)).toBe(true);
  });
});

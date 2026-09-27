// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * furniture-detector.test.ts
 *
 * Recurring header/footer ("furniture") detection over a rolling window (task
 * 2.2, requirement 7.3 / D10). Driven with synthetic page geometry — a page is
 * just a set of lines with normalised boxes, exactly what S2 produces — so no
 * poppler or image is needed.
 *
 * Covers:
 *  - a line recurring at the same band across a window is recorded as furniture
 *  - a one-off line is NOT furniture
 *  - a page-number-like footer with volatile digits still matches (normalised)
 *    and lands in the pageLabel slot
 *  - the drawing-number title block on a plan survives as furniture (D10)
 *  - the rolling-window state round-trips through docpass_state on resume
 */

import { describe, expect, it } from "vitest";
import type { AnalyzedLine, PageAnalysis } from "../src/pipeline/bbox-layout.js";
import {
  createFurnitureDetector,
  normalizeFurnitureText,
  parseFurnitureState,
} from "../src/jobs/furniture-detector.js";
import { createFakeJobStore } from "./job-store-fake.js";

/** A line at a given normalised vertical centre with the given text. */
function line(text: string, centreY: number): AnalyzedLine {
  const bbox: [number, number, number, number] = [0.1, centreY - 0.01, 0.9, centreY + 0.01];
  return {
    words: [],
    bbox,
    text,
    height: 0.02,
  };
}

/** A synthetic page analysis carrying the given lines. */
function page(pageNumber: number, lines: AnalyzedLine[]): PageAnalysis {
  return {
    page: pageNumber,
    size: { widthPt: 595, heightPt: 842 },
    blocks: [],
    lines,
    words: [],
    headingCandidates: [],
  };
}

describe("createFurnitureDetector", () => {
  it("records a header that recurs at the same band across the window", () => {
    const detector = createFurnitureDetector();
    const header = "Pflichtenheft WMS";
    let last = null as ReturnType<typeof detector.observe>;
    for (let p = 1; p <= 4; p++) {
      last = detector.observe(
        page(p, [line(header, 0.04), line(`Body text of page ${p}`, 0.5)]),
      );
    }
    // By the 3rd page the header has recurred enough (minRepeats = 3).
    expect(last?.header).toBe(header);
  });

  it("does not treat a one-off line as furniture", () => {
    const detector = createFurnitureDetector();
    // Page 1 has a unique top line; pages 2-4 have a different, also-unique one.
    const r1 = detector.observe(page(1, [line("Just this once", 0.04), line("body", 0.5)]));
    detector.observe(page(2, [line("Something else", 0.04), line("body", 0.5)]));
    detector.observe(page(3, [line("Yet another", 0.04), line("body", 0.5)]));
    expect(r1).toBeNull();
  });

  it("matches a page-number footer despite volatile digits and records it as pageLabel", () => {
    const detector = createFurnitureDetector();
    let last = null as ReturnType<typeof detector.observe>;
    for (let p = 1; p <= 4; p++) {
      // "Seite 1 von 340", "Seite 2 von 340", … normalise to the same template.
      last = detector.observe(
        page(p, [line("Kapitel", 0.5), line(`Seite ${p} von 340`, 0.97)]),
      );
    }
    expect(last?.pageLabel).toBe("Seite 4 von 340");
    expect(last?.footer).toBeUndefined();
  });

  it("keeps a plan's drawing-number title block as furniture (D10)", () => {
    const detector = createFurnitureDetector();
    // A plan set: the same drawing number/revision recurs in the bottom band.
    const titleBlock = "Zeichnung ZN-4471 Rev. C";
    let last = null as ReturnType<typeof detector.observe>;
    for (let p = 1; p <= 3; p++) {
      last = detector.observe(page(p, [line("Grundriss", 0.5), line(titleBlock, 0.96)]));
    }
    // A non-page-number footer is recorded as the footer, not discarded.
    expect(last?.footer).toBe(titleBlock);
  });

  it("does not flag furniture before it has recurred enough", () => {
    const detector = createFurnitureDetector();
    const r1 = detector.observe(page(1, [line("Header", 0.04)]));
    const r2 = detector.observe(page(2, [line("Header", 0.04)]));
    // minRepeats = 3, so 2 appearances is not yet furniture.
    expect(r1).toBeNull();
    expect(r2).toBeNull();
  });

  it("round-trips the rolling-window state through docpass_state on resume", async () => {
    const store = createFakeJobStore();
    const jobId = "job-furniture";
    const header = "Betriebshandbuch";

    // First worker: process pages 1 and 2, persisting the window after each.
    const first = createFurnitureDetector();
    for (const p of [1, 2]) {
      first.observe(page(p, [line(header, 0.04), line(`body ${p}`, 0.5)]));
      await store.saveDocpassState(jobId, p, { furniture: first.snapshot() });
    }
    // After two pages the header is not yet furniture (needs a third).
    const afterTwo = first.observe(page(3, [line(header, 0.04), line("body 3", 0.5)]));
    // (page 3 makes the third appearance) — but simulate a crash BEFORE page 3
    // by resuming from the persisted state of page 2 instead.
    expect(afterTwo?.header).toBe(header); // sanity: uninterrupted run flags it

    // Resume: load the last persisted state and rebuild the detector from it.
    const persisted = await store.latestDocpassState(jobId);
    expect(persisted).not.toBeNull();
    const state = parseFurnitureState(
      (persisted?.state as { furniture?: unknown } | null)?.furniture,
    );
    // The restored window remembers pages 1 and 2.
    expect(state.window.map((e) => e.page)).toEqual([1, 2]);

    const resumed = createFurnitureDetector(state);
    // The very next page (3) is the third appearance → furniture, proving the
    // window survived the resume rather than restarting empty.
    const afterResume = resumed.observe(page(3, [line(header, 0.04), line("body 3", 0.5)]));
    expect(afterResume?.header).toBe(header);
  });
});

describe("normalizeFurnitureText", () => {
  it("collapses digits and whitespace so page numbers match across pages", () => {
    expect(normalizeFurnitureText("Seite 12 von 340")).toBe(
      normalizeFurnitureText("Seite 7 von 340"),
    );
  });

  it("rejects a too-short line as furniture", () => {
    expect(normalizeFurnitureText("x")).toBeNull();
    expect(normalizeFurnitureText("  .  ")).toBeNull();
  });
});

describe("parseFurnitureState", () => {
  it("rehydrates a valid persisted state", () => {
    const state = { version: 1, window: [{ page: 1, header: "h", footer: null }] };
    expect(parseFurnitureState(state).window).toHaveLength(1);
  });

  it("degrades an unrecognised value to an empty window", () => {
    expect(parseFurnitureState(null).window).toEqual([]);
    expect(parseFurnitureState({ version: 99 }).window).toEqual([]);
    expect(parseFurnitureState("nonsense").window).toEqual([]);
  });
});

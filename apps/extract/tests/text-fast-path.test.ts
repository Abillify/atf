// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * text-fast-path.test.ts
 *
 * The pure core of the deterministic text fast-path (task 2.9, requirements
 * 7.5, 18.1): the per-page eligibility gate and the S2-geometry → v2-blocks
 * builder, plus the fidelity check that stays active on the fast path. Driven
 * against synthetic {@link PageAnalysis} objects with no poppler, sharp, model
 * or database — the whole point of keeping the builder pure and testable.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { BBox } from "@atf/extract-contract/v2";
import type {
  AnalyzedBlock,
  AnalyzedLine,
  AnalyzedWord,
  PageAnalysis,
} from "../src/pipeline/bbox-layout.js";
import type { Classification } from "../src/jobs/page-classifier.js";
import {
  buildTextFastPathBlocks,
  checkFastPathFidelity,
  fastPathEligibility,
  fastPathMarkdown,
} from "../src/pipeline/text-fast-path.js";

// ── synthetic-geometry helpers ─────────────────────────────────────────────

function word(text: string, bbox: BBox): AnalyzedWord {
  return { text, bbox };
}

function line(text: string, bbox: BBox, height = 0.02): AnalyzedLine {
  const words: AnalyzedWord[] = text
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => word(w, bbox));
  return { words, bbox, text, height };
}

function block(lines: AnalyzedLine[]): AnalyzedBlock {
  const bbox: BBox = [
    Math.min(...lines.map((l) => l.bbox[0])),
    Math.min(...lines.map((l) => l.bbox[1])),
    Math.max(...lines.map((l) => l.bbox[2])),
    Math.max(...lines.map((l) => l.bbox[3])),
  ];
  return { lines, bbox, text: lines.map((l) => l.text).join("\n") };
}

/** A text page: two paragraph blocks, one numbered heading, one bullet list. */
function textPageAnalysis(page = 1): PageAnalysis {
  const heading = line("2.1 Anmeldung", [0.1, 0.1, 0.5, 0.13], 0.03);
  const para1 = block([
    line("Der Antragseingang wird über die Maske WE01 erfasst.", [0.1, 0.15, 0.9, 0.18]),
    line("Die Artikelnummer BA2b ist dabei Pflicht.", [0.1, 0.19, 0.9, 0.22]),
  ]);
  const list = block([
    line("- Position 1", [0.12, 0.3, 0.4, 0.33]),
    line("- Position 2", [0.12, 0.34, 0.4, 0.37]),
  ]);
  const headingBlock = block([heading]);
  return {
    page,
    size: { widthPt: 595, heightPt: 842 },
    blocks: [headingBlock, para1, list],
    lines: [heading, ...para1.lines, ...list.lines],
    words: [...para1.lines.flatMap((l) => l.words), ...list.lines.flatMap((l) => l.words), ...heading.words],
    headingCandidates: [
      { text: "2.1 Anmeldung", numbering: "2.1", bbox: heading.bbox, height: heading.height },
    ],
  };
}

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    class: "text",
    textDensity: 120,
    inkRatioOutsideBlocks: 0.01,
    largeFormat: false,
    ...overrides,
  };
}

const emptyAnalysis = (page = 1): PageAnalysis => ({
  page,
  size: { widthPt: 0, heightPt: 0 },
  blocks: [],
  lines: [],
  words: [],
  headingCandidates: [],
});

// ── eligibility gate ────────────────────────────────────────────────────────

describe("fastPathEligibility", () => {
  const base = {
    enabled: true,
    analysis: textPageAnalysis(),
    maxInkRatio: 0.04,
  };

  it("accepts a clean text page with low ink and usable geometry", () => {
    expect(fastPathEligibility({ ...base, classification: classification() })).toEqual({
      eligible: true,
    });
  });

  it("declines when the fast path is disabled", () => {
    expect(
      fastPathEligibility({ ...base, enabled: false, classification: classification() }),
    ).toEqual({ eligible: false, reason: "disabled" });
  });

  it.each(["scan", "drawing", "mixed"] as const)("declines a %s page (falls back to vision)", (cls) => {
    expect(
      fastPathEligibility({ ...base, classification: classification({ class: cls }) }),
    ).toEqual({ eligible: false, reason: "not-text" });
  });

  it("declines a text page with no usable geometry", () => {
    expect(
      fastPathEligibility({
        ...base,
        analysis: emptyAnalysis(),
        classification: classification(),
      }),
    ).toEqual({ eligible: false, reason: "no-geometry" });
  });

  it("declines when there is no ink signal (cannot rule out non-text content)", () => {
    expect(
      fastPathEligibility({
        ...base,
        classification: classification({ inkRatioOutsideBlocks: null }),
      }),
    ).toEqual({ eligible: false, reason: "no-ink-signal" });
  });

  it("declines when ink outside the blocks exceeds the ceiling", () => {
    expect(
      fastPathEligibility({
        ...base,
        classification: classification({ inkRatioOutsideBlocks: 0.2 }),
      }),
    ).toEqual({ eligible: false, reason: "ink-outside-blocks" });
  });

  it("accepts ink exactly at the ceiling", () => {
    expect(
      fastPathEligibility({
        ...base,
        classification: classification({ inkRatioOutsideBlocks: 0.04 }),
      }),
    ).toEqual({ eligible: true });
  });
});

// ── deterministic block builder ──────────────────────────────────────────────

describe("buildTextFastPathBlocks", () => {
  it("maps S2 geometry to heading / paragraph / list blocks, all source:text-layer", () => {
    const blocks = buildTextFastPathBlocks(textPageAnalysis(1), 1);
    expect(blocks).toHaveLength(3);

    const [heading, para, list] = blocks;
    expect(heading).toMatchObject({
      type: "heading",
      source: "text-layer",
      page: 1,
      level: 2,
      numbering: "2.1",
      // The numbering lives in its own field; the text is the title after it.
      text: "Anmeldung",
    });
    expect(para).toMatchObject({ type: "paragraph", source: "text-layer", page: 1 });
    if (para?.type === "paragraph") {
      expect(para.text).toContain("BA2b");
    }
    expect(list).toMatchObject({ type: "list", source: "text-layer", page: 1 });
    if (list?.type === "list") {
      expect(list.items).toEqual(["Position 1", "Position 2"]);
      expect(list.ordered).toBeUndefined(); // bullets → unordered
    }
    // Every block carries a bbox and belongs to the page.
    for (const b of blocks) {
      expect(b.bbox).toBeDefined();
      expect(b.page).toBe(1);
    }
  });

  it("marks a numbered list as ordered", () => {
    const numbered = block([
      line("1. Erster", [0.1, 0.3, 0.4, 0.33]),
      line("2. Zweiter", [0.1, 0.34, 0.4, 0.37]),
    ]);
    const analysis: PageAnalysis = {
      ...emptyAnalysis(1),
      size: { widthPt: 595, heightPt: 842 },
      blocks: [numbered],
      lines: numbered.lines,
      words: numbered.lines.flatMap((l) => l.words),
    };
    const blocks = buildTextFastPathBlocks(analysis, 1);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true });
    if (blocks[0]?.type === "list") {
      expect(blocks[0].items).toEqual(["Erster", "Zweiter"]);
    }
  });

  it("skips empty blocks", () => {
    const empty = block([line("", [0.1, 0.1, 0.1, 0.1])]);
    const analysis: PageAnalysis = {
      ...emptyAnalysis(1),
      size: { widthPt: 595, heightPt: 842 },
      blocks: [empty],
      lines: empty.lines,
      words: [],
    };
    expect(buildTextFastPathBlocks(analysis, 1)).toEqual([]);
  });

  it("generates unique block ids per page", () => {
    const blocks = buildTextFastPathBlocks(textPageAnalysis(7), 7);
    const ids = blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith("p7-")).toBe(true);
  });
});

// ── fidelity stays active on the fast path ──────────────────

describe("checkFastPathFidelity", () => {
  it("passes for a clean text layer (blocks ARE the text layer verbatim)", () => {
    const analysis = textPageAnalysis(1);
    const blocks = buildTextFastPathBlocks(analysis, 1);
    // The raw text layer as poppler linearises it: the same wording.
    const rawText =
      "2.1 Anmeldung\nDer Antragseingang wird über die Maske WE01 erfasst.\n" +
      "Die Artikelnummer BA2b ist dabei Pflicht.\n- Position 1\n- Position 2";
    const result = checkFastPathFidelity(rawText, blocks);
    expect(result.flagged).toBe(false);
  });

  it("PROPERTY: the fast-path markdown preserves every risky token of the text layer", () =>
    // The blocks are built from the geometry verbatim, so the markdown rendered
    // back from them must contain the same numbers/identifiers — the check can
    // never flag a page whose blocks came straight from that text layer.
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.stringMatching(/^[A-Za-z]{2,8}\d{1,4}$/), // identifiers like BA2b
            fc.stringMatching(/^\d{2,6}$/), // numbers
          ),
          { minLength: 1, maxLength: 8 },
        ),
        (tokens) => {
          const text = `Zeile mit ${tokens.join(" und ")} Ende.`;
          const b = block([line(text, [0.1, 0.1, 0.9, 0.13])]);
          const analysis: PageAnalysis = {
            ...emptyAnalysis(1),
            size: { widthPt: 595, heightPt: 842 },
            blocks: [b],
            lines: b.lines,
            words: b.lines.flatMap((l) => l.words),
          };
          const blocks = buildTextFastPathBlocks(analysis, 1);
          const result = checkFastPathFidelity(text, blocks);
          // Verbatim carry-over: nothing risky is ever reported missing.
          return result.missing.length === 0 && result.flagged === false;
        },
      ),
      { numRuns: 200 },
    ));
});

// ── markdown renderer ─────────────────────────────────────────────────────────

describe("fastPathMarkdown", () => {
  it("renders headings, paragraphs and list items to plain text", () => {
    const blocks = buildTextFastPathBlocks(textPageAnalysis(1), 1);
    const md = fastPathMarkdown(blocks);
    expect(md).toContain("2.1 Anmeldung");
    expect(md).toContain("WE01");
    expect(md).toContain("Position 1");
    expect(md).toContain("Position 2");
  });
});

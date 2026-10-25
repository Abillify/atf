// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure-logic tests for the contextual embedding header (task 3.3,
 * Requirements 11.4 / 11.6). No database, no network: a stubbed token counter
 * drives the 15 % cap deterministically.
 *
 * Covered:
 *   (a) the header contains title / section path / pages / type / summary and is
 *       prepended to embedInput (the header string itself; the embedInput-only
 *       wiring is verified in the batch-worker test);
 *   (b) the header is truncated to ≤ 15 % of the budget, dropping the summary
 *       tail first while keeping title / section / pages / type;
 *   (c) the optional placement sentence is folded into the header when supplied
 *       and is trimmed before the fixed head when over budget.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applyContextualHeaders,
  buildContextualHeader,
  prependHeader,
  DEFAULT_CONTEXT_HEADER_MAX_FRACTION,
  type HeaderableUnit,
  type HeaderContext,
  type HeaderTokenCounter,
  type PlacementLlm,
} from "../src/contextual-header.js";

/** A token counter that counts whitespace-delimited words. Deterministic, offline. */
const wordCounter: HeaderTokenCounter = {
  countBatch: (texts) =>
    Promise.resolve(
      texts.map((t) => (t.trim() === "" ? 0 : t.trim().split(/\s+/).length)),
    ),
};

/** A counter that always reports a huge count, forcing the truncation path. */
const alwaysOverCounter: HeaderTokenCounter = {
  countBatch: (texts) => Promise.resolve(texts.map(() => 10_000)),
};

const baseCtx: HeaderContext = {
  title: "Betriebsanleitung",
  sectionPath: ["4 Inbetriebnahme", "4.2 Erstkonfiguration"],
  pageStart: 12,
  pageEnd: 14,
  unitType: "chunk",
  pageSummary: "Die Seiten beschreiben die Erstkonfiguration des Geräts.",
};

describe("buildContextualHeader — content (case a)", () => {
  it("contains title, section path, pages, type and summary", async () => {
    const header = await buildContextualHeader(baseCtx, {
      budgetTokens: 500,
      tokenCounter: wordCounter,
    });
    expect(header).toContain("Titel: Betriebsanleitung");
    expect(header).toContain("Abschnitt: 4 Inbetriebnahme");
    expect(header).toContain("4.2 Erstkonfiguration");
    expect(header).toContain("Seiten 12\u201314");
    expect(header).toContain("Typ: chunk");
    expect(header).toContain("Zusammenfassung: Die Seiten beschreiben");
  });

  it("renders a single page as 'Seite N', not a range", async () => {
    const header = await buildContextualHeader(
      { ...baseCtx, pageStart: 7, pageEnd: 7 },
      { budgetTokens: 500, tokenCounter: wordCounter },
    );
    expect(header).toContain("Seite 7");
    expect(header).not.toContain("Seiten 7");
  });

  it("omits title and section when absent", async () => {
    const header = await buildContextualHeader(
      {
        title: undefined,
        sectionPath: [],
        pageStart: 1,
        pageEnd: 1,
        unitType: "figure",
        pageSummary: undefined,
      },
      { budgetTokens: 500, tokenCounter: wordCounter },
    );
    expect(header).not.toContain("Titel:");
    expect(header).not.toContain("Abschnitt:");
    expect(header).toContain("Seite 1");
    expect(header).toContain("Typ: figure");
  });
});

describe("prependHeader — embedInput separation (case a)", () => {
  it("prepends the header with a blank-line separator", () => {
    const out = prependHeader("Titel: X\nTyp: chunk", "Der eigentliche Text.");
    expect(out).toBe("Titel: X\nTyp: chunk\n\nDer eigentliche Text.");
    expect(out.endsWith("Der eigentliche Text.")).toBe(true);
  });

  it("returns the body unchanged for an empty header", () => {
    expect(prependHeader("", "Body")).toBe("Body");
    expect(prependHeader("   ", "Body")).toBe("Body");
  });
});

describe("buildContextualHeader — 15 % truncation (case b)", () => {
  it("drops the summary tail first, keeping title/section/pages/type", async () => {
    // budget 100 → cap = floor(100 * 0.15) = 15 words. The head is 6 words
    // (Titel: Betriebsanleitung / Abschnitt: 4 Inbetriebnahme › 4.2
    // Erstkonfiguration / Seiten 12–14 / Typ: chunk). A long summary must be
    // trimmed away to fit.
    const longSummary = Array.from({ length: 200 }, (_, i) => `wort${i}`).join(" ");
    const header = await buildContextualHeader(
      { ...baseCtx, pageSummary: longSummary },
      {
        budgetTokens: 100,
        maxFraction: DEFAULT_CONTEXT_HEADER_MAX_FRACTION,
        tokenCounter: wordCounter,
      },
    );
    const [tokens] = await wordCounter.countBatch([header]);
    expect(tokens).toBeLessThanOrEqual(15);
    // The fixed head survives the truncation.
    expect(header).toContain("Titel: Betriebsanleitung");
    expect(header).toContain("Typ: chunk");
    expect(header).toContain("Seiten 12\u201314");
    // The bulk of the summary is gone.
    expect(header).not.toContain("wort199");
  });

  it("keeps the head whole even when the head alone exceeds the cap", async () => {
    // alwaysOverCounter reports 10 000 tokens for every candidate, so no amount
    // of tail-trimming ever fits: the head is returned as-is (never a mid-word cut).
    const header = await buildContextualHeader(baseCtx, {
      budgetTokens: 10,
      tokenCounter: alwaysOverCounter,
    });
    expect(header).toContain("Titel: Betriebsanleitung");
    expect(header).toContain("Typ: chunk");
    // The summary tail was dropped entirely.
    expect(header).not.toContain("Zusammenfassung:");
  });

  it("keeps a small summary that already fits under the cap", async () => {
    const header = await buildContextualHeader(baseCtx, {
      budgetTokens: 500, // cap = 75 words, head+summary is well under
      tokenCounter: wordCounter,
    });
    expect(header).toContain("Zusammenfassung: Die Seiten beschreiben");
  });
});

describe("buildContextualHeader — placement sentence (case c)", () => {
  it("folds a placement sentence into the header under Kontext", async () => {
    const header = await buildContextualHeader(
      { ...baseCtx, placementSentence: "Dieser Abschnitt erklärt die Erstkonfiguration." },
      { budgetTokens: 500, tokenCounter: wordCounter },
    );
    expect(header).toContain("Kontext: Dieser Abschnitt erklärt");
  });

  it("trims the placement sentence (tail) before the fixed head when over budget", async () => {
    const longSentence = Array.from({ length: 100 }, (_, i) => `satz${i}`).join(" ");
    const header = await buildContextualHeader(
      { ...baseCtx, pageSummary: undefined, placementSentence: longSentence },
      { budgetTokens: 100, tokenCounter: wordCounter }, // cap = 15 words
    );
    const [tokens] = await wordCounter.countBatch([header]);
    expect(tokens).toBeLessThanOrEqual(15);
    expect(header).toContain("Titel: Betriebsanleitung");
  });
});

// ─── applyContextualHeaders (the batch-worker pass) ──────────────────────────

/** A minimal chunk/table/figure/summary unit for the header pass. */
function unit(
  unitType: string,
  overrides: Partial<HeaderableUnit> = {},
): HeaderableUnit {
  return {
    unitType,
    embedInput: `Der eigentliche Text des ${unitType}.`,
    content: `Der eigentliche Text des ${unitType}.`,
    sectionPath: ["4 Inbetriebnahme"],
    pageStart: 3,
    pageEnd: 3,
    pageSummary: "Seite 3 beschreibt die Inbetriebnahme.",
    unitId: `id-${unitType}`,
    ...overrides,
  };
}

const okLlm = (sentence: string): PlacementLlm => ({
  placeInContext: vi.fn().mockResolvedValue({ ok: true, result: sentence }),
});

describe("applyContextualHeaders — embedInput only, never content (case a)", () => {
  it("prepends the header to embedInput but leaves content untouched", async () => {
    const u = unit("chunk");
    const originalContent = u.content;
    await applyContextualHeaders([u], {
      documentTitle: "Betriebsanleitung",
      budgetTokens: 500,
      tokenCounter: wordCounter,
    });
    expect(u.embedInput).toContain("Titel: Betriebsanleitung");
    expect(u.embedInput).toContain("Der eigentliche Text des chunk.");
    // content — the stored/FTS text — is NOT polluted with the header.
    expect(u.content).toBe(originalContent);
    expect(u.content).not.toContain("Titel:");
  });

  it("skips summary/section/page/document units (they are context already)", async () => {
    const chunk = unit("chunk");
    const section = unit("section", { embedInput: "Abschnittszusammenfassung." });
    const page = unit("page", { embedInput: "Seitenzusammenfassung." });
    await applyContextualHeaders([chunk, section, page], {
      documentTitle: "Doc",
      budgetTokens: 500,
      tokenCounter: wordCounter,
    });
    expect(chunk.embedInput).toContain("Titel: Doc");
    expect(section.embedInput).toBe("Abschnittszusammenfassung.");
    expect(page.embedInput).toBe("Seitenzusammenfassung.");
  });
});

describe("applyContextualHeaders — CONTEXTUAL_CHUNK_LLM off (case c)", () => {
  it("makes NO summary-client call when the flag is off", async () => {
    const llm = okLlm("Einordnung.");
    const u = unit("chunk");
    await applyContextualHeaders([u], {
      documentTitle: "Doc",
      budgetTokens: 500,
      tokenCounter: wordCounter,
      placementLlm: llm,
      contextualChunkLlm: false,
    });
    expect(llm.placeInContext).not.toHaveBeenCalled();
    expect(u.embedInput).not.toContain("Kontext:");
  });

  it("makes NO call when the flag is on but no client is provided", async () => {
    const u = unit("chunk");
    await applyContextualHeaders([u], {
      documentTitle: "Doc",
      budgetTokens: 500,
      tokenCounter: wordCounter,
      contextualChunkLlm: true,
    });
    expect(u.embedInput).not.toContain("Kontext:");
  });
});

describe("applyContextualHeaders — CONTEXTUAL_CHUNK_LLM on (case c)", () => {
  it("appends one placement sentence per chunk when on", async () => {
    const llm = okLlm("Dieser Abschnitt beschreibt die Inbetriebnahme.");
    const chunkA = unit("chunk", { unitId: "a" });
    const chunkB = unit("chunk", { unitId: "b" });
    const fig = unit("figure", { unitId: "f" });
    await applyContextualHeaders([chunkA, chunkB, fig], {
      documentTitle: "Doc",
      budgetTokens: 500,
      tokenCounter: wordCounter,
      placementLlm: llm,
      contextualChunkLlm: true,
    });
    // One call per CHUNK (not per figure).
    expect(llm.placeInContext).toHaveBeenCalledTimes(2);
    expect(chunkA.embedInput).toContain("Kontext: Dieser Abschnitt beschreibt");
    expect(chunkB.embedInput).toContain("Kontext: Dieser Abschnitt beschreibt");
    // Figures never get the LLM sentence.
    expect(fig.embedInput).not.toContain("Kontext:");
  });
});

describe("applyContextualHeaders — LLM failure degrades (case d)", () => {
  it("degrades to the header without the sentence on a non-ok result", async () => {
    const llm: PlacementLlm = {
      placeInContext: vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: "SUMMARY_UNREACHABLE" } }),
    };
    const u = unit("chunk");
    const degradations: string[] = [];
    await applyContextualHeaders([u], {
      documentTitle: "Doc",
      budgetTokens: 500,
      tokenCounter: wordCounter,
      placementLlm: llm,
      contextualChunkLlm: true,
      onLlmDegrade: (_id, reason) => degradations.push(reason),
    });
    // The batch is not failed; the header is still applied, just without Kontext.
    expect(u.embedInput).toContain("Titel: Doc");
    expect(u.embedInput).not.toContain("Kontext:");
    expect(degradations).toEqual(["SUMMARY_UNREACHABLE"]);
  });

  it("degrades to the header without the sentence when the client throws", async () => {
    const llm: PlacementLlm = {
      placeInContext: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const u = unit("chunk");
    await expect(
      applyContextualHeaders([u], {
        documentTitle: "Doc",
        budgetTokens: 500,
        tokenCounter: wordCounter,
        placementLlm: llm,
        contextualChunkLlm: true,
      }),
    ).resolves.toBeUndefined();
    expect(u.embedInput).toContain("Titel: Doc");
    expect(u.embedInput).not.toContain("Kontext:");
  });
});

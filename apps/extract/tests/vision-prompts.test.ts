// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  PAGE_SYSTEM_PROMPT,
  PAGE_PROMPT_VERSION,
  PREV_PAGE_CONTEXT_TOKEN_BUDGET,
  PASS2_PROMPT_VERSION,
  PASS2_KINDS,
  buildPageUserPrompt,
  buildFigureUserPrompt,
  pass1PromptSet,
  pass2PromptSet,
  pass2SystemPrompt,
} from "../src/vision/prompts.js";
import { promptHash } from "../src/jobs/snapshot.js";

/** A crude token proxy: whitespace-separated words. Good enough for a budget. */
function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

describe("PAGE_SYSTEM_PROMPT (v2, task 2.3)", () => {
  it("asks for figure kind, caption and a 2–3 sentence summary", () => {
    expect(PAGE_SYSTEM_PROMPT).toContain("kind");
    expect(PAGE_SYSTEM_PROMPT).toContain("caption");
    expect(PAGE_SYSTEM_PROMPT).toMatch(/zwei bis drei Sätze/i);
  });

  it("names every contract figure kind so the model has a closed vocabulary", () => {
    for (const kind of [
      "bpmn",
      "flowchart",
      "ui_mask",
      "technical_drawing",
      "chart",
      "table_image",
      "photo",
      "diagram",
      "other",
    ]) {
      expect(PAGE_SYSTEM_PROMPT).toContain(kind);
    }
  });

  it("asks for numbered headings and table continuation markers", () => {
    expect(PAGE_SYSTEM_PROMPT).toMatch(/Nummerierung/i);
    expect(PAGE_SYSTEM_PROMPT).toContain("data-continues");
    expect(PAGE_SYSTEM_PROMPT).toContain("data-continuation");
  });

  it("drops the v1 rule forbidding figure content in the body", () => {
    // The v1 prompt said: "Übernimm Inhalt, der Teil einer Abbildung ist, nicht
    // zusätzlich in den Fließtext." That rule is gone in v2.
    expect(PAGE_SYSTEM_PROMPT).not.toContain("Teil einer Abbildung ist, nicht");
  });
});

describe("buildPageUserPrompt (v2, task 2.3)", () => {
  const base = { page: 7, pageCount: 40, rawText: "Roher Text der Seite." };

  it("includes heading candidates when supplied", () => {
    const prompt = buildPageUserPrompt({
      ...base,
      headingCandidates: [
        { numbering: "4.2", text: "4.2 Anmeldung" },
        { numbering: "4.3", text: "4.3 Teilfreigabe" },
      ],
    });
    expect(prompt).toContain("HINWEISE");
    expect(prompt).toContain("4.2 Anmeldung");
    expect(prompt).toContain("4.3 Teilfreigabe");
  });

  it("includes the previous-page heading chain and last table header", () => {
    const prompt = buildPageUserPrompt({
      ...base,
      prevPage: {
        headingChain: ["4 Antragseingang", "4.2 Anmeldung"],
        lastTableHeader: "Bereich | Feld | Typ",
      },
    });
    expect(prompt).toContain("Überschriftenkette der Vorseite");
    expect(prompt).toContain("4 Antragseingang › 4.2 Anmeldung");
    expect(prompt).toContain("Letzte Tabellen-Kopfzeile der Vorseite");
    expect(prompt).toContain("Bereich | Feld | Typ");
  });

  it("omits the HINWEISE section entirely when there is nothing to hint", () => {
    // A first page (no prev context, no candidates) must not carry empty
    // scaffolding that would confuse the model.
    const prompt = buildPageUserPrompt(base);
    expect(prompt).not.toContain("HINWEISE");
    expect(prompt).toContain("ROHTEXT:");
  });

  it("keeps the previous-page context within the ~300 token budget", () => {
    // A pathological prev-page context: a very deep heading chain and a very
    // long table header. The rendered context block must still be bounded.
    const prompt = buildPageUserPrompt({
      ...base,
      prevPage: {
        headingChain: Array.from({ length: 40 }, (_, i) => `Kapitel ${i} mit langem Titel`),
        lastTableHeader: Array.from({ length: 200 }, (_, i) => `Spalte${i}`).join(" | "),
      },
    });
    // Isolate the context block (from its heading to the closing instruction).
    const start = prompt.indexOf("Kontext der Vorseite");
    const end = prompt.indexOf("Analysiere das angehängte BILD");
    expect(start).toBeGreaterThanOrEqual(0);
    const contextBlock = prompt.slice(start, end);
    // Word count is a conservative proxy for tokens (German prose ≈1.3
    // tokens/word); the block must stay under the token budget with margin.
    expect(wordCount(contextBlock)).toBeLessThanOrEqual(PREV_PAGE_CONTEXT_TOKEN_BUDGET);
  });

  it("caps a flood of heading candidates rather than emitting them all", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      numbering: `1.${i}`,
      text: `1.${i} Ein sehr langer Titel der Überschrift Nummer ${i}`,
    }));
    const prompt = buildPageUserPrompt({ ...base, headingCandidates: many });
    const lines = prompt.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(20);
  });
});

describe("pass1PromptSet and prompt hash (task 2.3, requirement 4.12)", () => {
  it("is stable for an unchanged prompt", () => {
    expect(promptHash(pass1PromptSet())).toBe(promptHash(pass1PromptSet()));
  });

  it("carries the system prompt and version so a change moves the hash", () => {
    const set = pass1PromptSet();
    expect(set["pass1.version"]).toBe(PAGE_PROMPT_VERSION);
    expect(set["pass1.system"]).toBe(PAGE_SYSTEM_PROMPT);
  });

  it("changes when the prompt text changes", () => {
    const baseline = promptHash(pass1PromptSet());
    const changed = promptHash({ ...pass1PromptSet(), "pass1.system": `${PAGE_SYSTEM_PROMPT} extra` });
    expect(changed).not.toBe(baseline);
  });

  it("changes when only the version tag changes", () => {
    const baseline = promptHash(pass1PromptSet());
    const bumped = promptHash({ ...pass1PromptSet(), "pass1.version": "9.9.9" });
    expect(bumped).not.toBe(baseline);
  });

  it("differs from the empty seed the previous stand used", () => {
    // Regression guard: before task 2.3 the snapshot seeded `{}`, so a resume
    // could not detect a prompt change. The real set must not hash like empty.
    expect(promptHash(pass1PromptSet())).not.toBe(promptHash({}));
  });
});

describe("Pass 2 prompts (task 2.5)", () => {
  it("has a per-kind system prompt for exactly the structured kinds", () => {
    expect([...PASS2_KINDS].sort()).toEqual(
      ["bpmn", "chart", "flowchart", "table_image", "technical_drawing", "ui_mask"].sort(),
    );
    // Non-structured kinds get no Pass-2 prompt.
    expect(pass2SystemPrompt("photo")).toBeUndefined();
    expect(pass2SystemPrompt("other")).toBeUndefined();
  });

  it("names the target output format in each per-kind prompt", () => {
    expect(pass2SystemPrompt("bpmn")).toContain('"format": "process"');
    expect(pass2SystemPrompt("flowchart")).toContain('"format": "process"');
    expect(pass2SystemPrompt("ui_mask")).toContain('"format": "fields"');
    expect(pass2SystemPrompt("technical_drawing")).toContain('"format": "drawing"');
    expect(pass2SystemPrompt("chart")).toContain('"format": "data"');
    expect(pass2SystemPrompt("table_image")).toContain('"format": "data"');
  });

  it("carries the regionText and caption into the figure user prompt", () => {
    const prompt = buildFigureUserPrompt({
      kind: "ui_mask",
      regionText: "Lieferant Datum Menge",
      caption: "Maske WE01",
    });
    expect(prompt).toContain("Maske WE01");
    expect(prompt).toContain("Lieferant Datum Menge");
    expect(prompt).toContain("ui_mask");
  });

  it("marks an empty region text so the model transcribes from the image", () => {
    const prompt = buildFigureUserPrompt({ kind: "chart", regionText: "" });
    expect(prompt).toMatch(/Keine Textschicht/i);
  });
});

describe("pass2PromptSet and prompt hash (task 2.5)", () => {
  it("is stable for an unchanged prompt set", () => {
    expect(promptHash(pass2PromptSet())).toBe(promptHash(pass2PromptSet()));
  });

  it("carries the version and one entry per kind", () => {
    const set = pass2PromptSet();
    expect(set["pass2.version"]).toBe(PASS2_PROMPT_VERSION);
    for (const kind of PASS2_KINDS) {
      expect(set[`pass2.system.${kind}`]).toBeDefined();
    }
  });

  it("changes when a per-kind prompt changes", () => {
    const baseline = promptHash(pass2PromptSet());
    const changed = promptHash({
      ...pass2PromptSet(),
      "pass2.system.bpmn": `${pass2SystemPrompt("bpmn")} extra`,
    });
    expect(changed).not.toBe(baseline);
  });

  it("changes when only the version tag changes", () => {
    const baseline = promptHash(pass2PromptSet());
    const bumped = promptHash({ ...pass2PromptSet(), "pass2.version": "9.9.9" });
    expect(bumped).not.toBe(baseline);
  });

  it("combined pass1+pass2 hash differs from pass1 alone", () => {
    // The snapshot folds both sets together; adding Pass 2 must move the hash so
    // a pinned job created before Pass 2 landed detects the change.
    const combined = promptHash({ ...pass1PromptSet(), ...pass2PromptSet() });
    expect(combined).not.toBe(promptHash(pass1PromptSet()));
  });
});

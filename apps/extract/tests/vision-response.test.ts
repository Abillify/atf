// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { parseVisionPage } from "../src/vision/response.js";

/** A fictional appliance manual; the fixtures deliberately name no real domain. */
const WELL_FORMED = `<summary>Die Seite beschreibt die Inbetriebnahme.</summary>
<figures>
<figure id="1" bbox="[0.0800, 0.2100, 0.4900, 0.5600]">Ablaufdiagramm der Inbetriebnahme mit einem Entscheidungspunkt.</figure>
<figure id="2" bbox="[0.5100, 0.2100, 0.9200, 0.5600]">Foto eines Bedienfelds.</figure>
</figures>
<markdown>
# Einleitung

Vor der ersten Inbetriebnahme ist das Gerät auszupacken.

![figure_1]

Weiter geht es mit der Sichtkontrolle.

![figure_2]
</markdown>`;

describe("parseVisionPage", () => {
  it("extracts all three sections", () => {
    const parsed = parseVisionPage(WELL_FORMED, 3);
    expect(parsed.summary).toBe("Die Seite beschreibt die Inbetriebnahme.");
    expect(parsed.figures).toHaveLength(2);
    expect(parsed.markdown).toContain("# Einleitung");
    expect(parsed.warnings).toEqual([]);
  });

  it("renumbers model ids into document-unique contract ids", () => {
    // The model is asked for 1, 2, 3 per page, which collides across pages. The
    // contract requires document-unique ids because asset ids derive from them.
    const parsed = parseVisionPage(WELL_FORMED, 7);
    expect(parsed.figures.map((figure) => figure.id)).toEqual(["p7-f1", "p7-f2"]);
    expect(parsed.figures.map((figure) => figure.modelId)).toEqual(["1", "2"]);
  });

  it("rewrites body placeholders in lockstep with the entries", () => {
    // The two drifting apart was a real defect: the body referenced ids the
    // figure entries no longer used.
    const parsed = parseVisionPage(WELL_FORMED, 7);
    expect(parsed.markdown).toContain("![figure_p7-f1]");
    expect(parsed.markdown).toContain("![figure_p7-f2]");
    expect(parsed.markdown).not.toContain("![figure_1]");
  });

  it("does not corrupt a two-digit id while rewriting a one-digit one", () => {
    const many = Array.from(
      { length: 12 },
      (_, index) => `<figure id="${index + 1}" bbox="[0,0,1,1]">F${index + 1}</figure>`,
    ).join("\n");
    const raw = `<figures>${many}</figures><markdown>![figure_1] und ![figure_12]</markdown>`;
    const parsed = parseVisionPage(raw, 1);
    expect(parsed.markdown).toContain("![figure_p1-f1]");
    expect(parsed.markdown).toContain("![figure_p1-f12]");
    expect(parsed.markdown).not.toContain("![figure_p1-f1]2");
  });

  it("normalises geometry through the contract", () => {
    const parsed = parseVisionPage(
      '<figures><figure id="1" bbox="[0.9, 0.8, 0.1, 0.2]">F</figure></figures><markdown>x</markdown>',
      1,
    );
    // Corners ordered, not rejected: models routinely invert them.
    expect(parsed.figures[0]?.bbox).toEqual([0.1, 0.2, 0.9, 0.8]);
  });

  describe("recoveries", () => {
    it("strips a leaked reasoning block", () => {
      const parsed = parseVisionPage(
        "<think>Ich überlege…</think><markdown>Inhalt</markdown>",
        1,
      );
      expect(parsed.markdown).toBe("Inhalt");
      expect(parsed.markdown).not.toContain("überlege");
    });

    it("strips an unterminated reasoning block and says so", () => {
      const parsed = parseVisionPage("<markdown>Inhalt</markdown><think>abgeschnitten", 1);
      expect(parsed.markdown).toBe("Inhalt");
      expect(parsed.warnings.join(" ")).toContain("unterminated reasoning block");
    });

    it("unwraps an outer code fence", () => {
      const parsed = parseVisionPage("```markdown\n<markdown>Inhalt</markdown>\n```", 1);
      expect(parsed.markdown).toBe("Inhalt");
      expect(parsed.warnings.join(" ")).toContain("code fence");
    });

    it("uses the whole response when the markdown section is missing", () => {
      const parsed = parseVisionPage("# Nur Inhalt\n\nOhne Tags.", 1);
      expect(parsed.markdown).toContain("# Nur Inhalt");
      expect(parsed.warnings.join(" ")).toContain("no <markdown> section");
    });

    it("keeps a truncated markdown section", () => {
      // Truncation is exactly where the closing tag goes missing, and the partial
      // page is still worth indexing.
      const parsed = parseVisionPage("<markdown># Anfang\n\nDer Text bricht ab", 1);
      expect(parsed.markdown).toContain("Der Text bricht ab");
      expect(parsed.warnings.join(" ")).toContain("was not closed");
    });

    it("reads the legacy None placeholder as no figures", () => {
      const parsed = parseVisionPage("<figures>None</figures><markdown>Text</markdown>", 1);
      expect(parsed.figures).toEqual([]);
      expect(parsed.warnings).toEqual([]);
    });

    it("recovers a figure emitted outside the wrapper", () => {
      const parsed = parseVisionPage(
        '<figure id="1" bbox="[0,0,1,1]">Allein</figure><markdown>Text</markdown>',
        2,
      );
      expect(parsed.figures.map((f) => f.id)).toEqual(["p2-f1"]);
      expect(parsed.warnings.join(" ")).toContain("outside a <figures> block");
    });

    it("keeps a figure with no bbox but flags that no crop follows", () => {
      const parsed = parseVisionPage(
        '<figures><figure id="1">Ohne Geometrie</figure></figures><markdown>Text</markdown>',
        1,
      );
      expect(parsed.figures[0]?.bbox).toBeUndefined();
      expect(parsed.figures[0]?.description).toBe("Ohne Geometrie");
      expect(parsed.warnings.join(" ")).toContain("no usable bbox");
    });

    it("removes a placeholder with no matching entry", () => {
      const parsed = parseVisionPage("<markdown>Text ![figure_9] Ende</markdown>", 1);
      expect(parsed.markdown).not.toContain("![figure_9]");
      expect(parsed.warnings.join(" ")).toContain("no <figure> entry");
    });

    it("substitutes a description for an empty one", () => {
      const parsed = parseVisionPage(
        '<figures><figure id="1" bbox="[0,0,1,1]"></figure></figures><markdown>x</markdown>',
        4,
      );
      expect(parsed.figures[0]?.description).toBe("Abbildung 1 auf Seite 4");
    });

    it("flags a page that produced nothing at all", () => {
      const parsed = parseVisionPage("<markdown></markdown>", 1);
      expect(parsed.warnings.join(" ")).toContain("neither text nor figures");
    });

    it("removes NUL bytes echoed back from a damaged text layer", () => {
      // PostgreSQL rejects them outright at the far end of the pipeline.
      const parsed = parseVisionPage("<markdown>Text\u0000mehr</markdown>", 1);
      expect(parsed.markdown).toBe("Textmehr");
    });
  });

  it("leaves HTML tables intact for Search to normalise", () => {
    const parsed = parseVisionPage(
      '<markdown><table><tr><th colspan="2">Kopf</th></tr></table></markdown>',
      1,
    );
    expect(parsed.markdown).toContain('colspan="2"');
  });

  it("joins multiple summaries rather than dropping one", () => {
    const parsed = parseVisionPage(
      "<summary>Erst.</summary><summary>Dann.</summary><markdown>x</markdown>",
      1,
    );
    expect(parsed.summary).toBe("Erst. Dann.");
  });
});

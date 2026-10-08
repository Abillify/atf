// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  PAGE_RESPONSE_FORMAT,
  pageJsonToTagText,
  parsePageJson,
  pass2ResponseFormat,
} from "../src/vision/schema.js";
import { parseVisionPage } from "../src/vision/response.js";

describe("pageExtractionSchema / parsePageJson", () => {
  it("accepts a conforming page object", () => {
    const parsed = parsePageJson(
      JSON.stringify({
        summary: "Eine Seite.",
        figures: [
          {
            id: "1",
            kind: "bpmn",
            caption: "Prozess",
            bbox: [0.1, 0.2, 0.3, 0.4],
            description: "Ein Prozessdiagramm.",
          },
        ],
        markdown: "Text",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.figures[0]?.kind).toBe("bpmn");
    expect(parsed?.figures[0]?.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("accepts a numeric figure id, because models alternate between 1 and \"1\"", () => {
    const parsed = parsePageJson(
      JSON.stringify({ figures: [{ id: 2, description: "d" }], markdown: "m" }),
    );
    expect(parsed?.figures[0]?.id).toBe(2);
  });

  it("defaults a missing figures array to empty", () => {
    const parsed = parsePageJson(JSON.stringify({ markdown: "nur Text" }));
    expect(parsed?.figures).toEqual([]);
  });

  it("unwraps a JSON code fence", () => {
    const parsed = parsePageJson('```json\n{"markdown": "m"}\n```');
    expect(parsed?.markdown).toBe("m");
  });

  it("returns null for tag-format text so the caller falls back to the tag parser", () => {
    expect(parsePageJson("<summary>s</summary><markdown>m</markdown>")).toBeNull();
  });

  it("returns null for a payload missing the required markdown", () => {
    expect(parsePageJson(JSON.stringify({ summary: "s" }))).toBeNull();
  });

  it("returns null for an unknown figure kind rather than coercing it", () => {
    // The tag parser's tolerant kind handling stays the recovery path; the
    // schema must not invent a kind the contract does not define.
    expect(
      parsePageJson(
        JSON.stringify({ figures: [{ kind: "mindmap", description: "d" }], markdown: "m" }),
      ),
    ).toBeNull();
  });
});

describe("pageJsonToTagText", () => {
  it("round-trips through parseVisionPage unchanged in substance", () => {
    const structured = parsePageJson(
      JSON.stringify({
        summary: "Eine Seite über etwas.",
        figures: [
          {
            id: "1",
            kind: "chart",
            caption: 'Spannung "U"',
            bbox: [0.1, 0.2, 0.3, 0.4],
            description: "Ein Balkendiagramm.",
          },
        ],
        markdown: "Text mit ![figure_1](x) und einer Tabelle.",
      }),
    );
    if (structured === null) throw new Error("expected a conforming page");
    const parsed = parseVisionPage(pageJsonToTagText(structured), 1);

    expect(parsed.summary).toBe("Eine Seite über etwas.");
    expect(parsed.figures).toHaveLength(1);
    const figure = parsed.figures[0];
    expect(figure?.id).toBe("p1-f1");
    expect(figure?.modelId).toBe("1");
    expect(figure?.kind).toBe("chart");
    // The tag grammar double-quotes attributes; inner quotes become single.
    expect(figure?.caption).toBe("Spannung 'U'");
    expect(figure?.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
    // Placeholder rewriting works on the reconstructed text as on model output.
    expect(parsed.markdown).toContain("![figure_p1-f1]");
    expect(parsed.markdown).not.toContain("![figure_1]");
  });

  it("omits optional attributes the model left out", () => {
    const structured = parsePageJson(
      JSON.stringify({ figures: [{ description: "d" }], markdown: "m" }),
    );
    if (structured === null) throw new Error("expected a conforming page");
    const parsed = parseVisionPage(pageJsonToTagText(structured), 2);
    expect(parsed.figures[0]?.kind).toBe("other");
    expect(parsed.figures[0]?.caption).toBeUndefined();
    expect(parsed.figures[0]?.bbox).toBeUndefined();
    expect(parsed.summary).toBeUndefined();
  });

  it("keeps a figure-free page parsable with an empty figures block", () => {
    const structured = parsePageJson(JSON.stringify({ markdown: "m" }));
    if (structured === null) throw new Error("expected a conforming page");
    const parsed = parseVisionPage(pageJsonToTagText(structured), 1);
    expect(parsed.figures).toEqual([]);
    expect(parsed.markdown).toBe("m");
  });
});

describe("response formats", () => {
  it("PAGE_RESPONSE_FORMAT has the OpenAI json_schema shape", () => {
    expect(PAGE_RESPONSE_FORMAT).toMatchObject({
      type: "json_schema",
      json_schema: { name: "page_extraction", strict: false },
    });
    const schema = (PAGE_RESPONSE_FORMAT["json_schema"] as Record<string, unknown>)[
      "schema"
    ] as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    expect(schema["properties"]).toHaveProperty("markdown");
  });

  it("maps every Pass-2 prompt kind to a response format", () => {
    for (const kind of ["bpmn", "flowchart", "ui_mask", "technical_drawing", "chart", "table_image"]) {
      expect(pass2ResponseFormat(kind)).toMatchObject({ type: "json_schema" });
    }
  });

  it("has no response format for kinds without a structured transcription", () => {
    expect(pass2ResponseFormat("photo")).toBeUndefined();
    expect(pass2ResponseFormat("other")).toBeUndefined();
  });
});

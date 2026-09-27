// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * vision-pass2.test.ts
 *
 * The Pass-2 (S5) per-kind parsers and the label-coverage computation (task
 * 2.5, requirements 8.3/8.4). Each parser turns a model's raw JSON into a
 * validated contract {@link Transcription} and degrades tolerantly on malformed
 * input rather than throwing.
 */

import { describe, expect, it } from "vitest";
import { transcriptionSchema } from "@atf/extract-contract/v2";
import {
  parseProcess,
  parseFields,
  parseDrawing,
  parseData,
  parseTableImage,
  parseTranscription,
  labelCoverage,
} from "../src/vision/response.js";

describe("Pass 2 · parseProcess (bpmn / flowchart)", () => {
  it("parses a well-formed process transcription", () => {
    const raw = JSON.stringify({
      format: "process",
      mermaid: "flowchart TD\n  A-->B",
      nodes: [
        { id: "A", type: "start", label: "Anmeldung", lane: "Sachbearbeitung" },
        { id: "B", type: "task", label: "Prüfen" },
      ],
      edges: [{ from: "A", to: "B", condition: "ja" }],
      lanes: ["Sachbearbeitung"],
      steps: ["Anmeldung erfassen", "Prüfen"],
    });
    const { transcription, warnings } = parseProcess(raw);
    expect(transcription.format).toBe("process");
    // The contract schema is the final gate.
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    expect(warnings).toEqual([]);
    if (transcription.format === "process") {
      expect(transcription.nodes).toHaveLength(2);
      expect(transcription.edges[0]?.condition).toBe("ja");
      expect(transcription.lanes).toEqual(["Sachbearbeitung"]);
    }
  });

  it("tolerates a leading prose preamble and a code fence", () => {
    const raw =
      "Hier ist das JSON:\n```json\n" +
      JSON.stringify({ format: "process", mermaid: "flowchart TD", nodes: [], edges: [], steps: [] }) +
      "\n```";
    const { transcription } = parseProcess(raw);
    expect(transcription.format).toBe("process");
  });

  it("drops a malformed node with a warning instead of throwing", () => {
    const raw = JSON.stringify({
      format: "process",
      mermaid: "flowchart TD",
      nodes: ["not-an-object", { id: "A", type: "task", label: "OK" }],
      edges: [{ from: "A" }], // no `to` → dropped
      steps: [],
    });
    const { transcription, warnings } = parseProcess(raw);
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    if (transcription.format === "process") {
      expect(transcription.nodes).toHaveLength(1);
      expect(transcription.edges).toHaveLength(0);
    }
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("falls back to a markdown transcription when there is no JSON", () => {
    const { transcription, warnings } = parseProcess("the model refused politely");
    expect(transcription.format).toBe("markdown");
    if (transcription.format === "markdown") {
      expect(transcription.text).toContain("refused");
    }
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("Pass 2 · parseFields (ui_mask)", () => {
  it("parses areas, fields, actions and messages", () => {
    const raw = JSON.stringify({
      format: "fields",
      areas: [
        {
          name: "Kopfdaten",
          fields: [
            { label: "Lieferant", type: "text", required: "ja", default: "" },
            { label: "Datum", type: "date" },
          ],
        },
      ],
      actions: ["Speichern", "Abbrechen"],
      messages: ["Pflichtfeld fehlt"],
    });
    const { transcription, warnings } = parseFields(raw);
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    expect(warnings).toEqual([]);
    if (transcription.format === "fields") {
      expect(transcription.areas[0]?.fields[0]?.required).toBe(true);
      expect(transcription.actions).toEqual(["Speichern", "Abbrechen"]);
      expect(transcription.messages).toEqual(["Pflichtfeld fehlt"]);
    }
  });

  it("coerces a missing fields array to empty rather than throwing", () => {
    const raw = JSON.stringify({
      format: "fields",
      areas: [{ name: "Leer" }],
      actions: [],
    });
    const { transcription } = parseFields(raw);
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    if (transcription.format === "fields") {
      expect(transcription.areas[0]?.fields).toEqual([]);
    }
  });
});

describe("Pass 2 · parseDrawing (technical_drawing)", () => {
  it("parses a title block, parts list and note lists", () => {
    const raw = JSON.stringify({
      format: "drawing",
      titleBlock: { Titel: "Getriebe", Zeichnungsnummer: "ZG-100", Maßstab: "1:2" },
      partsList: [
        ["Pos", "Benennung", "Menge"],
        ["1", "Welle", "1"],
      ],
      legend: ["A = Achse"],
      dimensions: ["Ø 40 h7"],
      notes: ["Kanten brechen"],
    });
    const { transcription, warnings } = parseDrawing(raw);
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    expect(warnings).toEqual([]);
    if (transcription.format === "drawing") {
      expect(transcription.titleBlock["Zeichnungsnummer"]).toBe("ZG-100");
      expect(transcription.partsList).toHaveLength(2);
      expect(transcription.dimensions).toEqual(["Ø 40 h7"]);
    }
  });

  it("treats a non-object titleBlock as empty with a warning", () => {
    const raw = JSON.stringify({ format: "drawing", titleBlock: "not-an-object" });
    const { transcription, warnings } = parseDrawing(raw);
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    if (transcription.format === "drawing") {
      expect(transcription.titleBlock).toEqual({});
    }
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("Pass 2 · parseData (chart) and parseTableImage", () => {
  it("parses a chart data table with axes", () => {
    const raw = JSON.stringify({
      format: "data",
      table: [
        ["Jahr", "Umsatz"],
        ["2023", "10"],
        ["2024", "12"],
      ],
      axes: ["x: Jahr", "y: Umsatz"],
    });
    const { transcription } = parseData(raw);
    expect(() => transcriptionSchema.parse(transcription)).not.toThrow();
    if (transcription.format === "data") {
      expect(transcription.table).toHaveLength(3);
      expect(transcription.axes).toEqual(["x: Jahr", "y: Umsatz"]);
    }
  });

  it("parseTableImage produces a data transcription and drops any axes", () => {
    const raw = JSON.stringify({
      format: "data",
      table: [["A", "B"], ["1", "2"]],
      axes: ["should be dropped"],
    });
    const { transcription } = parseTableImage(raw);
    expect(transcription.format).toBe("data");
    if (transcription.format === "data") {
      expect(transcription.axes).toBeUndefined();
      expect(transcription.table).toEqual([["A", "B"], ["1", "2"]]);
    }
  });
});

describe("Pass 2 · parseTranscription dispatch", () => {
  it("routes each pass-2 kind to a parser and skips non-pass-2 kinds", () => {
    expect(parseTranscription("bpmn", '{"format":"process","mermaid":"","nodes":[],"edges":[],"steps":[]}')).not.toBeNull();
    expect(parseTranscription("ui_mask", '{"format":"fields","areas":[],"actions":[]}')).not.toBeNull();
    expect(parseTranscription("table_image", '{"format":"data","table":[]}')).not.toBeNull();
    // photo / diagram / other get no Pass 2.
    expect(parseTranscription("photo", "{}")).toBeNull();
    expect(parseTranscription("other", "{}")).toBeNull();
  });
});

describe("Pass 2 · labelCoverage", () => {
  it("is 1 when there are no labels (nothing to miss)", () => {
    const t = parseData('{"format":"data","table":[["A"]]}').transcription;
    expect(labelCoverage([], t)).toBe(1);
  });

  it("counts labels present in the flattened transcription, case-insensitively", () => {
    const t = parseProcess(
      JSON.stringify({
        format: "process",
        mermaid: "flowchart TD",
        nodes: [{ id: "A", type: "task", label: "Anmeldung" }],
        edges: [],
        steps: ["Beleg prüfen"],
      }),
    ).transcription;
    // "anmeldung" and "beleg" appear; "unbekannt" does not → 2/3.
    expect(labelCoverage(["Anmeldung", "BELEG", "unbekannt"], t)).toBeCloseTo(2 / 3, 5);
  });
});

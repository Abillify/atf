// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { pageRecordSchema } from "@atf/extract-contract/v2";
import { readXlsx } from "../src/pipeline/native/xlsx.js";
import { buildXlsxRecords } from "../src/pipeline/native/index.js";

/**
 * Build a minimal XLSX (an OOXML ZIP) directly with fflate, so the test needs
 * no spreadsheet library. The workbook has a header row, values, a formula with
 * a cached result, a shared string and a merged cell — the exact cases
 * requirement 10.2 names (cells, merges, computed values).
 */
function buildDataWorkbook(extraParts: Record<string, Uint8Array> = {}): Uint8Array {
  const workbook = `<?xml version="1.0"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Zahlen" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const rels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://.../worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
  // Shared strings: 0=Artikel 1=Menge 2=Preis 3=Summe 4=Schraube 5=Zusammenfassung
  const shared = `<?xml version="1.0"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">
  <si><t>Artikel</t></si><si><t>Menge</t></si><si><t>Preis</t></si>
  <si><t>Summe</t></si><si><t>Schraube</t></si><si><t>Zusammenfassung</t></si>
</sst>`;
  const sheet = `<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>4</v></c>
      <c r="B2"><v>10</v></c>
      <c r="C2"><v>2.5</v></c>
      <c r="D2"><f>B2*C2</f><v>25</v></c>
    </row>
    <row r="4">
      <c r="A4" t="s"><v>5</v></c>
    </row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A4:B4"/></mergeCells>
</worksheet>`;
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/sharedStrings.xml": strToU8(shared),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
    ...extraParts,
  });
}

describe("readXlsx", () => {
  it("reads cells, computed formula values and merged cells as a table", async () => {
    const parsed = await readXlsx(buildDataWorkbook());
    expect(parsed.warnings).toEqual([]);
    expect(parsed.sheets).toHaveLength(1);

    const [sheet] = parsed.sheets;
    if (sheet === undefined) throw new Error("expected a sheet");
    expect(sheet.name).toBe("Zahlen");

    // Row 1 header (shared strings resolved).
    expect(sheet.rows[0]?.map((c) => c.text)).toEqual(["Artikel", "Menge", "Preis", "Summe"]);
    // Row 2 values, including the cached formula result (25) for D2.
    expect(sheet.rows[1]?.map((c) => c.text)).toEqual(["Schraube", "10", "2.5", "25"]);

    // The merged A4:B4 cell carries its span on the anchor.
    const mergedRow = sheet.rows.find((row) => row.some((c) => c.text === "Zusammenfassung"));
    const merged = mergedRow?.find((c) => c.text === "Zusammenfassung");
    expect(merged?.colspan).toBe(2);
  });

  it("does not need a render for a pure data workbook", async () => {
    const parsed = await readXlsx(buildDataWorkbook());
    expect(parsed.needsRender).toBe(false);
    expect(parsed.renderReasons).toEqual([]);
  });

  it("needs a render when the workbook embeds an image", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const parsed = await readXlsx(buildDataWorkbook({ "xl/media/image1.png": new Uint8Array(png) }));
    expect(parsed.needsRender).toBe(true);
    expect(parsed.renderReasons).toContain("images");
    // The grid is still read alongside the render decision.
    expect(parsed.sheets[0]?.rows.length).toBeGreaterThan(0);
  });

  it("needs a render when the workbook embeds a chart", async () => {
    const chart = strToU8('<?xml version="1.0"?><chartSpace/>');
    const parsed = await readXlsx(buildDataWorkbook({ "xl/charts/chart1.xml": chart }));
    expect(parsed.needsRender).toBe(true);
    expect(parsed.renderReasons).toContain("charts");
  });

  it("degrades to an empty result with a warning on non-XLSX bytes", async () => {
    const parsed = await readXlsx(new TextEncoder().encode("not a spreadsheet"));
    expect(parsed.sheets).toEqual([]);
    expect(parsed.needsRender).toBe(false);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });
});

describe("buildXlsxRecords", () => {
  it("emits one contract-valid table page per worksheet with header rows", async () => {
    const parsed = await readXlsx(buildDataWorkbook());
    const built = buildXlsxRecords("xlsx-ref", parsed);
    expect(built.needsRender).toBe(false);
    expect(built.records).toHaveLength(1);

    const [record] = built.records;
    if (record === undefined) throw new Error("expected a record");
    expect(() => pageRecordSchema.parse(record)).not.toThrow();

    const table = record.blocks.find((b) => b.type === "table");
    expect(table).toBeDefined();
    if (table?.type === "table") {
      expect(table.source).toBe("native");
      expect(table.caption).toBe("Zahlen");
      // First row became the header; the rest are body rows.
      expect(table.headerRows).toHaveLength(1);
      expect(table.rows.length).toBeGreaterThan(0);
      // The merged cell object is preserved with its span in the body.
      const cells = table.rows.flat();
      const merged = cells.find((c) => typeof c === "object" && c.text === "Zusammenfassung");
      expect(merged).toMatchObject({ colspan: 2 });
    }
  });
});

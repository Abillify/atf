// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractDocxEmbeddings } from "../src/pipeline/native/index.js";
import { resolveFormat } from "../src/formats.js";
import { writeCfb } from "./cfb-writer.js";

const BPMN = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="p"/></definitions>';

function xlsx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    ),
    "xl/workbook.xml": strToU8("<workbook/>"),
  });
}

/** An `\x01Ole10Native` package object wrapping a file. */
function ole10Native(label: string, data: Uint8Array): Uint8Array {
  const parts: Buffer[] = [];
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const tmp = Buffer.from(`C:\\Temp\\${label}\0`, "latin1");
  parts.push(Buffer.from([2, 0]), Buffer.from(`${label}\0`, "latin1"), Buffer.from(`C:\\src\\${label}\0`, "latin1"));
  parts.push(u32(0x00030000), u32(tmp.length), tmp, u32(data.length), Buffer.from(data));
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]);
}

function docx(embeddings: Record<string, Uint8Array>): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8("<w:document/>"),
    "word/media/image1.emf": new Uint8Array([1, 2, 3]),
    ...Object.fromEntries(Object.entries(embeddings).map(([k, v]) => [`word/embeddings/${k}`, v])),
  });
}

describe("extractDocxEmbeddings", () => {
  it("returns raw OOXML packages, OLE package objects and OOXML-in-OLE, not media", () => {
    const pdf = Buffer.from(`%PDF-1.4\n${"x".repeat(100)}\n%%EOF`);
    const { sources, warnings } = extractDocxEmbeddings(
      docx({
        "Microsoft_Excel_Worksheet.xlsx": xlsx(),
        "oleObject1.bin": writeCfb([{ name: "\u0001Ole10Native", data: ole10Native("Prozess.bpmn", strToU8(BPMN)) }]),
        "oleObject2.bin": writeCfb([{ name: "Package", data: xlsx() }]),
        "oleObject3.bin": writeCfb([{ name: "\u0001Ole10Native", data: ole10Native("Spez.pdf", pdf) }]),
        "oleObject4.bin": writeCfb([{ name: "Equation Native", data: new Uint8Array(10) }]),
      }),
    );
    expect(sources.map((s) => [s.filename, s.mimeType])).toEqual([
      ["Microsoft_Excel_Worksheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["Prozess.bpmn", "application/bpmn+xml"],
      ["oleObject2.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["Spez.pdf", "application/pdf"],
    ]);
    expect(new TextDecoder().decode(sources[1]?.content)).toBe(BPMN);
    // Every child resolves to a format Extract can read.
    for (const s of sources) {
      const resolved = resolveFormat({ buffer: s.content, filename: s.filename, declaredMimeType: s.mimeType });
      expect(resolved.ok).toBe(true);
    }
    expect(warnings.join()).toContain("oleObject4.bin");
  });

  it("returns nothing for a DOCX without embeddings or an unreadable package", () => {
    expect(extractDocxEmbeddings(docx({})).sources).toEqual([]);
    expect(extractDocxEmbeddings(new Uint8Array([1, 2, 3])).sources).toEqual([]);
  });
});

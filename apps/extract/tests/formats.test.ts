// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  extensionOf,
  formatByMimeType,
  resolveFormat,
  sniffFamily,
  supportedExtensions,
  supportedMimeTypes,
} from "../src/formats.js";
import { officeExtensionFor } from "../src/pipeline/office.js";

const PDF = Buffer.from("%PDF-1.7\n%…\n");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const GIF = Buffer.from("GIF89a\u0001\u0000");
function oleWithStream(name: string, streamDirectorySector = 0, includeDifat = false): Buffer {
  const sectorSize = 512;
  const fatSector = streamDirectorySector + 1;
  const difatSector = fatSector + 1;
  const finalSector = includeDifat ? difatSector : fatSector;
  const buffer = Buffer.alloc((finalSector + 2) * sectorSize);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buffer);
  buffer.writeUInt16LE(0xfffe, 28);
  buffer.writeUInt16LE(9, 30);
  buffer.writeUInt32LE(1, 44);
  buffer.writeInt32LE(0, 48);
  buffer.writeInt32LE(includeDifat ? difatSector : -2, 68);
  buffer.writeUInt32LE(includeDifat ? 1 : 0, 72);
  buffer.fill(0xff, 76, 512);
  buffer.writeInt32LE(fatSector, 76);

  const directoryOffset = (streamDirectorySector + 1) * sectorSize;
  const encoded = Buffer.from(`${name}\0`, "utf16le");
  encoded.copy(buffer, directoryOffset, 0, Math.min(encoded.length, 64));
  buffer.writeUInt16LE(Math.min(encoded.length, 64), directoryOffset + 64);
  buffer[directoryOffset + 66] = 2;

  const fatOffset = (fatSector + 1) * sectorSize;
  buffer.fill(0xff, fatOffset, fatOffset + sectorSize);
  for (let sector = 0; sector <= streamDirectorySector; sector++) {
    buffer.writeUInt32LE(
      sector === streamDirectorySector ? 0xfffffffe : sector + 1,
      fatOffset + sector * 4,
    );
  }
  buffer.writeUInt32LE(0xfffffffd, fatOffset + fatSector * 4);
  if (includeDifat) {
    buffer.writeUInt32LE(0xfffffffc, fatOffset + difatSector * 4);
    const difatOffset = (difatSector + 1) * sectorSize;
    buffer.fill(0xff, difatOffset, difatOffset + sectorSize);
    buffer.writeUInt32LE(0xfffffffe, difatOffset + sectorSize - 4);
  }
  return buffer;
}
const DOC_OLE = oleWithStream("WordDocument");
const XLS_OLE = oleWithStream("Workbook");
const OTHER_OLE = oleWithStream("PowerPoint Document");
const TIFF_LE = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08]);
const TIFF_BE = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00]);
const BMP = Buffer.from([0x42, 0x4d, 0x10, 0x00]);
const WEBP = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ");
const NOISE = Buffer.from("this is just text");

describe("supported set", () => {
  it("covers exactly the specified formats", () => {
    expect(supportedMimeTypes()).toEqual([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/tiff",
      "image/bmp",
      "image/webp",
    ]);
  });

  it("includes legacy Office and extract image extensions", () => {
    expect(supportedExtensions()).toEqual(
      expect.arrayContaining([".doc", ".xls", ".tif", ".tiff", ".bmp", ".webp"]),
    );
  });
});

describe("sniffFamily", () => {
  it("identifies each signature", () => {
    expect(sniffFamily(PDF)).toBe("pdf");
    expect(sniffFamily(ZIP)).toBe("zip");
    expect(sniffFamily(PNG)).toBe("png");
    expect(sniffFamily(JPEG)).toBe("jpeg");
    expect(sniffFamily(GIF)).toBe("gif");
    expect(sniffFamily(DOC_OLE)).toBe("ole");
    expect(sniffFamily(TIFF_LE)).toBe("tiff");
    expect(sniffFamily(TIFF_BE)).toBe("tiff");
    expect(sniffFamily(BMP)).toBe("bmp");
    expect(sniffFamily(WEBP)).toBe("webp");
    expect(sniffFamily(Buffer.from("RIFF-not-webp"))).toBe("unknown");
    expect(sniffFamily(NOISE)).toBe("unknown");
  });

  it("does not read past a short buffer", () => {
    expect(sniffFamily(Buffer.from([0x89]))).toBe("unknown");
    expect(sniffFamily(Buffer.alloc(0))).toBe("unknown");
  });
});

describe("extensionOf", () => {
  it("lower-cases and keeps the dot", () => {
    expect(extensionOf("Report.PDF")).toBe(".pdf");
    expect(extensionOf("a.b.docx")).toBe(".docx");
  });

  it("returns empty for no extension", () => {
    expect(extensionOf("README")).toBe("");
  });
});

describe("resolveFormat", () => {
  it("trusts the bytes over a wrong declaration for unambiguous formats", () => {
    // Browsers send application/octet-stream often enough that the declaration
    // cannot be authoritative.
    const result = resolveFormat({
      buffer: PDF,
      filename: "scan.pdf",
      declaredMimeType: "application/octet-stream",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.format.mimeType).toBe("application/pdf");
  });

  it("resolves an image with no filename and no declaration", () => {
    const result = resolveFormat({ buffer: PNG });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.format.mimeType).toBe("image/png");
  });

  it("reports a declaration that contradicts the content", () => {
    // A caller who declared PDF and sent PNG has a bug worth hearing about, and
    // silently overriding would hide it.
    const result = resolveFormat({
      buffer: PNG,
      filename: "report.pdf",
      declaredMimeType: "application/pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/declares PDF but the file content is PNG/);
  });

  describe("OOXML, where the signature is ambiguous", () => {
    it("uses the declaration to choose DOCX", () => {
      const result = resolveFormat({
        buffer: ZIP,
        filename: "spec.docx",
        declaredMimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.format.kind).toBe("word");
    });

    it("falls back to the extension when the declaration is generic", () => {
      const result = resolveFormat({
        buffer: ZIP,
        filename: "budget.xlsx",
        declaredMimeType: "application/octet-stream",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.format.kind).toBe("spreadsheet");
    });

    it("refuses a bare ZIP with no hint at all", () => {
      const result = resolveFormat({ buffer: ZIP, filename: "archive.zip" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/whether it is DOCX or XLSX/);
    });

    it("will not let a declaration route arbitrary bytes into LibreOffice", () => {
      // The declaration only picks between two ZIP-shaped candidates; it cannot
      // make a text file into a DOCX.
      const result = resolveFormat({
        buffer: NOISE,
        filename: "payload.docx",
        declaredMimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/content does not match that format/);
    });
  });

  describe("legacy Office OLE, where the signature is ambiguous", () => {
    it("uses the declaration to choose DOC", () => {
      const result = resolveFormat({
        buffer: DOC_OLE,
        filename: "spec.doc",
        declaredMimeType: "application/msword",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.format.mimeType).toBe("application/msword");
    });

    it("uses the extension to choose XLS", () => {
      const result = resolveFormat({
        buffer: XLS_OLE,
        filename: "budget.xls",
        declaredMimeType: "application/octet-stream",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.format.mimeType).toBe("application/vnd.ms-excel");
    });

    it("follows the FAT chain to a later directory sector", () => {
      const result = resolveFormat({
        buffer: oleWithStream("WordDocument", 1),
        filename: "chained.doc",
        declaredMimeType: "application/msword",
      });
      expect(result.ok).toBe(true);
    });

    it("refuses a primary stream when the FAT declaration is missing", () => {
      const malformed = Buffer.from(DOC_OLE);
      malformed.writeUInt32LE(0, 44);
      malformed.writeInt32LE(-1, 76);
      const result = resolveFormat({
        buffer: malformed,
        filename: "broken.doc",
        declaredMimeType: "application/msword",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/primary stream required for Word/);
    });

    it("refuses a FAT sector without the FATSECT marker", () => {
      const malformed = Buffer.from(DOC_OLE);
      malformed.writeUInt32LE(0xfffffffe, 2 * 512 + 4);
      const result = resolveFormat({
        buffer: malformed,
        filename: "bad-fat.doc",
        declaredMimeType: "application/msword",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/primary stream required for Word/);
    });

    it("refuses a DIFAT sector without the DIFSECT marker", () => {
      const malformed = oleWithStream("WordDocument", 0, true);
      malformed.writeUInt32LE(0xfffffffe, 2 * 512 + 8);
      const result = resolveFormat({
        buffer: malformed,
        filename: "bad-difat.doc",
        declaredMimeType: "application/msword",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/primary stream required for Word/);
    });

    it("refuses a different OLE compound format renamed to DOC", () => {
      const result = resolveFormat({
        buffer: OTHER_OLE,
        filename: "slides.doc",
        declaredMimeType: "application/msword",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/primary stream required for Word/);
    });

    it("refuses a bare OLE container", () => {
      const result = resolveFormat({ buffer: DOC_OLE, filename: "legacy.bin" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/whether it is DOC or XLS/);
    });
  });

  it.each([
    [TIFF_LE, "image/tiff"],
    [BMP, "image/bmp"],
    [WEBP, "image/webp"],
  ])("resolves extract image bytes as %s", (buffer, mimeType) => {
    const result = resolveFormat({ buffer });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.format.mimeType).toBe(mimeType);
  });

  it("refuses an entirely unknown file with the supported list", () => {
    const result = resolveFormat({ buffer: NOISE, filename: "notes.txt" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Supported formats: PDF, Word \(DOCX\)/);
  });

  it("ignores charset parameters on the declared type", () => {
    const result = resolveFormat({
      buffer: PNG,
      declaredMimeType: "image/png; charset=binary",
    });
    expect(result.ok).toBe(true);
  });
});

describe("LibreOffice import extensions", () => {
  it.each([
    ["application/msword", ".doc"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    ["application/vnd.ms-excel", ".xls"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
  ])("preserves the exact format for %s", (mimeType, expected) => {
    const format = formatByMimeType(mimeType);
    if (format === undefined) throw new Error(`Missing supported format for ${mimeType}`);
    expect(officeExtensionFor(format)).toBe(expected);
  });
});
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  extensionOf,
  resolveFormat,
  sniffFamily,
  supportedExtensions,
  supportedMimeTypes,
} from "../src/formats.js";

const PDF = Buffer.from("%PDF-1.7\n%…\n");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const GIF = Buffer.from("GIF89a\u0001\u0000");
const NOISE = Buffer.from("this is just text");

describe("supported set", () => {
  it("covers exactly the specified formats", () => {
    expect(supportedMimeTypes()).toEqual([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/png",
      "image/jpeg",
      "image/gif",
    ]);
  });

  it("does not accept the legacy binary Office formats", () => {
    // Deliberate: LibreOffice's binary-format parsers have the worst track record,
    // and nothing asked for .doc/.xls.
    expect(supportedExtensions()).not.toContain(".doc");
    expect(supportedExtensions()).not.toContain(".xls");
  });
});

describe("sniffFamily", () => {
  it("identifies each signature", () => {
    expect(sniffFamily(PDF)).toBe("pdf");
    expect(sniffFamily(ZIP)).toBe("zip");
    expect(sniffFamily(PNG)).toBe("png");
    expect(sniffFamily(JPEG)).toBe("jpeg");
    expect(sniffFamily(GIF)).toBe("gif");
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

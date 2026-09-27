// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  compareDocumentVersions,
  documentBeginRecordSchema,
  documentKeyOf,
  isStrongVersionSource,
  versionLabelTokens,
} from "../../src/index.js";

describe("documentKeyOf", () => {
  test("strips a known document extension, case-insensitively", () => {
    expect(documentKeyOf("docs/Handbuch.pdf")).toBe("docs/Handbuch");
    expect(documentKeyOf("docs/Handbuch.DOCX")).toBe("docs/Handbuch");
    expect(documentKeyOf("mail/2024-03-01 Angebot.eml")).toBe("mail/2024-03-01 Angebot");
  });

  test("keeps version-like suffixes and unknown extensions", () => {
    expect(documentKeyOf("Vertrag v1.2")).toBe("Vertrag v1.2");
    expect(documentKeyOf("archive.tar.gz")).toBe("archive.tar.gz");
    expect(documentKeyOf("report")).toBe("report");
  });

  test("strips only one extension and never a bare dotfile", () => {
    expect(documentKeyOf("a.pdf.pdf")).toBe("a.pdf");
    expect(documentKeyOf("dir/.pdf")).toBe("dir/.pdf");
  });

  test("normalises to NFC so both Unicode forms share a key", () => {
    const nfd = "Übersicht.pdf".normalize("NFD");
    expect(documentKeyOf(nfd)).toBe("Übersicht".normalize("NFC"));
  });
});

describe("versionLabelTokens", () => {
  test("drops prefixes, separators and trailing zeros", () => {
    expect(versionLabelTokens("Version 2.1")).toEqual([2, 1]);
    expect(versionLabelTokens("v2.0.0")).toEqual([2]);
    expect(versionLabelTokens("Rev. C")).toEqual(["c"]);
    expect(versionLabelTokens("2.1a")).toEqual([2, 1, "a"]);
  });
});

describe("compareDocumentVersions", () => {
  test("orders numeric labels numerically, not lexically", () => {
    expect(compareDocumentVersions({ label: "1.10" }, { label: "1.9" })).toBe(1);
    expect(compareDocumentVersions({ label: "v2" }, { label: "2.0" })).toBe(0);
    expect(compareDocumentVersions({ label: "2.1" }, { label: "2.1a" })).toBe(-1);
  });

  test("orders letter revisions", () => {
    expect(compareDocumentVersions({ label: "Rev. B" }, { label: "Rev. C" })).toBe(-1);
  });

  test("labels win over dates", () => {
    expect(
      compareDocumentVersions({ label: "2.0", date: "2025-01-01" }, { label: "1.0", date: "2026-01-01" }),
    ).toBe(1);
  });

  test("equal labels fall through to the date", () => {
    expect(
      compareDocumentVersions({ label: "2.0", date: "2025-01-01" }, { label: "2.0", date: "2025-02-01" }),
    ).toBe(-1);
  });

  test("falls back to the calendar day when labels are not comparable", () => {
    expect(compareDocumentVersions({ label: "2.0", date: "2025-03-01" }, { label: "Rev. A", date: "2025-02-01" })).toBe(1);
    expect(compareDocumentVersions({ date: "2025-03-01" }, { date: "2025-03-01T17:00:00Z" })).toBe(0);
  });

  test("returns null when nothing is comparable", () => {
    expect(compareDocumentVersions({ label: "2.0" }, { date: "2025-01-01" })).toBeNull();
    expect(compareDocumentVersions(null, { label: "1" })).toBeNull();
  });
});

describe("isStrongVersionSource", () => {
  test("a file timestamp is weak, content and caller values are strong", () => {
    expect(isStrongVersionSource("source_modified")).toBe(false);
    expect(isStrongVersionSource("page_label")).toBe(true);
    expect(isStrongVersionSource(undefined)).toBe(false);
  });
});

describe("document.begin 2.1 fields", () => {
  const base = {
    type: "document.begin",
    contract: "atf-extract/2.1.0",
    reference: "mail/1.eml",
    source: { filename: "1.eml", mimeType: "message/rfc822", bytes: 10, sha256: "a".repeat(64) },
    pipeline: { extractor: "atf-extract" },
  };

  test("accepts a version, e-mail headers and a parent reference", () => {
    const parsed = documentBeginRecordSchema.parse({
      ...base,
      version: { label: "2.1", source: "page_label" },
      email: { messageId: "abc@example.com", references: ["root@example.com"] },
      parentReference: "mail/0.eml",
    });
    expect(parsed.email?.inReplyTo).toEqual([]);
    expect(parsed.version?.label).toBe("2.1");
  });

  test("rejects a version with neither label nor date", () => {
    expect(() => documentBeginRecordSchema.parse({ ...base, version: { source: "explicit" } })).toThrow();
  });
});

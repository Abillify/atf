// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  EXTRACT_CONTRACT_ID,
  assetPath,
  buildAssetHeaders,
  buildIngestHeaders,
  encodeHeaderValue,
} from "../src/v1/index.js";
import { REFERENCE, document, figure, page } from "./fixtures.js";
import { parseMetadataHeader } from "../../../apps/search/src/metadata.js";

describe("encodeHeaderValue", () => {
  test("passes printable ASCII through untouched", () => {
    expect(encodeHeaderValue("Plain title 123")).toBe("Plain title 123");
  });

  test("base64-encodes anything Node would reject or mangle", () => {
    // Sent raw these either throw ERR_INVALID_CHAR or arrive latin1-mangled.
    expect(encodeHeaderValue("Handbuch — Grün")).toBe(
      `base64:${Buffer.from("Handbuch — Grün", "utf-8").toString("base64")}`,
    );
    expect(encodeHeaderValue("a\r\nX-Injected: 1")).toStartWith("base64:");
  });

  test("cannot be used to inject a header", () => {
    const encoded = encodeHeaderValue("value\r\nX-Evil: yes");
    expect(encoded).not.toContain("\r");
    expect(encoded).not.toContain("\n");
  });
});

describe("buildIngestHeaders", () => {
  test("declares the body as markdown and turns structure parsing on", () => {
    const headers = buildIngestHeaders(document());
    expect(headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(headers["x-document-structure"]).toBe("auto");
    expect(headers["x-page-markers"]).toBe("true");
    expect(headers["x-figure-chunks"]).toBe("true");
    expect(headers["x-normalize-tables"]).toBe("true");
    expect(headers["x-reference"]).toBe(REFERENCE);
    expect(headers["x-extract-contract"]).toBe(EXTRACT_CONTRACT_ID);
  });

  test("selects embedded summaries when the document carries them", () => {
    expect(buildIngestHeaders(document())["x-summary-mode"]).toBe("embedded");
  });

  test("falls back to auto when no page carries a summary", () => {
    const doc = document({ pages: [page(1, { summary: undefined })] });
    expect(buildIngestHeaders(doc)["x-summary-mode"]).toBe("auto");
  });

  test("reflects the serialize options actually used", () => {
    // Claiming figures exist when they were not serialized makes Search look for
    // entries that are not there.
    const headers = buildIngestHeaders(document(), {
      pageMarkers: false,
      figureChunks: false,
      normalizeTables: false,
    });
    expect(headers["x-page-markers"]).toBe("false");
    expect(headers["x-figure-chunks"]).toBe("false");
    expect(headers["x-normalize-tables"]).toBe("false");
  });

  test("carries optional routing and ACL values", () => {
    const headers = buildIngestHeaders(document(), {
      collection: "specs",
      source: "upload",
      link: "https://example.invalid/a.pdf",
      validFrom: "2026-01-01T12:30:00+01:00",
      version: "2026-01-01",
      versionMode: "version",
      tags: ["wms", " ", "spec"],
      allowedUsers: ["alice"],
      allowedGroups: ["engineering", ""],
      ftsLanguage: "german",
      chunkSize: 1200,
      chunkOverlap: 150,
      semanticChunking: true,
    });
    expect(headers["x-collection"]).toBe("specs");
    expect(headers["x-source"]).toBe("upload");
    expect(headers["x-link"]).toBe("https://example.invalid/a.pdf");
    expect(headers["x-version"]).toBe("2026-01-01");
    expect(headers["x-valid-from"]).toBe("2026-01-01T12:30:00+01:00");
    expect(headers["x-version-mode"]).toBe("version");
    expect(headers["x-tags"]).toBe("wms,spec");
    expect(headers["x-allowed-users"]).toBe("alice");
    expect(headers["x-allowed-groups"]).toBe("engineering");
    expect(headers["x-fts-language"]).toBe("german");
    expect(headers["x-chunk-size"]).toBe("1200");
    expect(headers["x-chunk-overlap"]).toBe("150");
    expect(headers["x-semantic-chunking"]).toBe("true");
  });

  test("omits ACL headers entirely when nothing was requested", () => {
    const headers = buildIngestHeaders(document());
    expect(headers["x-allowed-users"]).toBeUndefined();
    expect(headers["x-allowed-groups"]).toBeUndefined();
    expect(headers["x-tags"]).toBeUndefined();
  });

  test("carries the chunking and structure overrides", () => {
    const headers = buildIngestHeaders(document(), {
      lateChunkingAlpha: 0.5,
      quantization: "binary",
      breakpointPercentile: 80,
      contextPrefixSize: 256,
      summarize: true,
      chapterSplitMaxChunks: 25,
      documentStructure: "off",
      summaryMode: "generate",
    });
    expect(headers["x-late-chunking-alpha"]).toBe("0.5");
    expect(headers["x-quantization"]).toBe("binary");
    expect(headers["x-breakpoint-percentile"]).toBe("80");
    expect(headers["x-context-prefix-size"]).toBe("256");
    expect(headers["x-summarize"]).toBe("true");
    expect(headers["x-chapter-split-max-chunks"]).toBe("25");
    expect(headers["x-document-structure"]).toBe("off");
    expect(headers["x-summary-mode"]).toBe("generate");
  });

  test("passes through explicit-disable zeros for prefix and chapter split", () => {
    // Search reads 0 as an explicit off switch, so it must survive as "0" and
    // not be dropped as falsy.
    const headers = buildIngestHeaders(document(), {
      contextPrefixSize: 0,
      chapterSplitMaxChunks: 0,
      lateChunkingAlpha: 0,
    });
    expect(headers["x-context-prefix-size"]).toBe("0");
    expect(headers["x-chapter-split-max-chunks"]).toBe("0");
    expect(headers["x-late-chunking-alpha"]).toBe("0");
  });

  test("omits the new overrides when unset, so Search keeps its defaults", () => {
    const headers = buildIngestHeaders(document());
    expect(headers["x-late-chunking-alpha"]).toBeUndefined();
    expect(headers["x-quantization"]).toBeUndefined();
    expect(headers["x-breakpoint-percentile"]).toBeUndefined();
    expect(headers["x-context-prefix-size"]).toBeUndefined();
    expect(headers["x-summarize"]).toBeUndefined();
    expect(headers["x-chapter-split-max-chunks"]).toBeUndefined();
    // Document structure has a contract default rather than being omitted.
    expect(headers["x-document-structure"]).toBe("auto");
  });

  test("base64-encodes a non-ASCII title", () => {
    const headers = buildIngestHeaders(document({ title: "Handbuch Grün" }));
    expect(headers["x-title"]).toStartWith("base64:");
  });

  test("falls back to the source filename for the title", () => {
    const headers = buildIngestHeaders(document({ title: undefined }));
    expect(headers["x-title"]).toBe("handbuch.pdf");
  });

  test("produces metadata Search accepts and keeps provenance in it", () => {
    const headers = buildIngestHeaders(document(), {
      metadata: { project_id: "wms", document_type: "specification" },
    });
    const parsed = parseMetadataHeader(headers["x-metadata"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.metadata["project_id"]).toBe("wms");
    expect(parsed.metadata["document_type"]).toBe("specification");
    expect(parsed.metadata["extract_contract"]).toBe(EXTRACT_CONTRACT_ID);
    expect(parsed.metadata["extract_extractor"]).toBe("poppler");
    expect(parsed.metadata["extract_page_count"]).toBe(2);
    expect(parsed.metadata["extract_dpi"]).toBe(200);
    expect(parsed.metadata["extract_source_mime_type"]).toBe("application/pdf");
  });

  test("lets caller metadata win over provenance defaults", () => {
    const headers = buildIngestHeaders(document(), {
      metadata: { extract_extractor: "manual" },
    });
    const parsed = parseMetadataHeader(headers["x-metadata"]);
    expect(parsed.metadata["extract_extractor"]).toBe("manual");
  });

  test("survives a non-ASCII metadata value", () => {
    // A synthetic author with an umlaut: the point is the encoding path, and a
    // plausible real surname in a published repository is a placeholder nobody
    // can tell apart from data.
    const headers = buildIngestHeaders(document(), { metadata: { author: "Prüfautor" } });
    expect(headers["x-metadata"]).toStartWith("base64:");
    const parsed = parseMetadataHeader(headers["x-metadata"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.metadata["author"]).toBe("Prüfautor");
  });
});

describe("buildAssetHeaders", () => {
  test("binds reference, figure id and path to the same asset id", () => {
    // Search recomputes the id from these two headers and 400s on a mismatch,
    // so they have to be produced together with the path.
    const fig = figure(3, 2);
    const headers = buildAssetHeaders(document(), fig, { collection: "specs" });
    expect(headers["content-type"]).toBe("image/png");
    expect(headers["x-document-reference"]).toBe(REFERENCE);
    expect(headers["x-figure-id"]).toBe("p3-f2");
    expect(headers["x-collection"]).toBe("specs");
    expect(assetPath(fig)).toBe(`/document-assets/${fig.assetId}`);
  });

  test("omits the collection when not routed", () => {
    expect(buildAssetHeaders(document(), figure(1, 1))["x-collection"]).toBeUndefined();
  });
});

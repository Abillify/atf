// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import pino from "pino";
import {
  EXTRACT_CONTRACT_ID,
  buildDocumentAssetId,
  buildFigureId,
  serializeDocument,
  sha256Hex,
  type ExtractedDocument,
  type ExtractedFigure,
  type ExtractedPage,
} from "@atf/extract-contract";
import { loadConfig, type Config } from "../src/config.js";
import type { Extractor, ExtractResult } from "../src/pipeline/extract.js";
import type { VisionClient } from "../src/vision/client.js";
import type { SearchClient } from "../src/search-client.js";
import type { FigureCrop } from "../src/pipeline/raster.js";

/** Silent logger, so a failing test's output is the assertion and not a log dump. */
export const testLogger = pino({ level: "silent" });

/** The minimum environment `loadConfig` accepts. */
export const BASE_ENV: Record<string, string> = {
  VISION_URL: "http://127.0.0.1:8000",
  VISION_MODEL: "test-vlm",
  AUTHN_MODE: "disabled",
  AUTHZ_ENABLED: "false",
  TENANT_ISOLATION_ENABLED: "false",
};

/**
 * Load a config from an isolated environment.
 *
 * `loadConfig` reads `process.env` directly, matching Search's convention, so the
 * environment is replaced for the duration of the call and restored afterwards —
 * otherwise one test's variables leak into the next and the failure appears in an
 * unrelated file.
 */
export function loadTestConfig(overrides: Record<string, string | undefined> = {}): Config {
  const saved = process.env;
  const next: Record<string, string> = { ...BASE_ENV };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  process.env = { PATH: saved["PATH"] ?? "", ...next } as NodeJS.ProcessEnv;
  try {
    return loadConfig();
  } finally {
    process.env = saved;
  }
}

/**
 * Fixtures describe a fictional appliance manual and nothing else.
 *
 * A test corpus that mirrors a real document set leaks which document set it
 * mirrors: process names, terminology and file naming are recognisable even
 * without a customer name attached. This repository is published.
 */
export const TEST_REFERENCE = "tests/handbuch.pdf";

export function testFigure(
  page: number,
  ordinal: number,
  overrides: Partial<ExtractedFigure> = {},
): ExtractedFigure {
  const id = overrides.id ?? buildFigureId(page, ordinal);
  return {
    id,
    page,
    description: `Diagramm ${id}.`,
    bbox: [0.1, 0.2, 0.6, 0.75],
    assetId: buildDocumentAssetId(TEST_REFERENCE, id),
    mimeType: "image/png",
    ...overrides,
  };
}

export function testPage(page: number, overrides: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    page,
    markdown: `# Kapitel\n\nText auf Seite ${page}.`,
    summary: `Seite ${page} beschreibt etwas.`,
    figures: [],
    warnings: [],
    ...overrides,
  };
}

export function testDocument(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  const pages = overrides.pages ?? [testPage(1), testPage(2)];
  return {
    contract: EXTRACT_CONTRACT_ID,
    reference: TEST_REFERENCE,
    title: "Betriebsanleitung",
    source: {
      filename: "handbuch.pdf",
      mimeType: "application/pdf",
      bytes: 2048,
      sha256: sha256Hex("handbuch"),
    },
    pipeline: {
      extractor: "poppler",
      renderer: "pdftoppm",
      visionModel: "test-vlm",
      ocr: false,
      dpi: 200,
    },
    pageCount: pages.length,
    pageLabel: "Seite",
    warnings: [],
    ...overrides,
    pages,
  };
}

/** A one-pixel PNG, so a crop has plausible bytes without pulling in a fixture. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

export function testCrop(): FigureCrop {
  return { buffer: TINY_PNG, mimeType: "image/png", width: 1, height: 1 };
}

/** An extractor that returns a fixed document without touching a converter. */
export function stubExtractor(options: {
  document?: ExtractedDocument;
  crops?: Map<string, FigureCrop>;
  error?: Error;
  onExtract?: (input: Parameters<Extractor["extract"]>[0]) => void;
} = {}): Extractor {
  return {
    async extract(input) {
      options.onExtract?.(input);
      if (options.error !== undefined) throw options.error;
      const document = options.document ?? testDocument({ reference: input.reference });
      const result: ExtractResult = {
        document,
        markdown: serializeDocument(document),
        crops: options.crops ?? new Map(),
      };
      // Mirror the streaming contract so SSE tests exercise the real path.
      if (input.onPage !== undefined) {
        for (const page of document.pages) await input.onPage(page, result.crops);
      }
      return result;
    },
  };
}

/** A vision client that never reaches the network. */
export function stubVisionClient(available = true): VisionClient {
  return {
    async analyzePage() {
      return {
        raw: "<summary>S</summary><figures></figures><markdown>Text</markdown>",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        requests: 1,
        truncated: false,
        maxTokens: 8192,
      };
    },
    async probe() {
      return available ? { available: true } : { available: false, error: "stubbed as down" };
    },
  };
}

/** Records what would have been sent to Search. */
export interface RecordingSearchClient extends SearchClient {
  calls: Array<{
    reference: string;
    collection: string;
    markdown: string;
    cropIds: string[];
    allowedUsers: readonly string[] | undefined;
    allowedGroups: readonly string[] | undefined;
  }>;
}

export function stubSearchClient(options: { error?: Error; assetsFailed?: number } = {}): RecordingSearchClient {
  const calls: RecordingSearchClient["calls"] = [];
  return {
    calls,
    async ingestDocument(args) {
      if (options.error !== undefined) throw options.error;
      const collection = args.options?.collection ?? "documents";
      calls.push({
        reference: args.document.reference,
        collection,
        markdown: args.markdown,
        cropIds: [...args.crops.keys()],
        allowedUsers: args.options?.allowedUsers,
        allowedGroups: args.options?.allowedGroups,
      });
      const assetsFailed = options.assetsFailed ?? 0;
      return {
        ingest: { status: "ok" },
        collection,
        reference: args.document.reference,
        assets: [],
        assetsStored: args.crops.size - assetsFailed,
        assetsFailed,
      };
    },
    async probe() {
      return { available: true };
    },
  };
}

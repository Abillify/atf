// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-header-parser.ts
 *
 * Shared header-parsing helpers for all three ingest endpoints
 * (/ingest, /ingest-batch, /ingest-stream).
 *
 * Each parser follows the same three-value contract:
 *   undefined  — header absent or empty → use server default
 *   <value>    — valid parsed value
 *   null       — unrecognised / out-of-range → caller returns HTTP 400
 */

import type { IncomingMessage } from "node:http";
import { readHeader, parseBooleanHeader } from "./header-utils.js";
import { validateFtsLanguage } from "./collection-ddl.js";
import type { ChunkingOptions } from "./ingest-jobs.js";
import type { IngestDefaults } from "./handlers/ingest.js";
import type { SummaryMode } from "./document-structure.js";

// ─── Individual header parsers ────────────────────────────────────────────────

/**
 * Parse the X-Semantic-Chunking header.
 *   undefined  — absent/empty → use server default
 *   true/false — explicit override
 *   null       — invalid value → HTTP 400
 */
export function parseSemanticChunkingHeader(
  header: string | undefined,
): boolean | null | undefined {
  return parseBooleanHeader(header);
}

/**
 * Parse the X-Late-Chunking-Alpha header.
 *   undefined — absent/empty → use server default
 *   0         — explicitly disable late chunking
 *   (0,1)     — enable with this alpha
 *   null      — invalid → HTTP 400
 */
export function parseLateChunkingAlphaHeader(
  header: string | undefined,
): number | null | undefined {
  if (header === undefined) return undefined;
  const v = header.trim();
  if (v === "") return undefined;
  const parsed = parseFloat(v);
  if (isNaN(parsed)) return null;
  if (parsed === 0) return 0; // explicit disable
  if (parsed > 0 && parsed < 1) return parsed;
  return null; // out of range
}

/**
 * Parse the X-Quantization header.
 *   undefined        — absent/empty → use server default
 *   "none"|"binary"  — explicit value (only effective on first ingest)
 *   null             — unrecognised → HTTP 400
 */
export function parseQuantizationHeader(
  header: string | undefined,
): "none" | "binary" | null | undefined {
  if (header === undefined) return undefined;
  const v = header.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "none") return "none";
  if (v === "binary") return "binary";
  return null;
}

/**
 * Parse the X-Breakpoint-Percentile header.
 *   undefined    — absent/empty → use server default
 *   integer 1–99 — explicit percentile
 *   null         — invalid → HTTP 400
 */
export function parseBreakpointPercentileHeader(
  header: string | undefined,
): number | null | undefined {
  if (header === undefined) return undefined;
  const v = header.trim();
  if (v === "") return undefined;
  const parsed = parseInt(v, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99) return null;
  return parsed;
}

/**
 * Parse the X-Context-Prefix-Size header.
 *   undefined        — absent/empty → use server default
 *   0                — explicitly disable context prefix
 *   positive integer — use this many chars of document beginning as prefix
 *   null             — invalid → HTTP 400
 */
export function parseContextPrefixSizeHeader(
  header: string | undefined,
): number | null | undefined {
  if (header === undefined) return undefined;
  const v = header.trim();
  if (v === "") return undefined;
  const parsed = parseInt(v, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed; // 0 = explicit disable, >0 = use this size
}

/**
 * Parse the X-Summarize header.
 *   undefined — absent/empty → use server default (false unless SUMMARY_MODEL set)
 *   true      — generate LLM summary as context prefix
 *   false     — disable summarization for this request
 *   null      — invalid → HTTP 400
 */
export function parseSummarizeHeader(
  header: string | undefined,
): boolean | null | undefined {
  return parseBooleanHeader(header);
}

export function parseDocumentStructureHeader(
  header: string | undefined,
): "auto" | "off" | null | undefined {
  if (header === undefined || header.trim() === "") return undefined;
  const value = header.trim().toLowerCase();
  return value === "auto" || value === "off" ? value : null;
}

export function parseSummaryModeHeader(
  header: string | undefined,
): SummaryMode | null | undefined {
  if (header === undefined || header.trim() === "") return undefined;
  const value = header.trim().toLowerCase();
  return value === "auto" || value === "generate" || value === "embedded" || value === "off"
    ? value
    : null;
}

/**
 * Parse the X-Chapter-Split-Max-Chunks header.
 *   undefined        — absent/empty → use server default
 *   0                — explicitly disable chapter splitting
 *   positive integer — split documents exceeding this many chunks into chapters
 *   null             — invalid → HTTP 400
 */
export function parseChapterSplitMaxChunksHeader(
  header: string | undefined,
): number | null | undefined {
  if (header === undefined) return undefined;
  const v = header.trim();
  if (v === "") return undefined;
  const parsed = parseInt(v, 10);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed; // 0 = explicit disable, >0 = threshold
}

// ─── Chunking options resolver ────────────────────────────────────────────────

export function resolveChunkingOptions(
  rawChunkSize: string | undefined,
  rawChunkOverlap: string | undefined,
  defaults: IngestDefaults,
  semanticChunkingOverride?: boolean,
  lateChunkingAlphaOverride?: number,
  breakpointPercentileOverride?: number,
  contextPrefixSizeOverride?: number,
  useSummarization = false,
  chapterSplitMaxChunksOverride?: number,
  documentStructure: "auto" | "off" = "auto",
  summaryMode: SummaryMode = "auto",
  pageMarkers = true,
  figureChunks = true,
  normalizeTables = true,
): ChunkingOptions | { error: string } {
  let chunkingEnabled = false;
  let chunkSize = 0;
  let overlapSize = 0;

  if (rawChunkSize === undefined && rawChunkOverlap === undefined) {
    if (
      defaults.defaultChunkSize !== null &&
      defaults.defaultChunkOverlap !== null
    ) {
      chunkingEnabled = true;
      chunkSize = defaults.defaultChunkSize;
      overlapSize = defaults.defaultChunkOverlap;
    }
  } else if (rawChunkSize === undefined) {
    // X-Chunk-Overlap alone without X-Chunk-Size is not meaningful.
    return {
      error: "Both X-Chunk-Size and X-Chunk-Overlap headers are required",
    };
  } else if (rawChunkOverlap === undefined) {
    const useSemanticEarly =
      semanticChunkingOverride ?? defaults.semanticChunking ?? false;
    if (!useSemanticEarly) {
      // Without semantic chunking, overlap is required.
      return {
        error: "Both X-Chunk-Size and X-Chunk-Overlap headers are required",
      };
    }
    // With X-Semantic-Chunking, overlap defaults to 0 when omitted.
    const parsedChunkSize = Number(rawChunkSize);
    if (!Number.isInteger(parsedChunkSize) || parsedChunkSize <= 0) {
      return { error: "X-Chunk-Size must be a positive integer" };
    }
    chunkingEnabled = true;
    chunkSize = parsedChunkSize;
    overlapSize = 0;
  } else {
    const parsedChunkSize = Number(rawChunkSize);
    if (!Number.isInteger(parsedChunkSize) || parsedChunkSize <= 0) {
      return { error: "X-Chunk-Size must be a positive integer" };
    }
    const parsedOverlapSize = Number(rawChunkOverlap);
    if (!Number.isInteger(parsedOverlapSize) || parsedOverlapSize < 0) {
      return { error: "X-Chunk-Overlap must be a non-negative integer" };
    }
    if (parsedOverlapSize >= parsedChunkSize) {
      return { error: "X-Chunk-Overlap must be less than X-Chunk-Size" };
    }
    chunkingEnabled = true;
    chunkSize = parsedChunkSize;
    overlapSize = parsedOverlapSize;
  }

  const useSemanticChunking =
    semanticChunkingOverride ?? defaults.semanticChunking ?? false;

  const lateChunkingAlpha =
    lateChunkingAlphaOverride === undefined
      ? (defaults.lateChunkingAlpha ?? null)
      : lateChunkingAlphaOverride === 0
        ? null
        : lateChunkingAlphaOverride;

  const breakpointPercentile =
    breakpointPercentileOverride ?? defaults.breakpointPercentile ?? 75;

  const contextPrefixSize =
    contextPrefixSizeOverride === undefined
      ? (defaults.contextPrefixSize ?? null)
      : contextPrefixSizeOverride === 0
        ? null
        : contextPrefixSizeOverride;

  const chapterSplitMaxChunks =
    chapterSplitMaxChunksOverride === undefined
      ? (defaults.chapterSplitMaxChunks ?? null)
      : chapterSplitMaxChunksOverride === 0
        ? null
        : chapterSplitMaxChunksOverride;

  return {
    enabled: chunkingEnabled,
    chunkSize,
    overlapSize,
    contextPrefixSize,
    lateChunkingAlpha,
    useSemanticChunking,
    breakpointPercentile,
    useSummarization,
    chapterSplitMaxChunks,
    documentStructure,
    summaryMode,
    pageMarkers: documentStructure === "auto" && pageMarkers,
    figureChunks: documentStructure === "auto" && figureChunks,
    normalizeTables: documentStructure === "auto" && normalizeTables,
  };
}

// ─── Composite: parse all ingest-specific headers from a request ──────────────

export interface ParsedIngestHeaders {
  rawChunkSize: string | undefined;
  rawChunkOverlap: string | undefined;
  collectionRaw: string;
  versionMode: "replace" | "version";
  versionTag: string | undefined;
  ftsLanguage: string;
  semanticChunkingOverride: boolean | undefined;
  lateChunkingAlphaOverride: number | undefined;
  quantizationOverride: "none" | "binary" | undefined;
  breakpointPercentileOverride: number | undefined;
  contextPrefixSizeOverride: number | undefined;
  summarizeOverride: boolean | undefined;
  chapterSplitMaxChunksOverride: number | undefined;
  documentStructure: "auto" | "off";
  summaryMode: SummaryMode;
  pageMarkers: boolean;
  figureChunks: boolean;
  normalizeTables: boolean;
  /** Set when a header value is invalid; caller should return HTTP 400. */
  validationError?: string;
}

/**
 * Parse all shared ingest headers from a request in one call.
 * Returns a `validationError` string if any header value is invalid.
 */
export function parseIngestHeaders(
  req: Pick<IncomingMessage, "headers">,
  defaults: IngestDefaults,
): ParsedIngestHeaders {
  const rawChunkSize = readHeader(req, "x-chunk-size");
  const rawChunkOverlap = readHeader(req, "x-chunk-overlap");
  const collectionRaw = readHeader(req, "x-collection") || "documents";
  const versionMode =
    readHeader(req, "x-version-mode") === "version" ? "version" : "replace";
  const versionTag = readHeader(req, "x-version");

  // Helper to build a partial error return with all overrides undefined
  const errReturn = (validationError: string): ParsedIngestHeaders => ({
    rawChunkSize,
    rawChunkOverlap,
    collectionRaw,
    versionMode,
    versionTag,
    ftsLanguage: defaults.defaultFtsLanguage ?? "simple",
    semanticChunkingOverride: undefined,
    lateChunkingAlphaOverride: undefined,
    quantizationOverride: undefined,
    breakpointPercentileOverride: undefined,
    contextPrefixSizeOverride: undefined,
    summarizeOverride: undefined,
    chapterSplitMaxChunksOverride: undefined,
    documentStructure: "auto",
    summaryMode: "auto",
    pageMarkers: true,
    figureChunks: true,
    normalizeTables: true,
    validationError,
  });

  // FTS language
  const ftsLanguageRaw = readHeader(req, "x-fts-language");
  let ftsLanguage = defaults.defaultFtsLanguage ?? "simple";
  if (ftsLanguageRaw) {
    try {
      ftsLanguage = validateFtsLanguage(ftsLanguageRaw);
    } catch (err) {
      return errReturn((err as Error).message);
    }
  }

  // Semantic chunking
  const semanticChunkingParsed = parseSemanticChunkingHeader(
    readHeader(req, "x-semantic-chunking"),
  );
  if (semanticChunkingParsed === null)
    return errReturn(
      "X-Semantic-Chunking must be one of: 1/0, true/false, yes/no, on/off",
    );

  // Late chunking alpha
  const lateAlphaParsed = parseLateChunkingAlphaHeader(
    readHeader(req, "x-late-chunking-alpha"),
  );
  if (lateAlphaParsed === null)
    return errReturn(
      "X-Late-Chunking-Alpha must be a float in (0, 1) or 0 to disable",
    );

  // Quantization
  const quantizationParsed = parseQuantizationHeader(
    readHeader(req, "x-quantization"),
  );
  if (quantizationParsed === null)
    return errReturn('X-Quantization must be "none" or "binary"');

  // Breakpoint percentile
  const breakpointParsed = parseBreakpointPercentileHeader(
    readHeader(req, "x-breakpoint-percentile"),
  );
  if (breakpointParsed === null)
    return errReturn(
      "X-Breakpoint-Percentile must be an integer between 1 and 99",
    );

  // Context prefix size
  const contextPrefixParsed = parseContextPrefixSizeHeader(
    readHeader(req, "x-context-prefix-size"),
  );
  if (contextPrefixParsed === null)
    return errReturn(
      "X-Context-Prefix-Size must be a non-negative integer (0 to disable)",
    );

  // Summarize
  const summarizeParsed = parseSummarizeHeader(readHeader(req, "x-summarize"));
  if (summarizeParsed === null)
    return errReturn(
      "X-Summarize must be one of: 1/0, true/false, yes/no, on/off",
    );

  // Chapter split threshold
  const chapterSplitParsed = parseChapterSplitMaxChunksHeader(
    readHeader(req, "x-chapter-split-max-chunks"),
  );
  if (chapterSplitParsed === null)
    return errReturn(
      "X-Chapter-Split-Max-Chunks must be a non-negative integer (0 to disable)",
    );

  const documentStructure = parseDocumentStructureHeader(readHeader(req, "x-document-structure"));
  if (documentStructure === null)
    return errReturn('X-Document-Structure must be "auto" or "off"');
  const summaryMode = parseSummaryModeHeader(readHeader(req, "x-summary-mode"));
  if (summaryMode === null)
    return errReturn('X-Summary-Mode must be one of: auto, generate, embedded, off');

  const parseStructureBoolean = (header: string, label: string): boolean | ParsedIngestHeaders => {
    const parsed = parseBooleanHeader(readHeader(req, header));
    return parsed === null
      ? errReturn(`${label} must be one of: 1/0, true/false, yes/no, on/off`)
      : (parsed ?? true);
  };
  const pageMarkers = parseStructureBoolean("x-page-markers", "X-Page-Markers");
  if (typeof pageMarkers !== "boolean") return pageMarkers;
  const figureChunks = parseStructureBoolean("x-figure-chunks", "X-Figure-Chunks");
  if (typeof figureChunks !== "boolean") return figureChunks;
  const normalizeTables = parseStructureBoolean("x-normalize-tables", "X-Normalize-Tables");
  if (typeof normalizeTables !== "boolean") return normalizeTables;

  return {
    rawChunkSize,
    rawChunkOverlap,
    collectionRaw,
    versionMode,
    versionTag,
    ftsLanguage,
    semanticChunkingOverride: semanticChunkingParsed ?? undefined,
    lateChunkingAlphaOverride: lateAlphaParsed ?? undefined,
    quantizationOverride: quantizationParsed ?? undefined,
    breakpointPercentileOverride: breakpointParsed ?? undefined,
    contextPrefixSizeOverride: contextPrefixParsed ?? undefined,
    summarizeOverride: summarizeParsed ?? undefined,
    chapterSplitMaxChunksOverride: chapterSplitParsed ?? undefined,
    documentStructure: documentStructure ?? "auto",
    summaryMode: summaryMode ?? "auto",
    pageMarkers,
    figureChunks,
    normalizeTables,
  };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-headers.ts
 *
 * The producer side of Search's ingest header contract.
 *
 * Search takes the document body as the request body and everything else as
 * `X-…` headers. That is a compact interface but an easy one to get subtly
 * wrong: `X-Document-Structure: off` silently discards page markers and figure
 * entries, and a title containing an umlaut sent raw makes Node reject the
 * request. Centralising header construction here means a producer cannot
 * accidentally ingest a structured document as flat text.
 *
 * The structure flags are set to match what {@link serializeDocument} actually
 * emitted rather than hardcoded to `true`: a document serialized with
 * `includeFigures: false` sets `X-Figure-Chunks: false`, so Search does not look
 * for entries that are not there.
 *
 * Header names and accepted values mirror
 * `apps/search/src/ingest-header-parser.ts`.
 */

import type { ExtractedDocument, ExtractedFigure } from "./document.js";
import { EXTRACT_CONTRACT_HEADER } from "./version.js";

/** Search's document-versioning behaviour for a repeated reference. */
export type VersionMode = "replace" | "version";

/** Search's summary source selection. */
export type SummaryMode = "auto" | "generate" | "embedded" | "off";

export interface IngestHeaderOptions {
  /** Target collection. Search defaults to `documents` when omitted. */
  collection?: string;
  /** Provenance label, e.g. the upload origin. */
  source?: string;
  /** Canonical URL of the source document. */
  link?: string;
  /** Overrides the document title. */
  title?: string;
  tags?: readonly string[];
  allowedUsers?: readonly string[];
  allowedGroups?: readonly string[];
  /** Technical version tag stored with the document. */
  version?: string;
  /** RFC 3339 business-validity start with an explicit timezone. */
  validFrom?: string;
  /** Default `replace`; `version` keeps prior revisions addressable. */
  versionMode?: VersionMode;
  /**
   * Default `embedded`, because this contract carries per-page `<summary>`
   * blocks and asking Search to regenerate them would pay a second time for
   * work already done — and produce a worse summary, since Search only sees the
   * text while the extractor saw the rendered page.
   */
  summaryMode?: SummaryMode;
  /** Full-text-search language configuration, e.g. `german`. */
  ftsLanguage?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  semanticChunking?: boolean;
  /**
   * Late-chunking blend factor in `[0, 1]`. `0` explicitly disables late
   * chunking for this request; omit to use Search's default.
   */
  lateChunkingAlpha?: number;
  /**
   * Vector quantization for a *new* collection. Ignored once a collection
   * exists, so it only bites on first ingest. Omit for Search's default.
   */
  quantization?: "none" | "binary";
  /** Semantic-chunking breakpoint percentile, integer `1..99`. */
  breakpointPercentile?: number;
  /**
   * Characters of document context prepended to each chunk's embedding input.
   * `0` explicitly disables the context prefix; omit for Search's default.
   */
  contextPrefixSize?: number;
  /**
   * Generate an LLM summary as the context prefix. Requires a summary model on
   * the Search side and only takes effect when set to `true`.
   */
  summarize?: boolean;
  /**
   * Split a document exceeding this many chunks into chapter sub-documents.
   * `0` explicitly disables chapter splitting; omit for Search's default.
   */
  chapterSplitMaxChunks?: number;
  /** Merged into the provenance metadata; caller keys win on collision. */
  metadata?: Record<string, unknown>;
  /**
   * Whether Search parses the marker structure at all. Defaults to `auto`.
   * `off` makes Search treat the body as flat text, discarding page markers and
   * figure entries — rarely wanted, since it throws away what the contract
   * carries, but exposed for completeness.
   */
  documentStructure?: "auto" | "off";
  /** Reflects the serialize options actually used. Defaults to true. */
  pageMarkers?: boolean;
  /** Reflects the serialize options actually used. Defaults to true. */
  figureChunks?: boolean;
  /** Whether Search should convert HTML tables to Markdown. Default true. */
  normalizeTables?: boolean;
}

/** Header values must be printable ASCII with no control characters. */
const SAFE_HEADER_VALUE = /^[\x20-\x7E]*$/;

/**
 * Encode a header value, falling back to Search's `base64:` convention.
 *
 * Titles, links and provenance strings routinely contain umlauts or an em dash.
 * Sent raw, Node either throws `ERR_INVALID_CHAR` or the value arrives
 * latin1-mangled; both have happened on this path before.
 */
export function encodeHeaderValue(value: string): string {
  if (SAFE_HEADER_VALUE.test(value)) return value;
  return `base64:${Buffer.from(value, "utf-8").toString("base64")}`;
}

function boolHeader(value: boolean): string {
  return value ? "true" : "false";
}

/** Provenance recorded on every chunk, so an index can be audited later. */
export function buildProvenanceMetadata(
  document: ExtractedDocument,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    // Non-canonical keys: Search validates the fields it knows and passes
    // everything else through untouched.
    extract_contract: document.contract,
    extract_extractor: document.pipeline.extractor,
    extract_ocr: document.pipeline.ocr,
    extract_page_count: document.pageCount,
    extract_source_mime_type: document.source.mimeType,
    extract_source_sha256: document.source.sha256,
    ...(document.pipeline.visionModel !== undefined
      ? { extract_vision_model: document.pipeline.visionModel }
      : {}),
    ...(document.pipeline.renderer !== undefined
      ? { extract_renderer: document.pipeline.renderer }
      : {}),
    ...(document.pipeline.dpi !== undefined ? { extract_dpi: document.pipeline.dpi } : {}),
    ...(document.language !== undefined ? { extract_language: document.language } : {}),
    ...extra,
  };
}

/**
 * Headers for `POST /ingest` with a `text/markdown` body.
 *
 * Returns lower-case header names so the result can be handed to `fetch`
 * without duplicate-key surprises.
 */
export function buildIngestHeaders(
  document: ExtractedDocument,
  options: IngestHeaderOptions = {},
): Record<string, string> {
  const pageMarkers = options.pageMarkers ?? true;
  const figureChunks = options.figureChunks ?? true;
  const normalizeTables = options.normalizeTables ?? true;
  const title = options.title ?? document.title ?? document.source.filename;
  const hasSummary = document.pages.some(
    (page) => page.summary !== undefined && page.summary.trim() !== "",
  );
  const summaryMode: SummaryMode = options.summaryMode ?? (hasSummary ? "embedded" : "auto");

  const headers: Record<string, string> = {
    "content-type": "text/markdown; charset=utf-8",
    "x-reference": encodeHeaderValue(document.reference),
    "x-document-structure": options.documentStructure ?? "auto",
    "x-page-markers": boolHeader(pageMarkers),
    "x-figure-chunks": boolHeader(figureChunks),
    "x-normalize-tables": boolHeader(normalizeTables),
    "x-summary-mode": summaryMode,
    [EXTRACT_CONTRACT_HEADER.toLowerCase()]: document.contract,
  };

  if (title.trim() !== "") headers["x-title"] = encodeHeaderValue(title);
  if (options.collection !== undefined) headers["x-collection"] = options.collection;
  if (options.source !== undefined) headers["x-source"] = encodeHeaderValue(options.source);
  if (options.link !== undefined) headers["x-link"] = encodeHeaderValue(options.link);
  if (options.version !== undefined) headers["x-version"] = encodeHeaderValue(options.version);
  if (options.validFrom !== undefined) headers["x-valid-from"] = options.validFrom;
  if (options.versionMode !== undefined) headers["x-version-mode"] = options.versionMode;
  if (options.ftsLanguage !== undefined) headers["x-fts-language"] = options.ftsLanguage;
  if (options.chunkSize !== undefined) headers["x-chunk-size"] = String(options.chunkSize);
  if (options.chunkOverlap !== undefined) {
    headers["x-chunk-overlap"] = String(options.chunkOverlap);
  }
  if (options.semanticChunking !== undefined) {
    headers["x-semantic-chunking"] = boolHeader(options.semanticChunking);
  }
  if (options.lateChunkingAlpha !== undefined) {
    headers["x-late-chunking-alpha"] = String(options.lateChunkingAlpha);
  }
  if (options.quantization !== undefined) headers["x-quantization"] = options.quantization;
  if (options.breakpointPercentile !== undefined) {
    headers["x-breakpoint-percentile"] = String(options.breakpointPercentile);
  }
  if (options.contextPrefixSize !== undefined) {
    headers["x-context-prefix-size"] = String(options.contextPrefixSize);
  }
  if (options.summarize !== undefined) headers["x-summarize"] = boolHeader(options.summarize);
  if (options.chapterSplitMaxChunks !== undefined) {
    headers["x-chapter-split-max-chunks"] = String(options.chapterSplitMaxChunks);
  }

  const tags = (options.tags ?? []).filter((tag) => tag.trim() !== "");
  if (tags.length > 0) headers["x-tags"] = encodeHeaderValue(tags.join(","));
  const allowedUsers = (options.allowedUsers ?? []).filter((user) => user.trim() !== "");
  if (allowedUsers.length > 0) {
    headers["x-allowed-users"] = encodeHeaderValue(allowedUsers.join(","));
  }
  const allowedGroups = (options.allowedGroups ?? []).filter((group) => group.trim() !== "");
  if (allowedGroups.length > 0) {
    headers["x-allowed-groups"] = encodeHeaderValue(allowedGroups.join(","));
  }

  const metadata = buildProvenanceMetadata(document, options.metadata ?? {});
  headers["x-metadata"] = encodeHeaderValue(JSON.stringify(metadata));

  return headers;
}

/**
 * Headers for `PUT /document-assets/:assetId` with the raw crop as the body.
 *
 * Search recomputes the asset id from `X-Document-Reference` and `X-Figure-Id`
 * and rejects the upload when it does not match the path — so these three
 * values have to be produced together, which is why this lives next to
 * {@link buildIngestHeaders} rather than in the HTTP client.
 */
export function buildAssetHeaders(
  document: Pick<ExtractedDocument, "reference">,
  figure: Pick<ExtractedFigure, "id" | "mimeType">,
  options: { collection?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": figure.mimeType,
    "x-document-reference": encodeHeaderValue(document.reference),
    "x-figure-id": encodeHeaderValue(figure.id),
  };
  if (options.collection !== undefined) headers["x-collection"] = options.collection;
  return headers;
}

/** Path a figure crop is uploaded to, relative to the Search base URL. */
export function assetPath(figure: Pick<ExtractedFigure, "assetId">): string {
  return `/document-assets/${figure.assetId}`;
}

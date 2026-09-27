// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * document.ts
 *
 * The structured document model and its wire schemas.
 *
 * Zod is the single source of truth here rather than hand-written interfaces
 * plus hand-written guards, because the same shapes arrive from three
 * directions a producer does not control: the JSON body of an async conversion
 * callback, a stored envelope being replayed, and the response Search's
 * `/ingest-file` proxy forwards. Each of those is untrusted input.
 *
 * Two representations, one model:
 *
 *   {@link ExtractedDocument} — the structured form. Pages carry their body
 *   Markdown *without* the page marker, so a caller can re-serialize with a
 *   different page label or drop figures without re-parsing text.
 *
 *   {@link ConvertResponse} — the same document plus the serialized `markdown`
 *   field. The redundancy is intentional: the overwhelmingly common consumer
 *   (`POST /ingest` with `text/markdown`) wants exactly that string and should
 *   not have to depend on this package to obtain it.
 */

import { z } from "zod";
import { FIGURE_ID_PATTERN, FIGURE_MIME_TYPES, PAGE_LABELS } from "./markers.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be lower-case hex SHA-256");

/** `[x1, y1, x2, y2]`, normalised to `[0,1]`, origin top-left. */
export const boundingBoxSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

/** A figure detected on a page, together with the identity of its stored crop. */
export const extractedFigureSchema = z.object({
  /** Document-unique id, canonically `p<page>-f<ordinal>`. */
  id: z.string().regex(FIGURE_ID_PATTERN, "invalid figure id"),
  /** 1-based page the figure was found on. */
  page: z.int().min(1),
  /** Self-contained prose description; the only retrievable text for the figure. */
  description: z.string(),
  /** Geometry on the rendered page, normalised. */
  bbox: boundingBoxSchema,
  /** `sha256(reference \n id)` — the id the crop is stored under. */
  assetId: sha256Schema,
  /** MIME type of the rendered crop. */
  mimeType: z.enum(FIGURE_MIME_TYPES),
  /** Size of the rendered crop in bytes, when it was rendered. */
  bytes: z.int().min(0).optional(),
  /** SHA-256 of the rendered crop, for upload verification. */
  checksum: sha256Schema.optional(),
  /**
   * The crop itself, base64. Omitted by default: a 40-page document with four
   * figures per page would otherwise produce a multi-megabyte JSON body on a
   * path where the bytes are usually pushed straight to Search instead.
   */
  dataBase64: z.string().optional(),
});

/** One page of an extracted document. */
export const extractedPageSchema = z.object({
  /** 1-based page number. */
  page: z.int().min(1),
  /** Body Markdown, without the page marker, summary or figures block. */
  markdown: z.string(),
  /** Page-level summary, surfaced to Search as an embedded summary. */
  summary: z.string().optional(),
  /** Figures found on this page, in reading order. */
  figures: z.array(extractedFigureSchema).default([]),
  /** Non-fatal problems encountered while extracting this page. */
  warnings: z.array(z.string()).default([]),
});

/**
 * How the document was produced.
 *
 * Recorded because extraction quality is not reproducible from the output
 * alone: whether OCR ran, at what DPI the page was rendered and which vision
 * model described the figures all change the result, and an operator comparing
 * two ingests of the same PDF needs to see which of those differed.
 */
export const pipelineDescriptorSchema = z.object({
  /** Text/layout extraction stage, e.g. `poppler` or `libreoffice+poppler`. */
  extractor: z.string().min(1),
  /** Page rasteriser, e.g. `pdftoppm` or `sharp`. */
  renderer: z.string().optional(),
  /** Vision model that produced page Markdown and figure descriptions. */
  visionModel: z.string().optional(),
  /** True when an OCR pass contributed text. */
  ocr: z.boolean().default(false),
  /** DPI the pages were rendered at. */
  dpi: z.int().min(1).optional(),
});

/** Identity of the uploaded source document. */
export const sourceDescriptorSchema = z.object({
  filename: z.string(),
  mimeType: z.string().min(1),
  bytes: z.int().min(0),
  /** Checksum of the uploaded bytes — the only way to prove two ingests match. */
  sha256: sha256Schema,
});

/** Aggregated model usage for the whole document. */
export const usageSchema = z.object({
  requests: z.int().min(0).default(0),
  promptTokens: z.int().min(0).default(0),
  completionTokens: z.int().min(0).default(0),
  totalTokens: z.int().min(0).default(0),
});

/** Wall-clock breakdown, in milliseconds. */
export const timingsSchema = z.object({
  totalMs: z.int().min(0).default(0),
  extractionMs: z.int().min(0).default(0),
  visionMs: z.int().min(0).default(0),
  renderMs: z.int().min(0).default(0),
  timeToFirstPageMs: z.int().min(0).optional(),
  avgVisionMsPerPage: z.int().min(0).optional(),
  perPageVisionMs: z.array(z.int().min(0)).optional(),
});

/** A fully extracted document in structured form. */
export const extractedDocumentSchema = z.object({
  /** `atf-extract/<semver>` — gate on the major before trusting the rest. */
  contract: z.string().min(1),
  /** Stable document identity; becomes Search's `X-Reference`. */
  reference: z.string().min(1),
  /** Human-readable title, defaulting to the source filename. */
  title: z.string().optional(),
  /** BCP-47 language tag of the document body, when detected. */
  language: z.string().optional(),
  source: sourceDescriptorSchema,
  pipeline: pipelineDescriptorSchema,
  pageCount: z.int().min(0),
  /** Label used by the page markers in the serialized form. */
  pageLabel: z.enum(PAGE_LABELS).default("Seite"),
  pages: z.array(extractedPageSchema),
  usage: usageSchema.optional(),
  timings: timingsSchema.optional(),
  /** Document-level non-fatal problems. */
  warnings: z.array(z.string()).default([]),
});

/**
 * The response body of a completed conversion: the structured document plus its
 * serialized Markdown.
 */
export const convertResponseSchema = extractedDocumentSchema.extend({
  markdown: z.string(),
});

/** Progress event emitted on the SSE conversion channel. */
export const convertProgressEventSchema = z.object({
  type: z.literal("progress"),
  page: z.int().min(1),
  pageCount: z.int().min(0),
  /** extract-compatible alias for pageCount. */
  total: z.int().min(0).optional(),
  /** Serialized Markdown for this page, ready to append. */
  markdown: z.string(),
  figures: z.array(extractedFigureSchema).default([]),
  warnings: z.array(z.string()).default([]),
  tokens: z
    .object({
      prompt: z.int().min(0),
      completion: z.int().min(0),
      total: z.int().min(0),
    })
    .optional(),
  etaSeconds: z.int().min(0).nullable().optional(),
  elapsedMs: z.int().min(0).optional(),
  pageTiming: z
    .object({ totalMs: z.int().min(0), visionMs: z.int().min(0) })
    .optional(),
});

export type ExtractedFigure = z.infer<typeof extractedFigureSchema>;
export type ExtractedPage = z.infer<typeof extractedPageSchema>;
export type PipelineDescriptor = z.infer<typeof pipelineDescriptorSchema>;
export type SourceDescriptor = z.infer<typeof sourceDescriptorSchema>;
export type ExtractUsage = z.infer<typeof usageSchema>;
export type ExtractTimings = z.infer<typeof timingsSchema>;
export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;
export type ConvertResponse = z.infer<typeof convertResponseSchema>;
export type ConvertProgressEvent = z.infer<typeof convertProgressEventSchema>;

/** Parse an untrusted conversion response, throwing on a schema violation. */
export function parseConvertResponse(value: unknown): ConvertResponse {
  return convertResponseSchema.parse(value);
}

/** Parse an untrusted structured document, throwing on a schema violation. */
export function parseExtractedDocument(value: unknown): ExtractedDocument {
  return extractedDocumentSchema.parse(value);
}

/** All figures across all pages, in page then reading order. */
export function collectFigures(
  document: Pick<ExtractedDocument, "pages">,
): ExtractedFigure[] {
  return [...document.pages]
    .sort((a, b) => a.page - b.page)
    .flatMap((page) => page.figures);
}

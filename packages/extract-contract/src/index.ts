// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/extract-contract
 *
 * The document-extraction output contract: one normative definition of what a
 * converted document looks like, shared by the producer (`@atf/extract`) and
 * every consumer (`@atf/search`, runtime flows, operators re-ingesting stored
 * Markdown).
 *
 * See `README.md` for the grammar and `src/markers.ts` for its normative form.
 */

export {
  EXTRACT_CONTRACT_HEADER,
  EXTRACT_CONTRACT_ID,
  EXTRACT_CONTRACT_MAJOR,
  EXTRACT_CONTRACT_NAME,
  EXTRACT_CONTRACT_VERSION,
  isCompatibleContract,
  parseContractId,
  type ContractId,
} from "./version.js";

export { buildDocumentAssetId, isAssetId, sha256Hex } from "./asset-id.js";

export {
  BBOX_PRECISION,
  DEFAULT_PAGE_LABEL,
  FIGURES_BLOCK_PATTERN,
  FIGURE_ID_PATTERN,
  FIGURE_MIME_TYPES,
  FIGURE_PATTERN,
  FIGURE_PLACEHOLDER_PATTERN,
  PAGE_LABELS,
  PAGE_MARKER_PATTERN,
  PAGE_SEPARATOR,
  RESERVED_FIGURE_ID_PREFIX,
  SUMMARY_PATTERN,
  boundingBoxFromPixels,
  boundingBoxToPixels,
  buildFigureId,
  buildFigurePlaceholder,
  buildFigureTag,
  buildFiguresBlock,
  buildPageMarker,
  buildSummaryTag,
  escapeAttribute,
  escapeFigureDescription,
  formatBoundingBox,
  globalize,
  isValidBoundingBox,
  normalizeBoundingBox,
  parseBoundingBoxAttribute,
  parseFigureIdAttribute,
  parsePageAttribute,
  type BoundingBox,
  type FigureMimeType,
  type FigureTagInput,
  type PageLabel,
} from "./markers.js";

export {
  boundingBoxSchema,
  collectFigures,
  convertProgressEventSchema,
  convertResponseSchema,
  extractedDocumentSchema,
  extractedFigureSchema,
  extractedPageSchema,
  parseConvertResponse,
  parseExtractedDocument,
  pipelineDescriptorSchema,
  sourceDescriptorSchema,
  timingsSchema,
  usageSchema,
  type ConvertProgressEvent,
  type ConvertResponse,
  type ExtractTimings,
  type ExtractUsage,
  type ExtractedDocument,
  type ExtractedFigure,
  type ExtractedPage,
  type PipelineDescriptor,
  type SourceDescriptor,
} from "./document.js";

export {
  serializeDocument,
  serializePage,
  type SerializeOptions,
} from "./serialize.js";

export {
  parseDocument,
  parsePageBlock,
  type ParsedDocument,
  type ParsedFigure,
  type ParsedPage,
} from "./parse.js";

export {
  assetPath,
  buildAssetHeaders,
  buildIngestHeaders,
  buildProvenanceMetadata,
  encodeHeaderValue,
  type IngestHeaderOptions,
  type SummaryMode,
  type VersionMode,
} from "./ingest-headers.js";

export {
  ExtractContractError,
  assertValidDocument,
  isValidDocument,
  validateDocument,
  type ValidationIssue,
  type ValidationSeverity,
} from "./validate.js";

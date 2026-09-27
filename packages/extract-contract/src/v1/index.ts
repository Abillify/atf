// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/extract-contract/v1
 *
 * The legacy v1 marker grammar: `## Seite N` page markers, `<figure>` entries
 * with normalised geometry, per-page `<summary>` blocks, HTML tables, figure
 * asset identity and the ingest headers.
 *
 * v1 is no longer the current contract — the package's default export is the v2
 * NDJSON record stream — but it is kept fully available under this subpath so
 * that corpora ingested before v2 stay readable and re-ingestable, and so
 * Search's legacy adapter has exactly one implementation to parse them with.
 *
 * The two shared primitives (`parseContractId`, `buildDocumentAssetId` and the
 * raw-bytes hash helpers) are re-exported from here for convenience; they are
 * the same functions the v2 surface uses.
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

export { buildDocumentAssetId, isAssetId, sha256Hex } from "../asset-id.js";

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

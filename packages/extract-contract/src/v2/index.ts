// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * @atf/extract-contract v2 surface.
 *
 * The `atf-extract/2.0.0` NDJSON record stream: record and block schemas, the
 * transcription union, asset references, the API types shared by the Extract
 * job and Search ingest routes, the NDJSON codec, `validateRecord` and
 * `renderMarkdown`.
 *
 * Re-exported from the package root; grouped here so the record model stays one
 * cohesive module.
 */

export {
  assetRefSchema,
  assetVariantsSchema,
  bboxSchema,
  blockSchema,
  blockSourceSchema,
  cellSchema,
  dataTranscriptionSchema,
  documentBeginRecordSchema,
  documentEndRecordSchema,
  drawingTranscriptionSchema,
  fidelitySchema,
  fieldSchema,
  fieldsTranscriptionSchema,
  figureBlockSchema,
  figureKindSchema,
  furnitureSchema,
  headingBlockSchema,
  identifierEntrySchema,
  isDocumentBegin,
  isDocumentEnd,
  isPage,
  listBlockSchema,
  markdownTranscriptionSchema,
  outlineNodeSchema,
  pageRecordSchema,
  pipelineDescriptorSchema,
  processEdgeSchema,
  processNodeSchema,
  processTranscriptionSchema,
  recordSchema,
  refSchema,
  sourceDescriptorSchema,
  summaryNodeSchema,
  tableBlockSchema,
  textBlockSchema,
  tileRefSchema,
  timingsSchema,
  transcriptionSchema,
  usageSchema,
  type AssetRef,
  type BBox,
  type Block,
  type BlockSource,
  type Cell,
  type DocumentBeginRecord,
  type DocumentEndRecord,
  type ExtractRecord,
  type Fidelity,
  type FigureBlock,
  type FigureKind,
  type Furniture,
  type HeadingBlock,
  type IdentifierEntry,
  type ListBlock,
  type OutlineNode,
  type PageRecord,
  type Ref,
  type SummaryNode,
  type TableBlock,
  type TextBlock,
  type TileRef,
  type Transcription,
} from "./records.js";

export {
  BBOX_PRECISION,
  formatBoundingBoxTuple,
  isValidBoundingBoxTuple,
  normalizeBoundingBoxTuple,
} from "./geometry.js";

export {
  batchAckSchema,
  batchStatusSchema,
  commitResultSchema,
  jobRequestSchema,
  jobSchema,
  jobStatusSchema,
  pageRangeSchema,
  pauseReasonSchema,
  renderRequestSchema,
  renderResultSchema,
  resumePolicySchema,
  revisionSchema,
  revisionStateSchema,
  revisionStatusSchema,
  stageProgressSchema,
  visibilitySchema,
  type BatchAck,
  type BatchStatus,
  type CommitResult,
  type Job,
  type JobRequest,
  type JobStatus,
  type PageRange,
  type PauseReason,
  type RenderRequest,
  type RenderResult,
  type ResumePolicy,
  type Revision,
  type RevisionState,
  type RevisionStatus,
  type StageProgress,
  type Visibility,
} from "./api.js";

export {
  RecordDecodeError,
  decodeRecordLine,
  decodeRecordStream,
  decodeRecords,
  encodeRecordLine,
  encodeRecordStream,
  encodeRecords,
} from "./codec.js";

export {
  isValidRecord,
  validateRecord,
  type RecordValidation,
  type RecordValidationFailure,
  type RecordValidationIssue,
  type RecordValidationSeverity,
  type RecordValidationSuccess,
  type ValidateRecordOptions,
} from "./validate.js";

export {
  renderMarkdown,
  renderPage,
  type RenderMarkdownOptions,
} from "./render.js";

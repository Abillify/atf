// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/records.ts
 *
 * The v2 record model and its wire schemas — the normative definition of the
 * `atf-extract/2.0.0` NDJSON stream.
 *
 * Where v1 shipped a Markdown body with in-band markers, v2 ships a stream of
 * three record types validated with zod:
 *
 *   document.begin   one, first: identity, source, pipeline
 *   page             one per page, sent in batches: typed blocks, furniture,
 *                    assets, fidelity
 *   document.end     one, last: outline, identifier index, summary hierarchy,
 *                    cross-references, usage and timings
 *
 * Markdown is no longer the transport. It is derived from these records by
 * `renderMarkdown` (see `./render.ts`) purely as a human/LLM view.
 *
 * Zod is the single source of truth — the same records arrive from untrusted
 * directions (an ingest batch body, a stored checkpoint being replayed) and
 * every consumer parses them through these schemas.
 *
 * Design reference: `design.md` §4.2 (block model) and §4.1 (record types).
 */

import { z } from "zod";

/** Lower-case hex SHA-256. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be lower-case hex SHA-256");

/**
 * Normalised bounding box `[x1, y1, x2, y2]` in `[0,1]`, origin top-left.
 *
 * Same coordinate space as v1: independent of the DPI a page was rendered at,
 * so higher-resolution re-rendering never invalidates stored geometry.
 */
export const bboxSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export type BBox = z.infer<typeof bboxSchema>;

/** A table cell. A string is the common case; the object carries spans. */
export const cellSchema = z.union([
  z.string(),
  z.object({
    text: z.string(),
    colspan: z.int().min(1).optional(),
    rowspan: z.int().min(1).optional(),
    header: z.boolean().optional(),
  }),
]);

export type Cell = z.infer<typeof cellSchema>;

const cellRow = z.array(cellSchema);

/** The origin of a block's content — deterministic text, vision, or a native parser. */
export const blockSourceSchema = z.enum(["text-layer", "vision", "native"]);

export type BlockSource = z.infer<typeof blockSourceSchema>;

/**
 * A resolved cross-reference, e.g. "Abbildung 12", "siehe Kapitel 4.2".
 *
 * `target` points at another block id / figure id / table id / section id when
 * the document pass could resolve it; it is absent for a dangling reference.
 */
export const refSchema = z.object({
  kind: z.enum(["figure", "table", "section", "identifier", "page"]),
  text: z.string(),
  target: z.string().optional(),
});

export type Ref = z.infer<typeof refSchema>;

/** Kind of figure, driving which transcription format Pass 2 produces. */
export const figureKindSchema = z.enum([
  "bpmn",
  "flowchart",
  "ui_mask",
  "technical_drawing",
  "chart",
  "table_image",
  "photo",
  "diagram",
  "other",
]);

export type FigureKind = z.infer<typeof figureKindSchema>;

// --- Transcription union (design §4.2) -------------------------------------

/** A BPMN/flowchart node in a `process` transcription. */
export const processNodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  lane: z.string().optional(),
});

/** A directed edge, optionally guarded by a condition. */
export const processEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.string().optional(),
});

/** BPMN / flowchart: a Mermaid rendering plus the structured graph. */
export const processTranscriptionSchema = z.object({
  format: z.literal("process"),
  mermaid: z.string(),
  nodes: z.array(processNodeSchema),
  edges: z.array(processEdgeSchema),
  lanes: z.array(z.string()).optional(),
  steps: z.array(z.string()),
});

/** A single input field within a form area. */
export const fieldSchema = z.object({
  label: z.string(),
  type: z.string(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  hint: z.string().optional(),
});

/** UI mask: areas of labelled fields, actions and messages. */
export const fieldsTranscriptionSchema = z.object({
  format: z.literal("fields"),
  areas: z.array(
    z.object({
      name: z.string(),
      fields: z.array(fieldSchema),
    }),
  ),
  actions: z.array(z.string()),
  messages: z.array(z.string()).optional(),
});

/** Technical drawing: title block, parts list, legend, dimensions, views, notes. */
export const drawingTranscriptionSchema = z.object({
  format: z.literal("drawing"),
  titleBlock: z.record(z.string(), z.string()),
  partsList: z.array(cellRow).optional(),
  legend: z.array(z.string()).optional(),
  dimensions: z.array(z.string()).optional(),
  views: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

/** Chart: the extracted data table and the axis labels. */
export const dataTranscriptionSchema = z.object({
  format: z.literal("data"),
  table: z.array(cellRow),
  axes: z.array(z.string()).optional(),
});

/** Fallback: free Markdown when no structured format fits. */
export const markdownTranscriptionSchema = z.object({
  format: z.literal("markdown"),
  text: z.string(),
});

/** Structured, verbatim transcription of a figure's content. */
export const transcriptionSchema = z.discriminatedUnion("format", [
  processTranscriptionSchema,
  fieldsTranscriptionSchema,
  drawingTranscriptionSchema,
  dataTranscriptionSchema,
  markdownTranscriptionSchema,
]);

export type Transcription = z.infer<typeof transcriptionSchema>;

/** A tile of a large figure or drawing, stored as its own asset. */
export const tileRefSchema = z.object({
  tileId: z.string(),
  assetId: sha256Schema,
  bbox: bboxSchema,
});

export type TileRef = z.infer<typeof tileRefSchema>;

// --- Block model (design §4.2) ---------------------------------------------

/**
 * Fields every block carries in addition to its type-specific payload.
 *
 * `bbox`/`source` are optional because a document-pass-synthesised block (a
 * merged table, say) has no single region or origin. `sectionPath` is filled by
 * the document pass, so a page emitted before the pass completes may not have
 * it yet.
 */
const blockBaseSchema = z.object({
  id: z.string(),
  page: z.int().min(1),
  bbox: bboxSchema.optional(),
  source: blockSourceSchema.optional(),
  sectionPath: z.array(z.string()).optional(),
  refs: z.array(refSchema).optional(),
});

export const headingBlockSchema = blockBaseSchema.extend({
  type: z.literal("heading"),
  level: z.int().min(1).max(9),
  numbering: z.string().optional(),
  text: z.string(),
});

export const textBlockSchema = blockBaseSchema.extend({
  type: z.enum(["paragraph", "footnote", "code"]),
  text: z.string(),
});

export const listBlockSchema = blockBaseSchema.extend({
  type: z.literal("list"),
  ordered: z.boolean().optional(),
  items: z.array(z.string()),
});

export const tableBlockSchema = blockBaseSchema.extend({
  type: z.literal("table"),
  tableId: z.string(),
  headerRows: z.array(cellRow),
  rows: z.array(cellRow),
  continuationOf: z.string().optional(),
  continues: z.boolean().optional(),
  caption: z.string().optional(),
});

export const figureBlockSchema = blockBaseSchema.extend({
  type: z.literal("figure"),
  figureId: z.string(),
  kind: figureKindSchema,
  caption: z.string().optional(),
  /** 2–3 sentence summary. */
  description: z.string(),
  transcription: transcriptionSchema.optional(),
  /** Text-layer words inside the bbox (poppler), verbatim. */
  regionText: z.string().optional(),
  /** Deduplicated, normalised labels. */
  labels: z.array(z.string()).optional(),
  tiles: z.array(tileRefSchema).optional(),
  assetId: sha256Schema.optional(),
});

/** A typed content block. */
export const blockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  textBlockSchema,
  listBlockSchema,
  tableBlockSchema,
  figureBlockSchema,
]);

export type Block = z.infer<typeof blockSchema>;
export type HeadingBlock = z.infer<typeof headingBlockSchema>;
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ListBlock = z.infer<typeof listBlockSchema>;
export type TableBlock = z.infer<typeof tableBlockSchema>;
export type FigureBlock = z.infer<typeof figureBlockSchema>;

// --- Asset references (design §4.3) ----------------------------------------

/** The three variants Search materialises for an asset. */
export const assetVariantsSchema = z.object({
  thumb: z.boolean().optional(),
  preview: z.boolean().optional(),
  full: z.boolean().optional(),
});

/** A reference to a stored asset, with the metadata Search indexes it under. */
export const assetRefSchema = z.object({
  assetId: sha256Schema,
  kind: z.enum(["figure", "page", "tile", "native"]),
  /** Local id the asset id was derived from, e.g. `p12-f3`, `page:p37`. */
  localId: z.string(),
  page: z.int().min(1).optional(),
  bbox: bboxSchema.optional(),
  width: z.int().min(1).optional(),
  height: z.int().min(1).optional(),
  mimeType: z.string().optional(),
  variants: assetVariantsSchema.optional(),
  checksum: sha256Schema.optional(),
});

export type AssetRef = z.infer<typeof assetRefSchema>;

// --- Furniture and fidelity ------------------------------------------------

/** Recurring header/footer content, kept rather than discarded (design §4.2). */
export const furnitureSchema = z.object({
  header: z.string().optional(),
  footer: z.string().optional(),
  pageLabel: z.string().optional(),
});

export type Furniture = z.infer<typeof furnitureSchema>;

/** Per-page quality signals, e.g. label coverage and whether the fast path ran. */
export const fidelitySchema = z.object({
  fastPath: z.boolean().optional(),
  labelCoverage: z.number().min(0).max(1).optional(),
  ocr: z.boolean().optional(),
  degraded: z.boolean().optional(),
});

export type Fidelity = z.infer<typeof fidelitySchema>;

// --- Source / pipeline / usage / timings -----------------------------------

export const sourceDescriptorSchema = z.object({
  filename: z.string(),
  mimeType: z.string().min(1),
  bytes: z.int().min(0),
  sha256: sha256Schema,
});

export const pipelineDescriptorSchema = z.object({
  extractor: z.string().min(1),
  renderer: z.string().optional(),
  visionModel: z.string().optional(),
  summaryModel: z.string().optional(),
  ocr: z.boolean().default(false),
  dpi: z.int().min(1).optional(),
  /** Extract's own pipeline version, distinct from the contract version. */
  pipelineVersion: z.string().optional(),
  /** Prompt hash, so two ingests of the same PDF are comparable. */
  promptHash: z.string().optional(),
  /**
   * The contract id (`atf-extract/<semver>`) the producer wrote, repeated on
   * the pipeline descriptor so a consumer that stamps the pipeline stand onto
   * its units (contract + pipelineVersion + promptHash) reads it from one place.
   */
  contract: z.string().optional(),
});

export const usageSchema = z.object({
  requests: z.int().min(0).default(0),
  promptTokens: z.int().min(0).default(0),
  completionTokens: z.int().min(0).default(0),
  totalTokens: z.int().min(0).default(0),
});

export const timingsSchema = z.object({
  totalMs: z.int().min(0).default(0),
  extractionMs: z.int().min(0).default(0),
  visionMs: z.int().min(0).default(0),
  renderMs: z.int().min(0).default(0),
});

// --- Outline / identifiers / summaries (document.end) ----------------------

/** A node in the document outline. */
export const outlineNodeSchema = z.object({
  sectionId: z.string(),
  level: z.int().min(1),
  numbering: z.string().optional(),
  title: z.string(),
  pageStart: z.int().min(1),
  pageEnd: z.int().min(1).optional(),
});

export type OutlineNode = z.infer<typeof outlineNodeSchema>;

/** An indexed identifier (article number, mask code, drawing number, …). */
export const identifierEntrySchema = z.object({
  value: z.string(),
  kind: z.string(),
  occurrences: z.array(
    z.object({
      page: z.int().min(1),
      blockId: z.string().optional(),
    }),
  ),
});

export type IdentifierEntry = z.infer<typeof identifierEntrySchema>;

/** A node in the summary hierarchy (page → section → chapter → document). */
export const summaryNodeSchema = z.object({
  scope: z.enum(["page", "section", "chapter", "document"]),
  id: z.string(),
  summary: z.string(),
  pageStart: z.int().min(1).optional(),
  pageEnd: z.int().min(1).optional(),
});

export type SummaryNode = z.infer<typeof summaryNodeSchema>;

// --- Document version / e-mail / parent (document.begin) --------------------

/**
 * Where a document version came from, strongest first. `explicit` is the
 * caller's own value; the rest are Extract's detection fallbacks.
 */
export const versionSourceSchema = z.enum([
  "explicit",
  "page_label",
  "page_date",
  "llm",
  "source_modified",
]);

export type VersionSource = z.infer<typeof versionSourceSchema>;

/**
 * The document's version. Two versions are ordered by `label` when both carry a
 * comparable one, else by `date` (see `compareDocumentVersions`). Search uses
 * the order to decide which revision of a document is the latest.
 */
export const documentVersionSchema = z
  .object({
    /** The version as written, e.g. `2.1`, `Rev. C`, `v3.0.1`. */
    label: z.string().min(1).max(200).optional(),
    /** The version date, `YYYY-MM-DD` or RFC 3339. */
    date: z.string().min(1).max(64).optional(),
    source: versionSourceSchema,
  })
  .refine((v) => v.label !== undefined || v.date !== undefined, {
    message: "a version needs a label or a date",
  });

export type DocumentVersion = z.infer<typeof documentVersionSchema>;

/** A mailbox as written in a header: display name and address. */
export const mailboxSchema = z.object({
  name: z.string().optional(),
  address: z.string(),
});

export type Mailbox = z.infer<typeof mailboxSchema>;

/**
 * The threading headers of an e-mail (RFC 5322 §3.6.4) plus the Outlook
 * conversation root. Search threads messages ingested independently of each
 * other with these.
 */
export const emailHeadersSchema = z.object({
  /** `Message-ID` without angle brackets. */
  messageId: z.string().min(1),
  inReplyTo: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  /** Base64 conversation root (the first 22 bytes) of Outlook's `Thread-Index`. */
  threadIndexRoot: z.string().optional(),
  subject: z.string().optional(),
  from: mailboxSchema.optional(),
  to: z.array(mailboxSchema).default([]),
  cc: z.array(mailboxSchema).default([]),
  /** `Date` header as RFC 3339. */
  date: z.string().optional(),
  /** File names of the message's attachments, in order. */
  attachments: z.array(z.string()).default([]),
});

export type EmailHeaders = z.infer<typeof emailHeadersSchema>;

// --- Records ---------------------------------------------------------------

/** First record: document identity, source and pipeline. */
export const documentBeginRecordSchema = z.object({
  type: z.literal("document.begin"),
  /** `atf-extract/<semver>` — gate on the major before trusting the rest. */
  contract: z.string().min(1),
  /** Stable document identity; becomes Search's `X-Reference`. */
  reference: z.string().min(1),
  title: z.string().optional(),
  language: z.string().optional(),
  source: sourceDescriptorSchema,
  pipeline: pipelineDescriptorSchema,
  /** Total page count when known up front; omit for a streaming producer. */
  pageCount: z.int().min(0).optional(),
  /** The document's version, explicit or detected (contract 2.1). */
  version: documentVersionSchema.optional(),
  /** Threading headers when the document is an e-mail (contract 2.1). */
  email: emailHeadersSchema.optional(),
  /**
   * The document this one was extracted from, e.g. the e-mail an attachment
   * came with (contract 2.1). Search groups the two.
   */
  parentReference: z.string().min(1).optional(),
});

export type DocumentBeginRecord = z.infer<typeof documentBeginRecordSchema>;

/** One page: typed blocks, furniture, assets, warnings and fidelity. */
export const pageRecordSchema = z.object({
  type: z.literal("page"),
  page: z.int().min(1),
  size: z.object({ wPt: z.number().positive(), hPt: z.number().positive() }),
  class: z.enum(["text", "scan", "drawing", "mixed"]),
  summary: z.string().optional(),
  blocks: z.array(blockSchema),
  furniture: furnitureSchema.optional(),
  assets: z.array(assetRefSchema).default([]),
  warnings: z.array(z.string()).default([]),
  fidelity: fidelitySchema.optional(),
});

export type PageRecord = z.infer<typeof pageRecordSchema>;

/** Last record: outline, identifier index, summary hierarchy, usage, timings. */
export const documentEndRecordSchema = z.object({
  type: z.literal("document.end"),
  reference: z.string().min(1),
  pageCount: z.int().min(0),
  outline: z.array(outlineNodeSchema).default([]),
  identifiers: z.array(identifierEntrySchema).default([]),
  summaries: z.array(summaryNodeSchema).default([]),
  refs: z.array(refSchema).default([]),
  usage: usageSchema.optional(),
  timings: timingsSchema.optional(),
  warnings: z.array(z.string()).default([]),
});

export type DocumentEndRecord = z.infer<typeof documentEndRecordSchema>;

/** Any record on the v2 stream. */
export const recordSchema = z.discriminatedUnion("type", [
  documentBeginRecordSchema,
  pageRecordSchema,
  documentEndRecordSchema,
]);

export type ExtractRecord = z.infer<typeof recordSchema>;

/** Narrowing guards, handy for consumers walking a stream. */
export function isDocumentBegin(record: ExtractRecord): record is DocumentBeginRecord {
  return record.type === "document.begin";
}

export function isPage(record: ExtractRecord): record is PageRecord {
  return record.type === "page";
}

export function isDocumentEnd(record: ExtractRecord): record is DocumentEndRecord {
  return record.type === "document.end";
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ingest-jobs.ts
 *
 * Shared logic for building the flat list of embedding jobs from a set of
 * documents.  Used by all three ingest handlers (single, batch, stream) to
 * eliminate code duplication.
 *
 * An "EmbedJob" represents one chunk (or the whole document when chunking is
 * disabled) that needs to be embedded.  After embedding, the caller attaches
 * the resulting vector and calls postgresClient.batchUpsert().
 */

import { createHash } from "node:crypto";
import type { DocumentPoint, ChunkInfo } from "./postgres-client.js";
import { normalizeMetadata, type Metadata } from "./metadata.js";
import { chunkDocument, isMeaningfulChunk, type Chunk } from "./chunker.js";
import { semanticChunkBatch, type EmbedFn } from "./semantic-chunker.js";
import { blendVectors } from "./vector-utils.js";
import type { SparseVector } from "./sparse-embedding-client.js";
import type { SummaryClient } from "./summary-client.js";
import { splitDocumentIntoChapters } from "./chapter-splitter.js";

/**
 * Minimal structured-logger shape used across the ingest pipeline. Satisfied by
 * pino's Logger (which the handlers pass in as req.log). info/debug are optional
 * so lightweight test doubles that only implement warn keep working.
 */
export interface IngestLogger {
  info?: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
  debug?: (obj: unknown, msg: string) => void;
}

// ─── Chunk filtering ───────────────────────────────────────────────────────────

/**
 * Drop low-value ("meaningless") chunks and renumber the survivors so `index`
 * stays contiguous (0..n-1) and `total` reflects the kept count.
 *
 * chunkDocument itself is intentionally lossless (Requirement 6.1); filtering
 * junk chunks — pure whitespace, punctuation, single-letter tokens — is an
 * indexing-layer decision applied here so we never embed/store meaningless
 * points. The semantic chunker already performs this filtering on its own
 * output, so re-applying it is idempotent.
 */
function keepMeaningfulChunks(chunks: Chunk[]): Chunk[] {
  const kept = chunks.filter((c) => isMeaningfulChunk(c.content));
  const total = kept.length;
  return kept.map((c, i) => ({ ...c, index: i, total }));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IngestDocument {
  reference: string;
  content: string;
  title?: string;
  source?: string;
  link?: string;
  metadata?: Metadata;
  tags?: string[];
  allowedUsers?: string[];
  allowedGroups?: string[];
  /** Explicit version tag (X-Version header). */
  version?: string;
}

export interface EmbedJob {
  /** Text to embed (may include context prefix). */
  embedInput: string;
  /** Index into the source documents array. */
  docIndex: number;
  chunkIndex: number;
  point: Omit<DocumentPoint, "vector" | "sparseVector">;
}

export interface ChunkingOptions {
  enabled: boolean;
  chunkSize: number;
  overlapSize: number;
  contextPrefixSize: number | null;
  lateChunkingAlpha: number | null;
  useSemanticChunking: boolean;
  breakpointPercentile: number;
  /** Use LLM summarization instead of text-slice for context prefix. */
  useSummarization: boolean;
  /**
   * Chapter splitting threshold. When set (and chunking is enabled), a document
   * that would produce MORE than this many chunks is split into chapter
   * sub-documents at Markdown heading boundaries (recursively at deeper heading
   * levels for still-oversized chapters). Each chapter gets its own `base_ref`
   * (documentRef + "/" + "<n>. <title>") and is summarized independently.
   * null = disabled (index the document as a single unit).
   */
  chapterSplitMaxChunks: number | null;
}

// ─── Ingest unit (a document or one of its chapters) ──────────────────────────

/**
 * A single indexable unit: either a whole document (no chapter splitting) or
 * one chapter of a split document. All chapters of the same source document
 * share the same `docIndex` so response grouping and late-chunking document
 * vectors continue to key off the original document.
 */
interface IngestUnit {
  /** Index of the originating document in the caller's `documents` array. */
  docIndex: number;
  /** This unit's reference — becomes the `base_ref` for its chunks. */
  reference: string;
  /** This unit's version tag, derived from the document version + suffix. */
  version?: string;
  content: string;
  metadata: Metadata;
  source?: string;
  link?: string;
  title?: string;
  tags: string[];
  allowedUsers: string[];
  allowedGroups: string[];
  /** Original root-document identity and coordinates retained through chapter splitting. */
  rootDocumentId: string;
  parentRef?: string;
  sectionPath: string[];
  sourceCharStart: number;
  pageStart?: number;
  pageEnd?: number;
}

/**
 * Expand one document into one or more ingest units.
 *
 * Without chapter splitting (or when it is disabled) this returns a single
 * unit identical to the document. With chapter splitting active, the document
 * is divided into chapter sub-documents whose references carry a readable
 * suffix, e.g. `<docRef>/1. Beteiligte Parteien`.
 */
function expandDocumentToUnits(
  doc: IngestDocument,
  docIndex: number,
  sharedMetadata: Metadata,
  chunking: ChunkingOptions,
  logger?: IngestLogger,
): IngestUnit[] {
  const docMetadata = normalizeMetadata(
    { ...sharedMetadata, ...(doc.metadata ?? {}) },
    doc.version,
  );
  const page = typeof docMetadata.page === "number" ? docMetadata.page : undefined;
  const base = {
    docIndex,
    metadata: docMetadata,
    source: doc.source,
    link: doc.link,
    title: doc.title,
    tags: doc.tags ?? [],
    allowedUsers: doc.allowedUsers ?? [],
    allowedGroups: doc.allowedGroups ?? [],
    rootDocumentId: typeof docMetadata.document_id === "string" ? docMetadata.document_id : doc.reference,
    sectionPath: [] as string[],
    sourceCharStart: 0,
    pageStart: page,
    pageEnd: page,
  };

  if (!chunking.chapterSplitMaxChunks) {
    return [
      { ...base, reference: doc.reference, version: doc.version, content: doc.content },
    ];
  }

  const parts = splitDocumentIntoChapters(doc.content, {
    maxChunks: chunking.chapterSplitMaxChunks,
    chunkSize: chunking.chunkSize,
    overlapSize: chunking.overlapSize,
    // Large documents without any Markdown headings (e.g. extracted PDFs) would
    // otherwise stay whole and overflow the summary model — split them by size.
    sizeFallback: true,
  });

  const units = parts.map((part) => ({
    ...base,
    reference: part.refSuffix
      ? `${doc.reference}/${part.refSuffix}`
      : doc.reference,
    version: doc.version
      ? part.refSuffix
        ? `${doc.version}/${part.refSuffix}`
        : doc.version
      : undefined,
    content: part.content,
    sourceCharStart: part.charStart,
    parentRef: part.refSuffix ? doc.reference : undefined,
    sectionPath: part.refSuffix ? part.refSuffix.split("/") : [],
  }));

  if (units.length > 1) {
    logger?.info?.(
      {
        reference: doc.reference,
        chapterSplitMaxChunks: chunking.chapterSplitMaxChunks,
        chapters: units.length,
        chapterRefs: units.map((u) => u.reference),
      },
      `Ingest: split document into ${units.length} chapters`,
    );
  } else {
    logger?.info?.(
      { reference: doc.reference },
      "Ingest: document not split (below chapter threshold)",
    );
  }

  return units;
}

// ─── ChunkInfo builder ────────────────────────────────────────────────────────

/**
 * Build the ChunkInfo object for a chunk.
 *
 * When semantic chunking is active, chunk_overlap_start and chunk_overlap_end
 * are always 0 (sentences don't overlap) and are omitted to keep the JSON lean.
 * For text-boundary chunking they are included only when non-zero.
 *
 * context_prefix_size is included for ALL chunks (not just > 0) so that
 * consumers know chunk 0 contains the document summary in context_prefix.
 */
function buildChunkInfo(
  chunk: Chunk,
  totalChunks: number,
  chunking: ChunkingOptions,
  unit: IngestUnit,
): ChunkInfo {
  const charStart = unit.sourceCharStart + chunk.charStart;
  const charEnd = unit.sourceCharStart + chunk.charEnd;
  const chunkId = createHash("sha256")
    .update(`${unit.rootDocumentId}\n${unit.reference}\n${charStart}\n${charEnd}\n${chunk.content}`)
    .digest("hex");
  const base: ChunkInfo = {
    chunk_index: chunk.index,
    chunk_total: totalChunks,
    chunk_size: chunking.chunkSize,
    chunk_id: chunkId,
    char_start: charStart,
    char_end: charEnd,
    root_document_id: unit.rootDocumentId,
    ...(unit.parentRef ? { parent_ref: unit.parentRef } : {}),
    ...(unit.sectionPath.length ? { section_path: unit.sectionPath } : {}),
    ...(unit.pageStart !== undefined ? { page_start: unit.pageStart } : {}),
    ...(unit.pageEnd !== undefined ? { page_end: unit.pageEnd } : {}),
    // Omit overlap fields for semantic chunking (always 0, no information value).
    ...(!chunking.useSemanticChunking && {
      chunk_overlap: chunking.overlapSize,
      chunk_overlap_start: chunk.overlapStart,
      chunk_overlap_end: chunk.overlapEnd,
    }),
    ...(chunking.useSemanticChunking
      ? {
          semantic_chunking: true,
          breakpoint_percentile: chunking.breakpointPercentile,
        }
      : {}),
    ...(chunking.lateChunkingAlpha !== null
      ? { late_chunking_alpha: chunking.lateChunkingAlpha }
      : {}),
    // Set for ALL chunks when context prefix is active, so consumers know
    // that chunk 0 of this document contains the summary in context_prefix.
    ...(chunking.contextPrefixSize || chunking.useSummarization
      ? {
          context_prefix_size: chunking.contextPrefixSize ?? undefined,
          ...(chunking.useSummarization ? { summary: true } : {}),
        }
      : {}),
  };
  return base;
}

// ─── Embed input builder ─────────────────────────────────────────────────────

/**
 * Build the text that will be sent to the embedding model for a single chunk.
 *
 * Layout (each section only included when the value is present):
 *
 *   [title: <title>]
 *   [ref: <base_ref>]
 *   [<context prefix>
 *   ---]
 *   <chunk content>
 *
 * `title` and `base_ref` are prepended so the embedding model sees the
 * document identity alongside every chunk, which helps retrieval for
 * short or generic chunks.
 *
 * Context prefix rules:
 *   - Summary prefix (LLM-generated): added for ALL chunks, including chunk 0,
 *     because the summary is always additive context that differs from the text.
 *   - Text-slice prefix: only added for chunks > 0, because chunk 0 starts at
 *     the very beginning of the document — prepending a slice of that same text
 *     would be redundant.
 */
function buildEmbedInput(
  chunkContent: string,
  chunkIndex: number,
  baseRef: string,
  title: string | undefined,
  resolvedPrefix: string | undefined,
  isSummaryPrefix: boolean,
): string {
  const headerLines: string[] = [];
  if (title) headerLines.push(`title: ${title}`);
  headerLines.push(`ref: ${baseRef}`);

  const header = headerLines.join("\n");
  const includePrefix = resolvedPrefix && (isSummaryPrefix || chunkIndex > 0);
  const prefix = includePrefix ? `${resolvedPrefix}\n---\n` : "";
  return `${header}\n${prefix}${chunkContent}`;
}

// ─── Non-chunking single-point job ────────────────────────────────────────────

/**
 * Build the single embed job used when chunking is disabled: the whole
 * document becomes one point keyed by its own reference (no `_chunk_` suffix).
 */
function buildUnchunkedJob(
  doc: IngestDocument,
  docIndex: number,
  sharedMetadata: Metadata,
): EmbedJob {
  const docMetadata = normalizeMetadata(
    { ...sharedMetadata, ...(doc.metadata ?? {}) },
    doc.version,
  );
  return {
    embedInput: buildEmbedInput(
      doc.content,
      0,
      doc.reference,
      doc.title,
      undefined,
      false,
    ),
    docIndex,
    chunkIndex: 0,
    point: {
      reference: doc.reference,
      version: doc.version,
      content: doc.content,
      metadata: docMetadata,
      source: doc.source,
      link: doc.link,
      title: doc.title,
      tags: doc.tags ?? [],
      allowedUsers: doc.allowedUsers ?? [],
      allowedGroups: doc.allowedGroups ?? [],
    },
  };
}

// ─── Unit job builder (shared by single + batch) ──────────────────────────────

/**
 * Build embed jobs for a flat list of ingest units (documents or chapters).
 *
 * Uses a single batch embedding call for semantic chunking (O(1) round-trips
 * regardless of unit count) and resolves one context prefix / summary per unit
 * — so chapters are summarized independently. Falls back to text-boundary
 * chunking if semantic chunking fails.
 */
async function buildJobsFromUnits(
  units: IngestUnit[],
  chunking: ChunkingOptions,
  embedFn: EmbedFn,
  summaryClient: SummaryClient | null,
  logger?: IngestLogger,
): Promise<EmbedJob[]> {
  // Chunk every unit. Semantic chunking runs one batch embedding call for all
  // units at once; text chunking is purely local.
  let unitChunks: Chunk[][];
  if (chunking.useSemanticChunking) {
    try {
      unitChunks = await semanticChunkBatch(
        units.map((u) => u.content),
        embedFn,
        {
          maxChunkSize: chunking.chunkSize,
          maxChunkOverlap: chunking.overlapSize,
          breakpointPercentile: chunking.breakpointPercentile,
        },
      );
    } catch {
      unitChunks = units.map((u) =>
        chunkDocument(u.content, chunking.chunkSize, chunking.overlapSize),
      );
    }
  } else {
    unitChunks = units.map((u) =>
      chunkDocument(u.content, chunking.chunkSize, chunking.overlapSize),
    );
  }

  // Drop meaningless chunks per unit and renumber (chunkDocument is lossless).
  unitChunks = unitChunks.map(keepMeaningfulChunks);

  const totalChunks = unitChunks.reduce((sum, cs) => sum + cs.length, 0);
  for (let i = 0; i < units.length; i++) {
    logger?.info?.(
      {
        reference: units[i]!.reference,
        unit: i + 1,
        unitsTotal: units.length,
        chunks: unitChunks[i]!.length,
        semantic: chunking.useSemanticChunking,
      },
      `Ingest: chunked ${units.length > 1 ? "chapter" : "document"} into ${unitChunks[i]!.length} chunks`,
    );
  }
  if (chunking.useSummarization && summaryClient !== null) {
    logger?.info?.(
      { units: units.length, totalChunks },
      `Ingest: generating ${units.length} summaries`,
    );
  }

  // Resolve context prefixes per unit in parallel. LLM summary takes priority
  // over text-slice. summaryClient enforces its own maxConcurrency semaphore,
  // so firing all requests concurrently is safe and faster than sequential.
  const resolvedPrefixes: Array<{
    text: string | undefined;
    isSummary: boolean;
  }> = await Promise.all(
    units.map(async (unit) => {
      if (chunking.useSummarization && summaryClient !== null) {
        logger?.info?.(
          { reference: unit.reference, contentLength: unit.content.length },
          "Ingest: summarizing",
        );
        const summaryRes = await summaryClient.summarize(unit.content);
        if (summaryRes.ok) {
          logger?.info?.(
            { reference: unit.reference, summaryLength: summaryRes.result.length },
            "Ingest: summary generated",
          );
          return { text: summaryRes.result, isSummary: true };
        }
        logger?.warn(
          { error: summaryRes.error, ref: unit.reference },
          "Summary failed; falling back to text-slice prefix",
        );
      }
      if (chunking.contextPrefixSize) {
        return {
          text: unit.content.slice(0, chunking.contextPrefixSize),
          isSummary: false,
        };
      }
      return { text: undefined, isSummary: false };
    }),
  );

  const jobs: EmbedJob[] = [];
  for (let ui = 0; ui < units.length; ui++) {
    const unit = units[ui]!;
    const chunks = unitChunks[ui]!;
    const { text: resolvedPrefix, isSummary: isSummaryPrefix } =
      resolvedPrefixes[ui]!;

    for (const chunk of chunks) {
      const embedInput = buildEmbedInput(
        chunk.content,
        chunk.index,
        unit.reference,
        unit.title,
        resolvedPrefix,
        isSummaryPrefix,
      );

      jobs.push({
        embedInput,
        docIndex: unit.docIndex,
        chunkIndex: chunk.index,
        point: {
          reference: `${unit.reference}_chunk_${chunk.index}`,
          baseRef: unit.reference,
          version: unit.version
            ? `${unit.version}_chunk_${chunk.index}`
            : undefined,
          content: chunk.content,
          metadata: unit.metadata,
          prefix: chunk.index === 0 ? resolvedPrefix : undefined,
          chunk: buildChunkInfo(chunk, chunks.length, chunking, unit),
          source: unit.source,
          link: unit.link,
          title: unit.title,
          tags: unit.tags,
          allowedUsers: unit.allowedUsers,
          allowedGroups: unit.allowedGroups,
        },
      });
    }
  }
  return jobs;
}

// ─── Single-document job builder ──────────────────────────────────────────────

/**
 * Build embed jobs for a single document.
 * When semantic chunking is requested, the caller must provide an embedFn.
 * Falls back to text chunking if semantic chunking fails.
 *
 * When chapter splitting is active (chunking.chapterSplitMaxChunks set) and the
 * document is large enough, the document is first divided into chapter
 * sub-documents; each chapter is then chunked and summarized independently.
 */
export async function buildJobsForDocument(
  doc: IngestDocument,
  docIndex: number,
  sharedMetadata: Metadata,
  versionMode: "replace" | "version",
  chunking: ChunkingOptions,
  embedFn: EmbedFn,
  summaryClient: SummaryClient | null = null,
  logger?: IngestLogger,
): Promise<EmbedJob[]> {
  logger?.info?.(
    {
      reference: doc.reference,
      contentLength: doc.content.length,
      chunkingEnabled: chunking.enabled,
    },
    "Ingest: processing document",
  );

  if (!chunking.enabled) {
    return [buildUnchunkedJob(doc, docIndex, sharedMetadata)];
  }

  const units = expandDocumentToUnits(
    doc,
    docIndex,
    sharedMetadata,
    chunking,
    logger,
  );
  return buildJobsFromUnits(units, chunking, embedFn, summaryClient, logger);
}

// ─── Batch job builder ────────────────────────────────────────────────────────

/**
 * Build embed jobs for a batch of documents using a single embedding call
 * for semantic chunking (O(1) round-trips instead of O(N)).
 *
 * For non-semantic chunking, falls back to the per-document path which
 * requires no embedding calls during job building.
 *
 * Chapter splitting (when enabled) expands each oversized document into chapter
 * sub-documents; all chapters of a document keep the document's `docIndex` so
 * per-document response grouping and late-chunking document vectors are
 * unaffected.
 */
export async function buildJobsForBatch(
  documents: IngestDocument[],
  sharedMetadata: Metadata,
  versionMode: "replace" | "version",
  chunking: ChunkingOptions,
  embedFn: EmbedFn,
  summaryClient: SummaryClient | null = null,
  logger?: IngestLogger,
): Promise<EmbedJob[]> {
  logger?.info?.(
    { documents: documents.length, chunkingEnabled: chunking.enabled },
    `Ingest: processing batch of ${documents.length} documents`,
  );

  if (!chunking.enabled) {
    return documents.map((doc, docIndex) =>
      buildUnchunkedJob(doc, docIndex, sharedMetadata),
    );
  }

  const units = documents.flatMap((doc, docIndex) =>
    expandDocumentToUnits(doc, docIndex, sharedMetadata, chunking, logger),
  );
  return buildJobsFromUnits(units, chunking, embedFn, summaryClient, logger);
}

// ─── Embedding + late-chunking ────────────────────────────────────────────────

export interface EmbedAndBlendResult {
  vectors: number[][];
}

/**
 * Embed all job inputs in a single batch call.
 * If lateChunkingAlpha is set and chunking is enabled, also embeds the full
 * document texts and blends chunk vectors with document vectors.
 *
 * Returns the final vectors in job order.
 * Throws if the embedding call fails (caller should handle).
 */
export const DEFAULT_EMBED_BATCH_SIZE = 64;

async function embedInProviderBatches(
  inputs: string[],
  embedFn: EmbedFn,
  batchSize = DEFAULT_EMBED_BATCH_SIZE,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < inputs.length; start += batchSize) {
    const batch = inputs.slice(start, start + batchSize);
    const result = await embedFn(batch);
    if (result.length !== batch.length) {
      throw new Error("Embedding provider returned wrong number of vectors");
    }
    vectors.push(...result);
  }
  return vectors;
}

export async function embedJobsWithLateChunking(
  jobs: EmbedJob[],
  documents: IngestDocument[],
  chunking: ChunkingOptions,
  embedFn: EmbedFn,
): Promise<number[][]> {
  const needsDocVecs = chunking.lateChunkingAlpha !== null && chunking.enabled;
  const docContents = needsDocVecs ? documents.map((d) => d.content) : [];
  const allInputs = [...jobs.map((j) => j.embedInput), ...docContents];

  const allVectors = await embedInProviderBatches(allInputs, embedFn);

  let vectors = allVectors.slice(0, jobs.length);

  if (needsDocVecs) {
    const docVecs = allVectors.slice(jobs.length);
    vectors = vectors.map((chunkVec, i) => {
      const docVec = docVecs[jobs[i]!.docIndex];
      if (!docVec) return chunkVec;
      return blendVectors(chunkVec, docVec, chunking.lateChunkingAlpha!);
    });
  }

  return vectors;
}

// ─── Assemble DocumentPoints ──────────────────────────────────────────────────

export function assemblePoints(
  jobs: EmbedJob[],
  vectors: number[][],
  sparseVectors: Array<SparseVector | undefined>,
): Array<Omit<DocumentPoint, never>> {
  return jobs.map((job, i) => ({
    ...job.point,
    vector: vectors[i]!,
    sparseVector: sparseVectors[i],
  }));
}

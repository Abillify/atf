// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import type { EmbeddingClient } from "../embedding-client.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { PostgresClient } from "../postgres-client.js";
import { normalizeMetadata, type Metadata } from "../metadata.js";
import {
  buildJobsForBatch,
  embedJobsWithLateChunking,
  assemblePoints,
  type IngestDocument,
} from "../ingest-jobs.js";
import {
  resolveChunkingOptions,
  parseIngestHeaders,
  type IngestDefaults,
} from "./ingest.js";
import type { EmbedFn } from "../semantic-chunker.js";
import type { SummaryClient } from "../summary-client.js";
import { getUsageContext } from "../usage-context.js";
import { aclForMutation } from "../access-scope.js";
import { parseRfc3339DateTime } from "../rfc3339.js";

export interface BatchDocument {
  reference: string;
  content: string;
  title?: string;
  source?: string;
  link?: string;
  metadata?: Metadata;
  tags?: string[];
  allowedUsers?: string[];
  allowedGroups?: string[];
  version?: string;
  valid_from?: string | null;
}

export interface BatchDocumentResult {
  reference: string;
  ids: string[];
  chunks?: number;
  error?: string;
}

export function createIngestBatchHandler(
  embeddingClient: EmbeddingClient,
  postgresClient: PostgresClient,
  defaults: IngestDefaults = {
    defaultChunkSize: null,
    defaultChunkOverlap: null,
  },
  sparseClient: SparseEmbeddingClient | null = null,
  summaryClient: SummaryClient | null = null,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const body = req.body as unknown;

      if (!Array.isArray(body) || body.length === 0) {
        res.status(400).json({
          error: "Request body must be a non-empty JSON array of documents",
        });
        return;
      }
      if (body.length > 100) {
        res
          .status(400)
          .json({ error: "Batch size must not exceed 100 documents" });
        return;
      }

      for (let i = 0; i < body.length; i++) {
        const doc = body[i] as Record<string, unknown>;
        if (typeof doc !== "object" || doc === null) {
          res.status(400).json({ error: `documents[${i}] must be an object` });
          return;
        }
        if (typeof doc["reference"] !== "string" || !doc["reference"]) {
          res.status(400).json({
            error: `documents[${i}].reference must be a non-empty string`,
          });
          return;
        }
        if (typeof doc["content"] !== "string" || !doc["content"].trim()) {
          res.status(400).json({
            error: `documents[${i}].content must be a non-empty string`,
          });
          return;
        }
      }

      const documents = body as BatchDocument[];

      // Reject batches with duplicate references — two upserts for the same
      // reference in one call produce undefined ordering and confusing results.
      const seenRefs = new Set<string>();
      const dupeRefs: string[] = [];
      for (const doc of documents) {
        if (seenRefs.has(doc.reference)) {
          dupeRefs.push(doc.reference);
        } else {
          seenRefs.add(doc.reference);
        }
      }
      if (dupeRefs.length > 0) {
        res.status(400).json({
          error: `Duplicate references in batch: ${dupeRefs.join(", ")}`,
        });
        return;
      }

      const sharedMetadata: Metadata =
        (res.locals as { metadata?: Metadata }).metadata ?? {};

      const parsed = parseIngestHeaders(req, defaults);
      if (parsed.validationError) {
        res.status(400).json({ error: parsed.validationError });
        return;
      }

      const {
        rawChunkSize,
        rawChunkOverlap,
        collectionRaw,
        versionMode,
        versionTag,
        validFrom,
        ftsLanguage,
        semanticChunkingOverride,
        lateChunkingAlphaOverride,
        quantizationOverride,
        breakpointPercentileOverride,
        contextPrefixSizeOverride,
        summarizeOverride,
        chapterSplitMaxChunksOverride,
        documentStructure,
        summaryMode,
        pageMarkers,
        figureChunks,
        normalizeTables,
      } = parsed;

      const scope = (res.locals as { accessScope?: import("../access-scope.js").AccessScope }).accessScope;
      const collectionAcl = (res.locals as { collectionAcl?: import("../collection-access.js").CollectionAcl }).collectionAcl;
      const writeAcl = scope && collectionAcl ? aclForMutation(scope, collectionAcl) : undefined;

      const useSummarization =
        summaryClient !== null && summarizeOverride === true;

      const chunking = resolveChunkingOptions(
        rawChunkSize,
        rawChunkOverlap,
        defaults,
        semanticChunkingOverride,
        lateChunkingAlphaOverride,
        breakpointPercentileOverride,
        contextPrefixSizeOverride,
        useSummarization,
        chapterSplitMaxChunksOverride,
        documentStructure,
        summaryMode,
        pageMarkers,
        figureChunks,
        normalizeTables,
      );
      if ("error" in chunking) {
        res.status(400).json({ error: chunking.error });
        return;
      }

      const embedFn: EmbedFn = async (texts) => {
        const r = await embeddingClient.embedBatch(texts);
        if (!r.ok) throw new Error(r.error.message);
        return r.result.vectors;
      };

      req.log.info(
        {
          collection: collectionRaw,
          count: documents.length,
          chunking: chunking.enabled
            ? {
                chunkSize: chunking.chunkSize,
                overlapSize: chunking.overlapSize,
                semantic: chunking.useSemanticChunking,
                contextPrefixSize: chunking.contextPrefixSize,
                useSummarization: chunking.useSummarization,
              }
            : false,
          versionMode,
          ftsLanguage,
          lateChunking: chunking.lateChunkingAlpha !== null,
          sparse: sparseClient !== null,
        },
        "Incoming batch ingest request",
      );

      // Convert to IngestDocument and normalize the merged metadata contract.
      let ingestDocs: IngestDocument[];
      let normalizedSharedMetadata: Metadata;
      try {
        normalizedSharedMetadata = normalizeMetadata(sharedMetadata, versionTag);
        ingestDocs = documents.map((d) => ({
          ...d,
          metadata: normalizeMetadata({ ...normalizedSharedMetadata, ...(d.metadata ?? {}) }, d.version ?? versionTag),
          allowedUsers: writeAcl?.allowedUsers ?? [],
          allowedGroups: writeAcl?.allowedGroups ?? [],
          version: d.version ?? versionTag,
          validFrom: d.valid_from === null ? undefined : parseRfc3339DateTime(d.valid_from) ?? validFrom,
        }));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid metadata" });
        return;
      }

      // Build jobs — uses semanticChunkBatch internally (one embed call for all docs)
      const jobs = await buildJobsForBatch(
        ingestDocs,
        normalizedSharedMetadata,
        versionMode,
        chunking,
        embedFn,
        summaryClient,
        req.log,
      );

      // Embed all inputs + optional doc vectors for late chunking
      req.log.info(
        { collection: collectionRaw, documents: documents.length, chunks: jobs.length },
        "Ingest: embedding chunks (batch)",
      );
      let vectors: number[][];
      try {
        vectors = await embedJobsWithLateChunking(
          jobs,
          ingestDocs,
          chunking,
          embedFn,
        );
      } catch (err) {
        req.log.warn({ err }, "Batch embedding failed");
        res
          .status(502)
          .json({ error: `Embedding failed: ${(err as Error).message}` });
        return;
      }

      if (vectors.length !== jobs.length) {
        res
          .status(502)
          .json({ error: "Embedding server returned wrong number of vectors" });
        return;
      }

      const ensureResult = await postgresClient.ensureCollection(
        collectionRaw,
        vectors[0]!.length,
        {
          language: ftsLanguage,
          sparseVocabSize: defaults.sparseVocabSize ?? undefined,
          quantization: quantizationOverride ?? defaults.quantization,
          embeddingModel: defaults.embeddingModel,
          embeddingModelRevision: defaults.embeddingModelRevision,
        },
      );
      if (!ensureResult.ok) {
        res
          .status(
            ensureResult.error.code === "INVALID_COLLECTION_NAME" ? 400 : 502,
          )
          .json({ error: ensureResult.error.message });
        return;
      }

      // Sparse embeddings
      let sparseVectors: Array<
        import("../sparse-embedding-client.js").SparseVector | undefined
      > = jobs.map(() => undefined);
      if (sparseClient !== null) {
        const sparseResult = await sparseClient.embedSparseBatch(
          jobs.map((j) => j.embedInput),
        );
        if (sparseResult.ok) {
          sparseVectors = sparseResult.result;
        } else {
          req.log.warn(
            { error: sparseResult.error },
            "Sparse batch embedding failed; skipping",
          );
        }
      }

      const points = assemblePoints(jobs, vectors, sparseVectors);
      for (const point of points) {
        point.tenantId = scope?.tenantId;
        point.preserveExistingAclOnConflict = writeAcl?.preserveExistingOnConflict === true;
      }

      req.log.info(
        { collection: collectionRaw, documents: documents.length, points: points.length },
        "Ingest: storing chunks in database (batch)",
      );
      const upsertResult = await postgresClient.batchUpsert(
        points,
        collectionRaw,
        versionMode,
      );
      if (!upsertResult.ok) {
        req.log.warn({ error: upsertResult.error }, "Batch upsert failed");
        res
          .status(502)
          .json({ error: `PostgreSQL error: ${upsertResult.error.message}` });
        return;
      }

      // Build per-document result summary
      const resultMap = new Map<string, BatchDocumentResult>();
      for (const doc of documents) {
        resultMap.set(doc.reference, {
          reference: doc.reference,
          ids: [],
          chunks: 0,
        });
      }
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const doc = documents[job.docIndex]!;
        const entry = resultMap.get(doc.reference)!;
        entry.ids.push(upsertResult.result.ids[i]!);
        entry.chunks = (entry.chunks ?? 0) + 1;
      }

      const results = [...resultMap.values()].map((r) => ({
        reference: r.reference,
        ids: r.ids,
        ...(chunking.enabled ? { chunks: r.chunks } : {}),
      }));

      const usage = getUsageContext();
      if (usage) {
        res.setHeader("X-Usage-Input-Tokens", String(usage.inputTokens));
        res.setHeader("X-Usage-Output-Tokens", String(usage.outputTokens));
        res.setHeader("X-Usage-Total-Cost", String(usage.cost));
      }

      res.status(200).json({
        status: "ok",
        results,
        ...(usage
          ? {
              usage: {
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                total_cost: usage.cost,
              },
            }
          : {}),
      });
    } catch (err) {
      next(err);
    }
  };
}

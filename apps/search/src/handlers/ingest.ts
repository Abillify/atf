// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { EmbeddingClient } from "../embedding-client.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { PostgresClient } from "../postgres-client.js";
import { normalizeMetadata, type Metadata } from "../metadata.js";
import { readHeader } from "../header-utils.js";
import {
  buildJobsForDocument,
  embedJobsWithLateChunking,
  assemblePoints,
  type ChunkingOptions,
  type IngestDocument,
} from "../ingest-jobs.js";
import type { EmbedFn } from "../semantic-chunker.js";
import type { SummaryClient } from "../summary-client.js";
import {
  parseIngestHeaders,
  resolveChunkingOptions,
  parseSemanticChunkingHeader,
  parseLateChunkingAlphaHeader,
  parseQuantizationHeader,
  parseBreakpointPercentileHeader,
} from "../ingest-header-parser.js";
import { emitActivity } from "../activity-emitter.js";
import { newActivityId } from "./activity-stream.js";
import { getUsageContext } from "../usage-context.js";
import { aclForMutation } from "../access-scope.js";

// Re-export so ingest-batch.ts and ingest-stream.ts can import from one place.
export {
  parseIngestHeaders,
  resolveChunkingOptions,
  parseSemanticChunkingHeader,
  parseLateChunkingAlphaHeader,
  parseQuantizationHeader,
  parseBreakpointPercentileHeader,
} from "../ingest-header-parser.js";

export interface IngestDefaults {
  defaultChunkSize: number | null;
  defaultChunkOverlap: number | null;
  hybridSearch?: boolean;
  contextPrefixSize?: number | null;
  defaultFtsLanguage?: string;
  lateChunkingAlpha?: number | null;
  sparseVocabSize?: number | null;
  embeddingModel?: string;
  embeddingModelRevision?: string;
  semanticChunking?: boolean;
  breakpointPercentile?: number;
  /** Server-wide default quantization for new collections. Overridable via X-Quantization header. */
  quantization?: "none" | "binary";
  /** Server-wide chapter-split threshold (chunks). Overridable via X-Chapter-Split-Max-Chunks. */
  chapterSplitMaxChunks?: number | null;
}

export function createIngestHandler(
  embeddingClient: EmbeddingClient,
  postgresClient: PostgresClient,
  logger: Logger,
  defaults: IngestDefaults = {
    defaultChunkSize: null,
    defaultChunkOverlap: null,
  },
  sparseClient: SparseEmbeddingClient | null = null,
  summaryClient: SummaryClient | null = null,
): RequestHandler {
  return async (req, res, next) => {
    const log: Logger = (req as { log?: Logger }).log ?? logger;
    try {
      const body = req.body as string;
      if (!body || body.trim() === "") {
        res.status(400).json({ error: "Request body must not be empty" });
        return;
      }

      const reference = readHeader(req, "x-reference");
      if (!reference) {
        res.status(400).json({ error: "X-Reference header is required" });
        return;
      }

      const source = readHeader(req, "x-source");
      const link = readHeader(req, "x-link");
      const title = readHeader(req, "x-title");
      const tagsRaw = readHeader(req, "x-tags");
      const tags = tagsRaw
        ? tagsRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
      const allowedUsersRaw = readHeader(req, "x-allowed-users");
      const allowedUsers = allowedUsersRaw
        ? allowedUsersRaw
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean)
        : [];
      const allowedGroupsRaw = readHeader(req, "x-allowed-groups");
      const allowedGroups = allowedGroupsRaw
        ? allowedGroupsRaw
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean)
        : [];

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

      // Summarization active only when explicitly requested via header.
      // Having SUMMARY_MODEL configured does NOT auto-enable summarization —
      // it must be activated per-request with X-Summarize: true.
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

      let metadata: Metadata;
      try {
        metadata = normalizeMetadata(
          (res.locals as { metadata?: Metadata }).metadata ?? {},
          versionTag,
        );
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid metadata" });
        return;
      }
      const scope = (res.locals as { accessScope?: import("../access-scope.js").AccessScope }).accessScope;
      const collectionAcl = (res.locals as { collectionAcl?: import("../collection-access.js").CollectionAcl }).collectionAcl;
      const writeAcl = scope && collectionAcl ? aclForMutation(scope, collectionAcl) : undefined;

      log.info(
        {
          collection: collectionRaw,
          reference,
          versionMode,
          version: versionTag,
          metadata,
          ftsLanguage,
          chunking: chunking.enabled
            ? {
                chunkSize: chunking.chunkSize,
                overlapSize: chunking.overlapSize,
                semantic: chunking.useSemanticChunking,
                contextPrefixSize: chunking.contextPrefixSize,
                useSummarization: chunking.useSummarization,
              }
            : false,
          lateChunking: chunking.lateChunkingAlpha !== null,
          sparse: sparseClient !== null,
          bodyLength: body.length,
        },
        "Incoming ingest request",
      );

      const embedFn: EmbedFn = async (texts) => {
        const r = await embeddingClient.embedBatch(texts);
        if (!r.ok) throw new Error(r.error.message);
        return r.result.vectors;
      };

      const doc: IngestDocument = {
        reference,
        content: body,
        title,
        source,
        link,
        tags,
        allowedUsers: writeAcl?.allowedUsers ?? [],
        allowedGroups: writeAcl?.allowedGroups ?? [],
        version: versionTag,
      };

      const jobs = await buildJobsForDocument(
        doc,
        0,
        metadata,
        versionMode,
        chunking,
        embedFn,
        summaryClient,
        log,
      );

      // Embed all inputs in one batch call (includes doc vector for late chunking)
      log.info(
        { reference, collection: collectionRaw, chunks: jobs.length },
        "Ingest: embedding chunks",
      );
      let vectors: number[][];
      try {
        vectors = await embedJobsWithLateChunking(
          [...jobs],
          [doc],
          chunking,
          embedFn,
        );
      } catch (err) {
        log.warn({ err }, "Embedding failed");
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
          log.warn(
            { error: sparseResult.error },
            "Sparse embedding failed; skipping",
          );
        }
      }

      const points = assemblePoints(jobs, vectors, sparseVectors);
      for (const point of points) {
        point.tenantId = scope?.tenantId;
        point.preserveExistingAclOnConflict = writeAcl?.preserveExistingOnConflict === true;
      }

      log.info(
        { reference, collection: collectionRaw, points: points.length },
        "Ingest: storing chunks in database",
      );

      const ingestStartTime = Date.now();
      if (!chunking.enabled) {
        // Single document — use upsert for the simple response shape
        const upsertResult = await postgresClient.upsert(
          points[0]!,
          collectionRaw,
          versionMode,
        );
        if (!upsertResult.ok) {
          log.warn({ error: upsertResult.error }, "Upsert failed");
          emitActivity({
            id: newActivityId(),
            type: "ingest",
            status: "error",
            summary:
              reference +
              (collectionRaw !== "documents" ? " → " + collectionRaw : ""),
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - ingestStartTime,
            detail: { error: upsertResult.error.message },
          });
          res
            .status(502)
            .json({ error: `PostgreSQL error: ${upsertResult.error.message}` });
          return;
        }
        const usage = getUsageContext();
        if (usage) {
          res.setHeader("X-Usage-Input-Tokens", String(usage.inputTokens));
          res.setHeader("X-Usage-Output-Tokens", String(usage.outputTokens));
          res.setHeader("X-Usage-Total-Cost", String(usage.cost));
        }
        const responseBody = {
          status: "ok",
          id: upsertResult.result.id,
          ...(usage
            ? {
                usage: {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  total_cost: usage.cost,
                  model_costs: usage.modelCosts,
                },
              }
            : {}),
        };
        emitActivity({
          id: newActivityId(),
          type: "ingest",
          status: "ok",
          summary:
            reference +
            (collectionRaw !== "documents" ? " → " + collectionRaw : ""),
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - ingestStartTime,
          detail: responseBody,
          usage: usage ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cost: usage.cost,
            modelCosts: usage.modelCosts,
          } : undefined,
        });
        res.status(200).json(responseBody);
      } else {
        const batchResult = await postgresClient.batchUpsert(
          points,
          collectionRaw,
          versionMode,
        );
        if (!batchResult.ok) {
          log.warn({ error: batchResult.error }, "Batch upsert failed");
          emitActivity({
            id: newActivityId(),
            type: "ingest",
            status: "error",
            summary:
              reference +
              (collectionRaw !== "documents" ? " → " + collectionRaw : ""),
            timestamp: new Date().toISOString(),
            duration_ms: Date.now() - ingestStartTime,
            detail: { error: batchResult.error.message },
          });
          res
            .status(502)
            .json({ error: `PostgreSQL error: ${batchResult.error.message}` });
          return;
        }
        log.info(
          { reference, collection: collectionRaw, chunks: jobs.length },
          "Ingest: done",
        );
        const usage = getUsageContext();
        if (usage) {
          res.setHeader("X-Usage-Input-Tokens", String(usage.inputTokens));
          res.setHeader("X-Usage-Output-Tokens", String(usage.outputTokens));
          res.setHeader("X-Usage-Total-Cost", String(usage.cost));
        }
        const responseBody = {
          status: "ok",
          ids: batchResult.result.ids,
          chunks: jobs.length,
          ...(usage
            ? {
                usage: {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  total_cost: usage.cost,
                  model_costs: usage.modelCosts,
                },
              }
            : {}),
        };
        emitActivity({
          id: newActivityId(),
          type: "ingest",
          status: "ok",
          summary:
            reference +
            (collectionRaw !== "documents" ? " → " + collectionRaw : "") +
            " (" +
            jobs.length +
            " chunks)",
          timestamp: new Date().toISOString(),
          duration_ms: Date.now() - ingestStartTime,
          detail: responseBody,
          usage: usage ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cost: usage.cost,
            modelCosts: usage.modelCosts,
          } : undefined,
        });
        res.status(200).json(responseBody);
      }
    } catch (err) {
      next(err);
    }
  };
}

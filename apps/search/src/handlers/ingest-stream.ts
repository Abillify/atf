// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// POST /ingest-stream — bulk NDJSON ingest without the 100-document limit.
//
// Request:  Content-Type: application/x-ndjson
//           Each line: { reference, content, title?, source?, link?, metadata? }
//           Same X-* headers as /ingest-batch apply.
//
// Response: application/x-ndjson — one JSON result line per document,
//           emitted progressively as each sub-batch completes.
//           Final line: { status: "ok", total: N, errors: N }
//
// Sub-batch size: SUB_BATCH_SIZE (50).

import type { RequestHandler } from "express";
import type pino from "pino";
import type { EmbeddingClient } from "../embedding-client.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { PostgresClient } from "../postgres-client.js";
import { normalizeMetadata, type Metadata } from "../metadata.js";
import {
  buildJobsForBatch,
  embedJobsWithLateChunking,
  assemblePoints,
  type EmbedJob,
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

const SUB_BATCH_SIZE = 16;
/** The current Express transport buffers the request before this handler. */
const MAX_STREAM_ITEMS = 10_000;
const MAX_ITEM_BYTES = 2 * 1024 * 1024;

async function writeWithBackpressure(
  res: Parameters<RequestHandler>[1],
  value: unknown,
): Promise<void> {
  const payload = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
  if (res.write(payload)) return;
  await new Promise<void>((resolve, reject) => {
    res.once("drain", resolve);
    res.once("error", reject);
  });
}

interface StreamResult {
  reference: string;
  ids: string[];
  chunks?: number;
  error?: string;
}

export function createIngestStreamHandler(
  embeddingClient: EmbeddingClient,
  postgresClient: PostgresClient,
  defaults: IngestDefaults = {
    defaultChunkSize: null,
    defaultChunkOverlap: null,
  },
  sparseClient: SparseEmbeddingClient | null = null,
  summaryClient: SummaryClient | null = null,
  logger?: pino.Logger,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const log: pino.Logger = (req as { log?: pino.Logger }).log ?? logger!;
      const rawBody = req.body as string;
      if (typeof rawBody !== "string" || rawBody.trim() === "") {
        res
          .status(400)
          .json({ error: "Request body must be non-empty NDJSON" });
        return;
      }

      const lines = rawBody.split("\n").filter((l) => l.trim() !== "");
      if (lines.length > MAX_STREAM_ITEMS) {
        res.status(413).json({ error: `NDJSON item limit exceeded (${MAX_STREAM_ITEMS})` });
        return;
      }
      if (lines.length === 0) {
        res.status(400).json({ error: "No documents found in NDJSON body" });
        return;
      }

      const documents: IngestDocument[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (Buffer.byteLength(lines[i]!, "utf8") > MAX_ITEM_BYTES) {
          res.status(413).json({ error: `Line ${i + 1}: item exceeds ${MAX_ITEM_BYTES} bytes` });
          return;
        }
        let doc: unknown;
        try {
          doc = JSON.parse(lines[i]!);
        } catch {
          res.status(400).json({ error: `Line ${i + 1}: invalid JSON` });
          return;
        }
        if (typeof doc !== "object" || doc === null) {
          res
            .status(400)
            .json({ error: `Line ${i + 1}: must be a JSON object` });
          return;
        }
        const d = doc as Record<string, unknown>;
        if (typeof d["reference"] !== "string" || !d["reference"]) {
          res.status(400).json({
            error: `Line ${i + 1}: reference must be a non-empty string`,
          });
          return;
        }
        if (
          typeof d["content"] !== "string" ||
          !(d["content"] as string).trim()
        ) {
          res.status(400).json({
            error: `Line ${i + 1}: content must be a non-empty string`,
          });
          return;
        }
        documents.push(doc as IngestDocument);
      }

      // Reject streams with duplicate references — same reasoning as /ingest-batch.
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
          error: `Duplicate references in stream: ${dupeRefs.join(", ")}`,
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

      // Validate every item before starting the NDJSON response so malformed
      // timestamps cannot produce a partially committed stream.
      for (let i = 0; i < documents.length; i++) {
        const document = documents[i] as IngestDocument & { valid_from?: unknown };
        if (document.valid_from === null) {
          document.validFrom = undefined;
        } else {
          try {
            document.validFrom = parseRfc3339DateTime(document.valid_from) ?? validFrom;
          } catch (error) {
            res.status(400).json({ error: `Line ${i + 1}: valid_from ${(error as Error).message}` });
            return;
          }
        }
      }

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

      log.info(
        {
          collection: collectionRaw,
          total: documents.length,
          chunking: chunking.enabled
            ? {
                chunkSize: chunking.chunkSize,
                overlapSize: chunking.overlapSize,
                semantic: chunking.useSemanticChunking,
              }
            : false,
          versionMode,
          ftsLanguage,
        },
        "Incoming stream ingest request",
      );

      const embedFn: EmbedFn = async (texts) => {
        const r = await embeddingClient.embedBatch(texts);
        if (!r.ok) throw new Error(r.error.message);
        return r.result.vectors;
      };

      let normalizedSharedMetadata: Metadata;
      try {
        normalizedSharedMetadata = normalizeMetadata(sharedMetadata, versionTag);
        for (const document of documents) {
          document.metadata = normalizeMetadata(
            { ...normalizedSharedMetadata, ...(document.metadata ?? {}) },
            document.version ?? versionTag,
          );
        }
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Invalid metadata" });
        return;
      }

      // Start streaming response
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Transfer-Encoding", "chunked");
      res.status(200);

      let collectionEnsured = false;
      let totalDocs = 0;
      let totalErrors = 0;

      for (let start = 0; start < documents.length; start += SUB_BATCH_SIZE) {
        const batch = documents.slice(start, start + SUB_BATCH_SIZE);
        const batchWithVersion: IngestDocument[] = batch.map((d) => ({
          ...d,
          allowedUsers: writeAcl?.allowedUsers ?? [],
          allowedGroups: writeAcl?.allowedGroups ?? [],
          version: d.version ?? versionTag,
          validFrom: d.validFrom,
        }));

        // Build jobs using semanticChunkBatch (one embed call for all docs in sub-batch)
        let jobs: EmbedJob[];
        try {
          jobs = await buildJobsForBatch(
            batchWithVersion,
            normalizedSharedMetadata,
            versionMode,
            chunking,
            embedFn,
            summaryClient,
            log,
          );
        } catch (err) {
          const errLine: StreamResult = {
            reference: "_chunk_error",
            ids: [],
            error: `Chunking failed: ${(err as Error).message}`,
          };
          await writeWithBackpressure(res, JSON.stringify(errLine) + "\n");
          totalErrors += batch.length;
          continue;
        }

        // Embed all inputs + optional doc vectors for late chunking
        log.info(
          { collection: collectionRaw, documents: batch.length, chunks: jobs.length },
          "Ingest: embedding chunks (stream sub-batch)",
        );
        let vectors: number[][];
        try {
          vectors = await embedJobsWithLateChunking(
            jobs,
            batchWithVersion,
            chunking,
            embedFn,
          );
        } catch (err) {
          const errLine: StreamResult = {
            reference: "_batch_error",
            ids: [],
            error: `Embedding failed: ${(err as Error).message}`,
          };
          await writeWithBackpressure(res, JSON.stringify(errLine) + "\n");
          totalErrors += batch.length;
          continue;
        }

        if (!collectionEnsured && vectors[0]) {
          const ensureResult = await postgresClient.ensureCollection(
            collectionRaw,
            vectors[0].length,
            {
              language: ftsLanguage,
              sparseVocabSize: defaults.sparseVocabSize ?? undefined,
              quantization: quantizationOverride ?? defaults.quantization,
              embeddingModel: defaults.embeddingModel,
              embeddingModelRevision: defaults.embeddingModelRevision,
            },
          );
          if (!ensureResult.ok) {
            await writeWithBackpressure(res,
              JSON.stringify({
                reference: "_collection_error",
                ids: [],
                error: ensureResult.error.message,
              }) + "\n",
            );
            res.end();
            return;
          }
          collectionEnsured = true;
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
              "Sparse batch embedding failed; skipping",
            );
          }
        }

        const points = assemblePoints(jobs, vectors, sparseVectors);
        for (const point of points) {
          point.tenantId = scope?.tenantId;
          point.preserveExistingAclOnConflict = writeAcl?.preserveExistingOnConflict === true;
        }

        log.info(
          { collection: collectionRaw, documents: batch.length, points: points.length },
          "Ingest: storing chunks in database (stream sub-batch)",
        );
        const upsertResult = await postgresClient.batchUpsert(
          points,
          collectionRaw,
          versionMode,
        );
        if (!upsertResult.ok) {
          await writeWithBackpressure(res,
            JSON.stringify({
              reference: "_upsert_error",
              ids: [],
              error: `PostgreSQL error: ${upsertResult.error.message}`,
            }) + "\n",
          );
          totalErrors += batch.length;
          continue;
        }

        // Emit one result line per document in this sub-batch
        const resultMap = new Map<string, StreamResult>();
        for (const doc of batch) {
          resultMap.set(doc.reference, {
            reference: doc.reference,
            ids: [],
            chunks: 0,
          });
        }
        for (let i = 0; i < jobs.length; i++) {
          const job = jobs[i]!;
          const doc = batch[job.docIndex]!;
          const entry = resultMap.get(doc.reference)!;
          entry.ids.push(upsertResult.result.ids[i]!);
          entry.chunks = (entry.chunks ?? 0) + 1;
        }

        for (const entry of resultMap.values()) {
          await writeWithBackpressure(res,
            JSON.stringify({
              reference: entry.reference,
              ids: entry.ids,
              ...(chunking.enabled ? { chunks: entry.chunks } : {}),
            }) + "\n",
          );
          totalDocs++;
        }
      }

      const usage = getUsageContext();
      await writeWithBackpressure(res,
        JSON.stringify({
          status: "ok",
          total: totalDocs,
          errors: totalErrors,
          ...(usage
            ? {
                usage: {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  total_cost: usage.cost,
                },
              }
            : {}),
        }) + "\n",
      );
      res.end();
    } catch (err) {
      next(err);
    }
  };
}

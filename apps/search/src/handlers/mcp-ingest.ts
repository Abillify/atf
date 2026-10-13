// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp-ingest.ts
 *
 * The mutating MCP tools: ingest (chunking + embedding pipeline,
 * identical to the REST /ingest endpoint) and delete_document.
 *
 * Extracted verbatim from handlers/mcp.ts (Requirement 13.6). The tools are
 * registered onto the SAME {@link McpServer} built by buildMcpServer, so they
 * inherit its one registration boundary — identical Fabric scope,
 * authorization and idempotency semantics.
 */

import { z } from "zod";
import { accessScopeForMcp, aclForMutation } from "../access-scope.js";
import { emitActivity } from "../activity-emitter.js";
import { assemblePoints, buildJobsForDocument, embedJobsWithLateChunking, type ChunkingOptions, type EmbedJob, type IngestDocument } from "../ingest-jobs.js";
import { normalizeMetadata, type Metadata } from "../metadata.js";
import { parseRfc3339DateTime } from "../rfc3339.js";
import type { EmbedFn } from "../semantic-chunker.js";
import { getUsageContext } from "../usage-context.js";
import { newActivityId } from "./activity-stream.js";
import type { McpToolContext } from "./mcp-tool-ctx.js";

export function registerIngestTools(opts: McpToolContext): void {
  const {
    server,
    embeddingClient,
    postgresClient,
    sparseClient,
    logger,
    defaultCollection = "documents",
    chunkingOptions = null,
    summaryClient = null,
    authorize,
  } = opts;

  server.tool(
    "ingest",
    "Add or update a document in the vector index. Uses the same chunking pipeline as the REST API (chunking, sparse vectors, etc.).",
    {
      reference: z
        .string()
        .min(1)
        .describe("Unique document identifier (URI, path, or slug)"),
      requesting_user: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Explicit owner for a private document. Must exactly match the authenticated end-user principal.",
        ),
      content: z
        .string()
        .min(1)
        .describe("Full document text to embed and index"),
      collection: z
        .string()
        .optional()
        .describe(`Target collection (default: "${defaultCollection}")`),
      title: z.string().optional().describe("Human-readable document title"),
      source: z.string().optional().describe("Source system identifier"),
      link: z
        .string()
        .optional()
        .describe("URL linking back to the original document"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags to attach to the document"),
      version: z.string().min(1).optional().describe("Technical document version tag"),
      version_mode: z
        .union([z.literal("replace"), z.literal("version")])
        .optional()
        .describe("replace updates the current reference; version preserves prior revisions (default: replace)"),
      valid_from: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("RFC 3339 business-validity start with an explicit timezone"),
      metadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Arbitrary metadata key/value pairs"),
    },
    async ({
      reference,
      requesting_user,
      content,
      collection,
      title,
      source,
      link,
      tags,
      version,
      version_mode = "replace",
      valid_from,
      metadata,
    }) => {
      const col = collection ?? defaultCollection;

      const embedFn: EmbedFn = async (texts) => {
        const r = await embeddingClient.embedBatch(texts);
        if (!r.ok) throw new Error(r.error.message);
        return r.result.vectors;
      };

      const secured = await authorize(col);
      const writeAcl = aclForMutation(secured.scope, secured.acl, requesting_user);

      let normalizedMetadata: Metadata;
      try {
        normalizedMetadata = normalizeMetadata(metadata ?? {}, version);
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid metadata" }], isError: true };
      }
      const doc: IngestDocument = {
        reference,
        content,
        title,
        source,
        link,
        tags: tags ?? [],
        allowedUsers: writeAcl.allowedUsers,
        allowedGroups: writeAcl.allowedGroups,
        version,
        validFrom: parseRfc3339DateTime(valid_from),
        metadata: normalizedMetadata,
      };

      // Use the server-configured chunking pipeline (same as /ingest).
      // Falls back to a single-document embed when chunking is disabled.
      const chunking: ChunkingOptions = chunkingOptions ?? {
        enabled: false,
        chunkSize: 0,
        overlapSize: 0,
        contextPrefixSize: null,
        lateChunkingAlpha: null,
        useSemanticChunking: false,
        breakpointPercentile: 75,
        useSummarization: false,
        chapterSplitMaxChunks: null,
      };

      let jobs: EmbedJob[];
      try {
        jobs = await buildJobsForDocument(
          doc,
          0,
          normalizedMetadata,
          version_mode,
          chunking,
          embedFn,
          summaryClient,
          logger,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "[MCP] Chunking failed");
        return {
          content: [{ type: "text", text: `Chunking failed: ${msg}` }],
          isError: true,
        };
      }

      let vectors: number[][];
      try {
        vectors = await embedJobsWithLateChunking(
          jobs,
          [doc],
          chunking,
          embedFn,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "[MCP] Embedding failed");
        return {
          content: [{ type: "text", text: `Embedding failed: ${msg}` }],
          isError: true,
        };
      }

      if (vectors.length !== jobs.length) {
        return {
          content: [
            {
              type: "text",
              text: "Embedding server returned wrong number of vectors",
            },
          ],
          isError: true,
        };
      }

      // Ensure collection exists (uses the first vector's dimension).
      const firstVector = vectors[0];
      if (firstVector === undefined) {
        return {
          content: [{ type: "text", text: "Embedding server returned no vectors" }],
          isError: true,
        };
      }
      const ensureResult = await postgresClient.ensureCollection(
        col,
        firstVector.length,
        {
          ...(opts.embeddingModel ? { embeddingModel: opts.embeddingModel } : {}),
          ...(opts.embeddingModelRevision ? { embeddingModelRevision: opts.embeddingModelRevision } : {}),
        },
      );
      if (!ensureResult.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Collection error: ${ensureResult.error.message}`,
            },
          ],
          isError: true,
        };
      }

      // Optional sparse vectors.
      const sparseVectors: Array<
        import("../sparse-embedding-client.js").SparseVector | undefined
      > = jobs.map(() => undefined);
      if (sparseClient) {
        const sparseRes = await sparseClient.embedSparseBatch(
          jobs.map((j) => j.embedInput),
        );
        if (sparseRes.ok) {
          sparseRes.result.forEach((sv, i) => {
            sparseVectors[i] = sv;
          });
        }
      }

      const points = assemblePoints(jobs, vectors, sparseVectors);
      for (const point of points) {
        point.tenantId = secured.scope.tenantId;
        point.preserveExistingAclOnConflict = writeAcl.preserveExistingOnConflict === true;
      }

      const upsertResult = await postgresClient.batchUpsert(
        points,
        col,
        version_mode,
      );

      if (!upsertResult.ok) {
        logger.warn(
          { error: upsertResult.error },
          "[MCP] Ingest upsert failed",
        );
        return {
          content: [
            {
              type: "text",
              text: `Ingest failed: ${upsertResult.error.message}`,
            },
          ],
          isError: true,
        };
      }

      const usage = getUsageContext();
      emitActivity({
        id: newActivityId(),
        type: "ingest",
        status: "ok",
        summary:
          reference +
          (col !== "documents" ? " in " + col : "") +
          " [mcp, " +
          jobs.length +
          (jobs.length === 1 ? " chunk]" : " chunks]"),
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        detail: {
          ids: upsertResult.result.ids,
          chunks: jobs.length,
          reference,
          collection: col,
          source: "mcp",
        },
        usage: usage ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: usage.cost,
          modelCosts: usage.modelCosts,
        } : undefined,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              ids: upsertResult.result.ids,
              chunks: jobs.length,
              reference,
              collection: col,
              version_mode,
              valid_from: parseRfc3339DateTime(valid_from) ?? null,
              ...(usage !== undefined &&
              (usage.inputTokens > 0 ||
                usage.outputTokens > 0 ||
                usage.cost > 0)
                ? {
                    usage: {
                      input_tokens: usage.inputTokens,
                      output_tokens: usage.outputTokens,
                      cost_usd: usage.cost,
                      model_costs: usage.modelCosts,
                    },
                  }
                : {}),
            }),
          },
        ],
      };
    },
  );
  server.tool(
    "delete_document",
    "Delete a document and all its chunks/versions from the index by reference.",
    {
      reference: z
        .string()
        .min(1)
        .describe("The exact reference key to delete"),
      collection: z
        .string()
        .optional()
        .describe(
          `Collection to delete from (default: "${defaultCollection}")`,
        ),
    },
    async ({ reference, collection }) => {
      const col = collection ?? defaultCollection;
      await authorize(col);
      const result = await postgresClient.delete({}, col, accessScopeForMcp(), reference);

      if (!result.ok) {
        logger.warn({ error: result.error }, "[MCP] Delete failed");
        return {
          content: [
            { type: "text", text: `Delete failed: ${result.error.message}` },
          ],
          isError: true,
        };
      }

      emitActivity({
        id: newActivityId(),
        type: "delete",
        status: "ok",
        summary:
          reference + (col !== "documents" ? " in " + col : "") + " [mcp]",
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        detail: {
          deleted: result.result.deleted,
          reference,
          collection: col,
          source: "mcp",
        },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              deleted: result.result.deleted,
              reference,
              collection: col,
            }),
          },
        ],
      };
    },
  );
}

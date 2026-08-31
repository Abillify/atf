// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * RAG ingestion API (`src/routes/rag.ts`)
 *
 * CRUD over the vector store that backs `retrieval` flow nodes. Documents are
 * embedded server-side (clients send plain text, not vectors) using the same
 * embedding model the retrieval nodes use, so a corpus indexed here is directly
 * queryable by a flow.
 *
 * Routes (all under the standard `/v1/*` auth gate):
 *   POST   /v1/rag/:collection/documents   — upsert { documents: [{id?, text, metadata?}] }
 *   DELETE /v1/rag/:collection/documents   — delete { ids: [...] }
 *   DELETE /v1/rag/:collection             — drop a whole collection
 *   GET    /v1/rag/:collection/count       — document count
 *   GET    /v1/rag/collections             — list non-empty collections
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import crypto from "node:crypto";
import type { AuthContext } from "../middleware/auth.js";
import type { VectorStore, RagDocument } from "../graph/vector-store.js";
import type { Embedder } from "../graph/semantic-cache.js";
import type { Logger } from "../observability/logger.js";

interface IngestDocument {
  id?: string;
  text?: string;
  metadata?: Record<string, unknown>;
}

interface IngestBody {
  documents?: IngestDocument[];
}

/** Max documents accepted in a single ingest request (bounds memory/latency). */
const MAX_BATCH = 256;

export function createRagRouter(
  vectorStore: VectorStore,
  embedder: Embedder,
  logger?: Logger,
): Hono<AuthContext> {
  const router = new Hono<AuthContext>();

  router.post("/v1/rag/:collection/documents", async (ctx) => {
    const collection = ctx.req.param("collection");
    let body: IngestBody;
    try {
      body = await ctx.req.json<IngestBody>();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const docs = Array.isArray(body.documents) ? body.documents : [];
    if (docs.length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'documents' must be a non-empty array.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    if (docs.length > MAX_BATCH) {
      return ctx.json(
        {
          error: {
            message: `Too many documents (max ${MAX_BATCH} per request).`,
            type: "invalid_request_error",
          },
        },
        413,
      );
    }

    // Validate + embed. Empty-text documents are rejected up front.
    const prepared: RagDocument[] = [];
    try {
      for (const d of docs) {
        const text = typeof d.text === "string" ? d.text.trim() : "";
        if (text.length === 0) {
          return ctx.json(
            {
              error: {
                message: "Each document needs a non-empty 'text'.",
                type: "invalid_request_error",
              },
            },
            400,
          );
        }
        const embedding = await embedder.embed(text);
        prepared.push({
          id:
            typeof d.id === "string" && d.id.length > 0
              ? d.id
              : crypto.randomUUID(),
          text,
          embedding,
          ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
        });
      }
      await vectorStore.upsert(collection, prepared);
    } catch (err) {
      logger?.warn("RAG ingest failed", {
        collection,
        error: err instanceof Error ? err.message : String(err),
      });
      return ctx.json(
        {
          error: {
            message: "Failed to index documents.",
            type: "execution_error",
          },
        },
        500,
      );
    }

    return ctx.json({
      collection,
      upserted: prepared.length,
      ids: prepared.map((p) => p.id),
    });
  });

  router.delete("/v1/rag/:collection/documents", async (ctx) => {
    const collection = ctx.req.param("collection");
    let body: { ids?: string[] };
    try {
      body = await ctx.req.json<{ ids?: string[] }>();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((i) => typeof i === "string")
      : [];
    if (ids.length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'ids' must be a non-empty array.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }
    const removed = await vectorStore.deleteDocuments(collection, ids);
    return ctx.json({ collection, removed });
  });

  router.delete("/v1/rag/:collection", async (ctx) => {
    const collection = ctx.req.param("collection");
    const removed = await vectorStore.deleteCollection(collection);
    return ctx.json({ collection, removed });
  });

  router.get("/v1/rag/collections", async (ctx) => {
    const collections = await vectorStore.listCollections();
    return ctx.json({ collections });
  });

  router.get("/v1/rag/:collection/count", async (ctx) => {
    const collection = ctx.req.param("collection");
    const count = await vectorStore.count(collection);
    return ctx.json({ collection, count });
  });

  router.get("/v1/rag/:collection/documents", async (ctx) => {
    const collection = ctx.req.param("collection");
    const limitParam = ctx.req.query("limit");
    const limit = limitParam !== undefined ? Number.parseInt(limitParam, 10) : 100;
    const documents = await vectorStore.listDocuments(
      collection,
      Number.isFinite(limit) && limit > 0 ? limit : 100,
    );
    return ctx.json({ collection, documents });
  });

  return router;
}

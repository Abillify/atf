// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * openapi.ts
 *
 * Returns the OpenAPI 3.1 specification for this service as a plain JS object.
 * Served as JSON at GET /openapi.json (no auth required) and as YAML at
 * GET /openapi.yaml.  Keeping the spec in code (rather than a static file)
 * means it is always bundled and never goes out of sync with the route list.
 *
 * The spec describes every endpoint, all custom X-* request headers, and the
 * response shapes.  It intentionally omits internal/admin endpoints from the
 * public-facing summary but includes them under the "Admin" tag for operators.
 */

// ─── Reusable header parameter objects ───────────────────────────────────────

const booleanHeader = (
  name: string,
  description: string,
  required = false,
) => ({
  name,
  in: "header" as const,
  required,
  description,
  schema: {
    type: "string",
    enum: ["1", "0", "true", "false", "yes", "no", "on", "off"],
  },
});

// ─── Shared schema components ─────────────────────────────────────────────────

const searchResultSchema = {
  type: "object",
  required: [
    "id",
    "score",
    "content",
    "reference",
    "base_ref",
    "metadata",
    "created",
    "modified",
  ],
  properties: {
    id: { type: "string", description: "Internal row UUID" },
    score: {
      type: "number",
      description: "Primary relevance score (cosine, rrf, ts_rank)",
    },
    vector_score: {
      type: "number",
      nullable: true,
      description: "Raw cosine similarity (0–1)",
    },
    text_score: {
      type: "number",
      nullable: true,
      description: "PostgreSQL full-text-search ts_rank score",
    },
    sparse_score: {
      type: "number",
      nullable: true,
      description: "SPLADE dot-product score",
    },
    content: { type: "string", description: "Chunk or document text" },
    prefix: {
      type: "string",
      nullable: true,
      description: "Context prefix stored on chunk_index=0",
    },
    reference: {
      type: "string",
      description: "Unique document/chunk reference key",
    },
    base_ref: {
      type: "string",
      description:
        "Parent document reference (equals reference for non-chunked docs)",
    },
    source: { type: "string", nullable: true },
    link: { type: "string", nullable: true },
    title: { type: "string", nullable: true },
    tags: { type: "array", items: { type: "string" } },
    metadata: {
      type: "object",
      additionalProperties: true,
      description: "Canonical optional fields: project_id, case_id, document_id, document_type, document_date (ISO), version, supersedes, author, recipient, confidentiality, page, section, attachment_of, ocr_quality (0..1). Unknown keys are preserved.",
    },
    chunk: {
      type: "object",
      nullable: true,
      description: "Chunk-technical metadata (chunk_index, chunk_total, chunk_id, char_start/char_end, hierarchy and optional page span)",
    },
    evidence: {
      type: "object",
      nullable: true,
      description: "Citation coordinates for the hit (chunk id, original character/page/section span).",
      additionalProperties: true,
    },
    created: { type: "string", format: "date-time" },
    modified: { type: "string", format: "date-time" },
  },
};

const errorSchema = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" } },
};

// ─── Spec factory ─────────────────────────────────────────────────────────────

export function buildOpenApiSpec(serverUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "vectorsearch",
      version: "1.0.0",
      description:
        "Semantic search service backed by PostgreSQL + pgvector. " +
        "Supports dense, hybrid (dense + PostgreSQL FTS/ts_rank + SPLADE), and FTS-only search " +
        "with optional cross-encoder reranking, HyDE query expansion, " +
        "document versioning, and fine-grained access control.",
      license: { name: "MIT" },
    },
    servers: [{ url: serverUrl }],
    tags: [
      { name: "Search", description: "Query the vector index" },
      { name: "Ingest", description: "Add or update documents" },
      { name: "Delete", description: "Remove documents" },
      {
        name: "Query",
        description:
          "Read-only lookups: list/read documents, folders, and summaries",
      },
      { name: "Admin", description: "Collections, stats, and metrics" },
      { name: "Auth", description: "Session management" },
      {
        name: "MCP",
        description:
          "Model Context Protocol — Streamable HTTP transport for LLM agents",
      },
    ],
    components: {
      securitySchemes: {
        BearerToken: {
          type: "http",
          scheme: "bearer",
          description: "API token set via the API_TOKEN environment variable.",
        },
      },
      schemas: {
        SearchResult: searchResultSchema,
        Error: errorSchema,
      },
    },
    security: [{ BearerToken: [] }],
    paths: {
      // ── Health ─────────────────────────────────────────────────────────────
      "/health": {
        get: {
          tags: ["Admin"],
          operationId: "getHealth",
          summary: "Health check",
          description:
            "Returns 200 when the service and database are reachable. No auth required.",
          security: [],
          responses: {
            "200": {
              description: "Healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string", example: "ok" } },
                  },
                },
              },
            },
            "503": { description: "Database unreachable" },
          },
        },
      },

      // ── Auth ───────────────────────────────────────────────────────────────
      "/login": {
        post: {
          tags: ["Auth"],
          operationId: "login",
          summary: "Exchange API token for a session cookie",
          description:
            "Used by the browser test page. Sends the token in the request body and sets a secure session cookie.",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token"],
                  properties: { token: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": { description: "Authenticated; session cookie set" },
            "401": { description: "Invalid token" },
          },
        },
      },

      // ── Search ─────────────────────────────────────────────────────────────
      "/search": {
        post: {
          tags: ["Search"],
          operationId: "search",
          summary: "Semantic search",
          description:
            "Embeds the request body and queries the vector index. " +
            "Supports dense, hybrid (RRF), and FTS-only modes, optional " +
            "synchronous or async SSE reranking, HyDE query expansion, " +
            "metadata / tag / user-group filtering, and keyset pagination.",
          requestBody: {
            required: true,
            content: {
              "text/plain": {
                schema: {
                  type: "string",
                  example: "How do I reset my password?",
                },
              },
            },
          },
          parameters: [
            {
              name: "X-Collection",
              in: "header",
              description: "Target collection name. Default: `documents`.",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "X-Max-Results",
              in: "header",
              description:
                "Maximum number of results to return (1–100). Default: 10.",
              schema: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                default: 10,
              },
            },
            {
              name: "X-Offset",
              in: "header",
              description:
                "Legacy offset-based pagination. Prefer `X-Cursor` for large datasets.",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
            {
              name: "X-Cursor",
              in: "header",
              description:
                "Opaque keyset cursor returned as `next_cursor` from the previous page.",
              schema: { type: "string" },
            },
            {
              name: "X-Search-Mode",
              in: "header",
              description:
                "Search strategy. `dense` = cosine only, `hybrid` = RRF, `fts` = PostgreSQL FTS/ts_rank only. Overrides `X-Hybrid`.",
              schema: { type: "string", enum: ["dense", "hybrid", "fts"] },
            },
            booleanHeader(
              "X-Hybrid",
              "Enable hybrid search (RRF). Ignored when X-Search-Mode is set.",
            ),
            {
              name: "X-Rerank",
              in: "header",
              description:
                "Reranking mode: falsy = off, truthy = synchronous, `async` = SSE stream.",
              schema: {
                type: "string",
                enum: [
                  "1",
                  "0",
                  "true",
                  "false",
                  "yes",
                  "no",
                  "on",
                  "off",
                  "async",
                ],
              },
            },
            booleanHeader(
              "X-Hyde",
              "Expand the query with a hypothetical document before embedding (requires HYDE_MODEL).",
            ),
            booleanHeader(
              "X-Include-All-Versions",
              "Include superseded document versions in results.",
            ),
            booleanHeader(
              "X-Include-Query-Vector",
              "Return the query embedding vector in the response (adds ~12–64 KB).",
            ),
            {
              name: "X-Filter",
              in: "header",
              description:
                'Additional legacy JSON metadata equality filter merged with any X-Metadata filter. Example: `{"product":"acme"}`.',
              schema: { type: "string" },
            },
            {
              name: "X-Filter-V2",
              in: "header",
              description:
                'Additive canonical metadata filter with eq/in/range operators, e.g. `{"eq":{"case_id":"c-1"},"range":{"document_date":{"gte":"2025-01-01"}}}`.',
              schema: { type: "string" },
            },
            {
              name: "X-Tags",
              in: "header",
              description:
                "Comma-separated list of tags; documents must contain ALL listed tags.",
              schema: { type: "string", example: "public,v2" },
            },
            {
              name: "X-Base-Ref",
              in: "header",
              description:
                "Restrict results to chunks of a specific base document. Returns chunks in order.",
              schema: { type: "string" },
            },
            {
              name: "X-User",
              in: "header",
              description:
                "User ID for access-control filtering (returns docs where allowed_users contains this ID).",
              schema: { type: "string" },
            },
            {
              name: "X-Groups",
              in: "header",
              description:
                "Comma-separated group IDs; returns docs where allowed_groups overlaps.",
              schema: { type: "string" },
            },
            {
              name: "X-Metadata",
              in: "header",
              description:
                "JSON object of metadata key/value pairs used as an equality filter.",
              schema: { type: "string", example: '{"tenant":"acme"}' },
            },
          ],
          responses: {
            "200": {
              description:
                "Search results. When `X-Rerank: async` is used, returns `text/event-stream` " +
                "with `results`, `rerank`, and `done` events.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["results"],
                    properties: {
                      results: {
                        type: "array",
                        items: { $ref: "#/components/schemas/SearchResult" },
                      },
                      next_cursor: {
                        type: "string",
                        description: "Pass as X-Cursor to fetch the next page.",
                      },
                      hyde_query: {
                        type: "string",
                        description:
                          "The HyDE-expanded query text, if HyDE was applied.",
                      },
                      query_vector: {
                        type: "array",
                        items: { type: "number" },
                        description:
                          "Query embedding (opt-in via X-Include-Query-Vector).",
                      },
                    },
                  },
                },
                "text/event-stream": {
                  schema: {
                    type: "string",
                    description:
                      "SSE stream: events `results`, `rerank`, `rerank_error`, `done`.",
                  },
                },
              },
            },
            "400": {
              description: "Bad request (invalid header, empty body)",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "429": { description: "Rate limit exceeded" },
            "502": { description: "Embedding or upstream service error" },
          },
        },
      },

      "/evaluations/retrieval": {
        post: {
          tags: ["Search"],
          operationId: "evaluateRetrieval",
          summary: "Evaluate bounded retrieval qrels",
          description: "Evaluates an in-memory, tenant- and exact body.collection-ACL-scoped golden set with production search defaults; X-Collection is ignored. Supports a version label, deterministic dataset provenance hash and optional release thresholds; no qrels or query text are persisted.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object", required: ["collection", "queries"],
              properties: {
                collection: { type: "string" }, k: { type: "integer", minimum: 1, maximum: 100, default: 10, description: "Legacy compatible primary cutoff" },
                cutoffs: { type: "array", items: { type: "integer", minimum: 1, maximum: 100 }, default: [10, 20, 50], description: "Metrics cutoffs; retrieval runs once to the maximum" },
                dataset_version: { type: "string", maxLength: 128 },
                hybrid: { type: "boolean" }, include_all_versions: { type: "boolean", default: false },
                candidate_multiplier: { type: "integer", minimum: 1, maximum: 20 },
                deadline_ms: { type: "integer", minimum: 1, maximum: 300000, default: 60000 },
                concurrency: { type: "integer", minimum: 1, maximum: 8, default: 4 },
                baseline: { type: "object", minProperties: 1, additionalProperties: false, properties: { min_recall_at_k: { type: "number", minimum: 0, maximum: 1 }, min_mrr: { type: "number", minimum: 0, maximum: 1 }, min_ndcg_at_k: { type: "number", minimum: 0, maximum: 1 } } },
                queries: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["id", "query", "qrels"], properties: { id: { type: "string", maxLength: 256 }, query: { type: "string", maxLength: 8192 }, qrels: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", required: ["reference"], properties: { reference: { type: "string", maxLength: 2048 }, relevance: { type: "number", minimum: 0 } } } } } } },
              },
            } } },
          },
          responses: {
            "200": {
              description: "Metrics, effective retrieval parameters, deterministic dataset provenance hash and optional release-gate result",
              content: { "application/json": { schema: {
                type: "object", required: ["status", "collection", "parameters", "dataset", "metrics"],
                properties: {
                  status: { type: "string", enum: ["ok"] },
                  collection: { type: "string" },
                  parameters: { type: "object", required: ["k", "hybrid", "include_all_versions", "candidate_multiplier"], properties: { k: { type: "integer" }, hybrid: { type: "boolean" }, include_all_versions: { type: "boolean" }, candidate_multiplier: { type: "integer" } } },
                  dataset: { type: "object", description: "Client version label plus server-computed SHA-256 over the canonical bounded qrels input", required: ["version", "hash"], properties: { version: { type: ["string", "null"] }, hash: { type: "string", pattern: "^[a-f0-9]{64}$" } } },
                  metrics: { type: "object", required: ["recall_at_k", "mrr", "ndcg_at_k", "evaluated_queries", "skipped_queries"] },
                  release_gate: { type: "object", properties: { passed: { type: "boolean" }, thresholds: { type: "object" } } },
                },
              } } },
            },
            "400": { description: "Invalid or oversized evaluation" },
            "403": { description: "Tenant, scope or exact body collection denied" },
            "408": { description: "Evaluation deadline exceeded" },
            "502": { description: "Embedding or retrieval failure" },
          },
        },
      },

      // ── Ingest ─────────────────────────────────────────────────────────────
      "/ingest": {
        post: {
          tags: ["Ingest"],
          operationId: "ingest",
          summary: "Ingest a single document",
          description:
            "Embeds and stores a single document or, when chunking is configured, " +
            "splits it into chunks first. Supports versioning, sparse vectors, " +
            "semantic chunking, late chunking, and LLM-based summarization.",
          requestBody: {
            required: true,
            content: {
              "text/plain": { schema: { type: "string" } },
              "text/markdown": { schema: { type: "string" } },
            },
          },
          parameters: [
            {
              name: "X-Reference",
              in: "header",
              required: true,
              description: "Unique document identifier.",
              schema: { type: "string" },
            },
            {
              name: "X-Collection",
              in: "header",
              description: "Target collection. Default: `documents`.",
              schema: { type: "string" },
            },
            {
              name: "X-Title",
              in: "header",
              description: "Human-readable document title.",
              schema: { type: "string" },
            },
            {
              name: "X-Source",
              in: "header",
              description: "Source system identifier.",
              schema: { type: "string" },
            },
            {
              name: "X-Link",
              in: "header",
              description: "URL linking back to the original document.",
              schema: { type: "string" },
            },
            {
              name: "X-Tags",
              in: "header",
              description: "Comma-separated tag list.",
              schema: { type: "string" },
            },
            {
              name: "X-Version",
              in: "header",
              description:
                "Explicit version tag. When set, uses versioning mode.",
              schema: { type: "string" },
            },
            {
              name: "X-Version-Mode",
              in: "header",
              description:
                "`replace` (default) overwrites; `version` preserves history.",
              schema: { type: "string", enum: ["replace", "version"] },
            },
            {
              name: "X-Chunk-Size",
              in: "header",
              description: "Override server-default chunk size (characters).",
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "X-Chunk-Overlap",
              in: "header",
              description:
                "Override server-default chunk overlap (characters).",
              schema: { type: "integer", minimum: 0 },
            },
            {
              name: "X-FTS-Language",
              in: "header",
              description:
                "PostgreSQL FTS language (e.g. `english`, `german`, `simple`).",
              schema: { type: "string" },
            },
            {
              name: "X-Quantization",
              in: "header",
              description: "Binary quantization for this collection.",
              schema: { type: "string", enum: ["none", "binary"] },
            },
            booleanHeader(
              "X-Semantic-Chunking",
              "Use embedding-based sentence splitting instead of character-boundary chunking.",
            ),
            {
              name: "X-Breakpoint-Percentile",
              in: "header",
              description:
                "Breakpoint percentile for semantic chunking (1–99). Default: 75.",
              schema: { type: "integer", minimum: 1, maximum: 99 },
            },
            {
              name: "X-Late-Chunking-Alpha",
              in: "header",
              description:
                "Blend factor (0–1) for late chunking: final = alpha*chunk + (1-alpha)*doc.",
              schema: { type: "number", minimum: 0, maximum: 1 },
            },
            {
              name: "X-Context-Prefix-Size",
              in: "header",
              description:
                "Characters from document start prepended to each non-first chunk's embed input.",
              schema: { type: "integer", minimum: 1 },
            },
            booleanHeader(
              "X-Summarize",
              "Generate an LLM summary for the context prefix (requires SUMMARY_MODEL).",
            ),
            {
              name: "X-Allowed-Users",
              in: "header",
              description:
                "Comma-separated user IDs that may read this document.",
              schema: { type: "string" },
            },
            {
              name: "X-Allowed-Groups",
              in: "header",
              description:
                "Comma-separated group IDs that may read this document.",
              schema: { type: "string" },
            },
            {
              name: "X-Metadata",
              in: "header",
              description: "JSON metadata object to attach to the document.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Document stored",
              content: {
                "application/json": {
                  schema: {
                    oneOf: [
                      {
                        type: "object",
                        required: ["status", "id"],
                        properties: {
                          status: { type: "string" },
                          id: { type: "string" },
                        },
                      },
                      {
                        type: "object",
                        required: ["status", "ids", "chunks"],
                        properties: {
                          status: { type: "string" },
                          ids: { type: "array", items: { type: "string" } },
                          chunks: { type: "integer" },
                        },
                      },
                    ],
                  },
                },
              },
            },
            "400": {
              description: "Validation error",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Error" },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "429": { description: "Rate limit exceeded" },
            "502": { description: "Embedding or database error" },
          },
        },
      },

      "/ingest-batch": {
        post: {
          tags: ["Ingest"],
          operationId: "ingestBatch",
          summary: "Ingest a batch of documents (JSON array)",
          description:
            "Accepts a JSON array of document objects. Embeddings are computed in a single " +
            "batch call. Each document may override chunking options via per-document fields.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["reference", "content"],
                    properties: {
                      reference: { type: "string" },
                      content: { type: "string" },
                      title: { type: "string" },
                      source: { type: "string" },
                      link: { type: "string" },
                      tags: { type: "array", items: { type: "string" } },
                      metadata: { type: "object" },
                      version: { type: "string" },
                      allowed_users: {
                        type: "array",
                        items: { type: "string" },
                      },
                      allowed_groups: {
                        type: "array",
                        items: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          parameters: [
            { name: "X-Collection", in: "header", schema: { type: "string" } },
            {
              name: "X-Version-Mode",
              in: "header",
              schema: { type: "string", enum: ["replace", "version"] },
            },
            { name: "X-Chunk-Size", in: "header", schema: { type: "integer" } },
            {
              name: "X-Chunk-Overlap",
              in: "header",
              schema: { type: "integer" },
            },
            {
              name: "X-FTS-Language",
              in: "header",
              schema: { type: "string" },
            },
            booleanHeader(
              "X-Semantic-Chunking",
              "Use semantic chunking for all documents in the batch.",
            ),
          ],
          responses: {
            "200": {
              description: "Batch stored",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      ids: { type: "array", items: { type: "string" } },
                      chunks: { type: "integer" },
                    },
                  },
                },
              },
            },
            "400": { description: "Validation error" },
            "401": { description: "Unauthorized" },
            "502": { description: "Embedding or database error" },
          },
        },
      },

      "/ingest-stream": {
        post: {
          tags: ["Ingest"],
          operationId: "ingestStream",
          summary: "Bulk ingest via NDJSON stream",
          description:
            "Accepts a newline-delimited JSON (NDJSON) body where each line is a document object " +
            "(same shape as the ingest-batch array items). Designed for large bulk imports up to " +
            "the `STREAM_BODY_LIMIT` (default 50 MB). Documents are processed and embedded in batches.",
          requestBody: {
            required: true,
            content: {
              "application/x-ndjson": {
                schema: {
                  type: "string",
                  description: "One JSON document object per line.",
                },
              },
            },
          },
          parameters: [
            { name: "X-Collection", in: "header", schema: { type: "string" } },
            {
              name: "X-Version-Mode",
              in: "header",
              schema: { type: "string", enum: ["replace", "version"] },
            },
          ],
          responses: {
            "200": {
              description: "Stream processed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      processed: { type: "integer" },
                      chunks: { type: "integer" },
                    },
                  },
                },
              },
            },
            "400": { description: "Parse error" },
            "401": { description: "Unauthorized" },
            "502": { description: "Embedding or database error" },
          },
        },
      },

      // ── Delete ─────────────────────────────────────────────────────────────
      "/delete": {
        delete: {
          tags: ["Delete"],
          operationId: "deleteDocuments",
          summary: "Delete documents by reference or metadata filter",
          description:
            "Deletes all chunks belonging to the given reference (including all versions), " +
            "or all documents matching the metadata filter when no reference is supplied.",
          parameters: [
            { name: "X-Collection", in: "header", schema: { type: "string" } },
            {
              name: "X-Reference",
              in: "header",
              description:
                "Delete by exact reference (and all its chunks/versions).",
              schema: { type: "string" },
            },
            {
              name: "X-Metadata",
              in: "header",
              description:
                "JSON metadata filter — delete all matching documents.",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Deleted",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { deleted: { type: "integer" } },
                  },
                },
              },
            },
            "400": {
              description: "Neither X-Reference nor X-Metadata supplied",
            },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      // ── Query (read-only) ────────────────────────────────────────────────
      "/documents": {
        get: {
          tags: ["Query"],
          operationId: "listDocuments",
          summary: "List documents (one entry per document)",
          description:
            "Lists the documents in a collection (grouped by base_ref), newest first, " +
            "optionally restricted to a folder path prefix. Paginated.",
          parameters: [
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "path_prefix",
              in: "query",
              description: 'Restrict to documents beneath this folder, e.g. "/Unterlagen Teil 1".',
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
          ],
          responses: {
            "200": { description: "Document list" },
            "400": { description: "Invalid parameter" },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      "/document": {
        get: {
          tags: ["Query"],
          operationId: "getDocument",
          summary: "Fetch a document reassembled from its chunks",
          description:
            "Returns a whole document (chunks joined in order, overlaps trimmed). " +
            "Large documents are windowed via max_chars/offset — check the `truncated` flag.",
          parameters: [
            {
              name: "reference",
              in: "query",
              required: true,
              description: "Document reference/path (base_ref) or any chunk reference.",
              schema: { type: "string" },
            },
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "max_chars",
              in: "query",
              schema: { type: "integer", minimum: 1000, maximum: 2000000, default: 200000 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
          ],
          responses: {
            "200": { description: "Document content" },
            "400": { description: "Missing reference" },
            "401": { description: "Unauthorized" },
            "404": { description: "Document not found" },
            "502": { description: "Database error" },
          },
        },
      },

      "/documents/content": {
        get: {
          tags: ["Query"],
          operationId: "getDocuments",
          summary: "Reassemble every document beneath a folder",
          description:
            "Reads a whole folder in one call, each document reassembled from its chunks. " +
            "Bounded by limit and max_chars; check the `truncated` flag.",
          parameters: [
            {
              name: "path_prefix",
              in: "query",
              description: 'Folder whose documents to read, e.g. "/Unterlagen Teil 1".',
              schema: { type: "string" },
            },
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 20 },
            },
            {
              name: "max_chars",
              in: "query",
              schema: { type: "integer", minimum: 1000, maximum: 2000000, default: 200000 },
            },
          ],
          responses: {
            "200": { description: "Reassembled documents" },
            "400": { description: "Invalid parameter" },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      "/folders": {
        get: {
          tags: ["Query"],
          operationId: "listFolders",
          summary: "List sub-folders beneath a folder path",
          description:
            "Derives the folder structure from document reference paths, each folder with a " +
            "recursive document count, plus how many documents lie directly at the prefix.",
          parameters: [
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "path_prefix",
              in: "query",
              description: 'Folder to list, e.g. "/Unterlagen Teil 1". Omit or "/" for the top level.',
              schema: { type: "string" },
            },
            {
              name: "depth",
              in: "query",
              description:
                "Folder levels below the prefix: 1 (default) = immediate children; n>1 = up to n levels; 0/negative = whole sub-tree.",
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": { description: "Folder list" },
            "400": { description: "Invalid parameter" },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      "/summary": {
        get: {
          tags: ["Query"],
          operationId: "getSummary",
          summary: "Fetch the stored summary of one document",
          description:
            "Returns the document's stored summary/prefix (generated at ingest time). " +
            "Cheaper than /document when you only need the gist.",
          parameters: [
            {
              name: "reference",
              in: "query",
              required: true,
              description: "Document reference/path (base_ref) or any chunk reference.",
              schema: { type: "string" },
            },
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
          ],
          responses: {
            "200": { description: "Summary" },
            "400": { description: "Missing reference" },
            "401": { description: "Unauthorized" },
            "404": { description: "Document not found" },
            "502": { description: "Database error" },
          },
        },
      },

      "/summaries": {
        get: {
          tags: ["Query"],
          operationId: "getSummaries",
          summary: "List stored summaries (one per document)",
          description:
            "The cheap overview of a whole collection/folder — one summary per document, " +
            "optionally restricted to a folder path prefix. Paginated.",
          parameters: [
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "path_prefix",
              in: "query",
              schema: { type: "string" },
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
            },
            {
              name: "offset",
              in: "query",
              schema: { type: "integer", minimum: 0, default: 0 },
            },
          ],
          responses: {
            "200": { description: "Summary list" },
            "400": { description: "Invalid parameter" },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      "/collection-stats": {
        get: {
          tags: ["Query"],
          operationId: "getCollectionStats",
          summary: "Count documents and chunks in a collection",
          description:
            "Aggregate document/chunk counts, optionally scoped to a folder path prefix. " +
            "Answers 'how many documents are in the collection / in this folder'.",
          parameters: [
            {
              name: "collection",
              in: "query",
              schema: { type: "string", default: "documents" },
            },
            {
              name: "path_prefix",
              in: "query",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Stats" },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      // ── Collections ────────────────────────────────────────────────────────
      "/collections": {
        get: {
          tags: ["Admin"],
          operationId: "listCollections",
          summary: "List all collections with metadata",
          responses: {
            "200": {
              description: "Collection list",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        collection: { type: "string" },
                        table: { type: "string" },
                        ftsLanguage: { type: "string" },
                        sparseEnabled: { type: "boolean" },
                        quantization: {
                          type: "string",
                          enum: ["none", "binary"],
                        },
                        vectorSize: { type: "integer", nullable: true },
                        totalDocs: { type: "integer" },
                        totalChunks: { type: "integer" },
                        created: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
          },
        },
      },

      "/collections/{name}": {
        delete: {
          tags: ["Admin"],
          operationId: "deleteCollection",
          summary: "Drop a collection and all its data",
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Dropped",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { dropped: { type: "boolean" } },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
            "502": { description: "Database error" },
          },
        },
      },

      "/collections/{name}/rename": {
        post: {
          tags: ["Admin"],
          operationId: "renameCollection",
          summary: "Rename a collection",
          description:
            "Renames the collection table and updates all associated indexes " +
            "and the collection config row in a single transaction. " +
            "Returns 404 when the source collection does not exist.",
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              description: "Current collection name",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["new_name"],
                  properties: {
                    new_name: {
                      type: "string",
                      description:
                        "New collection name (must be a valid identifier)",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Renamed",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      from: { type: "string" },
                      to: { type: "string" },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid name or same name supplied" },
            "401": { description: "Unauthorized" },
            "404": { description: "Source collection not found" },
            "502": { description: "Database error" },
          },
        },
      },

      // ── Admin stats ────────────────────────────────────────────────────────
      "/admin/stats": {
        get: {
          tags: ["Admin"],
          operationId: "getStats",
          summary: "Recent ingest and search statistics",
          parameters: [
            { name: "collection", in: "query", schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", default: 100 },
            },
          ],
          responses: {
            "200": {
              description: "Stats",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ingest: { type: "array", items: { type: "object" } },
                      search: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized" },
          },
        },
      },

      // ── Metrics ────────────────────────────────────────────────────────────
      "/metrics": {
        get: {
          tags: ["Admin"],
          operationId: "getMetrics",
          summary: "Prometheus-compatible metrics",
          description:
            "Returns low-cardinality HTTP counters, in-flight gauge, request-duration histogram, ingest/search counters and runtime metrics in Prometheus text format. Requires `vectorsearch.metrics` when authorization enforcement is enabled.",
          responses: {
            "200": {
              description: "Metrics",
              content: { "text/plain": { schema: { type: "string" } } },
            },
            "401": { description: "Unauthorized" },
          },
        },
      },

      // ── MCP ────────────────────────────────────────────────────────────────
      "/mcp": {
        post: {
          tags: ["MCP"],
          operationId: "mcpPost",
          summary: "MCP Streamable HTTP — initialize or send a tool call",
          description:
            "Model Context Protocol Streamable HTTP transport (spec 2025-03-26). " +
            "A POST without `Mcp-Session-Id` initializes a new session and returns the session ID. " +
            "Subsequent POSTs with `Mcp-Session-Id` execute tool calls. " +
            "Available tools: `search`, `ingest`, `delete_document`, `list_collections`, " +
            "`collection_stats`, `list_documents`, `list_folders`, `get_document`, " +
            "`get_documents`, `get_summary`, `get_summaries`.",
          parameters: [
            {
              name: "Mcp-Session-Id",
              in: "header",
              description:
                "Session ID returned during initialization. Omit for the first (init) request.",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description:
                    "JSON-RPC 2.0 message (initialize, tools/call, etc.)",
                },
              },
            },
          },
          responses: {
            "200": { description: "JSON-RPC response or SSE stream" },
            "400": { description: "Bad request" },
            "401": { description: "Unauthorized" },
            "404": { description: "Session not found" },
          },
        },
        get: {
          tags: ["MCP"],
          operationId: "mcpGet",
          summary: "MCP Streamable HTTP — open SSE notification stream",
          description:
            "Opens a persistent SSE stream for server-to-client notifications. Requires an active session ID.",
          parameters: [
            {
              name: "Mcp-Session-Id",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "SSE stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "400": { description: "Missing session ID" },
            "401": { description: "Unauthorized" },
            "404": { description: "Session not found" },
          },
        },
        delete: {
          tags: ["MCP"],
          operationId: "mcpDelete",
          summary: "MCP Streamable HTTP — terminate session",
          parameters: [
            {
              name: "Mcp-Session-Id",
              in: "header",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": { description: "Session terminated" },
            "400": { description: "Missing session ID" },
            "401": { description: "Unauthorized" },
            "404": { description: "Session not found" },
          },
        },
      },

      "/mcp/v2026": {
        post: {
          tags: ["MCP"],
          operationId: "mcp2026Post",
          summary: "Stateless MCP 2026 tool discovery and invocation",
          description: "MCP 2026-07-28 stateless HTTP transport. All requests require Bearer authentication, MCP-Protocol-Version, a matching body protocol-version meta field and Mcp-Method; tools/call additionally requires Mcp-Name. Transaction tokens may be supplied in X-Transaction-Token or params._meta[transaction/token]. Errors are JSON-RPC errors: HeaderMismatch (-32020), UnsupportedProtocolVersion (-32022), transaction failures (-32001), access denied (-32003), deadline exceeded (-32008), invalid arguments (-32602), unknown tool (-32601), internal error (-32603).",
          parameters: [
            { name: "MCP-Protocol-Version", in: "header", required: true, schema: { type: "string", const: "2026-07-28" } },
            { name: "Mcp-Method", in: "header", required: true, schema: { type: "string", enum: ["server/discover", "tools/list", "tools/call"] } },
            { name: "Mcp-Name", in: "header", description: "Required for tools/call and equal to params.name.", schema: { type: "string" } },
            { name: "X-Transaction-Token", in: "header", description: "Optional for discovery; required for protected calls when transaction enforcement is required.", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "method", "_meta"],
                  properties: {
                    jsonrpc: { const: "2.0" },
                    id: {},
                    method: { type: "string" },
                    params: { type: "object" },
                    _meta: {
                      type: "object",
                      required: ["io.modelcontextprotocol/protocolVersion"],
                      properties: { "io.modelcontextprotocol/protocolVersion": { const: "2026-07-28" } },
                    },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "JSON-RPC complete result" }, "400": { description: "Header, protocol, validation or transaction request failure" }, "401": { description: "Authentication failure" }, "403": { description: "Authorization failure" }, "408": { description: "Deadline exceeded" }, "404": { description: "Tool not found" }, "500": { description: "Internal JSON-RPC failure" } },
        },
        get: { tags: ["MCP"], operationId: "mcp2026Get", summary: "Not supported by stateless MCP", responses: { "405": { description: "Method not allowed" } } },
        delete: { tags: ["MCP"], operationId: "mcp2026Delete", summary: "Not supported by stateless MCP", responses: { "405": { description: "Method not allowed" } } },
      },
    }, // end paths
  };
}

// ─── YAML serialiser (zero-dependency) ───────────────────────────────────────
//
// A minimal recursive serialiser that covers all value types used in the spec
// above (string, number, boolean, null, array, object).  Not a general-purpose
// YAML library — just enough for a machine-readable spec.

function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null || value === undefined) return "null\n";

  if (typeof value === "boolean") return `${value}\n`;
  if (typeof value === "number") return `${value}\n`;

  if (typeof value === "string") {
    // Multi-line strings use block scalar; simple strings are quoted when
    // they contain characters that would confuse a YAML parser.
    if (value.includes("\n")) {
      const lines = value.replace(/\n$/, "").split("\n");
      return "|\n" + lines.map((l) => `${pad}  ${l}\n`).join("");
    }
    if (/[:#\[\]{},&*?|<>=!%@`"']/.test(value) || value.trim() !== value) {
      return JSON.stringify(value) + "\n";
    }
    return `${value}\n`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]\n";
    return value
      .map((item) => `${pad}- ${toYaml(item, indent + 1).trimStart()}`)
      .join("");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}\n";
    return entries
      .map(([k, v]) => {
        const keyStr = /[:#\[\]{},&*?|<>=!%@`"' ]/.test(k)
          ? JSON.stringify(k)
          : k;
        const rendered = toYaml(v, indent + 1);
        if (rendered.startsWith("\n") || rendered.includes("\n  ")) {
          return `${pad}${keyStr}:\n${pad}  ${rendered.trimStart()}`;
        }
        const inlined = rendered.trimEnd();
        return `${pad}${keyStr}: ${inlined}\n`;
      })
      .join("");
  }

  return String(value) + "\n";
}

export function buildOpenApiYaml(serverUrl: string): string {
  const spec = buildOpenApiSpec(serverUrl);
  return "---\n" + toYaml(spec);
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Vector store for RAG retrieval (`src/graph/vector-store.ts`)
 *
 * A persistent, queryable index of embedded text chunks ("documents") grouped
 * into named collections. Powers the `retrieval` flow node and the `/v1/rag`
 * ingestion API, and feeds retrieved context into the groundedness gate.
 *
 * Two backends behind one {@link VectorStore} contract:
 *   - {@link InMemoryRagStore}: per-replica, bounded, cosine linear scan — the
 *     zero-dependency default and the unit-test target (pure logic).
 *   - {@link PgVectorStore}: durable, cross-replica Postgres storage. It uses
 *     the `pgvector` extension when available (native `<=>` cosine distance),
 *     and transparently FALLS BACK to a JSONB column with app-side cosine
 *     scoring when the extension is not installed — so enabling RAG never
 *     requires a database superuser to have pre-installed pgvector, and never
 *     touches the always-run migration set.
 *
 * Schema for the Postgres backend is provisioned lazily on first use (guarded,
 * idempotent), NOT via the global migrator — so a deployment that does not use
 * RAG pays nothing and a missing `pgvector` extension can never break startup.
 *
 * No `any` at module boundaries.
 */

import { cosineSimilarity } from "./semantic-cache.js";
import type { Database } from "../db/database.js";
import { safeSqlIdentifier } from "../db/sql-identifier.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A document to index: stable id, its text, the precomputed embedding, meta. */
export interface RagDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

/** A retrieval hit: the document plus its cosine similarity to the query. */
export interface RetrievedChunk {
  id: string;
  text: string;
  /** Cosine similarity to the query embedding, in [-1, 1] (typically [0,1]). */
  score: number;
  /**
   * Scale of `score` when the backend is not plain cosine (e.g. a search
   * service exposing its `score_scale`). Absent means cosine.
   */
  scoreScale?: "cosine" | "rerank" | "rrf" | "fts";
  metadata?: Record<string, unknown>;
}

/** A document listing row — no embedding/score, just enough for a management UI. */
export interface RagDocumentSummary {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  /** Inserts or replaces documents in a collection (by id). */
  upsert(collection: string, docs: RagDocument[]): Promise<void>;
  /** Returns the top-`topK` most similar chunks (>= `minScore` when given). */
  query(
    collection: string,
    embedding: number[],
    topK: number,
    minScore?: number,
  ): Promise<RetrievedChunk[]>;
  /** Removes specific documents; returns the number removed. */
  deleteDocuments(collection: string, ids: string[]): Promise<number>;
  /** Drops an entire collection; returns the number of documents removed. */
  deleteCollection(collection: string): Promise<number>;
  /** Number of documents in a collection. */
  count(collection: string): Promise<number>;
  /** Names of all non-empty collections. */
  listCollections(): Promise<string[]>;
  /** Lists documents in a collection (no similarity ranking) — for management UIs. */
  listDocuments(
    collection: string,
    limit?: number,
  ): Promise<RagDocumentSummary[]>;
  /**
   * Deletes every document whose collection starts with `collectionPrefix` and
   * whose metadata contains all `match` key/value pairs (string equality).
   * Returns the number of deleted documents. Optional: a store without it
   * cannot delete across collections.
   */
  deleteByMetadata?(
    collectionPrefix: string,
    match: Record<string, string>,
  ): Promise<number>;
  /**
   * Deletes every document whose collection starts with `collectionPrefix` and
   * whose metadata has no `key`. Returns the number of deleted documents.
   */
  deleteWithoutMetadataKey?(
    collectionPrefix: string,
    key: string,
  ): Promise<number>;
}

/** Escapes `%`, `_` and `\` so a string matches literally in a `LIKE ... ESCAPE '\'` pattern. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------------------
// Pure ranking helper (shared by both backends' app-side path)
// ---------------------------------------------------------------------------

/**
 * Ranks `docs` by cosine similarity to `queryEmbedding`, returning the top-`topK`
 * at/above `minScore`, highest first. Pure — exported for unit testing.
 */
export function rankByCosine(
  docs: readonly RagDocument[],
  queryEmbedding: number[],
  topK: number,
  minScore = -Infinity,
): RetrievedChunk[] {
  const scored: RetrievedChunk[] = [];
  for (const d of docs) {
    const score = cosineSimilarity(queryEmbedding, d.embedding);
    if (score < minScore) continue;
    scored.push({
      id: d.id,
      text: d.text,
      score: Math.round(score * 1_000_000) / 1_000_000,
      ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, topK));
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

/**
 * Per-replica in-memory vector store. A bounded total document count evicts the
 * oldest-inserted document when exceeded, so memory stays capped. Suitable for
 * small/medium corpora and tests; use {@link PgVectorStore} for durability and
 * cross-replica sharing.
 */
export class InMemoryRagStore implements VectorStore {
  private readonly collections = new Map<string, Map<string, RagDocument>>();
  private readonly insertOrder: Array<{ collection: string; id: string }> = [];

  constructor(private readonly maxDocuments = 10_000) {
    this.maxDocuments = Math.max(1, maxDocuments);
  }

  async upsert(collection: string, docs: RagDocument[]): Promise<void> {
    let bucket = this.collections.get(collection);
    if (bucket === undefined) {
      bucket = new Map<string, RagDocument>();
      this.collections.set(collection, bucket);
    }
    for (const doc of docs) {
      if (!bucket.has(doc.id)) {
        this.insertOrder.push({ collection, id: doc.id });
      }
      bucket.set(doc.id, doc);
    }
    this.evictIfNeeded();
  }

  async query(
    collection: string,
    embedding: number[],
    topK: number,
    minScore?: number,
  ): Promise<RetrievedChunk[]> {
    const bucket = this.collections.get(collection);
    if (bucket === undefined) return [];
    return rankByCosine(
      [...bucket.values()],
      embedding,
      topK,
      minScore ?? -Infinity,
    );
  }

  async deleteDocuments(collection: string, ids: string[]): Promise<number> {
    const bucket = this.collections.get(collection);
    if (bucket === undefined) return 0;
    let removed = 0;
    for (const id of ids) {
      if (bucket.delete(id)) removed++;
    }
    if (bucket.size === 0) this.collections.delete(collection);
    return removed;
  }

  async deleteCollection(collection: string): Promise<number> {
    const bucket = this.collections.get(collection);
    if (bucket === undefined) return 0;
    const n = bucket.size;
    this.collections.delete(collection);
    return n;
  }

  async count(collection: string): Promise<number> {
    return this.collections.get(collection)?.size ?? 0;
  }

  async listCollections(): Promise<string[]> {
    return [...this.collections.keys()].filter(
      (c) => (this.collections.get(c)?.size ?? 0) > 0,
    );
  }

  async listDocuments(
    collection: string,
    limit = 100,
  ): Promise<RagDocumentSummary[]> {
    const bucket = this.collections.get(collection);
    if (bucket === undefined) return [];
    const out: RagDocumentSummary[] = [];
    for (const doc of bucket.values()) {
      out.push({
        id: doc.id,
        text: doc.text,
        ...(doc.metadata !== undefined ? { metadata: doc.metadata } : {}),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async deleteByMetadata(
    collectionPrefix: string,
    match: Record<string, string>,
  ): Promise<number> {
    const entries = Object.entries(match);
    return this.deleteWhere(
      collectionPrefix,
      (doc) => entries.every(([k, v]) => doc.metadata?.[k] === v),
    );
  }

  async deleteWithoutMetadataKey(
    collectionPrefix: string,
    key: string,
  ): Promise<number> {
    return this.deleteWhere(
      collectionPrefix,
      (doc) => doc.metadata?.[key] === undefined,
    );
  }

  private deleteWhere(
    collectionPrefix: string,
    predicate: (doc: RagDocument) => boolean,
  ): number {
    let removed = 0;
    for (const [name, bucket] of [...this.collections]) {
      if (!name.startsWith(collectionPrefix)) continue;
      for (const [id, doc] of [...bucket]) {
        if (predicate(doc) && bucket.delete(id)) removed++;
      }
      if (bucket.size === 0) this.collections.delete(name);
    }
    return removed;
  }

  private evictIfNeeded(): void {
    let total = 0;
    for (const b of this.collections.values()) total += b.size;
    while (total > this.maxDocuments && this.insertOrder.length > 0) {
      const oldest = this.insertOrder.shift();
      if (oldest === undefined) break;
      const bucket = this.collections.get(oldest.collection);
      if (bucket?.delete(oldest.id)) {
        total--;
        if (bucket.size === 0) this.collections.delete(oldest.collection);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Postgres backend (pgvector with JSONB fallback)
// ---------------------------------------------------------------------------

interface DocRow {
  id: string;
  content: string;
  metadata: unknown;
  score?: number | string | null;
  embedding?: unknown;
}

/** Formats a JS number[] as a pgvector literal: `[0.1,0.2,…]`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function parseMetadata(v: unknown): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

function parseEmbedding(v: unknown): number[] {
  if (Array.isArray(v))
    return v.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (typeof v === "string") {
    // pgvector returns "[1,2,3]"; JSON arrays parse the same way.
    try {
      const arr = JSON.parse(v) as unknown[];
      return Array.isArray(arr) ? arr.map((x) => Number(x)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Postgres-backed store. Provisions its schema lazily on first use and detects
 * whether the `pgvector` extension is available, choosing the native cosine
 * operator path or the JSONB + app-side scoring fallback accordingly.
 */
export class PgVectorStore implements VectorStore {
  private ready: Promise<void> | undefined;
  private usePgvector = false;
  private readonly table: string;

  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
    tableName = "rag_documents",
  ) {
    // Defensive: the table name is an internal constant, never user input, but
    // validate it anyway since it is interpolated into DDL/queries. The check
    // goes through the central identifier whitelist (Req 7.10).
    this.table = safeSqlIdentifier(tableName, "vector store table name");
  }

  /** Idempotent, single-flight schema provisioning + capability detection. */
  private ensureReady(): Promise<void> {
    if (this.ready === undefined) this.ready = this.provision();
    return this.ready;
  }

  private async provision(): Promise<void> {
    // Try to enable pgvector. CREATE EXTENSION fails when the extension is not
    // installed on the server OR the role lacks privilege — either way we fall
    // back to the JSONB path rather than failing.
    try {
      await this.db.query("CREATE EXTENSION IF NOT EXISTS vector");
      this.usePgvector = true;
    } catch {
      this.usePgvector = false;
      this.logger?.warn(
        "pgvector extension unavailable — RAG store falls back to JSONB embeddings with app-side cosine scoring",
      );
    }

    const embeddingCol = this.usePgvector ? "vector" : "JSONB";
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         collection TEXT NOT NULL,
         id         TEXT NOT NULL,
         content    TEXT NOT NULL,
         embedding  ${embeddingCol} NOT NULL,
         metadata   JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (collection, id)
       )`,
    );
    await this.db.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_collection_idx
         ON ${this.table} (collection)`,
    );
    this.logger?.info("RAG vector store ready", {
      backend: this.usePgvector ? "pgvector" : "jsonb-fallback",
      table: this.table,
    });
  }

  async upsert(collection: string, docs: RagDocument[]): Promise<void> {
    await this.ensureReady();
    for (const doc of docs) {
      // The metadata goes through `::text::jsonb`: Bun's driver encodes a string
      // bound to a `::jsonb` parameter as a JSON *string* value, which `@>` and
      // `?` can neither match nor look into.
      const embeddingParam = this.usePgvector
        ? toVectorLiteral(doc.embedding)
        : JSON.stringify(doc.embedding);
      const cast = this.usePgvector ? "::vector" : "::jsonb";
      await this.db.query(
        `INSERT INTO ${this.table} (collection, id, content, embedding, metadata)
         VALUES ($1, $2, $3, $4${cast}, $5::text::jsonb)
         ON CONFLICT (collection, id) DO UPDATE
           SET content = EXCLUDED.content,
               embedding = EXCLUDED.embedding,
               metadata = EXCLUDED.metadata`,
        [
          collection,
          doc.id,
          doc.text,
          embeddingParam,
          doc.metadata !== undefined ? JSON.stringify(doc.metadata) : null,
        ],
      );
    }
  }

  async query(
    collection: string,
    embedding: number[],
    topK: number,
    minScore?: number,
  ): Promise<RetrievedChunk[]> {
    await this.ensureReady();
    const k = Math.max(1, topK);

    if (this.usePgvector) {
      // Native cosine distance ordering; similarity = 1 - distance.
      const rows = await this.db.query<DocRow>(
        `SELECT id, content, metadata,
                1 - (embedding <=> $1::vector) AS score
           FROM ${this.table}
          WHERE collection = $2
          ORDER BY embedding <=> $1::vector
          LIMIT $3`,
        [toVectorLiteral(embedding), collection, k],
      );
      const chunks = rows.map((r) => {
        const metadata = parseMetadata(r.metadata);
        return {
          id: r.id,
          text: r.content,
          score: Math.round(toNumber(r.score) * 1_000_000) / 1_000_000,
          ...(metadata !== undefined ? { metadata } : {}),
        };
      });
      return minScore !== undefined
        ? chunks.filter((c) => c.score >= minScore)
        : chunks;
    }

    // Fallback: fetch the collection's rows and score in app.
    const rows = await this.db.query<DocRow>(
      `SELECT id, content, metadata, embedding
         FROM ${this.table}
        WHERE collection = $1`,
      [collection],
    );
    if (rows.length > 1000) {
      this.logger?.warn(
        `Performance warning: collection '${collection}' has ${rows.length} documents. ` +
          `Using in-app cosine scoring fallback which might degrade query performance. Please install pgvector.`,
      );
    }
    const docs: RagDocument[] = rows.map((r) => {
      const metadata = parseMetadata(r.metadata);
      return {
        id: r.id,
        text: r.content,
        embedding: parseEmbedding(r.embedding),
        ...(metadata !== undefined ? { metadata } : {}),
      };
    });
    return rankByCosine(docs, embedding, k, minScore ?? -Infinity);
  }

  async deleteDocuments(collection: string, ids: string[]): Promise<number> {
    await this.ensureReady();
    if (ids.length === 0) return 0;
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM ${this.table}
        WHERE collection = $1 AND id = ANY($2)
        RETURNING id`,
      [collection, ids],
    );
    return rows.length;
  }

  async deleteCollection(collection: string): Promise<number> {
    await this.ensureReady();
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM ${this.table} WHERE collection = $1 RETURNING id`,
      [collection],
    );
    return rows.length;
  }

  async deleteByMetadata(
    collectionPrefix: string,
    match: Record<string, string>,
  ): Promise<number> {
    await this.ensureReady();
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM ${this.table}
        WHERE collection LIKE $1 ESCAPE '\\'
          AND metadata @> $2::text::jsonb
        RETURNING id`,
      [`${escapeLike(collectionPrefix)}%`, JSON.stringify(match)],
    );
    return rows.length;
  }

  async deleteWithoutMetadataKey(
    collectionPrefix: string,
    key: string,
  ): Promise<number> {
    await this.ensureReady();
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM ${this.table}
        WHERE collection LIKE $1 ESCAPE '\\'
          AND (metadata IS NULL OR NOT (metadata ? $2))
        RETURNING id`,
      [`${escapeLike(collectionPrefix)}%`, key],
    );
    return rows.length;
  }

  async count(collection: string): Promise<number> {
    await this.ensureReady();
    const rows = await this.db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM ${this.table} WHERE collection = $1`,
      [collection],
    );
    return toNumber(rows[0]?.n);
  }

  async listCollections(): Promise<string[]> {
    await this.ensureReady();
    const rows = await this.db.query<{ collection: string }>(
      `SELECT DISTINCT collection FROM ${this.table} ORDER BY collection`,
    );
    return rows.map((r) => r.collection);
  }

  async listDocuments(
    collection: string,
    limit = 100,
  ): Promise<RagDocumentSummary[]> {
    await this.ensureReady();
    const rows = await this.db.query<DocRow>(
      `SELECT id, content, metadata
         FROM ${this.table}
        WHERE collection = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [collection, Math.max(1, limit)],
    );
    return rows.map((r) => {
      const metadata = parseMetadata(r.metadata);
      return {
        id: r.id,
        text: r.content,
        ...(metadata !== undefined ? { metadata } : {}),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface VectorStoreOptions {
  enabled?: boolean;
  /** Max documents held by the in-memory backend (per replica). Default 10000. */
  maxDocuments?: number;
  /** Postgres table name (internal constant; isolates RAG vs. memory). Default "rag_documents". */
  tableName?: string;
}

/**
 * Builds a {@link VectorStore}, or undefined when RAG is disabled. Uses Postgres
 * (durable, cross-replica) when a database is provided, else an in-memory store.
 */
export function createVectorStore(
  options: VectorStoreOptions,
  db?: Database,
  logger?: Logger,
): VectorStore | undefined {
  if (options.enabled !== true) return undefined;
  if (db !== undefined) {
    logger?.info("Vector store enabled (Postgres)", {
      table: options.tableName ?? "rag_documents",
    });
    return new PgVectorStore(db, logger, options.tableName);
  }
  logger?.info("Vector store enabled (in-memory, per replica)");
  return new InMemoryRagStore(options.maxDocuments ?? 10_000);
}

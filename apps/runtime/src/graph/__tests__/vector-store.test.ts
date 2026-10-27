// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the RAG vector store (`src/graph/vector-store.ts`).
 *
 * Covers the pure ranking helper, the in-memory backend, and the Postgres
 * backend's pgvector vs. JSONB-fallback paths against a fake Database.
 */

import { describe, it, expect } from "bun:test";
import {
  escapeLike,
  InMemoryRagStore,
  PgVectorStore,
  rankByCosine,
  toVectorLiteral,
  type RagDocument,
} from "../vector-store.js";
import type { Database } from "../../db/database.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

function doc(
  id: string,
  embedding: number[],
  text = id,
  metadata?: Record<string, unknown>,
): RagDocument {
  return {
    id,
    text,
    embedding,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("rankByCosine", () => {
  it("ranks by similarity, highest first, bounded by topK", () => {
    const docs = [doc("a", [1, 0]), doc("b", [0, 1]), doc("c", [0.9, 0.1])];
    const out = rankByCosine(docs, [1, 0], 2);
    expect(out.map((c) => c.id)).toEqual(["a", "c"]);
    expect(at(out, 0).score).toBeGreaterThan(at(out, 1).score);
  });

  it("applies minScore filtering", () => {
    const docs = [doc("a", [1, 0]), doc("b", [0, 1])];
    const out = rankByCosine(docs, [1, 0], 10, 0.5);
    expect(out.map((c) => c.id)).toEqual(["a"]); // b is orthogonal (score 0)
  });

  it("preserves metadata", () => {
    const out = rankByCosine(
      [doc("a", [1, 0], "txt", { lang: "de" })],
      [1, 0],
      1,
    );
    expect(at(out, 0).metadata).toEqual({ lang: "de" });
  });
});

describe("toVectorLiteral", () => {
  it("formats a pgvector literal", () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe("[0.1,0.2,0.3]");
  });
});

describe("InMemoryRagStore", () => {
  it("upserts and queries by similarity", async () => {
    const store = new InMemoryRagStore();
    await store.upsert("kb", [doc("a", [1, 0]), doc("b", [0, 1])]);
    const hits = await store.query("kb", [1, 0.05], 1);
    expect(at(hits, 0).id).toBe("a");
    expect(await store.count("kb")).toBe(2);
  });

  it("upsert replaces an existing id", async () => {
    const store = new InMemoryRagStore();
    await store.upsert("kb", [doc("a", [1, 0], "old")]);
    await store.upsert("kb", [doc("a", [1, 0], "new")]);
    expect(await store.count("kb")).toBe(1);
    const hits = await store.query("kb", [1, 0], 1);
    expect(at(hits, 0).text).toBe("new");
  });

  it("deletes documents and collections", async () => {
    const store = new InMemoryRagStore();
    await store.upsert("kb", [doc("a", [1, 0]), doc("b", [0, 1])]);
    expect(await store.deleteDocuments("kb", ["a"])).toBe(1);
    expect(await store.count("kb")).toBe(1);
    expect(await store.deleteCollection("kb")).toBe(1);
    expect(await store.count("kb")).toBe(0);
  });

  it("lists only non-empty collections", async () => {
    const store = new InMemoryRagStore();
    await store.upsert("a", [doc("x", [1, 0])]);
    await store.upsert("b", [doc("y", [0, 1])]);
    expect((await store.listCollections()).sort()).toEqual(["a", "b"]);
  });

  it("evicts the oldest document past the bound", async () => {
    const store = new InMemoryRagStore(2);
    await store.upsert("kb", [doc("a", [1, 0])]);
    await store.upsert("kb", [doc("b", [0, 1])]);
    await store.upsert("kb", [doc("c", [1, 1])]);
    expect(await store.count("kb")).toBe(2);
    // "a" was inserted first → evicted.
    const ids = (await store.query("kb", [1, 1], 10)).map((c) => c.id).sort();
    expect(ids).toEqual(["b", "c"]);
  });

  it("returns empty for an unknown collection", async () => {
    const store = new InMemoryRagStore();
    expect(await store.query("nope", [1, 0], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PgVectorStore against a fake Database
// ---------------------------------------------------------------------------

/** Records executed SQL; lets a test script row results and toggle pgvector. */
function fakeDb(opts: {
  pgvectorAvailable: boolean;
  rows?: Record<string, unknown>[];
}): {
  db: Database;
  sql: string[];
} {
  const sql: string[] = [];
  const db: Database = {
    async query<T = Record<string, unknown>>(text: string): Promise<T[]> {
      sql.push(text);
      if (/CREATE EXTENSION/i.test(text)) {
        if (!opts.pgvectorAvailable) throw new Error("extension not available");
        return [] as T[];
      }
      if (/^SELECT/i.test(text.trim())) return (opts.rows ?? []) as T[];
      return [] as T[];
    },
    async close() {},
    async withOperator<T>(cb: (db: Database) => Promise<T>): Promise<T> {
      return cb(this);
    },
  };
  return { db, sql };
}

describe("PgVectorStore — pgvector path", () => {
  it("provisions a vector column and queries with the cosine operator", async () => {
    const { db, sql } = fakeDb({
      pgvectorAvailable: true,
      rows: [{ id: "a", content: "hello", metadata: null, score: 0.91 }],
    });
    const store = new PgVectorStore(db);
    const hits = await store.query("kb", [1, 0], 3);
    expect(hits[0]).toEqual({ id: "a", text: "hello", score: 0.91 });
    // The DDL used the native vector column and the query used <=>.
    expect(sql.some((s) => /embedding\s+vector/i.test(s))).toBe(true);
    expect(
      sql.some(
        (s) =>
          s.includes("embedding <=>") ||
          s.includes("1 - (embedding <=> $1::vector) AS score"),
      ),
    ).toBe(true);
  });
});

describe("PgVectorStore — JSONB fallback path", () => {
  it("falls back to JSONB + app-side cosine when pgvector is unavailable", async () => {
    const { db, sql } = fakeDb({
      pgvectorAvailable: false,
      rows: [
        { id: "a", content: "near", metadata: null, embedding: "[1,0]" },
        { id: "b", content: "far", metadata: null, embedding: "[0,1]" },
      ],
    });
    const store = new PgVectorStore(db);
    const hits = await store.query("kb", [1, 0], 1);
    expect(hits).toHaveLength(1);
    expect(at(hits, 0).id).toBe("a"); // ranked in app
    expect(sql.some((s) => /embedding\s+JSONB/i.test(s))).toBe(true);
  });

  it("parses array-typed embeddings from the driver", async () => {
    const { db } = fakeDb({
      pgvectorAvailable: false,
      rows: [{ id: "a", content: "x", metadata: { k: 1 }, embedding: [1, 0] }],
    });
    const store = new PgVectorStore(db);
    const hits = await store.query("kb", [1, 0], 1);
    expect(at(hits, 0).metadata).toEqual({ k: 1 });
  });
});

describe("deleteByMetadata / deleteWithoutMetadataKey", () => {
  async function seeded(): Promise<InMemoryRagStore> {
    const store = new InMemoryRagStore();
    await store.upsert("semcache:a", [
      doc("1", [1, 0], "1", { userScope: "u1", tenantScope: "t1" }),
      doc("2", [1, 0], "2", { userScope: "u2", tenantScope: "t1" }),
      doc("3", [1, 0], "3"),
    ]);
    await store.upsert("semcache:b", [doc("4", [1, 0], "4", { userScope: "u1", tenantScope: "t1" })]);
    await store.upsert("rag:c", [doc("5", [1, 0], "5", { userScope: "u1", tenantScope: "t1" })]);
    return store;
  }

  it("deletes across collections of the prefix when every pair matches", async () => {
    const store = await seeded();
    expect(await store.deleteByMetadata("semcache:", { userScope: "u1", tenantScope: "t1" })).toBe(2);
    expect(await store.count("semcache:a")).toBe(2);
    expect(await store.count("semcache:b")).toBe(0);
    expect(await store.count("rag:c")).toBe(1);
    expect(await store.deleteByMetadata("semcache:", { userScope: "u1", tenantScope: "t2" })).toBe(0);
  });

  it("deletes documents that lack the metadata key", async () => {
    const store = await seeded();
    expect(await store.deleteWithoutMetadataKey("semcache:", "userScope")).toBe(1);
    expect(await store.count("semcache:a")).toBe(2);
  });
});

describe("deleteExpired", () => {
  it("deletes expired documents of every collection with the prefix in one call", async () => {
    const store = new InMemoryRagStore();
    await store.upsert("semcache:a", [
      doc("1", [1, 0], "1", { expiresAt: 100 }),
      doc("2", [1, 0], "2", { expiresAt: 900 }),
      doc("3", [1, 0], "3"),
    ]);
    await store.upsert("semcache:b", [doc("4", [1, 0], "4", { expiresAt: 50 })]);
    await store.upsert("rag:c", [doc("5", [1, 0], "5", { expiresAt: 50 })]);

    expect(await store.deleteExpired("semcache:", 500)).toBe(2);
    expect(await store.count("semcache:a")).toBe(2);
    expect(await store.count("semcache:b")).toBe(0);
    expect(await store.count("rag:c")).toBe(1);
  });
});

describe("escapeLike", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
    expect(escapeLike("semcache:")).toBe("semcache:");
  });
});

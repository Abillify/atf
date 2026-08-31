// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the RAG ingestion API (`src/routes/rag.ts`).
 *
 * Uses the in-memory vector store and a fake embedder (no network).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createRagRouter } from "../rag.js";
import { InMemoryRagStore } from "../../graph/vector-store.js";
import type { Embedder } from "../../graph/semantic-cache.js";
import { TOKEN_KEY } from "../../middleware/auth.js";
import type { AuthContext } from "../../middleware/auth.js";

const embedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    // 2-d embedding: [len-ish, vowel count] — deterministic, good enough.
    const vowels = (text.match(/[aeiou]/gi) ?? []).length;
    return [text.length, vowels];
  },
};

function buildApp(store: InMemoryRagStore): Hono<AuthContext> {
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "h.p.s");
    await next();
  });
  app.route("/", createRagRouter(store, embedder));
  return app;
}

function post(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("RAG ingestion API", () => {
  it("upserts documents and assigns ids when missing", async () => {
    const store = new InMemoryRagStore();
    const app = buildApp(store);
    const res = await app.request(
      "/v1/rag/kb/documents",
      post({
        documents: [
          { text: "Paris is the capital of France." },
          { id: "d2", text: "Berlin." },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { upserted: number; ids: string[] };
    expect(body.upserted).toBe(2);
    expect(body.ids).toContain("d2");
    expect(await store.count("kb")).toBe(2);
  });

  it("rejects an empty documents array with 400", async () => {
    const app = buildApp(new InMemoryRagStore());
    const res = await app.request(
      "/v1/rag/kb/documents",
      post({ documents: [] }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a document with empty text with 400", async () => {
    const app = buildApp(new InMemoryRagStore());
    const res = await app.request(
      "/v1/rag/kb/documents",
      post({ documents: [{ text: "  " }] }),
    );
    expect(res.status).toBe(400);
  });

  it("lists collections and counts documents", async () => {
    const store = new InMemoryRagStore();
    const app = buildApp(store);
    await app.request(
      "/v1/rag/kb/documents",
      post({ documents: [{ text: "hello world" }] }),
    );

    const list = await app.request("/v1/rag/collections");
    expect(
      ((await list.json()) as { collections: string[] }).collections,
    ).toContain("kb");

    const count = await app.request("/v1/rag/kb/count");
    expect(((await count.json()) as { count: number }).count).toBe(1);
  });

  it("deletes specific documents and whole collections", async () => {
    const store = new InMemoryRagStore();
    const app = buildApp(store);
    await app.request(
      "/v1/rag/kb/documents",
      post({
        documents: [
          { id: "a", text: "aaa" },
          { id: "b", text: "bbb" },
        ],
      }),
    );

    const delDocs = await app.request("/v1/rag/kb/documents", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a"] }),
    });
    expect(((await delDocs.json()) as { removed: number }).removed).toBe(1);

    const delCol = await app.request("/v1/rag/kb", { method: "DELETE" });
    expect(((await delCol.json()) as { removed: number }).removed).toBe(1);
    expect(await store.count("kb")).toBe(0);
  });
});

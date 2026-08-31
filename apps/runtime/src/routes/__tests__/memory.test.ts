// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the long-term memory API (`src/routes/memory.ts`).
 *
 * The scope is derived from the request identity; a JWT verifier stub supplies
 * the email claim. Anonymous requests are rejected.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createMemoryRouter } from "../memory.js";
import { createMemoryStore } from "../../graph/memory-store.js";
import { InMemoryRagStore } from "../../graph/vector-store.js";
import type { Embedder } from "../../graph/semantic-cache.js";
import type { JwtVerifier } from "../../middleware/jwt-verifier.js";
import { TOKEN_KEY } from "../../middleware/auth.js";
import type { AuthContext } from "../../middleware/auth.js";

const embedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const t = text.toLowerCase();
    return [t.includes("coffee") ? 1 : 0, t.includes("tea") ? 1 : 0];
  },
};

/** Verifier stub: decodes a fixed email so the scope resolves. */
const verifier = {
  enabled: true,
  decodePayload: (_t: string) => ({ email: "alice@example.com" }),
} as unknown as JwtVerifier;

/** Anonymous verifier: no email claim → no scope. */
const anonVerifier = {
  enabled: true,
  decodePayload: (_t: string) => ({}),
} as unknown as JwtVerifier;

function buildApp(v: JwtVerifier) {
  const store = createMemoryStore(
    { enabled: true },
    new InMemoryRagStore(),
    embedder,
  );
  if (store === undefined) throw new Error("expected the memory store to be enabled");
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    ctx.set(TOKEN_KEY, "h.p.s");
    await next();
  });
  app.route("/", createMemoryRouter(store, v));
  return app;
}

function json(body: unknown, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("memory API", () => {
  it("remembers, recalls, counts and forgets for an identified user", async () => {
    const app = buildApp(verifier);

    const stored = await app.request(
      "/v1/memory",
      json({ text: "User loves coffee." }),
    );
    expect(stored.status).toBe(200);
    expect(((await stored.json()) as { stored: boolean }).stored).toBe(true);

    const count = await app.request("/v1/memory/count");
    expect(((await count.json()) as { count: number }).count).toBe(1);

    const recall = await app.request(
      "/v1/memory/recall",
      json({ query: "coffee", topK: 5 }),
    );
    const memories = (
      (await recall.json()) as { memories: Array<{ text: string }> }
    ).memories;
    const firstMemory = memories[0];
    if (firstMemory === undefined) throw new Error("expected a recalled memory");
    expect(firstMemory.text).toContain("coffee");

    const del = await app.request("/v1/memory", json({}, "DELETE"));
    expect(((await del.json()) as { removed: number }).removed).toBe(1);
  });

  it("rejects an anonymous request with 400", async () => {
    const app = buildApp(anonVerifier);
    const res = await app.request("/v1/memory", json({ text: "x" }));
    expect(res.status).toBe(400);
  });

  it("validates required fields", async () => {
    const app = buildApp(verifier);
    expect((await app.request("/v1/memory", json({}))).status).toBe(400);
    expect((await app.request("/v1/memory/recall", json({}))).status).toBe(400);
  });
});

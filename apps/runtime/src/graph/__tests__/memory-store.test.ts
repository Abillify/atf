// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for agent long-term memory (`src/graph/memory-store.ts`).
 *
 * Uses the in-memory vector store and a deterministic fake embedder.
 */

import { describe, it, expect } from "bun:test";
import {
  createMemoryStore,
  resolveMemoryScope,
  memoryCollection,
  type MemoryScope,
} from "../memory-store.js";
import { InMemoryRagStore } from "../vector-store.js";
import type { Embedder } from "../semantic-cache.js";

/** Keyword-axis embedder: france/germany/coffee dimensions. */
const embedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    const t = text.toLowerCase();
    return [
      t.includes("france") || t.includes("paris") ? 1 : 0,
      t.includes("germany") || t.includes("berlin") ? 1 : 0,
      t.includes("coffee") || t.includes("espresso") ? 1 : 0,
    ];
  },
};

function newStore() {
  const store = createMemoryStore(
    { enabled: true },
    new InMemoryRagStore(),
    embedder,
  );
  if (store === undefined) throw new Error("expected the memory store to be enabled");
  return store;
}

const alice: MemoryScope = { userId: "alice@example.com", tenantId: "acme" };
const bob: MemoryScope = { userId: "bob@example.com", tenantId: "acme" };

describe("resolveMemoryScope", () => {
  it("uses email first, then user_id param, then conversation_id", () => {
    expect(
      resolveMemoryScope({ ssoToken: "", executionId: "1", userEmail: "a@x" })
        ?.userId,
    ).toBe("a@x");
    expect(
      resolveMemoryScope({
        ssoToken: "",
        executionId: "1",
        requestParams: { user_id: "u9" },
      })?.userId,
    ).toBe("u9");
    expect(
      resolveMemoryScope({
        ssoToken: "",
        executionId: "1",
        requestParams: { conversation_id: "c5" },
      })?.userId,
    ).toBe("c5");
  });

  it("returns undefined for an anonymous request", () => {
    expect(
      resolveMemoryScope({ ssoToken: "", executionId: "1" }),
    ).toBeUndefined();
  });

  it("carries the tenant into the scope", () => {
    const scope = resolveMemoryScope({
      ssoToken: "",
      executionId: "1",
      userEmail: "a@x",
      clientId: "t1",
    });
    expect(scope).toEqual({ userId: "a@x", tenantId: "t1" });
  });
});

describe("memoryCollection", () => {
  it("isolates users and tenants", () => {
    expect(memoryCollection(alice)).not.toBe(memoryCollection(bob));
    expect(memoryCollection({ userId: "x" })).not.toBe(
      memoryCollection({ userId: "x", tenantId: "t" }),
    );
  });

  it("never contains a NUL byte (Postgres text columns reject 0x00)", () => {
    // The collection key is stored/queried as a Postgres `text` value; a NUL
    // byte would fail with `invalid byte sequence for encoding "UTF8": 0x00`
    // and silently disable memory on the pgvector backend.
    expect(memoryCollection(alice)).not.toContain("\u0000");
    expect(memoryCollection({ userId: "x" })).not.toContain("\u0000");
  });
});

describe("MemoryStore", () => {
  it("remembers and recalls the most relevant memory", async () => {
    const mem = newStore();
    await mem.remember(alice, "User prefers answers about France.");
    await mem.remember(alice, "User is learning about Germany.");
    const hits = await mem.recall(alice, "Tell me about Paris", 1);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    if (hit === undefined) throw new Error("expected a recalled memory");
    expect(hit.text).toContain("France");
    expect(hit.kind).toBe("fact");
    expect(hit.createdAt).toBeDefined();
  });

  it("isolates memories per scope", async () => {
    const mem = newStore();
    await mem.remember(alice, "Alice likes coffee.");
    await mem.remember(bob, "Bob likes Germany.");
    const aliceHits = await mem.recall(alice, "coffee", 5);
    expect(aliceHits.every((h) => h.text.includes("Alice"))).toBe(true);
    expect(await mem.count(bob)).toBe(1);
  });

  it("upserts under a stable id (dedupe)", async () => {
    const mem = newStore();
    await mem.remember(alice, "old preference", { id: "pref-1" });
    await mem.remember(alice, "new preference", { id: "pref-1" });
    expect(await mem.count(alice)).toBe(1);
  });

  it("forgets specific memories and clears a scope", async () => {
    const mem = newStore();
    const id = await mem.remember(alice, "Alice likes coffee.", { id: "m1" });
    expect(id).toBe("m1");
    await mem.remember(alice, "Alice studies France.", { id: "m2" });
    expect(await mem.forget(alice, ["m1"])).toBe(1);
    expect(await mem.count(alice)).toBe(1);
    expect(await mem.clear(alice)).toBe(1);
    expect(await mem.count(alice)).toBe(0);
  });

  it("ignores empty text on remember and empty query on recall", async () => {
    const mem = newStore();
    expect(await mem.remember(alice, "   ")).toBeUndefined();
    expect(await mem.recall(alice, "  ", 5)).toEqual([]);
  });

  it("is disabled without an embedder", () => {
    expect(
      createMemoryStore({ enabled: true }, new InMemoryRagStore(), undefined),
    ).toBeUndefined();
    expect(
      createMemoryStore({ enabled: false }, new InMemoryRagStore(), embedder),
    ).toBeUndefined();
  });
});

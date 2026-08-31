// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { TtlCache, identityScopeKey, stableStringify } from "../../src/cache.ts";
import { CachingToolExecutor } from "../../src/tools/caching-tool.ts";
import { CacheConfigSchema } from "../../src/config/schema.ts";
import type { AuthContext } from "../../src/auth/context.ts";
import type { ToolExecutor, ToolResult } from "../../src/tools/types.ts";

const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
  method: "static",
  subject: "u1",
  username: "u1",
  scopes: ["a", "b"],
  claims: {},
  headers: {},
  rawToken: "",
  ...over,
});

describe("TtlCache", () => {
  it("returns stored values until they expire", () => {
    const c = new TtlCache<number>(10);
    c.set("k", 42, 10_000);
    expect(c.get("k")).toBe(42);
  });

  it("expires entries after the ttl", () => {
    const c = new TtlCache<number>(10);
    c.set("k", 42, -1); // already expired
    expect(c.get("k")).toBeUndefined();
  });

  it("evicts the least-recently-used entry past maxEntries", () => {
    const c = new TtlCache<number>(2);
    c.set("a", 1, 10_000);
    c.set("b", 2, 10_000);
    c.get("a"); // touch a → b becomes LRU
    c.set("c", 3, 10_000); // evicts b
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });
});

describe("identityScopeKey", () => {
  it("is stable regardless of scope order", () => {
    expect(identityScopeKey(ctx({ scopes: ["b", "a"] }))).toBe(
      identityScopeKey(ctx({ scopes: ["a", "b"] })),
    );
  });
  it("differs by subject", () => {
    expect(identityScopeKey(ctx({ subject: "x" }))).not.toBe(
      identityScopeKey(ctx({ subject: "y" })),
    );
  });
});

describe("stableStringify", () => {
  it("is independent of key order", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });
});

describe("CachingToolExecutor", () => {
  function counting(): { exec: ToolExecutor; calls: () => number } {
    let calls = 0;
    const exec: ToolExecutor = {
      definition: { name: "t", description: "", inputSchema: {} },
      async execute(): Promise<ToolResult> {
        calls++;
        return { content: [{ type: "text", text: `n=${calls}` }] };
      },
    };
    return { exec, calls: () => calls };
  }

  it("serves a cached result for identical args + identity", async () => {
    const { exec, calls } = counting();
    const cfg = CacheConfigSchema.parse({ enabled: true, ttlSeconds: 60, scope: "identity" });
    const cached = new CachingToolExecutor(exec, cfg);

    const first = await cached.execute({ x: 1 }, ctx());
    const second = await cached.execute({ x: 1 }, ctx());
    expect(calls()).toBe(1);
    expect(first.meta?.cached).toBe(false);
    expect(second.meta?.cached).toBe(true);
    expect(second.content[0]?.text).toBe("n=1");
  });

  it("does not share identity-scoped results across users", async () => {
    const { exec, calls } = counting();
    const cfg = CacheConfigSchema.parse({ enabled: true, ttlSeconds: 60, scope: "identity" });
    const cached = new CachingToolExecutor(exec, cfg);
    await cached.execute({ x: 1 }, ctx({ subject: "u1" }));
    await cached.execute({ x: 1 }, ctx({ subject: "u2" }));
    expect(calls()).toBe(2);
  });

  it("shares results across users when scope is global", async () => {
    const { exec, calls } = counting();
    const cfg = CacheConfigSchema.parse({ enabled: true, ttlSeconds: 60, scope: "global" });
    const cached = new CachingToolExecutor(exec, cfg);
    await cached.execute({ x: 1 }, ctx({ subject: "u1" }));
    await cached.execute({ x: 1 }, ctx({ subject: "u2" }));
    expect(calls()).toBe(1);
  });

  it("forwards the parent abort signal to the wrapped executor", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const inner: ToolExecutor = {
      definition: { name: "t", description: "", inputSchema: {} },
      async execute(_args, _ctx, signal): Promise<ToolResult> {
        received = signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };
    const cfg = CacheConfigSchema.parse({ enabled: true, ttlSeconds: 60 });
    await new CachingToolExecutor(inner, cfg).execute({}, ctx(), controller.signal);
    expect(received).toBe(controller.signal);
  });

  it("does not cache error results", async () => {
    let calls = 0;
    const exec: ToolExecutor = {
      definition: { name: "t", description: "", inputSchema: {} },
      async execute(): Promise<ToolResult> {
        calls++;
        return { content: [{ type: "text", text: "boom" }], isError: true };
      },
    };
    const cfg = CacheConfigSchema.parse({ enabled: true, ttlSeconds: 60 });
    const cached = new CachingToolExecutor(exec, cfg);
    await cached.execute({}, ctx());
    await cached.execute({}, ctx());
    expect(calls).toBe(2);
  });
});

describe("authorization-context cache isolation", () => {
  it("partitions by claims, tenant headers, username and auth method", () => {
    const base = identityScopeKey(
      ctx({ claims: { role: "reader" }, headers: { "x-tenant-id": "a" } }),
    );
    expect(base).not.toBe(
      identityScopeKey(ctx({ claims: { role: "writer" }, headers: { "x-tenant-id": "a" } })),
    );
    expect(base).not.toBe(
      identityScopeKey(ctx({ claims: { role: "reader" }, headers: { "x-tenant-id": "b" } })),
    );
    expect(base).not.toBe(
      identityScopeKey(
        ctx({ username: "alias", claims: { role: "reader" }, headers: { "x-tenant-id": "a" } }),
      ),
    );
  });

  it("does not expose context secrets in the identity key", () => {
    const key = identityScopeKey(
      ctx({
        subject: "secret-subject",
        claims: { apiKey: "secret-claim" },
        headers: { authorization: "secret-header" },
      }),
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("secret");
  });
});

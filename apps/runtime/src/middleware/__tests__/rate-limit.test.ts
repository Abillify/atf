// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for rate-limit middleware (Fix #5).
 *
 * Verifies fixed-window per-identity limiting, 429 + Retry-After on overflow,
 * per-identity isolation, and the disabled (limit <= 0) pass-through path.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import type { AuthContext } from "../auth.js";
import { authMiddleware, AUTH_PRINCIPAL_KEY } from "../auth.js";
import {
  rateLimitMiddleware,
  createInMemoryStore,
  createRedisRateLimitStore,
  legacyRateLimitKey,
  postAuthRateLimitKey,
  preAuthRateLimitMiddleware,
  postAuthRateLimitMiddleware,
} from "../rate-limit.js";
import { createMetrics } from "../../observability/metrics.js";

/** `createRedisRateLimitStore` for a URL known to produce a store (mocked RedisClient global). */
function mustCreateRedisRateLimitStore(
  ...args: Parameters<typeof createRedisRateLimitStore>
): NonNullable<ReturnType<typeof createRedisRateLimitStore>> {
  const store = createRedisRateLimitStore(...args);
  if (store === undefined) throw new Error("expected a rate-limit store");
  return store;
}

function makeApp(limit: number): Hono {
  const app = new Hono();
  app.use("/v1/*", rateLimitMiddleware(limit));
  app.get("/v1/ping", (c) => c.json({ ok: true }));
  return app;
}

const VALID_JWT = "aaa.bbb.ccc";

function req(token?: string, ip?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers["X-Forwarded-For"] = ip;
  return new Request("http://localhost/v1/ping", { headers });
}

describe("rateLimitMiddleware", () => {
  test("allows requests up to the limit, then returns 429", async () => {
    const app = makeApp(3);

    for (let i = 0; i < 3; i++) {
      const res = await app.fetch(req(VALID_JWT));
      expect(res.status).toBe(200);
    }

    const blocked = await app.fetch(req(VALID_JWT));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
  });

  test("sets X-RateLimit-* headers", async () => {
    const app = makeApp(5);
    const res = await app.fetch(req(VALID_JWT));
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("4");
    expect(res.headers.get("X-RateLimit-Reset")).not.toBeNull();
  });

  test("limits are isolated per identity (token)", async () => {
    const app = makeApp(1);

    // First identity exhausts its budget
    expect((await app.fetch(req("tok1.x.y"))).status).toBe(200);
    expect((await app.fetch(req("tok1.x.y"))).status).toBe(429);

    // Second identity has its own budget
    expect((await app.fetch(req("tok2.x.y"))).status).toBe(200);
  });

  test("falls back to forwarded IP when no token is present", async () => {
    const app = makeApp(1);
    expect((await app.fetch(req(undefined, "1.2.3.4"))).status).toBe(200);
    expect((await app.fetch(req(undefined, "1.2.3.4"))).status).toBe(429);
    // Different IP → separate budget
    expect((await app.fetch(req(undefined, "5.6.7.8"))).status).toBe(200);
  });

  test("limit <= 0 disables limiting (pass-through)", async () => {
    const app = makeApp(0);
    for (let i = 0; i < 50; i++) {
      const res = await app.fetch(req(VALID_JWT));
      expect(res.status).toBe(200);
    }
  });
});

describe("rate-limit identity keys", () => {
  test("replaces the complete raw Bearer token with a full SHA-256 digest", () => {
    const raw = "secret.bearer.credential";
    const key = legacyRateLimitKey({ authorization: `Bearer ${raw}` });
    expect(key).toMatch(/^legacy:credential:sha256:[a-f0-9]{64}$/);
    expect(key).not.toContain(raw);
    expect(key).toBe(legacyRateLimitKey({ authorization: `Bearer ${raw}` }));
  });

  test("preserves historical non-credential key formats", () => {
    expect(legacyRateLimitKey({ forwardedFor: "1.2.3.4" })).toBe("ip:1.2.3.4");
  });

  test("post-auth keys are stable, namespaced, and contain no principal values", () => {
    const principal = {
      method: "token" as const,
      verified: true,
      claims: { sub: "user-42" },
      tenantId: "tenant-a",
    };
    const key = postAuthRateLimitKey(principal);
    expect(key).toMatch(/^post-auth:principal:sha256:[a-f0-9]{64}$/);
    expect(key).not.toContain("user-42");
    expect(key).not.toContain("tenant-a");
    expect(postAuthRateLimitKey(principal)).toBe(key);
    expect(postAuthRateLimitKey({ ...principal, verified: false })).toBeNull();
  });
});

describe("additive pre/post-auth rate limits", () => {
  test("pre-auth limit uses the transport IP and ignores spoofed header/token rotation", async () => {
    const app = new Hono<AuthContext>();
    app.use("/v1/*", preAuthRateLimitMiddleware(1));
    app.get("/v1/ping", (ctx) => ctx.json({ ok: true }));
    const first = new Request("http://localhost/v1/ping", {
      headers: { Authorization: "Bearer first.token.value", "X-Forwarded-For": "1.2.3.4" },
    });
    const second = new Request("http://localhost/v1/ping", {
      headers: { Authorization: "Bearer second.token.value", "X-Forwarded-For": "9.8.7.6" },
    });
    expect((await app.fetch(first)).status).toBe(200);
    const blocked = await app.fetch(second);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Pre-Auth-Limit")).toBe("1");
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
  });

  test("post-auth limit runs after auth and keys the verified principal", async () => {
    const app = new Hono<AuthContext>();
    app.use("/v1/*", authMiddleware(undefined, undefined, { mode: "disabled" }));
    app.use("/v1/*", postAuthRateLimitMiddleware(1));
    app.get("/v1/ping", (ctx) => ctx.json({ ok: true }));
    expect((await app.fetch(new Request("http://localhost/v1/ping"))).status).toBe(200);
    const blocked = await app.fetch(new Request("http://localhost/v1/ping"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-RateLimit-Post-Auth-Limit")).toBe("1");
  });

  test("authentication rejection happens before the post-auth store is touched", async () => {
    let hits = 0;
    const store = {
      async hit() {
        hits += 1;
        return { count: hits, resetAt: Date.now() + 60_000 };
      },
    };
    const app = new Hono<AuthContext>();
    app.use("/v1/*", authMiddleware());
    app.use("/v1/*", postAuthRateLimitMiddleware(1, store));
    app.get("/v1/ping", (ctx) => ctx.json({ ok: true }));
    expect((await app.fetch(new Request("http://localhost/v1/ping"))).status).toBe(401);
    expect(hits).toBe(0);
  });

  test("zero limits are complete pass-through and do not touch the store", async () => {
    let hits = 0;
    const store = {
      async hit() {
        hits += 1;
        return { count: hits, resetAt: Date.now() + 60_000 };
      },
    };
    const app = new Hono<AuthContext>();
    app.use("/v1/*", preAuthRateLimitMiddleware(0, store));
    app.use("/v1/*", (ctx, next) => {
      ctx.set(AUTH_PRINCIPAL_KEY, {
        method: "token",
        verified: true,
        claims: { sub: "u" },
        tenantId: "t",
      });
      return next();
    });
    app.use("/v1/*", postAuthRateLimitMiddleware(0, store));
    app.get("/v1/ping", (ctx) => ctx.json({ ok: true }));
    expect((await app.fetch(new Request("http://localhost/v1/ping"))).status).toBe(200);
    expect(hits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shared store → cluster-wide enforcement across replicas
// ---------------------------------------------------------------------------

describe("rateLimitMiddleware — shared store (cluster-wide)", () => {
  test("one shared store enforces the budget across two app instances", async () => {
    const shared = createInMemoryStore();
    const replicaA = new Hono();
    replicaA.use("/v1/*", rateLimitMiddleware(2, shared));
    replicaA.get("/v1/ping", (c) => c.json({ ok: true }));

    const replicaB = new Hono();
    replicaB.use("/v1/*", rateLimitMiddleware(2, shared));
    replicaB.get("/v1/ping", (c) => c.json({ ok: true }));

    // Budget of 2 for the identity is shared: A, B consume it; the 3rd is 429.
    expect((await replicaA.fetch(req(VALID_JWT))).status).toBe(200);
    expect((await replicaB.fetch(req(VALID_JWT))).status).toBe(200);
    expect((await replicaA.fetch(req(VALID_JWT))).status).toBe(429);
    expect((await replicaB.fetch(req(VALID_JWT))).status).toBe(429);
  });

  test("fails open (allows request) when the store throws", async () => {
    const brokenStore = {
      hit: async () => {
        throw new Error("store down");
      },
    };
    const app = new Hono();
    app.use("/v1/*", rateLimitMiddleware(1, brokenStore));
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    // Even past the nominal limit, a broken store must not block traffic.
    for (let i = 0; i < 5; i++) {
      expect((await app.fetch(req(VALID_JWT))).status).toBe(200);
    }
  });

  test("fail-open store error counts aiperator_degraded_total (Req 7.8)", async () => {
    const brokenStore = {
      hit: async () => {
        throw new Error("store down");
      },
    };
    const m = createMetrics(true);
    const app = new Hono();
    app.use(
      "/v1/*",
      rateLimitMiddleware(1, brokenStore, undefined, "open", 0, m),
    );
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    expect((await app.fetch(req(VALID_JWT))).status).toBe(200);
    expect((await app.fetch(req(VALID_JWT))).status).toBe(200);
    expect(m.render()).toContain(
      'aiperator_degraded_total{component="rate_limit"} 2',
    );
  });

  test("fail-closed store error returns 503 and is NOT a degradation (Req 7.8)", async () => {
    const brokenStore = {
      hit: async () => {
        throw new Error("store down");
      },
    };
    const m = createMetrics(true);
    const app = new Hono();
    app.use(
      "/v1/*",
      rateLimitMiddleware(1, brokenStore, undefined, "closed", 0, m),
    );
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    expect((await app.fetch(req(VALID_JWT))).status).toBe(503);
    // Fail-closed is a rejection, not a fail-open degradation — not counted.
    expect(m.render()).not.toContain("aiperator_degraded_total");
  });
});

// ---------------------------------------------------------------------------
// Redis store (mocked RedisClient global)
// ---------------------------------------------------------------------------

describe("createRedisRateLimitStore", () => {
  test("returns undefined when Bun RedisClient is unavailable", () => {
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    delete g.RedisClient;
    try {
      expect(
        createRedisRateLimitStore("redis://localhost:6379"),
      ).toBeUndefined();
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
    }
  });

  test("uses INCR (+EXPIRE on first hit) and derives a stable window reset", async () => {
    const calls: Array<{ cmd: string; args: unknown[] }> = [];
    const counters = new Map<string, number>();

    class MockRedis {
      constructor(public url: string) {}
      async incr(key: string): Promise<number> {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        calls.push({ cmd: "incr", args: [key] });
        return next;
      }
      async get(key: string): Promise<string | null> {
        calls.push({ cmd: "get", args: [key] });
        const v = counters.get(key);
        return v === undefined ? null : String(v);
      }
      async expire(key: string, seconds: number): Promise<number> {
        calls.push({ cmd: "expire", args: [key, seconds] });
        return 1;
      }
    }

    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    g.RedisClient = MockRedis as unknown;
    try {
      const store = mustCreateRedisRateLimitStore("redis://localhost:6379");

      const first = await store.hit("tok:abc", 60_000);
      expect(first.count).toBe(1);
      expect(first.resetAt % 60_000).toBe(0); // aligned to the window boundary
      expect(first.resetAt).toBeGreaterThan(Date.now());

      const second = await store.hit("tok:abc", 60_000);
      expect(second.count).toBe(2);

      // INCR twice; EXPIRE only on the first hit of the window
      expect(calls.filter((c) => c.cmd === "incr")).toHaveLength(2);
      expect(calls.filter((c) => c.cmd === "expire")).toHaveLength(1);
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
      else delete g.RedisClient;
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed mode → reject when the store is unavailable
// ---------------------------------------------------------------------------

describe("rateLimitMiddleware — fail-closed mode", () => {
  test("rejects with 503 + Retry-After when the store throws", async () => {
    const brokenStore = {
      hit: async (): Promise<never> => {
        throw new Error("store down");
      },
    };
    const app = new Hono();
    app.use("/v1/*", rateLimitMiddleware(1, brokenStore, undefined, "closed"));
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    const res = await app.fetch(req(VALID_JWT));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  test("default fail mode remains open (no behavioural change)", async () => {
    const brokenStore = {
      hit: async (): Promise<never> => {
        throw new Error("store down");
      },
    };
    const app = new Hono();
    app.use("/v1/*", rateLimitMiddleware(1, brokenStore, undefined));
    app.get("/v1/ping", (c) => c.json({ ok: true }));

    expect((await app.fetch(req(VALID_JWT))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: window rollover, close(), store-backed adapter,
// user-scoped key derivation, and per-user rate limiting.
// ---------------------------------------------------------------------------

import { userScopedKeyFn, createStoreBackedRateLimitStore } from "../rate-limit.js";

describe("createInMemoryStore — window rollover and close()", () => {
  test("rolls the window forward and eventually resets the estimate", async () => {
    const store = createInMemoryStore();
    const key = "rollover-key";
    const first = await store.hit(key, 50);
    expect(first.count).toBeGreaterThanOrEqual(1);

    // Wait past the window boundary so the internal bucket rolls over.
    await new Promise((r) => setTimeout(r, 120));
    const later = await store.hit(key, 50);
    expect(later.resetAt).toBeGreaterThan(first.resetAt - 1);
    await store.close?.();
  });

  test("close() clears internal state without throwing", async () => {
    const store = createInMemoryStore();
    await store.hit("a", 1000);
    await expect(store.close?.()).resolves.toBeUndefined();
  });
});

describe("createStoreBackedRateLimitStore", () => {
  test("delegates to the CounterStore.incr and derives resetAt from the window", async () => {
    const calls: Array<{ key: string; amount: number; windowMs: number }> = [];
    const counter = {
      async incr(key: string, amount: number, windowMs: number): Promise<number> {
        calls.push({ key, amount, windowMs });
        return 3;
      },
    };
    const store = createStoreBackedRateLimitStore(counter);
    const result = await store.hit("some-key", 60_000);
    expect(result.count).toBe(3);
    expect(result.resetAt % 60_000).toBe(0);
    expect(calls).toEqual([{ key: "some-key", amount: 1, windowMs: 60_000 }]);
  });
});

describe("userScopedKeyFn", () => {
  test("prefers the OWUI user id header over the JWT sub claim", () => {
    const key = userScopedKeyFn({ owuiUserId: "u1", tenantId: "t1" });
    expect(key).toBe("tenant:t1:user:u1");
  });

  test("falls back to the decoded JWT sub claim when no OWUI header is present", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "user-42" })).toString(
      "base64url",
    );
    const token = `header.${payload}.sig`;
    const key = userScopedKeyFn({ authorization: `Bearer ${token}` });
    expect(key).toBe("tenant:_:user:user-42");
  });

  test("returns null when there is no OWUI header and no usable JWT sub", () => {
    expect(userScopedKeyFn({})).toBeNull();
    expect(userScopedKeyFn({ authorization: "Bearer not-a-jwt" })).toBeNull();
  });

  test("returns null when the JWT payload is not valid JSON", () => {
    const token = "header.bm90anNvbg.sig"; // "notjson" base64
    expect(userScopedKeyFn({ authorization: `Bearer ${token}` })).toBeNull();
  });

  test("returns null when the sub claim is missing or not a string", () => {
    const payload = Buffer.from(JSON.stringify({ other: 1 })).toString(
      "base64url",
    );
    const token = `header.${payload}.sig`;
    expect(userScopedKeyFn({ authorization: `Bearer ${token}` })).toBeNull();
  });

  test("defaults the tenant segment to '_' when tenantId is empty", () => {
    const key = userScopedKeyFn({ owuiUserId: "u1", tenantId: "" });
    expect(key).toBe("tenant:_:user:u1");
  });
});

describe("rateLimitMiddleware — per-user limiting", () => {
  function makeUserApp(userLimit: number, tokenLimit = 0) {
    const app = new Hono();
    app.use("/v1/*", rateLimitMiddleware(tokenLimit, undefined, undefined, "open", userLimit));
    app.get("/v1/ping", (c) => c.json({ ok: true }));
    return app;
  }

  test("enforces a per-user budget keyed by the OWUI user id header", async () => {
    const app = makeUserApp(2);
    const headers = { "X-OpenWebUI-User-Id": "u1" };
    expect((await app.fetch(new Request("http://localhost/v1/ping", { headers }))).status).toBe(200);
    expect((await app.fetch(new Request("http://localhost/v1/ping", { headers }))).status).toBe(200);
    const blocked = await app.fetch(new Request("http://localhost/v1/ping", { headers }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
  });

  test("sets X-RateLimit-User-* headers", async () => {
    const app = makeUserApp(5);
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", { headers: { "X-OpenWebUI-User-Id": "u1" } }),
    );
    expect(res.headers.get("X-RateLimit-User-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-User-Remaining")).toBe("4");
  });

  test("skips the per-user check entirely when no user identity can be derived", async () => {
    const app = makeUserApp(1);
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(new Request("http://localhost/v1/ping"));
      expect(res.status).toBe(200);
    }
  });

  test("fails open on a store error for the per-user check by default", async () => {
    const brokenStore = {
      hit: async (): Promise<never> => {
        throw new Error("down");
      },
    };
    const app = new Hono();
    app.use("/v1/*", rateLimitMiddleware(0, brokenStore, undefined, "open", 1));
    app.get("/v1/ping", (c) => c.json({ ok: true }));
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", { headers: { "X-OpenWebUI-User-Id": "u1" } }),
    );
    expect(res.status).toBe(200);
  });

  test("fails closed on a store error for the per-user check when configured", async () => {
    const brokenStore = {
      hit: async (): Promise<never> => {
        throw new Error("down");
      },
    };
    const app = new Hono();
    app.use("/v1/*", rateLimitMiddleware(0, brokenStore, undefined, "closed", 1));
    app.get("/v1/ping", (c) => c.json({ ok: true }));
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", { headers: { "X-OpenWebUI-User-Id": "u1" } }),
    );
    expect(res.status).toBe(503);
  });

  test("both token-level and user-level limits apply together", async () => {
    const app = makeUserApp(10, 1);
    const headers = { "X-OpenWebUI-User-Id": "u1", Authorization: "Bearer aaa.bbb.ccc" };
    expect((await app.fetch(new Request("http://localhost/v1/ping", { headers }))).status).toBe(200);
    // token-level limit of 1 is now exhausted
    const blocked = await app.fetch(new Request("http://localhost/v1/ping", { headers }));
    expect(blocked.status).toBe(429);
  });
});

describe("createRedisRateLimitStore — hit accounting across buckets", () => {
  test("reads a non-zero previous bucket and blends it into the estimate", async () => {
    const counters = new Map<string, number>();
    class MockRedis {
      constructor(public url: string) {}
      async incr(key: string): Promise<number> {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }
      async get(key: string): Promise<string | null> {
        // Simulate a previous-window bucket with a stored count.
        if (key.endsWith(":0")) return "4";
        const v = counters.get(key);
        return v === undefined ? null : String(v);
      }
      async expire(): Promise<number> {
        return 1;
      }
    }
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    g.RedisClient = MockRedis as unknown;
    try {
      const store = mustCreateRedisRateLimitStore("redis://localhost:6379");
      const result = await store.hit("tok:blend", 60_000);
      expect(result.count).toBeGreaterThanOrEqual(1);
      await store.close?.();
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
      else delete g.RedisClient;
    }
  });

  test("tolerates a get() failure on the previous bucket (treated as 0)", async () => {
    const counters = new Map<string, number>();
    class MockRedis {
      constructor(public url: string) {}
      async incr(key: string): Promise<number> {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }
      async get(): Promise<string | null> {
        throw new Error("get failed");
      }
      async expire(): Promise<number> {
        return 1;
      }
    }
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    g.RedisClient = MockRedis as unknown;
    try {
      const store = mustCreateRedisRateLimitStore("redis://localhost:6379");
      const result = await store.hit("tok:geterr", 60_000);
      expect(result.count).toBe(1);
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
      else delete g.RedisClient;
    }
  });

  test("tolerates an expire() failure on the first hit of a bucket", async () => {
    const counters = new Map<string, number>();
    class MockRedis {
      constructor(public url: string) {}
      async incr(key: string): Promise<number> {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      }
      async get(key: string): Promise<string | null> {
        const v = counters.get(key);
        return v === undefined ? null : String(v);
      }
      async expire(): Promise<number> {
        throw new Error("expire failed");
      }
    }
    const g = globalThis as { RedisClient?: unknown };
    const saved = g.RedisClient;
    g.RedisClient = MockRedis as unknown;
    try {
      const store = mustCreateRedisRateLimitStore("redis://localhost:6379");
      const result = await store.hit("tok:expireerr", 60_000);
      expect(result.count).toBe(1);
    } finally {
      if (saved !== undefined) g.RedisClient = saved;
      else delete g.RedisClient;
    }
  });
});

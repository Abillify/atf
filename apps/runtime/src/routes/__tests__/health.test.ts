// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for GET /health, GET /health/live, GET /health/ready
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import {
  createHealthRouter,
  type RedisProbeClient,
  type ReadinessResponse,
} from "../health.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { Database } from "../../db/database.js";

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

function makeFlowRegistry(ids: string[]): FlowRegistry {
  return {
    list: () =>
      ids.map((id) => ({ id, name: id, nodes: [], edges: [] }) as never),
    get: (id: string) =>
      ids.includes(id)
        ? ({ id, name: id, nodes: [], edges: [] } as never)
        : undefined,
  } as unknown as FlowRegistry;
}

function makeDatabase(opts?: { fail?: boolean; delayMs?: number }): Database {
  const db: Database = {
    query: async <T = Record<string, unknown>>(_text: string): Promise<T[]> => {
      if (opts?.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts?.fail === true) {
        throw new Error("connection refused");
      }
      return [{ "?column?": 1 }] as T[];
    },
    close: async () => {},
    withOperator: async <T>(cb: (d: Database) => Promise<T>): Promise<T> =>
      cb(db),
  };
  return db;
}

function makeRedisClient(opts?: {
  fail?: boolean;
  delayMs?: number;
}): RedisProbeClient {
  return {
    ping: async () => {
      if (opts?.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts?.fail === true) {
        throw new Error("ECONNREFUSED");
      }
      return "PONG";
    },
  };
}

function buildApp(router: ReturnType<typeof createHealthRouter>): Hono {
  const app = new Hono();
  app.route("/", router);
  return app;
}

// ---------------------------------------------------------------------------
// GET /health — legacy, always 200
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with status ok when no registry provided", async () => {
    const app = buildApp(createHealthRouter());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.flows_loaded).toBeUndefined();
  });

  it("includes only the aggregate flow count when registry is provided", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["flow-a", "flow-b"])),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.flows_loaded).toBe(2);
    expect(body.flow_ids).toBeUndefined();
  });

  it("returns 200 even when flows list is empty (legacy compat)", async () => {
    const app = buildApp(createHealthRouter(makeFlowRegistry([])));
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /health/live — liveness probe
// ---------------------------------------------------------------------------

describe("GET /health/live", () => {
  it("returns 200 with status ok and uptime_seconds", async () => {
    const startTime = Date.now() - 5_000;
    const app = buildApp(createHealthRouter(undefined, { startTime }));
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      uptime_seconds: number;
    };
    expect(body.status).toBe("ok");
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(4);
    expect(body.uptime_seconds).toBeLessThanOrEqual(10);
  });

  it("returns 200 even when database is down (liveness must not check deps)", async () => {
    const db = makeDatabase({ fail: true });
    const app = buildApp(
      createHealthRouter(makeFlowRegistry([]), { database: db }),
    );
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
  });

  it("returns 200 even when redis is down (liveness must not check deps)", async () => {
    const redis = makeRedisClient({ fail: true });
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), { redisClient: redis }),
    );
    const res = await app.request("/health/live");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /health/ready — readiness probe
// ---------------------------------------------------------------------------

describe("GET /health/ready", () => {
  // --- happy paths ----------------------------------------------------------

  it("returns 200 ready when no optional deps configured but flows loaded", async () => {
    const app = buildApp(createHealthRouter(makeFlowRegistry(["f"])));
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.status).toBe("ready");
    expect(body.checks.database.status).toBe("unconfigured");
    expect(body.checks.redis.status).toBe("unconfigured");
    expect(body.checks.flows.status).toBe("ok");
  });

  it("returns 200 ready when db and redis are healthy", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        database: makeDatabase(),
        redisClient: makeRedisClient(),
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.status).toBe("ready");
    expect(body.checks.database.status).toBe("ok");
    expect(body.checks.database.latencyMs).toBeDefined();
    expect(body.checks.redis.status).toBe("ok");
    expect(body.checks.redis.latencyMs).toBeDefined();
  });

  // --- database failures ----------------------------------------------------

  it("returns 503 not_ready when database is configured but unreachable", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        database: makeDatabase({ fail: true }),
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.status).toBe("not_ready");
    expect(body.checks.database.status).toBe("unavailable");
    expect(body.checks.database.reason).toContain("connection refused");
    // Redis is unconfigured → not a failure
    expect(body.checks.redis.status).toBe("unconfigured");
  });

  it("returns 503 when database probe times out", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        database: makeDatabase({ delayMs: 500 }),
        probeTimeoutMs: 50, // force timeout
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.database.status).toBe("unavailable");
  });

  // --- redis failures -------------------------------------------------------

  it("returns 503 not_ready when redis is configured but unreachable", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        redisClient: makeRedisClient({ fail: true }),
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.status).toBe("not_ready");
    expect(body.checks.redis.status).toBe("unavailable");
  });

  it("returns 503 when redis probe times out", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        redisClient: makeRedisClient({ delayMs: 500 }),
        probeTimeoutMs: 50,
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.redis.status).toBe("unavailable");
  });

  // --- flows check ----------------------------------------------------------

  it("returns 503 not_ready when no flows are loaded", async () => {
    const app = buildApp(createHealthRouter(makeFlowRegistry([])));
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.status).toBe("not_ready");
    expect(body.checks.flows.status).toBe("degraded");
    expect(body.checks.flows.reason).toContain("No flows loaded");
  });

  it("returns unconfigured for flows when no registry provided", async () => {
    const app = buildApp(createHealthRouter(undefined));
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.flows.status).toBe("unconfigured");
  });

  // --- combined failures ----------------------------------------------------

  it("reports all failing deps when both db and redis are down", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        database: makeDatabase({ fail: true }),
        redisClient: makeRedisClient({ fail: true }),
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.database.status).toBe("unavailable");
    expect(body.checks.redis.status).toBe("unavailable");
  });

  it("probes run in parallel (total latency ≈ max, not sum)", async () => {
    // Each probe takes 80 ms → sequential would be 160+ ms, parallel ≈ 80 ms.
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        database: makeDatabase({ delayMs: 80 }),
        redisClient: makeRedisClient({ delayMs: 80 }),
        probeTimeoutMs: 500,
      }),
    );
    const t0 = Date.now();
    await app.request("/health/ready");
    const elapsed = Date.now() - t0;
    // Allow generous headroom for test runner overhead
    expect(elapsed).toBeLessThan(300);
  });

  // --- response shape -------------------------------------------------------

  it("always includes all three check keys", async () => {
    const app = buildApp(createHealthRouter());
    const res = await app.request("/health/ready");
    const body = (await res.json()) as ReadinessResponse;
    expect(Object.keys(body.checks).sort()).toEqual([
      "database",
      "flows",
      "redis",
    ]);
  });
});

// ---------------------------------------------------------------------------
// policy_stale check (Req 7.7) — informational, never causes 503
// ---------------------------------------------------------------------------

describe("GET /health/ready — policy_stale (Req 7.7)", () => {
  it("omits the policy_stale key when no loader is wired", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {}),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.policy_stale).toBeUndefined();
  });

  it("reports ok when the last reload succeeded", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        toolAuthz: { policyStale: false },
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.policy_stale?.status).toBe("ok");
    expect(body.checks.policy_stale?.policy_stale).toBe(false);
  });

  it("reports degraded with policy_stale=true after a failed reload", async () => {
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        toolAuthz: { policyStale: true },
      }),
    );
    const res = await app.request("/health/ready");
    const body = (await res.json()) as ReadinessResponse;
    expect(body.checks.policy_stale?.status).toBe("degraded");
    expect(body.checks.policy_stale?.policy_stale).toBe(true);
    expect(body.checks.policy_stale?.reason).toContain(
      "aiperator_policy_stale_total",
    );
  });

  it("stale policy never turns readiness into 503", async () => {
    // Informational check only: the last-known-good policy is still enforced,
    // so the replica keeps serving traffic (mirrors the audit check pattern).
    const app = buildApp(
      createHealthRouter(makeFlowRegistry(["f"]), {
        database: makeDatabase(),
        redisClient: makeRedisClient(),
        toolAuthz: { policyStale: true },
      }),
    );
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadinessResponse;
    expect(body.status).toBe("ready");
    expect(body.checks.policy_stale?.status).toBe("degraded");
  });
});
describe("auth: disabled signal", () => {
  it("/health and /health/ready say so while AUTHN_MODE=disabled", async () => {
    const app = new Hono().route(
      "/",
      createHealthRouter(makeFlowRegistry(["a"]), { database: makeDatabase(), authDisabled: true }),
    );
    expect(((await (await app.request("/health")).json()) as { auth?: string }).auth).toBe("disabled");
    const ready = (await (await app.request("/health/ready")).json()) as ReadinessResponse;
    expect(ready.auth).toBe("disabled");
  });
  it("adds nothing when authentication is on", async () => {
    const app = new Hono().route(
      "/",
      createHealthRouter(makeFlowRegistry(["a"]), { database: makeDatabase(), authDisabled: false }),
    );
    expect(await (await app.request("/health")).json()).not.toHaveProperty("auth");
    expect(await (await app.request("/health/ready")).json()).not.toHaveProperty("auth");
    const plain = new Hono().route("/", createHealthRouter(makeFlowRegistry(["a"])));
    expect(await (await plain.request("/health")).json()).not.toHaveProperty("auth");
  });
});

describe("compliance_policy readiness hint", () => {
  const ready = async (compliancePolicy?: { required: boolean; loaded: () => boolean }) => {
    const app = new Hono().route(
      "/",
      createHealthRouter(makeFlowRegistry(["a"]), {
        database: makeDatabase(),
        ...(compliancePolicy !== undefined ? { compliancePolicy } : {}),
      }),
    );
    const res = await app.request("/health/ready");
    return { status: res.status, body: (await res.json()) as ReadinessResponse };
  };

  it("reports `missing` (degraded, never 503) while the required policy is not loaded", async () => {
    const { status, body } = await ready({ required: true, loaded: () => false });
    expect(status).toBe(200);
    expect(body.status).toBe("ready");
    expect(body.checks.compliance_policy).toMatchObject({ status: "degraded", compliance_policy: "missing" });
  });

  it("reports `loaded` when the policy is there", async () => {
    const { body } = await ready({ required: true, loaded: () => true });
    expect(body.checks.compliance_policy).toEqual({ status: "ok", compliance_policy: "loaded" });
  });

  it("follows a failed hot-reload: the state is read per request", async () => {
    let loaded = true;
    const app = new Hono().route(
      "/",
      createHealthRouter(makeFlowRegistry(["a"]), {
        database: makeDatabase(),
        compliancePolicy: { required: true, loaded: () => loaded },
      }),
    );
    const first = (await (await app.request("/health/ready")).json()) as ReadinessResponse;
    expect(first.checks.compliance_policy?.compliance_policy).toBe("loaded");
    loaded = false;
    const second = (await (await app.request("/health/ready")).json()) as ReadinessResponse;
    expect(second.checks.compliance_policy?.compliance_policy).toBe("missing");
  });

  it("adds nothing when the policy is not required or no source is wired", async () => {
    expect((await ready({ required: false, loaded: () => false })).body.checks).not.toHaveProperty("compliance_policy");
    expect((await ready()).body.checks).not.toHaveProperty("compliance_policy");
  });
});

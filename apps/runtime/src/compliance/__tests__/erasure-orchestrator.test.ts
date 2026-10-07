// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Unit tests for the DSAR erasure orchestrator (Req 2.9): parallel fan-out,
 * retry with backoff, idempotent replay, honest aggregation, and the
 * persisted-operation retry path (failed stores only).
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";

import type { ErasureRequest, ErasureStoreResult } from "@atf/erasure-contract";

import {
  createErasureOrchestrator,
  RUNTIME_STORE_SERVICE,
  type ErasureOperationStatus,
} from "../erasure-orchestrator.js";
import type { ErasureTargetConfig } from "../erasure-targets.js";
import {
  RetentionService,
  type ErasureSubject,
  type RetentionTarget,
} from "../../observability/retention.js";
import type { Database } from "../../db/database.js";

class FakeTarget implements RetentionTarget {
  calls = 0;
  constructor(
    public readonly name: string,
    private readonly outcome: { erased?: number; error?: string } = {},
  ) {}
  eraseSubject = async (_s: ErasureSubject): Promise<number> => {
    this.calls++;
    if (this.outcome.error !== undefined) throw new Error(this.outcome.error);
    return this.outcome.erased ?? 1;
  };
}

function request(overrides: Partial<ErasureRequest> = {}): ErasureRequest {
  return {
    requestId: randomUUID(),
    tenantId: "acme",
    subject: { userId: "u@x.de", externalIds: [] },
    scope: "subject",
    dryRun: false,
    ...overrides,
  };
}

const target: ErasureTargetConfig = {
  service: "search",
  url: "http://search:8080/v1/erasure",
  tokenEnv: "SEARCH_ERASURE_TOKEN",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createErasureOrchestrator — local stores", () => {
  it("maps retention results to store results and aggregates ok", async () => {
    const retention = new RetentionService([
      new FakeTarget("runtime.sessions", { erased: 2 }),
      new FakeTarget("runtime.history", { erased: 5 }),
    ]);
    const orch = createErasureOrchestrator({ retention });
    const op = await orch.execute(request());
    expect(op.status).toBe("complete");
    expect(op.erased).toBe(7);
    expect(op.results).toEqual([
      { store: "runtime.sessions", status: "ok", erased: 2 },
      { store: "runtime.history", status: "ok", erased: 5 },
    ]);
    expect(op.storeGroups).toEqual([
      {
        service: RUNTIME_STORE_SERVICE,
        stores: ["runtime.sessions", "runtime.history"],
      },
    ]);
  });

  it("marks a throwing retention target as failed without losing the others", async () => {
    const retention = new RetentionService([
      new FakeTarget("a.ok", { erased: 1 }),
      new FakeTarget("b.bad", { error: "boom" }),
    ]);
    const orch = createErasureOrchestrator({ retention });
    const op = await orch.execute(request());
    expect(op.status).toBe("partial");
    const failed = op.results.find((r) => r.store === "b.bad");
    expect(failed).toMatchObject({ status: "failed", erased: 0, error: "boom" });
  });
});

describe("createErasureOrchestrator — remote targets", () => {
  it("calls each target once with bearer token and merges results", async () => {
    const retention = new RetentionService([]);
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string>)?.authorization ?? null,
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse({
        requestId: "irrelevant",
        service: "search",
        results: [{ store: "chunks", status: "ok", erased: 4 }],
      });
    }) as unknown as typeof fetch;
    const orch = createErasureOrchestrator({
      retention,
      targets: [target],
      fetchImpl,
      envLookup: () => "svc-token",
    });
    const req = request();
    const op = await orch.execute(req);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(target.url);
    expect(seen[0].auth).toBe("Bearer svc-token");
    expect(seen[0].body).toEqual(req);
    // Unqualified store names are namespaced with the service.
    expect(op.results).toEqual([
      { store: "search.chunks", status: "ok", erased: 4 },
    ]);
    expect(op.status).toBe("complete");
    expect(op.storeGroups).toEqual([
      { service: "search", stores: ["search.chunks"] },
    ]);
  });

  it("retries a failing endpoint up to 3 attempts, then reports failed", async () => {
    const retention = new RetentionService([]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    const orch = createErasureOrchestrator({
      retention,
      targets: [target],
      fetchImpl,
      envLookup: () => "svc-token",
      backoffBaseMs: 1,
    });
    const op = await orch.execute(request());
    expect(calls).toBe(3);
    expect(op.status).toBe("failed");
    expect(op.results[0]).toMatchObject({
      store: "search.endpoint",
      status: "failed",
      error: "HTTP 503",
    });
  });

  it("succeeds on the second attempt after a transient failure", async () => {
    const retention = new RetentionService([]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("busy", { status: 503 });
      return jsonResponse({
        requestId: "x",
        service: "search",
        results: [{ store: "search.chunks", status: "ok", erased: 1 }],
      });
    }) as unknown as typeof fetch;
    const orch = createErasureOrchestrator({
      retention,
      targets: [target],
      fetchImpl,
      envLookup: () => "svc-token",
      backoffBaseMs: 1,
    });
    const op = await orch.execute(request());
    expect(calls).toBe(2);
    expect(op.status).toBe("complete");
  });

  it("fails fast when the token env variable is unset (no HTTP call)", async () => {
    const retention = new RetentionService([]);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const orch = createErasureOrchestrator({
      retention,
      targets: [target],
      fetchImpl,
      envLookup: () => undefined,
    });
    const op = await orch.execute(request());
    expect(calls).toBe(0);
    expect(op.results[0]).toMatchObject({
      store: "search.endpoint",
      status: "failed",
      error: "token environment variable SEARCH_ERASURE_TOKEN is not set",
    });
  });

  it("treats not_configured as deliberate success in the aggregate", async () => {
    const retention = new RetentionService([]);
    const fetchImpl = (async () =>
      jsonResponse({
        requestId: "x",
        service: "search",
        results: [{ store: "search.opt", status: "not_configured", erased: 0 }],
      })) as unknown as typeof fetch;
    const orch = createErasureOrchestrator({
      retention,
      targets: [target],
      fetchImpl,
      envLookup: () => "t",
    });
    const op = await orch.execute(request());
    expect(op.status).toBe("complete");
  });
});

describe("createErasureOrchestrator — idempotency", () => {
  it("replays the stored operation for a repeated requestId", async () => {
    const target1 = new FakeTarget("a", { erased: 1 });
    const retention = new RetentionService([target1]);
    const orch = createErasureOrchestrator({ retention });
    const req = request();
    const first = await orch.execute(req);
    const second = await orch.execute(req);
    expect(second.requestId).toBe(first.requestId);
    expect(second.results).toEqual(first.results);
    expect(target1.calls).toBe(1); // no second erasure
  });
});

describe("createErasureOrchestrator — retry", () => {
  it("re-runs only failed stores and completes when they recover", async () => {
    const bad = new FakeTarget("runtime.bad", { error: "down" });
    const good = new FakeTarget("runtime.good", { erased: 2 });
    const retention = new RetentionService([bad, good]);
    let remoteCalls = 0;
    let remoteShouldFail = true;
    const fetchImpl = (async () => {
      remoteCalls++;
      if (remoteShouldFail) return new Response("down", { status: 500 });
      return jsonResponse({
        requestId: "x",
        service: "search",
        results: [{ store: "search.chunks", status: "ok", erased: 3 }],
      });
    }) as unknown as typeof fetch;
    const orch = createErasureOrchestrator({
      retention,
      targets: [target],
      fetchImpl,
      envLookup: () => "t",
      backoffBaseMs: 1,
    });
    const op = await orch.execute(request());
    expect(op.status).toBe("partial");
    expect(remoteCalls).toBe(3); // all attempts exhausted on first run

    bad.eraseSubject = async () => 7; // store recovered
    remoteShouldFail = false;
    const retried = await orch.retry(op.requestId);
    expect(retried).not.toBeNull();
    expect(retried?.status).toBe("complete");
    expect(retried?.erased).toBe(2 + 7 + 3);
    // The good local store was NOT touched again by the retry.
    expect(good.calls).toBe(1);
    // One fresh round of remote calls (success on first attempt).
    expect(remoteCalls).toBe(4);
  });

  it("returns null for an unknown requestId", async () => {
    const orch = createErasureOrchestrator({
      retention: new RetentionService([]),
    });
    expect(await orch.retry(randomUUID())).toBeNull();
  });

  it("replays a complete operation unchanged", async () => {
    const t = new FakeTarget("a", { erased: 1 });
    const orch = createErasureOrchestrator({
      retention: new RetentionService([t]),
    });
    const op = await orch.execute(request());
    const again = await orch.retry(op.requestId);
    expect(again?.status).toBe("complete");
    expect(t.calls).toBe(1);
  });
});

describe("createErasureOrchestrator — persistence (fake Database)", () => {
  /** Minimal in-memory fake speaking the erasure_requests SQL subset. */
  function fakeDb(): Database & { rows: Map<string, Record<string, unknown>> } {
    const rows = new Map<string, Record<string, unknown>>();
    const db = {
      rows,
      query: async <T,>(text: string, params?: readonly unknown[]): Promise<T[]> => {
        if (text.startsWith("INSERT INTO erasure_requests")) {
          const id = String(params?.[0]);
          if (rows.has(id)) return [];
          rows.set(id, {
            request_id: id,
            tenant_id: params?.[1],
            scope: params?.[2],
            subject: params?.[3] === null ? null : JSON.parse(String(params?.[3])),
            doc_references:
              params?.[4] === null ? null : JSON.parse(String(params?.[4])),
            status: params?.[5],
            results: JSON.parse(String(params?.[6])),
            store_groups: JSON.parse(String(params?.[7])),
            receipt: null,
            created_at: new Date(),
            updated_at: new Date(),
          });
          return [{ request_id: id }] as unknown as T[];
        }
        if (text.startsWith("UPDATE erasure_requests")) {
          const row = rows.get(String(params?.[0]));
          if (row !== undefined) {
            row.status = params?.[1];
            row.results = JSON.parse(String(params?.[2]));
            row.store_groups = JSON.parse(String(params?.[3]));
            if (params?.[4] !== null) row.receipt = JSON.parse(String(params?.[4]));
          }
          return [];
        }
        if (text.includes("FROM erasure_requests")) {
          const row = rows.get(String(params?.[0]));
          return (row !== undefined ? [row] : []) as unknown as T[];
        }
        throw new Error(`unexpected SQL: ${text}`);
      },
      close: async () => {},
    };
    return db as unknown as Database & { rows: Map<string, Record<string, unknown>> };
  }

  it("persists the operation and replays across orchestrator instances", async () => {
    const db = fakeDb();
    const retention = new RetentionService([new FakeTarget("a", { erased: 4 })]);
    const orch = createErasureOrchestrator({ retention, database: db });
    const req = request();
    const op = await orch.execute(req);
    expect(op.status).toBe("complete");
    expect(db.rows.size).toBe(1);

    // A fresh orchestrator over the same DB replays without re-erasing.
    const secondTarget = new FakeTarget("a", { erased: 4 });
    const orch2 = createErasureOrchestrator({
      retention: new RetentionService([secondTarget]),
      database: db,
    });
    const replay = await orch2.execute(req);
    expect(replay.results).toEqual(op.results);
    expect(secondTarget.calls).toBe(0);
  });

  it("setReceipt stores the signed envelope", async () => {
    const db = fakeDb();
    const orch = createErasureOrchestrator({
      retention: new RetentionService([new FakeTarget("a")]),
      database: db,
    });
    const op = await orch.execute(request());
    await orch.setReceipt(op.requestId, { alg: "EdDSA", payload: { x: 1 } });
    const loaded = await orch.get(op.requestId);
    expect(loaded?.receipt).toEqual({ alg: "EdDSA", payload: { x: 1 } });
  });
});

describe("createErasureOrchestrator — aggregation honesty (Req 2.10 basis)", () => {
  const cases: { readonly results: ErasureStoreResult[]; readonly expected: ErasureOperationStatus }[] = [
    { results: [], expected: "complete" },
    {
      results: [
        { store: "a", status: "ok", erased: 1 },
        { store: "b", status: "not_configured", erased: 0 },
      ],
      expected: "complete",
    },
    {
      results: [
        { store: "a", status: "ok", erased: 1 },
        { store: "b", status: "failed", erased: 0, error: "x" },
      ],
      expected: "partial",
    },
    {
      results: [
        { store: "a", status: "failed", erased: 0, error: "x" },
        { store: "b", status: "failed", erased: 0, error: "y" },
      ],
      expected: "failed",
    },
  ];
  for (const { results, expected } of cases) {
    it(`aggregate over [${results.map((r) => r.status).join(", ")}] is ${expected}`, async () => {
      // Drive the orchestrator with a retention service whose targets produce
      // exactly these local statuses (not_configured via a remote stub).
      const retention = new RetentionService(
        results
          .filter((r) => r.status !== "not_configured")
          .map(
            (r) =>
              new FakeTarget(
                r.store,
                r.status === "failed" ? { error: r.error } : { erased: r.erased },
              ),
          ),
      );
      const nc = results.filter((r) => r.status === "not_configured");
      const fetchImpl =
        nc.length > 0
          ? ((async () =>
              jsonResponse({
                requestId: "x",
                service: "stub",
                results: nc.map((r) => ({ ...r, store: `stub.${r.store}` })),
              })) as unknown as typeof fetch)
          : undefined;
      const orch = createErasureOrchestrator({
        retention,
        ...(fetchImpl !== undefined
          ? { targets: [{ service: "stub", url: "http://x/v1/erasure", tokenEnv: "T" }], fetchImpl, envLookup: () => "t" }
          : {}),
      });
      const op = await orch.execute(request());
      expect(op.status).toBe(expected);
      expect(op.erased).toBe(results.reduce((n, r) => n + r.erased, 0));
    });
  }
});

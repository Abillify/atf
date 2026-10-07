// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// vectorsearch/tests/erasure.test.ts — POST /v1/erasure (task 4.5, Req 2.5).
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  createErasureHandler,
  type ErasureHandlerOptions,
} from "../src/handlers/erasure.js";
import {
  MemoryInvocationLedger,
  type InvocationLedger,
} from "../src/invocation-ledger.js";
import type { PostgresClient } from "../src/postgres-client.js";
import type { ErasureRequest } from "@atf/erasure-contract";

// ─── Mock factories ───────────────────────────────────────────────────────────

type ErasurePostgres = Pick<
  PostgresClient,
  "delete" | "listCollections" | "queryInvocationLedger"
>;

interface MockPgOptions {
  collections?: string[];
  /** Rows returned for the subject root-ref SELECT / COUNT queries. */
  queryRows?: Record<string, string>[];
  queryRowCount?: number;
  deleteDeleted?: number;
  deleteFail?: string;
  queryFail?: Error;
}

function createMockPg(options: MockPgOptions = {}): ErasurePostgres & {
  delete: ReturnType<typeof vi.fn>;
  listCollections: ReturnType<typeof vi.fn>;
  queryInvocationLedger: ReturnType<typeof vi.fn>;
} {
  return {
    delete: vi.fn().mockImplementation(async () =>
      options.deleteFail
        ? { ok: false, error: { message: options.deleteFail } }
        : { ok: true, result: { deleted: options.deleteDeleted ?? 0 } },
    ),
    listCollections: vi.fn().mockResolvedValue({
      ok: true,
      result: (options.collections ?? ["documents"]).map((collection) => ({
        collection,
        table: `vs_chunks_${collection}`,
      })),
    }),
    queryInvocationLedger: vi.fn().mockImplementation(async () => {
      if (options.queryFail) throw options.queryFail;
      const rows = options.queryRows ?? [];
      return { rows, rowCount: options.queryRowCount ?? rows.length };
    }),
  };
}

function mockReq(
  body: unknown,
  headers: Record<string, string> = {},
  principal: Record<string, unknown> = { source: "service" },
) {
  return {
    body,
    headers,
    locals: {},
    principal,
  } as unknown as import("express").Request;
}

function mockRes() {
  const res = { statusCode: 200, body: null as unknown };
  const r = res as typeof res & {
    status: (code: number) => typeof r;
    json: (data: unknown) => typeof r;
  };
  r.status = (code: number) => {
    r.statusCode = code;
    return r;
  };
  r.json = (data: unknown) => {
    r.body = data;
    return r;
  };
  return r;
}

const logger = pino({ level: "silent" });

function request(overrides: Partial<ErasureRequest> = {}): ErasureRequest {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    tenantId: "acme",
    scope: "subject",
    subject: { userId: "user-42" },
    references: undefined,
    dryRun: false,
    ...overrides,
  };
}

function buildHandler(
  pg: ErasurePostgres,
  ledger: InvocationLedger = new MemoryInvocationLedger(),
  overrides: Partial<ErasureHandlerOptions> = {},
) {
  return createErasureHandler({
    postgresClient: pg,
    ledger,
    subjectMetadataField: "subject",
    statsQueryPepper: null,
    logger,
    ...overrides,
  });
}

async function run(
  handler: ReturnType<typeof buildHandler>,
  req: import("express").Request,
) {
  const res = mockRes();
  const next = vi.fn();
  await handler(req, res as never, next);
  return { res, next };
}

// ─── Validation & authorization ───────────────────────────────────────────────

describe("erasure handler — validation", () => {
  it("rejects a body without requestId with 400", async () => {
    const handler = buildHandler(createMockPg());
    const { res } = await run(
      handler,
      mockReq({ tenantId: "acme", scope: "subject" }),
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { code: string }).code).toBe(
      "ERASURE_REQUEST_INVALID",
    );
  });

  it("rejects scope=subject without any subject identifier", async () => {
    const handler = buildHandler(createMockPg());
    const { res } = await run(
      handler,
      mockReq({
        requestId: "11111111-1111-4111-8111-111111111111",
        tenantId: "acme",
        scope: "subject",
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("rejects scope=reference without references", async () => {
    const handler = buildHandler(createMockPg());
    const { res } = await run(
      handler,
      mockReq({
        requestId: "11111111-1111-4111-8111-111111111111",
        tenantId: "acme",
        scope: "reference",
      }),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("erasure handler — tenant binding", () => {
  it("403 TENANT_MISMATCH when the credential tenant differs", async () => {
    const handler = buildHandler(createMockPg());
    const { res } = await run(
      handler,
      mockReq(request(), {}, { source: "service", tenantId: "other" }),
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { code: string }).code).toBe("TENANT_MISMATCH");
  });

  it("uses the request tenant when the credential carries none", async () => {
    const pg = createMockPg({ deleteDeleted: 2 });
    const handler = buildHandler(pg);
    const { res } = await run(
      handler,
      mockReq(
        request({
          scope: "reference",
          subject: undefined,
          references: ["ref-a"],
        }),
      ),
    );
    expect(res.statusCode).toBe(200);
    // The effective scope must carry the request tenant.
    const scopeArg = pg.delete.mock.calls[0]?.[2] as { tenantId: string };
    expect(scopeArg.tenantId).toBe("acme");
  });
});

// ─── Scope handling ───────────────────────────────────────────────────────────

describe("erasure handler — scopes", () => {
  it("reference scope deletes every reference and sums the result", async () => {
    const pg = createMockPg({ deleteDeleted: 3 });
    const handler = buildHandler(pg);
    const { res } = await run(
      handler,
      mockReq(
        request({
          scope: "reference",
          subject: undefined,
          references: ["ref-a", "ref-b"],
        }),
      ),
    );
    expect(res.statusCode).toBe(200);
    expect(pg.delete).toHaveBeenCalledTimes(2);
    const body = res.body as {
      service: string;
      results: { store: string; status: string; erased: number }[];
    };
    expect(body.service).toBe("search");
    const docs = body.results.find((r) => r.store === "search.documents");
    expect(docs).toMatchObject({ status: "ok", erased: 6 });
    const ledgerStore = body.results.find((r) => r.store === "search.invocation_ledger");
    expect(ledgerStore).toMatchObject({ status: "ok", erased: 0 });
  });

  it("subject scope folds child rows onto parents and deletes per root", async () => {
    const pg = createMockPg({
      deleteDeleted: 4,
      queryRows: [{ root_ref: "doc-1" }, { root_ref: "doc-2" }],
    });
    const handler = buildHandler(pg);
    const { res } = await run(handler, mockReq(request()));
    expect(res.statusCode).toBe(200);
    expect(pg.delete).toHaveBeenCalledTimes(2);
    expect(pg.delete.mock.calls[0]?.[3]).toBe("doc-1");
    expect(pg.delete.mock.calls[1]?.[3]).toBe("doc-2");
    // The subject predicate must use allowed_users and the metadata field.
    const sql = String(pg.queryInvocationLedger.mock.calls[0]?.[0]);
    expect(sql).toContain("allowed_users");
    expect(sql).toContain("parent_ref");
    const params = pg.queryInvocationLedger.mock.calls[0]?.[1] as unknown[];
    expect(params).toEqual(["acme", ["user-42"], "subject"]);
  });

  it("tenant scope wipes every collection and system table", async () => {
    const pg = createMockPg({ queryRowCount: 5 });
    const handler = buildHandler(pg);
    const { res } = await run(
      handler,
      mockReq(request({ scope: "tenant", subject: undefined })),
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      results: { store: string; status: string; erased: number }[];
    };
    const docs = body.results.find((r) => r.store === "search.documents");
    // 1 collection table + 10 system tables, 5 rows each.
    expect(docs).toMatchObject({ status: "ok", erased: 55 });
    const stats = body.results.find((r) => r.store === "search.stats");
    expect(stats).toMatchObject({ status: "ok", erased: 5 });
    const deleteSql = pg.queryInvocationLedger.mock.calls.map(
      (c) => String(c[0]),
    );
    expect(deleteSql.some((s) => s.includes('DELETE FROM "vs_revisions"'))).toBe(
      true,
    );
    expect(
      deleteSql.some((s) => s.includes("DELETE FROM vs_search_stats")),
    ).toBe(true);
  });

  it("treats a missing system table (42P01) as a truthful zero", async () => {
    const err = Object.assign(new Error("relation does not exist"), {
      code: "42P01",
    });
    const pg = createMockPg({ queryRowCount: 1 });
    pg.queryInvocationLedger.mockImplementation(async (sql: string) => {
      if (String(sql).includes("vs_mail_messages")) throw err;
      return { rows: [], rowCount: 1 };
    });
    const handler = buildHandler(pg);
    const { res } = await run(
      handler,
      mockReq(request({ scope: "tenant", subject: undefined })),
    );
    const body = res.body as {
      results: { store: string; status: string }[];
    };
    expect(
      body.results.find((r) => r.store === "search.documents")?.status,
    ).toBe("ok");
  });

  it("X-Collection restricts the erasure to one collection", async () => {
    const pg = createMockPg({ collections: ["a", "b"], deleteDeleted: 1 });
    const handler = buildHandler(pg);
    await run(
      handler,
      mockReq(
        request({ scope: "reference", subject: undefined, references: ["r"] }),
        { "x-collection": "b" },
      ),
    );
    expect(pg.listCollections).not.toHaveBeenCalled();
    expect(pg.delete.mock.calls[0]?.[1]).toBe("b");
  });
});

// ─── dryRun ───────────────────────────────────────────────────────────────────

describe("erasure handler — dryRun", () => {
  it("counts instead of deleting", async () => {
    const pg = createMockPg({ queryRows: [{ n: "7" }] });
    const handler = buildHandler(pg);
    const { res } = await run(
      handler,
      mockReq(request({ dryRun: true })),
    );
    expect(res.statusCode).toBe(200);
    expect(pg.delete).not.toHaveBeenCalled();
    const body = res.body as {
      results: { store: string; erased: number }[];
    };
    expect(
      body.results.find((r) => r.store === "search.documents")?.erased,
    ).toBe(7);
    const countSql = String(pg.queryInvocationLedger.mock.calls[0]?.[0]);
    expect(countSql).toContain("COUNT(*)");
  });
});

// ─── Stats hashing ────────────────────────────────────────────────────────────

describe("erasure handler — stats", () => {
  it("subject scope deletes stats by plain SHA-256 without pepper", async () => {
    const pg = createMockPg();
    const handler = buildHandler(pg);
    await run(handler, mockReq(request()));
    const statsCall = pg.queryInvocationLedger.mock.calls.find((c) =>
      String(c[0]).includes("vs_search_stats"),
    );
    expect(statsCall).toBeDefined();
    const hashes = statsCall?.[1]?.[1] as string[];
    expect(hashes).toEqual([
      createHash("sha256").update("user-42").digest("hex"),
    ]);
  });

  it("subject scope deletes stats by HMAC when a pepper is set", async () => {
    const { createHmac } = await import("node:crypto");
    const pg = createMockPg();
    const handler = buildHandler(pg, new MemoryInvocationLedger(), {
      statsQueryPepper: "pepper-1",
    });
    await run(handler, mockReq(request()));
    const statsCall = pg.queryInvocationLedger.mock.calls.find((c) =>
      String(c[0]).includes("vs_search_stats"),
    );
    const hashes = statsCall?.[1]?.[1] as string[];
    expect(hashes).toEqual([
      createHmac("sha256", "pepper-1").update("user-42").digest("hex"),
    ]);
  });
});

// ─── Partial / total failure ──────────────────────────────────────────────────

describe("erasure handler — failure reporting", () => {
  it("207 when a store fails but others succeed", async () => {
    const pg = createMockPg({ deleteDeleted: 2, deleteFail: "boom" });
    // delete fails, stats succeeds → documents failed, stats ok → 207.
    const handler = buildHandler(pg);
    const { res } = await run(
      handler,
      mockReq(
        request({ scope: "reference", subject: undefined, references: ["r"] }),
      ),
    );
    expect(res.statusCode).toBe(207);
    const body = res.body as {
      results: { store: string; status: string; error?: string }[];
    };
    const docs = body.results.find((r) => r.store === "search.documents");
    expect(docs?.status).toBe("failed");
    expect(docs?.error).toContain("boom");
  });

  it("502 when every store fails", async () => {
    // Subject scope: the root-ref SELECT and the stats DELETE both go through
    // queryInvocationLedger — failing it fails both data stores.
    const pg = createMockPg();
    pg.queryInvocationLedger.mockRejectedValue(new Error("db down"));
    const handler = buildHandler(pg);
    const { res } = await run(handler, mockReq(request()));
    expect(res.statusCode).toBe(502);
  });
});

// ─── Idempotency ──────────────────────────────────────────────────────────────

describe("erasure handler — idempotency", () => {
  it("replays a committed request with the stored result", async () => {
    const pg = createMockPg({ deleteDeleted: 3 });
    const ledger = new MemoryInvocationLedger();
    const handler = buildHandler(pg, ledger);
    const req = request({
      scope: "reference",
      subject: undefined,
      references: ["r"],
    });
    const first = await run(handler, mockReq(req));
    expect(first.res.statusCode).toBe(200);
    const second = await run(handler, mockReq(req));
    expect(second.res.statusCode).toBe(200);
    expect(second.res.body).toEqual(first.res.body);
    // The replay must not touch the data again.
    expect(pg.delete).toHaveBeenCalledTimes(1);
  });

  it("409 IDEMPOTENCY_KEY_MISMATCH when the payload differs", async () => {
    const ledger = new MemoryInvocationLedger();
    const handler = buildHandler(createMockPg({ deleteDeleted: 1 }), ledger);
    const base = {
      scope: "reference" as const,
      subject: undefined,
    };
    await run(
      handler,
      mockReq(request({ ...base, references: ["r1"] })),
    );
    const { res } = await run(
      handler,
      mockReq(request({ ...base, references: ["r2"] })),
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_MISMATCH",
    );
  });

  it("409 INVOCATION_IN_FLIGHT while another attempt runs", async () => {
    const ledger: InvocationLedger = {
      durability: "memory",
      claim: vi.fn().mockResolvedValue({
        kind: "in_flight",
        record: { state: "running" },
      } as never),
      transition: vi.fn(),
    };
    const handler = buildHandler(createMockPg(), ledger);
    const { res } = await run(handler, mockReq(request()));
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe("INVOCATION_IN_FLIGHT");
  });

  /**
   * Ledger wrapper that records the key/fingerprint the handler actually
   * used — the fingerprint is computed over the zod-parsed request (with
   * defaults applied), so tests must not recompute it from the raw body.
   */
  function recordingLedger(inner = new MemoryInvocationLedger()) {
    const seen: { key: string; fingerprint: string }[] = [];
    const wrapper: InvocationLedger & {
      inner: MemoryInvocationLedger;
      last: () => { key: string; fingerprint: string };
    } = {
      durability: "memory",
      inner,
      last: () => seen[seen.length - 1] as { key: string; fingerprint: string },
      claim: async (key, fingerprint) => {
        seen.push({ key, fingerprint });
        return inner.claim(key, fingerprint);
      },
      transition: (key, fingerprint, state, result) =>
        inner.transition(key, fingerprint, state, result),
    };
    return wrapper;
  }

  it("retries a failed (terminal) request instead of replaying it", async () => {
    const pg = createMockPg({ deleteDeleted: 1 });
    const ledger = recordingLedger();
    const handler = buildHandler(pg, ledger);
    const req = request({
      scope: "reference",
      subject: undefined,
      references: ["r"],
    });
    // First attempt commits, then force the record into `failed`.
    await run(handler, mockReq(req));
    const { key, fingerprint } = ledger.last();
    await ledger.inner.transition(key, fingerprint, "failed");
    const { res } = await run(handler, mockReq(req));
    expect(res.statusCode).toBe(200);
    // The retry deletes again (idempotent at the data level).
    expect(pg.delete).toHaveBeenCalledTimes(2);
  });

  it("transitions to failed and forwards to next() on unexpected errors", async () => {
    const pg = createMockPg();
    pg.listCollections.mockRejectedValue(new Error("connection lost"));
    const ledger = recordingLedger();
    const handler = buildHandler(pg, ledger);
    const { res, next } = await run(handler, mockReq(request()));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200); // untouched — next() owns the response
    const { key, fingerprint } = ledger.last();
    const claim = await ledger.inner.claim(key, fingerprint);
    // The failed transition already happened; a re-claim sees terminal.
    expect(claim.kind).toBe("terminal");
  });
});

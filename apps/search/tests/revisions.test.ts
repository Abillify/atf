// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * HTTP-level tests for the v2 revision routes. These exercise the
 * handlers through a real Express app with a fake RevisionStore, so they pin:
 *   - route wiring and path-param parsing (ref/rev/seq/n)
 *   - the Idempotency-Key / Content-Digest headers reaching the store
 *   - status-code mapping (201 create vs 200 replay, 200 no-op, 409 conflict,
 *     422 validation with issues, 409 missing ranges)
 *   - tenant enforcement (no tenant ⇒ 403) and that a denying collection-ACL
 *     middleware blocks the route before the handler runs
 *
 * The store's own SQL semantics (idempotency, digest 200/409, TTL reap,
 * heartbeat) are covered against a real database in
 * revision-store.integration.test.ts.
 */

import express from "express";
import type { Logger } from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "../src/access-scope.js";
import { createRevisionHandlers } from "../src/handlers/revisions.js";
import type {
  CreatedRevision,
  RevisionStore,
  RevisionStoreResult,
} from "../src/revision-store.js";

const TTL_MS = 1000 * 60 * 60;
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

function okResult<T>(result: T): RevisionStoreResult<T> {
  return { ok: true, result };
}

/** Build a store whose methods are vi.fn() so a test can assert the args. */
function fakeStore(overrides: Partial<RevisionStore> = {}): RevisionStore {
  const revision: CreatedRevision = {
    created: true,
    revision: {
      revisionId: "rev-1",
      reference: "akte/doc.pdf",
      status: "staging",
      visibility: "on_commit",
      createdAt: new Date().toISOString(),
    },
  };
  return {
    ensureSchema: vi.fn(async () => {}),
    createRevision: vi.fn(async () => okResult(revision)),
    stageBatch: vi.fn(async () =>
      okResult({ seq: 0, digest: "a".repeat(64), status: "received", noop: false }),
    ),
    getRevisionState: vi.fn(async () =>
      okResult({
        revisionId: "rev-1",
        reference: "akte/doc.pdf",
        status: "partial",
        visibility: "on_commit",
        acceptedBatches: [0],
        processedPages: [],
        missingAssets: [],
        committedSegments: [],
        pagesAvailable: 0,
        commitPending: false,
      }),
    ),
    commitSegment: vi.fn(async () =>
      okResult({ reference: "akte/doc.pdf", revisionId: "rev-1", committed: true, segment: 0, missingRanges: [] }),
    ),
    finalCommit: vi.fn(async () =>
      okResult({ reference: "akte/doc.pdf", revisionId: "rev-1", committed: true, isLatest: true, missingRanges: [], pending: false }),
    ),
    abortRevision: vi.fn(async () => okResult({ aborted: true })),
    heartbeat: vi.fn(async () => okResult({ ttlExpiresAt: new Date().toISOString() })),
    reapExpired: vi.fn(async () => okResult({ reaped: 0 })),
    ...overrides,
  };
}

/**
 * Mount the revision handlers behind a stand-in for the auth / collection-ACL
 * chain. `scope` mirrors what collectionAccessHeader puts in res.locals; when
 * `denyAcl` is set the ACL middleware answers 403 before the handler runs.
 */
function makeApp(
  store: RevisionStore,
  options: { scope?: Partial<AccessScope> | null; denyAcl?: boolean } = {},
): express.Express {
  const app = express();
  const handlers = createRevisionHandlers(store, { revisionTtlMs: TTL_MS, logger: noopLogger });

  const aclMiddleware: express.RequestHandler = (_req, res, next) => {
    if (options.denyAcl) {
      res.status(403).json({ error: "Access denied to collection", code: "AUTH_SCOPE_DENIED" });
      return;
    }
    const scope =
      options.scope === null
        ? undefined
        : { tenantId: "t-1", userId: "u-1", userGroups: [], scopes: [], service: false, ...options.scope };
    if (scope) res.locals.accessScope = scope;
    res.locals.resolvedCollection = "documents";
    next();
  };

  app.post("/v2/documents/:ref/revisions", aclMiddleware, handlers.create);
  app.put(
    "/v2/documents/:ref/revisions/:rev/batches/:seq",
    aclMiddleware,
    express.raw({ type: () => true, limit: "10mb" }),
    handlers.putBatch,
  );
  app.get("/v2/documents/:ref/revisions/:rev", aclMiddleware, handlers.getState);
  app.post("/v2/documents/:ref/revisions/:rev/segments/:n/commit", aclMiddleware, handlers.commitSegment);
  app.post("/v2/documents/:ref/revisions/:rev/commit", aclMiddleware, handlers.commit);
  app.post("/v2/documents/:ref/revisions/:rev/heartbeat", aclMiddleware, handlers.heartbeat);
  app.delete("/v2/documents/:ref/revisions/:rev", aclMiddleware, handlers.abort);
  return app;
}

const REF = encodeURIComponent("akte/2026/doc.pdf");
const DIGEST = `${"a".repeat(64)}`;

describe("v2 revision routes", () => {
  let store: RevisionStore;

  beforeEach(() => {
    store = fakeStore();
  });

  it("POST creates a revision (201) and forwards the Idempotency-Key", async () => {
    const app = makeApp(store);
    const res = await request(app)
      .post(`/v2/documents/${REF}/revisions`)
      .set("Idempotency-Key", "job-42")
      .set("X-Collection", "documents");
    expect(res.status).toBe(201);
    expect(res.body.revisionId).toBe("rev-1");
    expect(store.createRevision).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "akte/2026/doc.pdf", idempotencyKey: "job-42", tenantId: "t-1", collection: "documents" }),
    );
  });

  it("POST answers 200 for an idempotent replay of the same key", async () => {
    store = fakeStore({
      createRevision: vi.fn(async () =>
        okResult({
          created: false,
          revision: {
            revisionId: "rev-1",
            reference: "akte/2026/doc.pdf",
            status: "staging",
            visibility: "on_commit",
            createdAt: new Date().toISOString(),
            idempotencyKey: "job-42",
          },
        }),
      ),
    });
    const app = makeApp(store);
    const res = await request(app)
      .post(`/v2/documents/${REF}/revisions`)
      .set("Idempotency-Key", "job-42");
    expect(res.status).toBe(200);
    expect(res.body.revisionId).toBe("rev-1");
  });

  it("PUT batch forwards the Content-Digest and body, returns the ack", async () => {
    const app = makeApp(store);
    const res = await request(app)
      .put(`/v2/documents/${REF}/revisions/rev-1/batches/0`)
      .set("Content-Digest", DIGEST)
      .set("Content-Type", "application/x-ndjson")
      .send('{"type":"page"}\n');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("received");
    const call = (store.stageBatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.seq).toBe(0);
    expect(call.contentDigest).toBe(DIGEST);
    expect(Buffer.isBuffer(call.body)).toBe(true);
  });

  it("PUT batch requires a Content-Digest header", async () => {
    const app = makeApp(store);
    const res = await request(app)
      .put(`/v2/documents/${REF}/revisions/rev-1/batches/0`)
      .set("Content-Type", "application/x-ndjson")
      .send('{"type":"page"}\n');
    expect(res.status).toBe(400);
    expect(store.stageBatch).not.toHaveBeenCalled();
  });

  it("PUT batch rejects a non-integer seq", async () => {
    const app = makeApp(store);
    const res = await request(app)
      .put(`/v2/documents/${REF}/revisions/rev-1/batches/abc`)
      .set("Content-Digest", DIGEST)
      .set("Content-Type", "application/x-ndjson")
      .send("x");
    expect(res.status).toBe(400);
  });

  it("PUT batch maps a digest conflict to 409", async () => {
    store = fakeStore({
      stageBatch: vi.fn(async () => ({
        ok: false as const,
        error: { status: 409, code: "BATCH_DIGEST_CONFLICT", message: "different digest" },
      })),
    });
    const app = makeApp(store);
    const res = await request(app)
      .put(`/v2/documents/${REF}/revisions/rev-1/batches/0`)
      .set("Content-Digest", DIGEST)
      .set("Content-Type", "application/x-ndjson")
      .send("x");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BATCH_DIGEST_CONFLICT");
  });

  it("PUT batch surfaces contract validation issues (422)", async () => {
    store = fakeStore({
      stageBatch: vi.fn(async () => ({
        ok: false as const,
        error: {
          status: 422,
          code: "BATCH_VALIDATION_FAILED",
          message: "bad batch",
          issues: [{ path: "line[0].size", message: "required", severity: "error" as const }],
        },
      })),
    });
    const app = makeApp(store);
    const res = await request(app)
      .put(`/v2/documents/${REF}/revisions/rev-1/batches/0`)
      .set("Content-Digest", DIGEST)
      .set("Content-Type", "application/x-ndjson")
      .send("x");
    expect(res.status).toBe(422);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].path).toBe("line[0].size");
  });

  it("GET returns the RevisionState shape", async () => {
    const app = makeApp(store);
    const res = await request(app).get(`/v2/documents/${REF}/revisions/rev-1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      revisionId: "rev-1",
      status: "partial",
      acceptedBatches: [0],
      processedPages: [],
      missingAssets: [],
      committedSegments: [],
    });
  });

  it("POST segment commit forwards the segment number", async () => {
    const app = makeApp(store);
    const res = await request(app).post(`/v2/documents/${REF}/revisions/rev-1/segments/2/commit`);
    expect(res.status).toBe(200);
    expect(store.commitSegment).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: "rev-1", segment: 2 }),
    );
  });

  it("POST final commit returns 409 with the missing ranges", async () => {
    store = fakeStore({
      finalCommit: vi.fn(async () => ({
        ok: false as const,
        error: {
          status: 409,
          code: "COMMIT_MISSING_BATCHES",
          message: "missing",
          missingRanges: [{ from: 101, to: 200 }],
        },
      })),
    });
    const app = makeApp(store);
    const res = await request(app).post(`/v2/documents/${REF}/revisions/rev-1/commit`);
    expect(res.status).toBe(409);
    expect(res.body.missingRanges).toEqual([{ from: 101, to: 200 }]);
  });

  it("DELETE aborts the revision", async () => {
    const app = makeApp(store);
    const res = await request(app).delete(`/v2/documents/${REF}/revisions/rev-1`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("aborted");
    expect(store.abortRevision).toHaveBeenCalled();
  });

  it("POST heartbeat extends the TTL", async () => {
    const app = makeApp(store);
    const res = await request(app).post(`/v2/documents/${REF}/revisions/rev-1/heartbeat`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(store.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t-1" }),
      "rev-1",
      TTL_MS,
    );
  });

  it("rejects a request without a tenant context (403)", async () => {
    const app = makeApp(store, { scope: null });
    const res = await request(app).post(`/v2/documents/${REF}/revisions`);
    expect(res.status).toBe(403);
    expect(store.createRevision).not.toHaveBeenCalled();
  });

  it("a denying collection-ACL middleware blocks the route before the handler", async () => {
    const app = makeApp(store, { denyAcl: true });
    const res = await request(app)
      .post(`/v2/documents/${REF}/revisions`)
      .set("Idempotency-Key", "job-42");
    expect(res.status).toBe(403);
    expect(store.createRevision).not.toHaveBeenCalled();
  });
  it("forwards the {ref} path param so the store can reject a foreign revision", async () => {
    const app = makeApp(store);
    await request(app).get(`/v2/documents/${REF}/revisions/rev-1`);
    expect(store.getRevisionState).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t-1", reference: "akte/2026/doc.pdf" }),
      "rev-1",
    );
    await request(app).post(`/v2/documents/${REF}/revisions/rev-1/commit`);
    expect(store.finalCommit).toHaveBeenCalledWith(
      expect.objectContaining({ reference: "akte/2026/doc.pdf", revisionId: "rev-1" }),
    );
  });

  it("maps a reference mismatch from the store to 409", async () => {
    store = fakeStore({
      abortRevision: vi.fn(async () => ({
        ok: false as const,
        error: { status: 409, code: "REVISION_REFERENCE_MISMATCH", message: "other document" },
      })),
    });
    const res = await request(makeApp(store)).delete(`/v2/documents/${REF}/revisions/rev-1`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REVISION_REFERENCE_MISMATCH");
  });

  it("answers 202 for an accepted final commit that waits for batch processing", async () => {
    store = fakeStore({
      finalCommit: vi.fn(async () =>
        okResult({ reference: "akte/doc.pdf", revisionId: "rev-1", committed: true, isLatest: false, missingRanges: [], pending: true }),
      ),
    });
    const res = await request(makeApp(store)).post(`/v2/documents/${REF}/revisions/rev-1/commit`);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ committed: true, isLatest: false, pending: true });
  });

  it("accepts a v2 X-Extract-Contract and rejects an incompatible major (422) or a malformed id (400)", async () => {
    const app = makeApp(store);
    const okRes = await request(app)
      .post(`/v2/documents/${REF}/revisions`)
      .set("X-Extract-Contract", "atf-extract/2.3.1");
    expect(okRes.status).toBe(201);

    const v1 = await request(app)
      .put(`/v2/documents/${REF}/revisions/rev-1/batches/0`)
      .set("X-Extract-Contract", "atf-extract/1.4.0")
      .set("Content-Digest", DIGEST)
      .set("Content-Type", "application/x-ndjson")
      .send('{"type":"page"}\n');
    expect(v1.status).toBe(422);
    expect(v1.body.code).toBe("INCOMPATIBLE_EXTRACT_CONTRACT");

    const bad = await request(app)
      .post(`/v2/documents/${REF}/revisions/rev-1/commit`)
      .set("X-Extract-Contract", "not a contract");
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("INVALID_EXTRACT_CONTRACT");
    expect(store.stageBatch).not.toHaveBeenCalled();
    expect(store.finalCommit).not.toHaveBeenCalled();
  });
});

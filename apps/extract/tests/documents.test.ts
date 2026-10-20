// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * documents.test.ts
 *
 * `DELETE /v2/documents/{reference}` (extract-outpost E2, requirements 9.1,
 * 9.3, 9.7–9.9) against the real router mounted by `createApp` with the
 * in-memory job store and a Search-Client stub.
 *
 * The two properties mirror what the Outpost's mirror-delete loop relies on:
 * repeated deletes of one reference must be idempotent from the caller's view
 * (first call 200, every later call 404, nothing else touched — Property 27),
 * and a credential without `extract.delete` must never reach a job cancel or
 * Search at all (Property 40). The unit cases cover the error taxonomy:
 * 400 invalid collection, 401 without a token, 404 for a reference Search
 * never held, 502 when Search fails, and the cancel-before-delete ordering
 * that stops an in-flight job from re-creating the document.
 */

import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import { createFakeJobStore, type FakeJobStore } from "./job-store-fake.js";
import {
  loadTestConfig,
  stubExtractor,
  stubSearchClient,
  stubVisionClient,
  testLogger,
  type RecordingSearchClient,
} from "./helpers.js";
import { HttpMetrics } from "../src/http-metrics.js";
import { ingestFailed } from "../src/errors.js";
import type { JobRow } from "../src/persistence/types.js";

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Mount `app` on one stable loopback URL for the duration of a test.
 *
 * Supertest creates — and closes — a fresh `http.Server` for every request
 * when handed the Express function (`supertest/lib/test.js`: `if (!addr)
 * this._server = app.listen(0)`). A property test with a few hundred requests
 * therefore churns a few hundred ephemeral ports per second; the OS reissues a
 * just-closed port to another local process, and the next request is answered
 * by *that* process — observed as a foreign `403 "Invalid CSRF token"` or a
 * 501 that no assertion in this file can explain. High-volume tests share one
 * listening socket instead.
 */
async function serve(app: ReturnType<typeof createApp>["app"]): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    // Keep-alive sockets would hold close() open indefinitely.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Build an app from `configOverrides`/`overrides` and mount it on a stable
 * loopback URL. Every request in this file goes through such a URL rather than
 * the Express function, so supertest reuses one socket instead of opening and
 * closing an ephemeral-port server per request (see serve()).
 */
async function buildApp(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
): Promise<string> {
  const config = loadTestConfig(configOverrides);
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    ...overrides,
  });
  cleanups.push(created.cleanup);
  return serve(created.app);
}

/**
 * A Search stub that models *existence*: the delete removes the reference from
 * the set the holder currently points at and reports `deleted: 1` only while
 * it was there. This is what makes the idempotence property meaningful — a
 * stub that always answered `deleted: 1` would hide a router that reports 200
 * forever.
 *
 * The set lives behind a holder so one mounted app (and one listening socket)
 * can serve every property run: building an app per run would churn a few
 * hundred ephemeral ports, and a pooled connection landing on a port the OS has
 * already handed to another local process answers with that process's error —
 * which looks exactly like a broken router.
 */
function indexBackedSearchClient(
  holder: { current: Set<string> },
): RecordingSearchClient {
  const base = stubSearchClient();
  const client: RecordingSearchClient = {
    ...base,
    async deleteByReference(args) {
      base.deleteCalls.push({
        reference: args.reference,
        collection: args.collection,
        identity: args.identity,
      });
      const existed = holder.current.delete(indexKey(args.collection, args.reference));
      return { deleted: existed ? 1 : 0 };
    },
  };
  return client;
}

const indexKey = (collection: string, reference: string): string =>
  `${collection}\\u0000${reference}`;

// ── Property 27: idempotency of erasure by reference ───────────────────────

// Feature: extract-outpost, Property 27: idempotency of erasure by reference (Extract)
// **Validates: Requirements 9.3, 9.7, 9.9**
describe("Property 27: delete by reference is idempotent", () => {
  // Path-parameter-safe reference alphabet; the handler trims, so a reference
  // equal to its trimmed form keeps the model (and the seeded index) exact.
  const referenceArb = fc
    .array(fc.constantFrom(..."abcXYZ019_-.".split("")), { minLength: 1, maxLength: 18 })
    .map((chars) => chars.join(""))
    .filter((r) => r === r.trim() && r !== "." && r !== "..");
  const collectionArb = fc.constantFrom("documents", "team_a", "Projekte2");

  it("first delete 200 (existing) / every later delete 404; others untouched", async () => {
    // One app and one listening socket for all 100 runs: the model state lives
    // in `holder`, which each run replaces wholesale. See serve() for why the
    // requests must not go through supertest's per-request server.
    const holder: { current: Set<string> } = { current: new Set() };
    const search = indexBackedSearchClient(holder);
    // RATE_LIMIT 0: the shared app would otherwise see up to 500 requests from
    // one IP inside a minute and answer 429 — the limiter is not what this
    // property is about.
    const config = loadTestConfig({ AUTHN_MODE: "disabled", RATE_LIMIT: "0" });
    const created = createApp(config, {
      logger: testLogger,
      vision: stubVisionClient(),
      extractor: stubExtractor(),
      probeBinary: availableBinary,
      store: createFakeJobStore(),
      searchClient: search,
    });
    cleanups.push(created.cleanup);
    const base = await serve(created.app);
    await fc.assert(
      fc.asyncProperty(
        collectionArb,
        referenceArb,
        fc.array(referenceArb, { maxLength: 3 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 5 }),
        async (collection, reference, othersRaw, existedBefore, deleteCount) => {
          const others = othersRaw.filter((o) => o !== reference);
          const held = new Set<string>(
            others.map((o) => indexKey(collection, o)),
          );
          if (existedBefore) held.add(indexKey(collection, reference));
          holder.current = held;

          const path = `/v2/documents/${encodeURIComponent(reference)}`;
          for (let i = 0; i < deleteCount; i++) {
            const res = await request(base)
              .delete(path)
              .set("X-Collection", collection);
            const expectFirst = i === 0 && existedBefore;
            expect(res.status).toBe(expectFirst ? 200 : 404);
            if (expectFirst) {
              expect(res.body).toEqual({
                status: "deleted",
                reference,
                collection,
                deleted: 1,
              });
            } else {
              expect(res.body.code).toBe("NOT_FOUND");
            }
          }
          // After the sequence Search holds no document for this reference…
          expect(held.has(indexKey(collection, reference))).toBe(false);
          // …and documents of other references are unchanged.
          for (const other of others) {
            expect(held.has(indexKey(collection, other))).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 40: scope requirement for erasures ────────────────────────────

// Feature: extract-outpost, Property 40: scope requirement for erasures (Extract)
// **Validates: Requirements 9.8**
describe("Property 40: delete requires the extract.delete scope", () => {
  const token = "d".repeat(40);
  // Scopes that do NOT grant delete. `extract.admin` is excluded on purpose:
  // like every other guard here it implies all scopes, so it belongs to the
  // "with delete authority" side of the property.
  const nonDeleteScopes = ["extract.convert", "extract.ingest", "extract.metrics"];
  const otherScopes = [...nonDeleteScopes, "extract.admin"];

  const referenceArb = fc
    .array(fc.constantFrom(..."abc019_-.".split("")), { minLength: 1, maxLength: 12 })
    .map((chars) => chars.join(""))
    .filter((r) => r === r.trim() && r !== "." && r !== "..");

  interface Harness {
    base: string;
    store: FakeJobStore;
    search: RecordingSearchClient;
  }

  // One mounted app — and one listening socket — per scope set: building an
  // app per request would churn a few hundred ephemeral ports (see serve()).
  function harnessFor(scopes: readonly string[]): Promise<Harness> {
    const cacheKey = scopes.join(",");
    const cached = harnessCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const store = createFakeJobStore();
    const search = stubSearchClient();
    const harness = buildApp(
      {
        AUTHN_MODE: "token",
        AUTHZ_ENABLED: "true",
        API_TOKEN: token,
        API_SERVICE_SCOPES: scopes.join(","),
        RATE_LIMIT: "0",
      },
      { store, searchClient: search },
    ).then((base) => ({ base, store, search }));
    harnessCache.set(cacheKey, harness);
    return harness;
  }
  const harnessCache = new Map<string, Promise<Harness>>();

  it("without extract.delete: always 403, no Search call, no job cancel", async () => {
    let jobCounter = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(nonDeleteScopes, { minLength: 1 }),
        fc.constantFrom("documents", "team_a"),
        referenceArb,
        async (scopes, collection, reference) => {
          const { base, store, search } = await harnessFor(scopes);
          // An active job of the same reference/collection: a 403 must not
          // cancel it (the guard runs before any store or Search access).
          const jobId = `00000000-0000-4000-8000-${String(jobCounter++).padStart(12, "0")}`;
          await store.createJob({
            id: jobId,
            reference,
            source_sha256: "0".repeat(64),
            collection,
            status: "queued",
          });

          const res = await request(base)
            .delete(`/v2/documents/${encodeURIComponent(reference)}`)
            .set("Authorization", `Bearer ${token}`)
            .set("X-Collection", collection);

          expect(res.status).toBe(403);
          expect(res.body.code).toBe("FORBIDDEN");
          expect(search.deleteCalls).toHaveLength(0);
          expect(store.peek(jobId)?.status).toBe("queued");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("with extract.delete (or admin): never 403", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.subarray(otherScopes), fc.boolean()),
        fc.constantFrom("documents", "team_a"),
        referenceArb,
        async ([extra, withDelete], collection, reference) => {
          const scopes = withDelete
            ? [...new Set([...extra, "extract.delete"])]
            : [...new Set([...extra, "extract.admin"])];
          const { base } = await harnessFor(scopes);
          const res = await request(base)
            .delete(`/v2/documents/${encodeURIComponent(reference)}`)
            .set("Authorization", `Bearer ${token}`)
            .set("X-Collection", collection);
          expect(res.status).not.toBe(403);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Unit: error taxonomy and cancel-before-delete (task 3.6) ───────────────

describe("DELETE /v2/documents/{reference} · error cases", () => {
  const token = "e".repeat(40);
  const tokenEnv = {
    AUTHN_MODE: "token",
    AUTHZ_ENABLED: "true",
    API_TOKEN: token,
    API_SERVICE_SCOPES: "extract.delete",
  };

  it("requires a token", async () => {
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: stubSearchClient(),
    });
    const res = await request(base).delete(
      `/v2/documents/${encodeURIComponent("tests/handbuch.pdf")}`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid collection name with 400", async () => {
    const search = stubSearchClient();
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: search,
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("a.pdf")}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Collection", "9bad-name!");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(search.deleteCalls).toHaveLength(0);
  });

  it("rejects a blank reference with 400", async () => {
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: stubSearchClient(),
    });
    const res = await request(base)
      .delete("/v2/documents/%20%20")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  it("maps a Search failure to 502 INGEST_FAILED", async () => {
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: stubSearchClient({
        deleteError: ingestFailed("Search ist nicht erreichbar"),
      }),
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("tests/handbuch.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("INGEST_FAILED");
  });

  it("answers 404 NOT_FOUND when Search deleted nothing", async () => {
    const search = stubSearchClient({ deleted: 0 });
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: search,
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("never/there.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    // The 404 is still an honest Search call — the reference was asked for.
    expect(search.deleteCalls).toHaveLength(1);
  });

  it("cancels active jobs of the same reference before deleting", async () => {
    const store = createFakeJobStore();
    const mk = (
      n: number,
      reference: string,
      collection: string | null,
      status: JobRow["status"],
    ): string => {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      void store.createJob({
        id,
        reference,
        source_sha256: "0".repeat(64),
        ...(collection !== null ? { collection } : {}),
        status,
      });
      return id;
    };
    const queued = mk(1, "docs/a.pdf", "team_a", "queued");
    const running = mk(2, "docs/a.pdf", "team_a", "processing");
    const paused = mk(3, "docs/a.pdf", "team_a", "paused");
    const completed = mk(4, "docs/a.pdf", "team_a", "completed");
    const otherRef = mk(5, "docs/b.pdf", "team_a", "queued");
    const otherColl = mk(6, "docs/a.pdf", "documents", "queued");

    // The jobs are removed after the cancel, so the cancel is observed on the transition.
    const cancelledIds: string[] = [];
    const transition = store.operatorTransition.bind(store);
    store.operatorTransition = async (id, change) => {
      const row = await transition(id, change);
      if (row !== null && change.status === "cancelled") cancelledIds.push(id);
      return row;
    };
    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient() });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Collection", "team_a");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "deleted",
      reference: "docs/a.pdf",
      collection: "team_a",
      deleted: 1,
    });
    expect(cancelledIds.sort()).toEqual([queued, running, paused].sort());
    // Every job of the document is gone afterwards — the finished one too, since its
    // checkpoints hold the page content — while other references/collections are untouched.
    for (const id of [queued, running, paused, completed]) expect(store.peek(id)).toBeUndefined();
    expect(store.peek(otherRef)?.status).toBe("queued");
    expect(store.peek(otherColl)?.status).toBe("queued");
  });

  it("cancels jobs even when the Search delete then fails", async () => {
    // Cancel-first is the point: a failing delete must not un-cancel the jobs,
    // or a still-running job would re-create the document behind the retry.
    const store = createFakeJobStore();
    const id = "00000000-0000-4000-8000-000000000007";
    await store.createJob({
      id,
      reference: "docs/a.pdf",
      source_sha256: "0".repeat(64),
      collection: "documents",
      status: "processing",
    });
    const base = await buildApp(tokenEnv, {
      store,
      searchClient: stubSearchClient({ deleteError: ingestFailed("Search down") }),
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(502);
    expect(store.peek(id)?.status).toBe("cancelled");
  });

  it("treats a null-collection job as the instance default collection", async () => {
    const store = createFakeJobStore();
    const id = "00000000-0000-4000-8000-000000000008";
    await store.createJob({
      id,
      reference: "docs/a.pdf",
      source_sha256: "0".repeat(64),
      status: "queued",
    });
    const cancelledIds: string[] = [];
    const transition = store.operatorTransition.bind(store);
    store.operatorTransition = async (jobId, change) => {
      const row = await transition(jobId, change);
      if (row !== null && change.status === "cancelled") cancelledIds.push(jobId);
      return row;
    };
    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient() });
    // No X-Collection → the instance default ("documents") also covers rows
    // stored without a collection.
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(cancelledIds).toEqual([id]);
    expect(store.peek(id)).toBeUndefined();
  });

  it("forwards the asserted identity to Search for the ACL check", async () => {
    const search = stubSearchClient();
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: search,
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna@example.com")
      .set("X-Groups", "legal,staff");
    expect(res.status).toBe(200);
    expect(search.deleteCalls).toEqual([
      {
        reference: "docs/a.pdf",
        collection: "documents",
        identity: { userId: "anna@example.com", userGroups: ["legal", "staff"] },
      },
    ]);
  });

  it("counts deletions in extract_documents_deleted_total", async () => {
    const metrics = new HttpMetrics();
    const base = await buildApp(tokenEnv, {
      store: createFakeJobStore(),
      searchClient: indexBackedSearchClient({
        current: new Set([indexKey("documents", "docs/a.pdf")]),
      }),
      metrics,
    });
    await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    await request(base)
      .delete(`/v2/documents/${encodeURIComponent("missing.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    const rendered = metrics.render();
    // One successful delete counted; the 404 adds nothing.
    expect(rendered).toMatch(/^extract_documents_deleted_total 1$/m);
  });
});

// ── What Extract keeps of a document leaves with it (P1-E8) ──────────────────
describe("DELETE /v2/documents/{reference} · Extract's own data", () => {
  const token = "f".repeat(40);
  const tokenEnv = {
    AUTHN_MODE: "token",
    AUTHZ_ENABLED: "true",
    API_TOKEN: token,
    API_SERVICE_SCOPES: "extract.delete",
  };
  const sha = (n: number): string => n.toString(16).padStart(64, "0");
  const jobId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  async function withSources(
    digests: string[],
  ): Promise<{ sourceStore: import("../src/source-store.js").SourceStore; removed: string[] }> {
    const removed: string[] = [];
    const sourceStore = {
      has: async () => true,
      locate: async () => null,
      putStream: async () => {
        throw new Error("not used");
      },
      remove: async (digest: string) => {
        removed.push(digest);
        return digests.includes(digest);
      },
    } as unknown as import("../src/source-store.js").SourceStore;
    return { sourceStore, removed };
  }

  it("removes the jobs, the upload sessions and the sources nothing else uses", async () => {
    const store = createFakeJobStore();
    await store.createJob({ id: jobId(1), reference: "docs/a.pdf", source_sha256: sha(1), collection: "documents", status: "completed" });
    // The same bytes under another reference keep sha(2) alive; sha(1) becomes an orphan.
    await store.createJob({ id: jobId(2), reference: "docs/a.pdf", source_sha256: sha(2), collection: "documents", status: "completed" });
    await store.createJob({ id: jobId(3), reference: "docs/b.pdf", source_sha256: sha(2), collection: "documents", status: "completed" });
    store.seedUpload("11111111-1111-4111-8111-111111111111", "docs/a.pdf");
    store.seedUpload("22222222-2222-4222-8222-222222222222", "docs/b.pdf");
    const { sourceStore, removed } = await withSources([sha(1), sha(2)]);
    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient(), sourceStore });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(store.peek(jobId(1))).toBeUndefined();
    expect(store.peek(jobId(2))).toBeUndefined();
    expect(store.peek(jobId(3))?.status).toBe("completed");
    expect(store.peekUploads().map((u) => u.reference)).toEqual(["docs/b.pdf"]);
    expect(removed).toEqual([sha(1)]);
  });

  it("also cleans up when Search never held the reference (404)", async () => {
    const store = createFakeJobStore();
    await store.createJob({ id: jobId(1), reference: "docs/a.pdf", source_sha256: sha(1), collection: "documents", status: "failed" });
    const { sourceStore, removed } = await withSources([sha(1)]);
    const base = await buildApp(tokenEnv, {
      store,
      searchClient: indexBackedSearchClient({ current: new Set() }),
      sourceStore,
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(store.peek(jobId(1))).toBeUndefined();
    expect(removed).toEqual([sha(1)]);
  });

  it("keeps everything but the cancelled state when the Search delete fails, so the retry still finds it", async () => {
    const store = createFakeJobStore();
    await store.createJob({ id: jobId(1), reference: "docs/a.pdf", source_sha256: sha(1), collection: "documents", status: "completed" });
    const { sourceStore, removed } = await withSources([sha(1)]);
    const base = await buildApp(tokenEnv, {
      store,
      searchClient: stubSearchClient({ deleteError: ingestFailed("Search down") }),
      sourceStore,
    });
    const res = await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(502);
    expect(store.peek(jobId(1))?.status).toBe("completed");
    expect(removed).toEqual([]);
  });

  it("does not touch another collection's jobs of the same reference", async () => {
    const store = createFakeJobStore();
    await store.createJob({ id: jobId(1), reference: "docs/a.pdf", source_sha256: sha(1), collection: "team_a", status: "completed" });
    await store.createJob({ id: jobId(2), reference: "docs/a.pdf", source_sha256: sha(1), collection: "documents", status: "completed" });
    const { sourceStore, removed } = await withSources([sha(1)]);
    const base = await buildApp(tokenEnv, { store, searchClient: stubSearchClient(), sourceStore });
    await request(base)
      .delete(`/v2/documents/${encodeURIComponent("docs/a.pdf")}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Collection", "team_a")
      .expect(200);
    expect(store.peek(jobId(1))).toBeUndefined();
    expect(store.peek(jobId(2))?.status).toBe("completed");
    // The other collection's job still uses the bytes.
    expect(removed).toEqual([]);
  });
});

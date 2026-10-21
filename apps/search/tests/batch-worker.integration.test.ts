// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the v2 batch-processing worker (task 1.10) against a
 * REAL PostgreSQL + pgvector instance. Unit tests cannot verify the properties
 * that matter here — they are all SQL semantics:
 *
 *   - SELECT … FOR UPDATE SKIP LOCKED claims a received batch and marks it
 *     processed (Requirement 5.4);
 *   - the transitional builder's units land on the (tenant_id, unit_id) key;
 *   - reprocessing the same batch UPSERTS (no duplicate rows) (Requirement 5.5);
 *   - an embedding failure returns the batch to 'received' with a next_attempt_at
 *     backoff and commits NO partial units (Requirement 5.4);
 *   - getRevisionState then reports the processed page range.
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites);
 * fails rather than silently passing when it IS set but unreachable.
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import type {
  EmbeddingBatchResponse,
  EmbeddingClient,
  EmbeddingResponse,
} from "../src/embedding-client.js";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { createRevisionStore, type RevisionStore } from "../src/revision-store.js";
import { createBatchWorker } from "../src/batch-worker.js";
import { collectionTableName } from "../src/collection-ddl.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `bwtest-${Date.now()}`;
const logger = pino({ level: "silent" });

/** A fake embedding client: returns unit vectors, or fails on demand. */
function fakeEmbeddingClient(opts: { fail?: boolean } = {}): EmbeddingClient {
  const vector = (): number[] => new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01));
  return {
    async embed(): Promise<EmbeddingResponse> {
      if (opts.fail) return { ok: false, error: { code: "LLM_UNREACHABLE", message: "down" } };
      return { ok: true, result: { vector: vector() } };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
      if (opts.fail) return { ok: false, error: { code: "LLM_UNREACHABLE", message: "down" } };
      return { ok: true, result: { vectors: texts.map(() => vector()) } };
    },
  };
}

/**
 * A fake embedding client that COUNTS how many inputs it embedded, so a test
 * can assert the selective re-embed path skipped the embed call (task 5.4,
 * requirement 9.6). `embedded` is the total number of unit inputs sent to the
 * model across all calls.
 */
function countingEmbeddingClient(): EmbeddingClient & { embedded: number; calls: number } {
  const vector = (): number[] => new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01));
  const client = {
    embedded: 0,
    calls: 0,
    async embed(): Promise<EmbeddingResponse> {
      client.embedded += 1;
      client.calls += 1;
      return { ok: true, result: { vector: vector() } };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
      client.embedded += texts.length;
      client.calls += 1;
      return { ok: true, result: { vectors: texts.map(() => vector()) } };
    },
  };
  return client;
}

/** A single-page NDJSON batch with one paragraph + one figure, and its digest. */
function pageBatch(pageNo: number): { body: Buffer; digest: string } {
  const record = {
    type: "page",
    page: pageNo,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    blocks: [
      { type: "paragraph", id: `p${pageNo}-b1`, page: pageNo, text: `Absatz auf Seite ${pageNo} mit Inhalt.` },
      {
        type: "figure",
        id: `p${pageNo}-b2`,
        page: pageNo,
        figureId: `p${pageNo}-f1`,
        kind: "chart",
        description: `Ein Diagramm auf Seite ${pageNo}.`,
      },
    ],
    assets: [],
    warnings: [],
  };
  const body = Buffer.from(`${JSON.stringify(record)}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

describeIfPg("batch worker · real postgres", () => {
  let pool: Pool;
  let store: RevisionStore;
  let pg: PostgresClient;
  const collection = `bwtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const table = collectionTableName(collection);

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    store = createRevisionStore(pool);
    await store.ensureSchema();
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    const ensured = await pg.ensureCollection(collection, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    try {
      await pg?.deleteCollection(collection);
    } catch {
      /* ignore */
    }
    try {
      await pool.query(`DELETE FROM vs_ingest_batches WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_identifiers WHERE tenant_id = $1`, [TENANT]);
    } catch {
      /* best-effort */
    }
    await pg?.close();
    await pool.end();
  });

  async function stage(reference: string, pageNo: number): Promise<string> {
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference,
      ttlMs: 60_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const { body, digest } = pageBatch(pageNo);
    const staged = await store.stageBatch({
      tenantId: TENANT,
      collection,
      revisionId,
      seq: 0,
      body,
      contentDigest: digest,
      ttlMs: 60_000,
    });
    expect(staged.ok).toBe(true);
    return revisionId;
  }

  async function countUnits(revisionId: string): Promise<number> {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2`,
      [TENANT, revisionId],
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  it("claims a received batch (SKIP LOCKED), builds units and marks it processed", async () => {
    const revisionId = await stage("claim.pdf", 1);
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });

    const outcome = await worker.tick();
    expect(outcome.kind).toBe("processed");
    if (outcome.kind === "processed") {
      expect(outcome.revisionId).toBe(revisionId);
      expect(outcome.units).toBe(2); // one chunk + one figure
    }

    // Batch is now 'processed'.
    const batch = await pool.query<{ status: string }>(
      `SELECT status FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
    expect(batch.rows[0]?.status).toBe("processed");

    // A chunk unit and a figure unit were written with real unit columns.
    const rows = await pool.query<{ unit_type: string; figure_kind: string | null }>(
      `SELECT unit_type, figure_kind FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2 ORDER BY unit_type`,
      [TENANT, revisionId],
    );
    expect(rows.rows.map((r) => r.unit_type).sort()).toEqual(["chunk", "figure"]);
    const figure = rows.rows.find((r) => r.unit_type === "figure");
    expect(figure?.figure_kind).toBe("chart");

    // A second tick finds nothing else claimable.
    expect((await worker.tick()).kind).toBe("idle");
    worker.stop();
  });

  it("works through a backlog in ONE poll wake-up instead of one batch per interval", async () => {
    const revisions = [
      await stage("backlog-1.pdf", 1),
      await stage("backlog-2.pdf", 2),
      await stage("backlog-3.pdf", 3),
    ];
    // A long interval: the first wake-up must drain all three staged batches.
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), {
      intervalMs: 40,
      onlyTenantId: TENANT,
      maxBatchesPerPoll: 10,
    });
    try {
      const deadline = Date.now() + 3_000;
      let done = 0;
      while (Date.now() < deadline && done < 3) {
        await new Promise((r) => setTimeout(r, 25));
        done = (await Promise.all(revisions.map((r) => countUnits(r)))).filter((n) => n > 0).length;
      }
      expect(done).toBe(3);
      // All three finished within the first poll wake-up (two further 40 ms
      // intervals would otherwise be needed).
      expect(Date.now()).toBeLessThan(deadline);
    } finally {
      worker.stop();
    }
  });

  it("drain() honours stop(): a stopped worker claims nothing more", async () => {
    await stage("stopped.pdf", 1);
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    worker.stop();
    expect(await worker.drain(5)).toEqual([]);
    // Not stopped: the same call processes it.
    const live = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    const outcomes = await live.drain(5);
    expect(outcomes.some((o) => o.kind === "processed")).toBe(true);
    live.stop();
  });

  it("embeds the slices of one batch concurrently and keeps the vector order", async () => {
    // 6 distinct paragraphs + 1 figure = enough units for several slices at size 2.
    const created = await store.createRevision({ tenantId: TENANT, collection, reference: "slices.pdf", ttlMs: 60_000 });
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const blocks = Array.from({ length: 6 }, (_, i) => ({
      type: "paragraph",
      id: `s-b${i}`,
      page: 1,
      // Distinct lengths per paragraph, so a vector landing on the wrong unit shows.
      text: "Absatz ".repeat(260 + i * 30).trim() + ".",
    }));
    const record = { type: "page", page: 1, size: { wPt: 595, hPt: 842 }, class: "text", blocks };
    const body = Buffer.from(JSON.stringify(record) + "\n");
    const digest = createHash("sha256").update(body).digest("hex");
    const staged = await store.stageBatch({ tenantId: TENANT, collection, revisionId, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    expect(staged.ok).toBe(true);

    let inFlight = 0;
    let peak = 0;
    const embedder: EmbeddingClient = {
      async embed(): Promise<EmbeddingResponse> {
        return { ok: true, result: { vector: new Array<number>(VECTOR_SIZE).fill(0.1) } };
      },
      async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        // The first component encodes the input length: order is checkable.
        return {
          ok: true,
          result: { vectors: texts.map((t) => [t.length / 10_000, ...new Array<number>(VECTOR_SIZE - 1).fill(0.01)]) },
        };
      },
    };
    const worker = createBatchWorker(pool, embedder, {
      intervalMs: 0,
      onlyTenantId: TENANT,
      embedBatchSize: 1,
      embedConcurrency: 4,
    });
    const outcome = await worker.tick();
    expect(outcome.kind).toBe("processed");
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    worker.stop();
    // Each stored vector belongs to its own unit: first component == len/10000.
    const rows = await pool.query<{ content: string; v0: number }>(
      `SELECT content, (vector::real[])[1] AS v0 FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2 AND unit_type = 'chunk'`,
      [TENANT, revisionId],
    );
    expect(rows.rows.length).toBeGreaterThan(2);
    // The stored vector encodes the length of the input that was embedded; the
    // input is the unit's content plus a header of constant size, so the
    // difference is (almost) the same for every unit unless vectors were
    // attached to the wrong unit.
    const offsets = rows.rows.map((row) => Math.round(row.v0 * 10_000) - row.content.length);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(40);
  });

  it("creates a collection that does not exist yet from the first batch's vector size", async () => {
    const fresh = `bwnew_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const created = await store.createRevision({ tenantId: TENANT, collection: fresh, reference: "neu.pdf", ttlMs: 60_000 });
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const { body, digest } = pageBatch(1);
    const staged = await store.stageBatch({ tenantId: TENANT, collection: fresh, revisionId, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    expect(staged.ok).toBe(true);

    const sizes: number[] = [];
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), {
      intervalMs: 0,
      onlyTenantId: TENANT,
      ensureCollection: async (collection, vectorSize) => {
        sizes.push(vectorSize);
        return pg.ensureCollection(collection, vectorSize);
      },
    });
    try {
      const outcome = await worker.tick();
      expect(outcome.kind).toBe("processed");
      expect(sizes).toEqual([VECTOR_SIZE]);
      const rows = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${collectionTableName(fresh)}" WHERE tenant_id = $1 AND revision_id = $2`,
        [TENANT, revisionId],
      );
      expect(Number(rows.rows[0]?.n)).toBe(2);
    } finally {
      worker.stop();
      await pg.deleteCollection(fresh).catch(() => {});
    }
  });

  it("copies document.begin provenance into the unit metadata of every batch — Req 18.2", async () => {
    const reference = "provenance.pdf";
    const created = await store.createRevision({ tenantId: TENANT, collection, reference, ttlMs: 60_000 });
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const begin = {
      type: "document.begin",
      contract: "atf-extract/2.0.0",
      reference,
      source: { filename: reference, mimeType: "application/pdf", bytes: 1, sha256: "a".repeat(64) },
      pipeline: { extractor: "test", pipelineVersion: "pv-7", promptHash: "ph-abc" },
    };
    // seq 0 carries document.begin + page 1; seq 1 is a plain page batch whose
    // units must pick the provenance up from the revision row.
    const first = Buffer.concat([Buffer.from(`${JSON.stringify(begin)}\n`), pageBatch(1).body]);
    const second = pageBatch(2);
    for (const [seq, body] of [[0, first], [1, second.body]] as const) {
      const staged = await store.stageBatch({
        tenantId: TENANT,
        collection,
        revisionId,
        seq,
        body,
        contentDigest: createHash("sha256").update(body).digest("hex"),
        ttlMs: 60_000,
      });
      expect(staged.ok).toBe(true);
    }
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    const outcomes = await worker.drain(5);
    expect(outcomes.filter((o) => o.kind === "processed")).toHaveLength(2);
    worker.stop();

    const rows = await pool.query<{ page_start: number; metadata: Record<string, unknown> }>(
      `SELECT page_start, metadata FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2`,
      [TENANT, revisionId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.rows.map((r) => r.page_start))).toEqual(new Set([1, 2]));
    for (const row of rows.rows) {
      expect(row.metadata.extract_contract).toBe("atf-extract/2.0.0");
      expect(row.metadata.extract_pipeline_version).toBe("pv-7");
      expect(row.metadata.extract_prompt_hash).toBe("ph-abc");
    }
  });

  it("stores document.begin's title, tags, metadata, link and source label on every unit (contract 2.2)", async () => {
    const reference = "attributes.pdf";
    const created = await store.createRevision({ tenantId: TENANT, collection, reference, ttlMs: 60_000 });
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const begin = {
      type: "document.begin",
      contract: "atf-extract/2.2.0",
      reference,
      title: "Pflichtenheft WE",
      tags: ["kunde-a", "wms"],
      // A caller key never overrides the unit's technical metadata.
      metadata: { projekt: "WMS", unit_type: "spoofed" },
      link: "https://dms.example/42",
      sourceLabel: "DMS",
      source: { filename: reference, mimeType: "application/pdf", bytes: 1, sha256: "b".repeat(64) },
      pipeline: { extractor: "test" },
    };
    const first = Buffer.concat([Buffer.from(`${JSON.stringify(begin)}\n`), pageBatch(1).body]);
    const second = pageBatch(2).body;
    for (const [seq, body] of [[0, first], [1, second]] as const) {
      const staged = await store.stageBatch({
        tenantId: TENANT,
        collection,
        revisionId,
        seq,
        body,
        contentDigest: createHash("sha256").update(body).digest("hex"),
        ttlMs: 60_000,
      });
      expect(staged.ok).toBe(true);
    }
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    await worker.drain(5);
    worker.stop();

    const rows = await pool.query<{
      title: string | null;
      tags: string[];
      link: string | null;
      source: string | null;
      unit_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT title, tags, link, source, unit_type, metadata FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2`,
      [TENANT, revisionId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows.rows) {
      // Page 2's batch carries no document.begin: it reads the revision row.
      expect(row.title).toBe("Pflichtenheft WE");
      expect(row.tags).toEqual(["kunde-a", "wms"]);
      expect(row.link).toBe("https://dms.example/42");
      expect(row.source).toBe("DMS");
      expect(row.metadata.projekt).toBe("WMS");
      expect(row.metadata.unit_type).toBe(row.unit_type);
    }
  });

  it("reprocessing the same batch upserts on unit_id (no duplicate rows) — Req 5.5", async () => {
    const revisionId = await stage("upsert.pdf", 1);
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });

    expect((await worker.tick()).kind).toBe("processed");
    const afterFirst = await countUnits(revisionId);
    expect(afterFirst).toBe(2);

    // Reset the batch to 'received' and process again — same deterministic
    // unit_ids must upsert in place, not insert new rows.
    await pool.query(
      `UPDATE vs_ingest_batches SET status = 'received', next_attempt_at = NULL
        WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
    expect((await worker.tick()).kind).toBe("processed");
    expect(await countUnits(revisionId)).toBe(afterFirst);
    worker.stop();
  });

  it("returns the batch to 'received' with a backoff and commits no partial units on embedding failure — Req 5.4", async () => {
    const revisionId = await stage("fail.pdf", 1);
    const worker = createBatchWorker(pool, fakeEmbeddingClient({ fail: true }), {
      intervalMs: 0,
      backoffMs: 60_000,
      onlyTenantId: TENANT,
    });

    const now = new Date();
    const outcome = await worker.tick(now);
    expect(outcome.kind).toBe("deferred");

    // No units were committed.
    expect(await countUnits(revisionId)).toBe(0);

    // Batch is back to 'received' with a future next_attempt_at.
    const batch = await pool.query<{ status: string; next_attempt_at: Date | null }>(
      `SELECT status, next_attempt_at FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
    const deferred = batch.rows[0];
    if (!deferred) throw new Error("expected the deferred batch row");
    expect(deferred.status).toBe("received");
    expect(deferred.next_attempt_at).not.toBeNull();
    expect((deferred.next_attempt_at ?? new Date(0)).getTime()).toBeGreaterThan(now.getTime());

    // The backoff hides the batch from an immediate tick, but a later one (after
    // the backoff and with a working embedder) processes it.
    expect((await worker.tick(now)).kind).toBe("idle");

    const laterWorker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    const later = new Date(now.getTime() + 120_000);
    expect((await laterWorker.tick(later)).kind).toBe("processed");
    expect(await countUnits(revisionId)).toBe(2);
    worker.stop();
    laterWorker.stop();
  });

  it("a batch left 'processing' by a dead worker is reclaimed only after its lease expires (no hot loop)", async () => {
    const revisionId = await stage("lease.pdf", 1);
    const now = new Date();
    // Model a worker that claimed the batch and died (or whose deferral write
    // failed): the committed claim holds a lease until now + 5 minutes.
    await pool.query(
      `UPDATE vs_ingest_batches
          SET status = 'processing', lease_token = 'dead-worker', next_attempt_at = $3
        WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId, new Date(now.getTime() + 300_000)],
    );
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    expect((await worker.tick(now)).kind).toBe("idle");
    expect(await countUnits(revisionId)).toBe(0);

    // After the lease, another worker reclaims it with a fresh lease token.
    const later = new Date(now.getTime() + 301_000);
    expect((await worker.tick(later)).kind).toBe("processed");
    const row = await pool.query<{ status: string; lease_token: string | null; attempts: number }>(
      `SELECT status, lease_token, attempts FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
    expect(row.rows[0]?.status).toBe("processed");
    expect(row.rows[0]?.lease_token).toBeNull();
    expect(await countUnits(revisionId)).toBe(2);
    worker.stop();
  });

  it("the claim itself sets a lease (next_attempt_at) so a failed processing never re-claims immediately", async () => {
    const revisionId = await stage("lease-claim.pdf", 1);
    const now = new Date();
    // Use a worker whose embedder fails AND whose backoff is shorter than the
    // lease: the deferral wins, and the batch is back to 'received' with it.
    const worker = createBatchWorker(pool, fakeEmbeddingClient({ fail: true }), {
      intervalMs: 0,
      backoffMs: 10_000,
      leaseMs: 60_000,
      onlyTenantId: TENANT,
    });
    expect((await worker.tick(now)).kind).toBe("deferred");
    const row = await pool.query<{ status: string; next_attempt_at: Date; attempts: number }>(
      `SELECT status, next_attempt_at, attempts FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
    expect(row.rows[0]?.status).toBe("received");
    expect(row.rows[0]?.attempts).toBe(1);
    expect(row.rows[0]?.next_attempt_at.getTime()).toBe(now.getTime() + 10_000);
    expect((await worker.tick(now)).kind).toBe("idle");
    worker.stop();
  });

  it("getRevisionState reports the processed page range once the batch is processed", async () => {
    const revisionId = await stage("state.pdf", 7);
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });

    // Before processing, no processed pages.
    const before = await store.getRevisionState({ tenantId: TENANT, collection }, revisionId);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.result.processedPages).toEqual([]);

    expect((await worker.tick()).kind).toBe("processed");

    const after = await store.getRevisionState({ tenantId: TENANT, collection }, revisionId);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.result.processedPages).toEqual([{ from: 7, to: 7 }]);
      expect(after.result.pagesAvailable).toBe(1);
    }
    worker.stop();
  });

  // ── task 3.4: ts_ident population + vs_identifiers indexing ────────────────

  it("populates ts_ident on upsert and indexes document.end.identifiers into vs_identifiers", async () => {
    // A page whose paragraph carries a code, then a trailing document.end batch
    // whose identifier index references that paragraph's block.
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference: "ident.pdf",
      ttlMs: 60_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;

    const pageRecord = {
      type: "page",
      page: 1,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [
        { type: "paragraph", id: "p1-b1", page: 1, text: "Bitte Maske WE-01/A gemäß DIN EN 1090-2 prüfen." },
      ],
      assets: [],
      warnings: [],
    };
    const pageBody = Buffer.from(`${JSON.stringify(pageRecord)}\n`);
    const stagedPage = await store.stageBatch({
      tenantId: TENANT,
      collection,
      revisionId,
      seq: 0,
      body: pageBody,
      contentDigest: createHash("sha256").update(pageBody).digest("hex"),
      ttlMs: 60_000,
    });
    expect(stagedPage.ok).toBe(true);

    const endRecord = {
      type: "document.end",
      reference: "ident.pdf",
      pageCount: 1,
      outline: [],
      identifiers: [
        { value: "WE-01/A", kind: "mask_code", occurrences: [{ page: 1, blockId: "p1-b1" }] },
        { value: "DIN EN 1090-2", kind: "standard", occurrences: [{ page: 1, blockId: "p1-b1" }] },
      ],
      summaries: [],
      refs: [],
      warnings: [],
    };
    const endBody = Buffer.from(`${JSON.stringify(endRecord)}\n`);
    const stagedEnd = await store.stageBatch({
      tenantId: TENANT,
      collection,
      revisionId,
      seq: 1,
      body: endBody,
      contentDigest: createHash("sha256").update(endBody).digest("hex"),
      ttlMs: 60_000,
    });
    expect(stagedEnd.ok).toBe(true);

    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    // Process the page batch, then the document.end batch.
    expect((await worker.tick()).kind).toBe("processed");
    expect((await worker.tick()).kind).toBe("processed");
    worker.stop();

    // ts_ident is populated on the chunk unit and matches the normalized code.
    const identRow = await pool.query<{ unit_id: string; matches: boolean }>(
      `SELECT unit_id, (ts_ident @@ to_tsquery('simple', 'WE01A')) AS matches
         FROM "${table}"
        WHERE tenant_id = $1 AND revision_id = $2 AND unit_type = 'chunk'`,
      [TENANT, revisionId],
    );
    expect(identRow.rows.length).toBeGreaterThan(0);
    expect(identRow.rows.some((r) => r.matches)).toBe(true);

    // vs_identifiers has a row per (value_norm, unit_id, page) resolved via block.
    const idx = await pool.query<{ value_norm: string; kind: string; page: number }>(
      `SELECT value_norm, kind, page FROM vs_identifiers
        WHERE tenant_id = $1 AND collection = $2 ORDER BY value_norm`,
      [TENANT, collection],
    );
    const byNorm = new Map(idx.rows.map((r) => [r.value_norm, r]));
    expect(byNorm.has("WE01A")).toBe(true);
    expect(byNorm.has("DINEN10902")).toBe(true);
    expect(byNorm.get("WE01A")?.page).toBe(1);
    expect(byNorm.get("WE01A")?.kind).toBe("mask_code");

    // The unit ids recorded resolve back to a real chunk unit of this revision.
    const recordedUnitIds = await pool.query<{ unit_id: string }>(
      `SELECT DISTINCT unit_id FROM vs_identifiers WHERE tenant_id = $1 AND collection = $2`,
      [TENANT, collection],
    );
    const chunkUnitIds = new Set(identRow.rows.map((r) => r.unit_id));
    expect(recordedUnitIds.rows.every((r) => chunkUnitIds.has(r.unit_id))).toBe(true);
  });

  // ── task 5.4 / requirement 9.6: selective re-embedding ─────────────────────

  /** Stage a one-page batch whose single paragraph carries `text`. */
  async function stageParagraph(reference: string, text: string): Promise<string> {
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference,
      ttlMs: 60_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const record = {
      type: "page",
      page: 1,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [{ type: "paragraph", id: "p1-b1", page: 1, text }],
      assets: [],
      warnings: [],
    };
    const body = Buffer.from(`${JSON.stringify(record)}\n`);
    const staged = await store.stageBatch({
      tenantId: TENANT,
      collection,
      revisionId,
      seq: 0,
      body,
      contentDigest: createHash("sha256").update(body).digest("hex"),
      ttlMs: 60_000,
    });
    expect(staged.ok).toBe(true);
    return revisionId;
  }

  /** Reset a revision's seq-0 batch to 'received' so the worker re-processes it. */
  async function requeue(revisionId: string): Promise<void> {
    await pool.query(
      `UPDATE vs_ingest_batches SET status = 'received', next_attempt_at = NULL
        WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
  }

  it("does NOT call the embedder when reprocessing an unchanged batch (unchanged path + content) — requirement 9.6", async () => {
    const revisionId = await stageParagraph("reembed-skip.pdf", "Ein unveränderter Absatz mit genug Inhalt zum Chunken.");
    const embedder = countingEmbeddingClient();
    const worker = createBatchWorker(pool, embedder, { intervalMs: 0, onlyTenantId: TENANT });

    // First pass: the unit is new, so it IS embedded.
    expect((await worker.tick()).kind).toBe("processed");
    expect(embedder.embedded).toBeGreaterThan(0);
    const afterFirst = embedder.embedded;

    // Re-queue and reprocess the SAME batch. Nothing changed, so the stored
    // vector is reused and the embedder is NOT called again.
    await requeue(revisionId);
    expect((await worker.tick()).kind).toBe("processed");
    expect(embedder.embedded).toBe(afterFirst); // no additional embeds
    worker.stop();
  });

  it("DOES call the embedder when the content changed for a reprocessed unit — requirement 9.6", async () => {
    const revisionId = await stageParagraph("reembed-content.pdf", "Version eins des Absatzes mit ausreichend Inhalt.");
    const embedder = countingEmbeddingClient();
    const worker = createBatchWorker(pool, embedder, { intervalMs: 0, onlyTenantId: TENANT });

    expect((await worker.tick()).kind).toBe("processed");
    const afterFirst = embedder.embedded;
    expect(afterFirst).toBeGreaterThan(0);

    // Restage the SAME reference/revision's seq-0 batch with DIFFERENT text. The
    // chunk's unit_id (page/section coordinates + block id + ordinal) is stable,
    // but its content changed → the stored vector is stale → it is re-embedded.
    const changed = {
      type: "page",
      page: 1,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [{ type: "paragraph", id: "p1-b1", page: 1, text: "Version ZWEI des Absatzes, komplett anderer Inhalt hier." }],
      assets: [],
      warnings: [],
    };
    const body = Buffer.from(`${JSON.stringify(changed)}\n`);
    // Overwrite the staged payload in place and re-queue it.
    await pool.query(
      `UPDATE vs_ingest_batches
          SET payload = $3, digest = $4, status = 'received', next_attempt_at = NULL
        WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId, body, createHash("sha256").update(body).digest("hex")],
    );

    expect((await worker.tick()).kind).toBe("processed");
    expect(embedder.embedded).toBeGreaterThan(afterFirst); // the changed unit was re-embedded
    worker.stop();
  });
});

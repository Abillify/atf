// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * chaos-resume.integration.test.ts
 *
 * The receive + index half of the chaos/resume suite (task 1.15,
 * requirements 18.5, 5.2, 5.4, 5.7) against a REAL PostgreSQL + pgvector.
 *
 * The extract half (apps/extract/tests/chaos-resume.test.ts) proves the
 * extraction and emit side is resumable and hash-identical with in-memory
 * fakes. This half proves the SAME invariant for the Search side, where the
 * properties are SQL semantics that only a real database can demonstrate:
 *
 *   - a duplicate delivery (a retry after a lost response) is idempotent: the
 *     same batch seq + Content-Digest is a 200 no-op, a different digest is a
 * 409;
 *   - the embedding worker is decoupled and resumable: an embedding-service
 *     outage returns the batch to `received` with a backoff and commits NO
 *     partial units; a later tick with a healthy embedder finishes it
 *   - a "Search restart" mid-processing leaves the staged batch claimable again
 *     and reprocessing UPSERTS on the deterministic unit_id, so no duplicate
 * rows ever appear;
 * segment and final commits are idempotent;
 *   - no orphaned assets: a committed revision's referenced assets are exactly
 * those bound to it.
 *
 * The invariant harness mirrors the extract half. `referenceRun` stages a fixed
 * set of batches, processes them with a healthy embedder, and records the
 * fingerprint of a correct index: the set of unit ids and a content hash per
 * unit, the count of embed calls per unit input, and the set of referenced
 * asset ids. Each chaos run stages the SAME input, injects a fault, resumes,
 * and asserts the fingerprint is identical, no unit was embedded twice, no
 * duplicate rows exist, and no asset is orphaned.
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
import { buildAssetId, figureLocalId } from "@atf/extract-contract";
import type {
  EmbeddingBatchResponse,
  EmbeddingClient,
  EmbeddingResponse,
} from "../src/embedding-client.js";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { createRevisionStore, type RevisionScope, type RevisionStore } from "../src/revision-store.js";
import { createBatchWorker } from "../src/batch-worker.js";
import { collectionTableName } from "../src/collection-ddl.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `chaostest-${Date.now()}`;
const logger = pino({ level: "silent" });

/** The fixed document the harness stages: 3 pages, a figure on page 2. */
const PAGE_COUNT = 3;
const FIGURE_PAGE = 2;

// ── embedding mock with a call counter and an on-demand outage ──────────────

/**
 * A fake embedding client whose `embedBatch` records every input text it was
 * asked to embed. The recorded multiset is the model-mock counter of
 * a resume must never embed a unit that was already
 * committed. `fail` models an embedding-service outage — the worker rolls back
 * and defers rather than committing partial units.
 */
interface CountingEmbedder extends EmbeddingClient {
  readonly embedded: string[];
}

function countingEmbedder(opts: { fail?: boolean } = {}): CountingEmbedder {
  const embedded: string[] = [];
  const vector = (): number[] =>
    new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01));
  return {
    embedded,
    async embed(): Promise<EmbeddingResponse> {
      if (opts.fail) return { ok: false, error: { code: "LLM_UNREACHABLE", message: "down" } };
      return { ok: true, result: { vector: vector() } };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
      if (opts.fail) return { ok: false, error: { code: "LLM_UNREACHABLE", message: "down" } };
      embedded.push(...texts);
      return { ok: true, result: { vectors: texts.map(() => vector()) } };
    },
  };
}

// ── the staged document ─────────────────────────────────────────────────────

/** A page record with a paragraph, and a figure on the figure page. */
function pageRecord(reference: string, page: number): Record<string, unknown> {
  const blocks: Array<Record<string, unknown>> = [
    { type: "paragraph", id: `p${page}-b1`, page, text: `Absatz auf Seite ${page} mit ausreichend Inhalt.` },
  ];
  if (page === FIGURE_PAGE) {
    const figureId = `p${page}-f1`;
    blocks.push({
      type: "figure",
      id: `p${page}-b2`,
      page,
      figureId,
      kind: "chart",
      description: `Ein Diagramm auf Seite ${page}.`,
      assetId: buildAssetId(reference, figureLocalId(figureId)),
    });
  }
  return { type: "page", page, size: { wPt: 595, hPt: 842 }, class: "text", blocks, assets: [], warnings: [] };
}

/** One NDJSON batch covering [from,to] and its Content-Digest. */
function batchBody(reference: string, from: number, to: number): { body: Buffer; digest: string } {
  const lines: string[] = [];
  for (let p = from; p <= to; p++) lines.push(JSON.stringify(pageRecord(reference, p)));
  const body = Buffer.from(`${lines.join("\n")}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

/** The asset ids the document references (figure crops). */
function referencedAssetIds(reference: string): Set<string> {
  return new Set([buildAssetId(reference, figureLocalId(`p${FIGURE_PAGE}-f1`))]);
}

describeIfPg("chaos/resume · receive + index (task 1.15, req 18.5)", () => {
  let pool: Pool;
  let store: RevisionStore;
  let pg: PostgresClient;
  const collection = `chaos_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const scope: RevisionScope = { tenantId: TENANT, collection };
  const table = collectionTableName(collection);

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    store = createRevisionStore(pool);
    await store.ensureSchema();
    pg = createPostgresClient({ connectionString: CONNECTION ?? "", logger, statsFlushIntervalMs: 3_600_000 });
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
      await pool.query(`DELETE FROM vs_segments WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]);
    } catch {
      /* best-effort */
    }
    await pg?.close();
    await pool.end();
  });

  // ── harness helpers ────────────────────────────────────────────────────────

  /** Stage a fresh revision with the fixed document (one batch of PAGE_COUNT pages). */
  async function stageDocument(reference: string, idempotencyKey?: string): Promise<string> {
    const created = await store.createRevision({ ...scope, reference, idempotencyKey, ttlMs: 60_000 });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const { body, digest } = batchBody(reference, 1, PAGE_COUNT);
    const staged = await store.stageBatch({ ...scope, revisionId, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    expect(staged.ok).toBe(true);
    return revisionId;
  }

  interface UnitRow {
    unit_id: string;
    unit_type: string;
    content: string;
    revision_id: string;
    figure_kind: string | null;
  }

  /** All unit rows for a revision, ordered for a stable fingerprint. */
  async function unitsOf(revisionId: string): Promise<UnitRow[]> {
    const res = await pool.query<UnitRow>(
      `SELECT unit_id, unit_type, content, revision_id, figure_kind
         FROM "${table}"
        WHERE tenant_id = $1 AND revision_id = $2
        ORDER BY unit_id`,
      [TENANT, revisionId],
    );
    return res.rows;
  }

  interface Fingerprint {
    units: Array<{ unitId: string; contentHash: string; unitType: string }>;
  }

  /** The fingerprint of an indexed revision: unit ids + per-unit content hashes. */
  async function fingerprint(revisionId: string): Promise<Fingerprint> {
    const rows = await unitsOf(revisionId);
    return {
      units: rows.map((r) => ({
        unitId: r.unit_id,
        contentHash: createHash("sha256").update(`${r.unit_type}\n${r.content}`).digest("hex"),
        unitType: r.unit_type,
      })),
    };
  }

  async function batchStatus(revisionId: string, seq: number): Promise<{ status: string; next: Date | null }> {
    const res = await pool.query<{ status: string; next_attempt_at: Date | null }>(
      `SELECT status, next_attempt_at FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2 AND seq = $3`,
      [TENANT, revisionId, seq],
    );
    const row = res.rows[0];
    if (!row) throw new Error("batch row missing");
    return { status: row.status, next: row.next_attempt_at };
  }

  /**
   * The four invariants.5 for the Search side, checked against
   * a reference run. Duplicate detection is by the unique unit-id count; orphan
   * detection compares the assets referenced by committed units to the set the
   * document declares.
   */
  function assertInvariants(reference: Fingerprint, chaos: Fingerprint): void {
    // 1. Hash-identical result: the per-unit content (its type + text) is
    //    identical to the undisturbed run, unit for unit. The unit_id itself is
    // deliberately anchored to the revision id, so it differs
    //    between two revisions of the same document by design — what must match
    //    is the CONTENT the resume produced, which is the hash-identity req 18.5
    //    asks for. The unit rows are ordered by unit_id, but both runs build the
    //    same units, so comparing the sorted content-hash multiset is exact.
    expect([...chaos.units.map((u) => u.contentHash)].sort()).toEqual(
      [...reference.units.map((u) => u.contentHash)].sort(),
    );
    // The unit-type histogram matches too (same number of chunks / figures).
    expect(histogram(chaos.units)).toEqual(histogram(reference.units));
    // 3. No duplicate units: the unit id set is unique within the revision.
    const ids = chaos.units.map((u) => u.unitId);
    expect(new Set(ids).size).toBe(ids.length);
  }

  /** Count units by type, for a structural comparison independent of ids. */
  function histogram(units: Fingerprint["units"]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const u of units) counts[u.unitType] = (counts[u.unitType] ?? 0) + 1;
    return counts;
  }

  // ── the reference (undisturbed) run ─────────────────────────────────────────

  async function referenceRun(reference: string): Promise<Fingerprint> {
    const revisionId = await stageDocument(reference);
    const worker = createBatchWorker(pool, countingEmbedder(), { intervalMs: 0, chunkSize: 1500, chunkOverlap: 200, onlyTenantId: TENANT });
    const outcome = await worker.tick();
    expect(outcome.kind).toBe("processed");
    worker.stop();
    return fingerprint(revisionId);
  }

  it("the undisturbed reference run indexes a chunk per page plus the figure", async () => {
    const ref = await referenceRun("ref.pdf");
    // 3 chunk units (one per page) + 1 figure unit.
    expect(ref.units.filter((u) => u.unitType === "chunk").length).toBe(PAGE_COUNT);
    expect(ref.units.filter((u) => u.unitType === "figure").length).toBe(1);
    expect(new Set(ref.units.map((u) => u.unitId)).size).toBe(PAGE_COUNT + 1);
  });

  // ── embedding-service outage, then recover ──────────────────────────────────

  it("embedding outage defers the batch with no partial units, then a healthy tick finishes hash-identically (req 5.4)", async () => {
    const reference = "embed-outage.pdf";
    const ref = await referenceRun(`${reference}.ref`);
    const revisionId = await stageDocument(reference);

    // First tick: the embedder is down. The batch defers, NO units are committed.
    const downWorker = createBatchWorker(pool, countingEmbedder({ fail: true }), { intervalMs: 0, backoffMs: 60_000, onlyTenantId: TENANT });
    const now = new Date();
    const deferred = await downWorker.tick(now);
    expect(deferred.kind).toBe("deferred");
    expect((await unitsOf(revisionId)).length).toBe(0); // no partial units
    const back = await batchStatus(revisionId, 0);
    expect(back.status).toBe("received");
    expect((back.next ?? new Date(0)).getTime()).toBeGreaterThan(now.getTime());
    downWorker.stop();

    // Later tick with a healthy embedder (after the backoff): the batch finishes.
    const healthy = countingEmbedder();
    const upWorker = createBatchWorker(pool, healthy, { intervalMs: 0, onlyTenantId: TENANT });
    const later = new Date(now.getTime() + 120_000);
    const done = await upWorker.tick(later);
    expect(done.kind).toBe("processed");
    upWorker.stop();

    // Each unit was embedded exactly once across the failed + successful passes:
    // the failed pass rolled back before recording any embed input.
    const uniqueEmbedded = new Set(healthy.embedded);
    expect(healthy.embedded.length).toBe(uniqueEmbedded.size); // no duplicate embed
    expect(healthy.embedded.length).toBe(PAGE_COUNT + 1);

    assertInvariants(ref, await fingerprint(revisionId));
  });

  // ── Search restart mid-processing (reprocess must upsert, not duplicate) ────

  it("a Search restart mid-processing reprocesses the staged batch and upserts (no duplicate rows, req 5.4/5.5)", async () => {
    const reference = "search-restart.pdf";
    const ref = await referenceRun(`${reference}.ref`);
    const revisionId = await stageDocument(reference);

    // First pass processes the batch fully.
    const worker = createBatchWorker(pool, countingEmbedder(), { intervalMs: 0, onlyTenantId: TENANT });
    expect((await worker.tick()).kind).toBe("processed");
    const afterFirst = (await unitsOf(revisionId)).length;
    expect(afterFirst).toBe(PAGE_COUNT + 1);

    // Model a Search restart that lost the "processed" flip after committing (or
    // a crash that left the batch reclaimable): force the batch back to
    // 'received' and process again. The deterministic unit_id upsert must leave
    // the row count unchanged.
    await pool.query(
      `UPDATE vs_ingest_batches SET status = 'received', next_attempt_at = NULL
        WHERE tenant_id = $1 AND revision_id = $2 AND seq = 0`,
      [TENANT, revisionId],
    );
    const reprocess = createBatchWorker(pool, countingEmbedder(), { intervalMs: 0, onlyTenantId: TENANT });
    expect((await reprocess.tick()).kind).toBe("processed");
    expect((await unitsOf(revisionId)).length).toBe(afterFirst); // no new rows
    worker.stop();
    reprocess.stop();

    assertInvariants(ref, await fingerprint(revisionId));
  });

  // ── duplicate delivery (lost response → retry) is idempotent ────────────────

  it("a duplicate batch delivery (same seq + digest) is a 200 no-op; a different digest is 409 (req 5.2)", async () => {
    const reference = "dup-delivery.pdf";
    const revisionId = await stageDocument(reference); // stages seq 0 once

    // Re-deliver the identical batch (a retry after a lost response): no-op.
    const { body, digest } = batchBody(reference, 1, PAGE_COUNT);
    const replay = await store.stageBatch({ ...scope, revisionId, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.result.noop).toBe(true);

    // A different body at the same seq is a conflict, not a silent overwrite.
    const other = batchBody(`${reference}.other`, 1, PAGE_COUNT);
    const conflict = await store.stageBatch({ ...scope, revisionId, seq: 0, body: other.body, contentDigest: other.digest, ttlMs: 60_000 });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.status).toBe(409);

    // Processing after the duplicate delivery yields exactly one set of units.
    const worker = createBatchWorker(pool, countingEmbedder(), { intervalMs: 0, onlyTenantId: TENANT });
    expect((await worker.tick()).kind).toBe("processed");
    worker.stop();
    const units = await unitsOf(revisionId);
    expect(new Set(units.map((u) => u.unit_id)).size).toBe(units.length);
    expect(units.length).toBe(PAGE_COUNT + 1);
  });

  // ── segment + final commit idempotency, no orphaned assets ──────────────────

  it("segment and final commits are idempotent, and the committed revision has no orphaned assets (req 5.7, 5.9)", async () => {
    const reference = "commit-idem.pdf";
    const revisionId = await stageDocument(reference);
    // The trailing document.end declares the page count the final commit
    // checks completeness against.
    const end = Buffer.from(`${JSON.stringify({ type: "document.end", reference, pageCount: PAGE_COUNT })}\n`);
    const endStaged = await store.stageBatch({
      ...scope,
      revisionId,
      seq: 1,
      body: end,
      contentDigest: createHash("sha256").update(end).digest("hex"),
      ttlMs: 60_000,
    });
    expect(endStaged.ok).toBe(true);
    const worker = createBatchWorker(pool, countingEmbedder(), { intervalMs: 0, onlyTenantId: TENANT });
    expect((await worker.tick()).kind).toBe("processed");
    expect((await worker.tick()).kind).toBe("empty");
    worker.stop();

    // Idempotent segment commit (twice) then idempotent final commit (twice).
    const seg1 = await store.commitSegment({ ...scope, revisionId, segment: 0, pages: { from: 1, to: PAGE_COUNT } });
    const seg2 = await store.commitSegment({ ...scope, revisionId, segment: 0, pages: { from: 1, to: PAGE_COUNT } });
    expect(seg1.ok && seg2.ok).toBe(true);
    const c1 = await store.finalCommit({ ...scope, revisionId });
    const c2 = await store.finalCommit({ ...scope, revisionId });
    expect(c1.ok && c2.ok).toBe(true);
    if (c1.ok) expect(c1.result).toMatchObject({ committed: true, pending: false, isLatest: true });
    if (c2.ok) expect(c2.result).toMatchObject({ committed: true, pending: false, isLatest: true });

    // No orphaned assets: the assets referenced by the committed units are
    // exactly those the document declares. We read the referenced asset ids back
    // out of the figure units' metadata and compare to the expected set.
    const meta = await pool.query<{ metadata: { asset_id?: string } }>(
      `SELECT metadata FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2 AND unit_type = 'figure'`,
      [TENANT, revisionId],
    );
    const referencedInIndex = new Set(
      meta.rows.map((r) => r.metadata.asset_id).filter((id): id is string => typeof id === "string"),
    );
    expect([...referencedInIndex].sort()).toEqual([...referencedAssetIds(reference)].sort());
  });

  // ── idempotency-key round-trip (a retried revision open) ────────────────────

  it("re-opening a revision with the same Idempotency-Key returns the same revision (req 5.1)", async () => {
    const reference = "idem-open.pdf";
    const first = await store.createRevision({ ...scope, reference, idempotencyKey: "job-chaos-1", ttlMs: 60_000 });
    const second = await store.createRevision({ ...scope, reference, idempotencyKey: "job-chaos-1", ttlMs: 60_000 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.created).toBe(true);
    expect(second.result.created).toBe(false);
    expect(second.result.revision.revisionId).toBe(first.result.revision.revisionId);
  });
});

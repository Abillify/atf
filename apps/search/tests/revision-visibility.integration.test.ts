// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the v2 revision visibility model (task 1.13) against a
 * REAL PostgreSQL + pgvector instance. These verify the SQL-level semantics that
 * unit tests cannot:
 *
 *   - a NEW document defaults to `progressive`; its committed segment is
 *     searchable while the revision is still `partial`, and the hit carries
 *     revision_state=partial + pages_available (Requirement 6.4);
 *   - a REPLACE defaults to `on_commit`; the OLD revision stays the only visible
 *     one until the new revision's final commit, then the switch is atomic —
 *     never both revisions, never neither (Requirements 5.11, 6.5);
 *   - the is_latest flip runs in batches (5,000 rows) and the pointer-based
 *     search filter never returns two revisions of one document (Req 6.5);
 *   - legacy null-revision rows keep searching unchanged, and a v2 replace of a
 *     legacy document hides the legacy rows in the same switch;
 *   - a commit that arrives BEFORE the worker processed the batches is deferred:
 *     the old revision stays visible, the worker completes the switch, and a
 *     progressive segment committed before processing is visible after it;
 *   - abort after a segment commit removes the units, identifiers and pointer;
 *   - concurrent same-seq PUTs, reaper-vs-commit and a missing last page.
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
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `vistest-${Date.now()}`;
const logger = pino({ level: "silent" });

const scope: AccessScope = {
  principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
  userId: undefined,
  userGroups: [],
  tenantId: TENANT,
  scopes: [],
  service: true,
};

function fakeEmbeddingClient(): EmbeddingClient {
  const vector = (): number[] =>
    new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01));
  return {
    async embed(): Promise<EmbeddingResponse> {
      return { ok: true, result: { vector: vector() } };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResponse> {
      return { ok: true, result: { vectors: texts.map(() => vector()) } };
    },
  };
}

/** The trailing `document.end` batch declaring the page count. */
function endBatch(reference: string, pageCount: number): { body: Buffer; digest: string } {
  const body = Buffer.from(`${JSON.stringify({ type: "document.end", reference, pageCount })}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

/** A single-page NDJSON batch whose paragraph text contains a search term. */
function pageBatch(pageNo: number, term: string): { body: Buffer; digest: string } {
  const record = {
    type: "page",
    page: pageNo,
    size: { wPt: 595, hPt: 842 },
    class: "text",
    blocks: [
      {
        type: "paragraph",
        id: `p${pageNo}-b1`,
        page: pageNo,
        text: `Seite ${pageNo} enthaelt ${term} als Suchbegriff.`,
      },
    ],
    assets: [],
    warnings: [],
  };
  const body = Buffer.from(`${JSON.stringify(record)}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

describeIfPg("revision visibility · real postgres (task 1.13)", () => {
  let pool: Pool;
  let store: RevisionStore;
  let pg: PostgresClient;
  const collection = `vistest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
      await pool.query(`DELETE FROM vs_segments WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]);
    } catch {
      /* best-effort */
    }
    await pg?.close();
    await pool.end();
  });

  /** Create a revision and stage one page (seq 1) plus document.end (seq 2). */
  async function stageOnly(
    reference: string,
    term: string,
    visibility?: "progressive" | "on_commit",
  ): Promise<string> {
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference,
      ttlMs: 60_000,
      ...(visibility ? { visibility } : {}),
    });
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    for (const [seq, batch] of [[1, pageBatch(1, term)], [2, endBatch(reference, 1)]] as const) {
      const staged = await store.stageBatch({
        tenantId: TENANT,
        collection,
        revisionId,
        seq,
        body: batch.body,
        contentDigest: batch.digest,
        ttlMs: 60_000,
      });
      expect(staged.ok).toBe(true);
    }
    return revisionId;
  }

  /** Run the worker until no batch of this suite's tenant is left. */
  async function drain(): Promise<void> {
    const worker = createBatchWorker(pool, fakeEmbeddingClient(), { intervalMs: 0, onlyTenantId: TENANT });
    const outcomes = await worker.drain();
    worker.stop();
    expect(outcomes.filter((o) => o.kind === "error" || o.kind === "deferred")).toEqual([]);
  }

  /** Create a revision, stage page 1 + document.end, and process them. */
  async function stageAndProcess(
    reference: string,
    _pageNo: number,
    term: string,
    visibility?: "progressive" | "on_commit",
  ): Promise<string> {
    const revisionId = await stageOnly(reference, term, visibility);
    await drain();
    return revisionId;
  }

  async function stateOf(revisionId: string) {
    const state = await store.getRevisionState({ tenantId: TENANT, collection }, revisionId);
    if (!state.ok) throw new Error(`state failed: ${state.error.code}`);
    return state.result;
  }

  /** FTS-only search for a term; returns the matching hits for this collection. */
  async function searchTerm(term: string) {
    const res = await pg.search(
      term,
      new Array<number>(VECTOR_SIZE).fill(0),
      50,
      collection,
      scope,
      undefined,
      false, // hybridSearch
      false, // includeAllVersions
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // ftsOnly
    );
    if (!res.ok) throw new Error(`search failed: ${res.error.code}`);
    return res.result;
  }

  it("new document defaults to progressive", async () => {
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference: "brand-new.pdf",
      ttlMs: 60_000,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.result.revision.visibility).toBe("progressive");
  });

  it("progressive: a committed segment is searchable while partial, hit carries revision_state=partial + pages_available", async () => {
    const term = "alphaterm";
    const revisionId = await stageAndProcess("prog.pdf", 1, term, "progressive");

    // Before any segment commit, the (is_latest=FALSE) units are invisible.
    expect(await searchTerm(term)).toHaveLength(0);

    // Commit segment 0 covering page 1 → the segment becomes searchable.
    const seg = await store.commitSegment({
      tenantId: TENANT,
      collection,
      revisionId,
      segment: 0,
      pages: { from: 1, to: 1 },
    });
    expect(seg.ok).toBe(true);

    const hits = await searchTerm(term);
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    if (!hit) throw new Error("expected a hit");
    expect(hit.revision_state).toBe("partial");
    expect(hit.pages_available).toBe("1\u20131");
    expect(hit.evidence?.revision_state).toBe("partial");
    expect(hit.evidence?.pages_available).toBe("1\u20131");
  });

  it("replace defaults to on_commit; the OLD revision stays the only visible one until the new final commit, then the switch is atomic", async () => {
    const ref = "replace.pdf";
    const oldTerm = "oldwording";
    const newTerm = "newwording";

    // First revision: create, process, commit segment + finalize so it is the
    // document's current committed revision and searchable.
    const oldRev = await stageAndProcess(ref, 1, oldTerm, "progressive");
    await store.commitSegment({
      tenantId: TENANT,
      collection,
      revisionId: oldRev,
      segment: 0,
      pages: { from: 1, to: 1 },
    });
    const oldFinal = await store.finalCommit({ tenantId: TENANT, collection, revisionId: oldRev });
    expect(oldFinal.ok).toBe(true);
    expect(await searchTerm(oldTerm)).toHaveLength(1);

    // Second revision on the SAME reference must default to on_commit (replace).
    const created = await store.createRevision({
      tenantId: TENANT,
      collection,
      reference: ref,
      ttlMs: 60_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("create failed");
    expect(created.result.revision.visibility).toBe("on_commit");
    const newRev = created.result.revision.revisionId;

    // Stage + process + even commit a segment of the new (on_commit) revision.
    for (const [seq, batch] of [[1, pageBatch(1, newTerm)], [2, endBatch(ref, 1)]] as const) {
      await store.stageBatch({
        tenantId: TENANT,
        collection,
        revisionId: newRev,
        seq,
        body: batch.body,
        contentDigest: batch.digest,
        ttlMs: 60_000,
      });
    }
    await drain();
    await store.commitSegment({
      tenantId: TENANT,
      collection,
      revisionId: newRev,
      segment: 0,
      pages: { from: 1, to: 1 },
    });

    // Old revision is STILL the only visible one; the new on_commit revision is
    // invisible until its final commit (Requirement 5.11).
    expect(await searchTerm(oldTerm)).toHaveLength(1);
    expect(await searchTerm(newTerm)).toHaveLength(0);

    // Final commit flips atomically: new visible, old gone. Never both, never
    // neither (Requirement 6.5).
    const fin = await store.finalCommit({ tenantId: TENANT, collection, revisionId: newRev });
    expect(fin.ok).toBe(true);
    expect(await searchTerm(newTerm)).toHaveLength(1);
    expect(await searchTerm(oldTerm)).toHaveLength(0);

    // The pointer resolves to exactly one revision; search never returns two.
    const both = [...(await searchTerm(newTerm)), ...(await searchTerm(oldTerm))];
    const revisionsSeen = new Set(
      (
        await pool.query<{ revision_id: string | null }>(
          `SELECT DISTINCT revision_id FROM "${table}"
            WHERE tenant_id = $1 AND is_latest = TRUE AND base_ref = $2`,
          [TENANT, ref],
        )
      ).rows.map((r) => r.revision_id),
    );
    expect(revisionsSeen.size).toBe(1);
    expect(revisionsSeen.has(newRev)).toBe(true);
    expect(both).toHaveLength(1);
  });

  it("the final commit flips is_latest in 5,000-row batches", async () => {
    const ref = "big.pdf";
    // Create a progressive revision, process one real unit, then synthesize many
    // extra is_latest=FALSE rows for the same revision so the flip must batch.
    const revisionId = await stageAndProcess(ref, 1, "bulkterm", "progressive");
    const ROWS = 12_000; // > 2 * FLIP_BATCH_ROWS (5,000)
    await pool.query(
      `INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, revision_id,
          unit_id, unit_type, document_id, page_start, page_end)
       SELECT $1, $2 || '#bulk:' || g, $2, FALSE, 'bulk', $3::vector, $4,
              'bulk-' || $4 || '-' || g, 'chunk', $2, 1, 1
       FROM generate_series(1, ${ROWS}) g`,
      [TENANT, ref, JSON.stringify(new Array<number>(VECTOR_SIZE).fill(0)), revisionId],
    );

    // Before the final commit these bulk rows are is_latest=FALSE (invisible).
    const invisible = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}"
        WHERE tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE`,
      [TENANT, revisionId],
    );
    expect(Number(invisible.rows[0]?.n)).toBeGreaterThanOrEqual(ROWS);

    const fin = await store.finalCommit({ tenantId: TENANT, collection, revisionId });
    expect(fin.ok).toBe(true);

    // After the final commit every one of the revision's rows is is_latest=TRUE,
    // proving the chunked flip covered all 12,000+ rows (not just one batch).
    const stillFalse = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}"
        WHERE tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE`,
      [TENANT, revisionId],
    );
    expect(Number(stillFalse.rows[0]?.n)).toBe(0);
  }, 60_000);

  it("legacy null-revision rows still search unchanged", async () => {
    const term = "legacyterm";
    const upserted = await pg.upsert(
      {
        tenantId: TENANT,
        reference: "legacy-doc",
        baseRef: "legacy-doc",
        content: `Ein Dokument mit ${term} ohne Revision.`,
        vector: new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01)),
        metadata: {},
      },
      collection,
    );
    expect(upserted.ok).toBe(true);

    const hits = await searchTerm(term);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const legacy = hits.find((h) => h.base_ref === "legacy-doc");
    expect(legacy).toBeDefined();
    // Legacy rows carry no revision state.
    expect(legacy?.revision_state).toBeUndefined();
    expect(legacy?.pages_available).toBeUndefined();
  });
  it("final commit BEFORE worker.tick(): old revision stays visible, the worker completes the switch", async () => {
    const ref = "commit-first.pdf";
    const oldRev = await stageAndProcess(ref, 1, "firstold", "progressive");
    expect((await store.finalCommit({ tenantId: TENANT, collection, revisionId: oldRev })).ok).toBe(true);
    expect(await searchTerm("firstold")).toHaveLength(1);

    // Replace: stage, then commit BEFORE any batch is processed.
    const newRev = await stageOnly(ref, "firstnew");
    const early = await store.finalCommit({ tenantId: TENANT, collection, revisionId: newRev });
    expect(early.ok).toBe(true);
    if (early.ok) expect(early.result).toMatchObject({ committed: true, pending: true, isLatest: false });
    expect((await stateOf(newRev)).commitPending).toBe(true);
    // Requirement 5.11: the old revision is still the only visible one.
    expect(await searchTerm("firstold")).toHaveLength(1);
    expect(await searchTerm("firstnew")).toHaveLength(0);

    // The worker processes the batches and performs the deferred switch.
    await drain();
    expect(await searchTerm("firstnew")).toHaveLength(1);
    expect(await searchTerm("firstold")).toHaveLength(0);
    const state = await stateOf(newRev);
    expect(state.status).toBe("committed");
    expect(state.commitPending).toBe(false);
    // Replaying the commit is an idempotent 200-style result.
    const replay = await store.finalCommit({ tenantId: TENANT, collection, revisionId: newRev });
    expect(replay.ok && replay.result).toMatchObject({ pending: false, isLatest: true });
  });

  it("progressive: a segment committed BEFORE processing becomes visible when the worker writes it", async () => {
    const ref = "segment-first.pdf";
    const rev = await stageOnly(ref, "segfirst", "progressive");
    const seg = await store.commitSegment({ tenantId: TENANT, collection, revisionId: rev, segment: 0, pages: { from: 1, to: 1 } });
    expect(seg.ok).toBe(true);
    expect(await searchTerm("segfirst")).toHaveLength(0); // nothing indexed yet
    await drain();
    const hits = await searchTerm("segfirst");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.revision_state).toBe("partial");
  });

  it("abort after a segment commit removes the units, their identifiers and the pointer", async () => {
    const ref = "abort-after-seg.pdf";
    const rev = await stageAndProcess(ref, 1, "abortterm", "progressive");
    expect((await store.commitSegment({ tenantId: TENANT, collection, revisionId: rev, segment: 0, pages: { from: 1, to: 1 } })).ok).toBe(true);
    expect(await searchTerm("abortterm")).toHaveLength(1);
    const unit = await pool.query<{ unit_id: string }>(
      `SELECT unit_id FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2 LIMIT 1`,
      [TENANT, rev],
    );
    const unitId = unit.rows[0]?.unit_id;
    if (!unitId) throw new Error("expected a unit");
    await pool.query(
      `INSERT INTO vs_identifiers (tenant_id, collection, value_norm, unit_id, page, kind)
       VALUES ($1, $2, 'WE01A', $3, 1, 'code')`,
      [TENANT, collection, unitId],
    );

    const aborted = await store.abortRevision({ tenantId: TENANT, collection, reference: ref }, rev);
    expect(aborted.ok).toBe(true);
    expect(await searchTerm("abortterm")).toHaveLength(0);
    const rows = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "${table}" WHERE tenant_id = $1 AND revision_id = $2`,
      [TENANT, rev],
    );
    expect(rows.rows[0]?.n).toBe(0);
    const ids = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM vs_identifiers WHERE tenant_id = $1 AND unit_id = $2`,
      [TENANT, unitId],
    );
    expect(ids.rows[0]?.n).toBe(0);
    const pointer = await pool.query(
      `SELECT 1 FROM vs_document_revisions WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
      [TENANT, collection, ref],
    );
    expect(pointer.rows).toHaveLength(0);
  });

  it("abort of a progressive revision resets the pointer to the previous committed revision", async () => {
    const ref = "abort-reset.pdf";
    const oldRev = await stageAndProcess(ref, 1, "resetold", "progressive");
    expect((await store.finalCommit({ tenantId: TENANT, collection, revisionId: oldRev })).ok).toBe(true);
    // Simulate a pointer that names an uncommitted revision (e.g. a progressive
    // revision whose segments went live) and abort it.
    const newRev = await stageAndProcess(ref, 1, "resetnew", "progressive");
    await pool.query(
      `UPDATE vs_document_revisions SET current_revision_id = $4
        WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
      [TENANT, collection, ref, newRev],
    );
    expect((await store.abortRevision({ tenantId: TENANT, collection }, newRev)).ok).toBe(true);
    const pointer = await pool.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM vs_document_revisions WHERE tenant_id = $1 AND collection = $2 AND reference = $3`,
      [TENANT, collection, ref],
    );
    expect(pointer.rows[0]?.current_revision_id).toBe(oldRev);
    expect(await searchTerm("resetold")).toHaveLength(1);
  });

  it("concurrent PUTs of the same batch seq resolve to one staged batch and no-ops", async () => {
    const created = await store.createRevision({ tenantId: TENANT, collection, reference: "concurrent-vis.pdf", ttlMs: 60_000 });
    if (!created.ok) throw new Error("create failed");
    const revisionId = created.result.revision.revisionId;
    const { body, digest } = pageBatch(1, "concterm");
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.stageBatch({ tenantId: TENANT, collection, revisionId, seq: 1, body, contentDigest: digest, ttlMs: 60_000 }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.result.noop)).toHaveLength(1);
    expect((await stateOf(revisionId)).acceptedBatches).toEqual([1]);
  });

  it("a final commit missing the last page is rejected with its range; the old revision stays visible", async () => {
    const ref = "missing-last.pdf";
    const oldRev = await stageAndProcess(ref, 1, "lastold", "progressive");
    expect((await store.finalCommit({ tenantId: TENANT, collection, revisionId: oldRev })).ok).toBe(true);
    const created = await store.createRevision({ tenantId: TENANT, collection, reference: ref, ttlMs: 60_000 });
    if (!created.ok) throw new Error("create failed");
    const rev = created.result.revision.revisionId;
    const page = pageBatch(1, "lastnew");
    const end = endBatch(ref, 2); // declares 2 pages, only page 1 staged
    for (const [seq, b] of [[1, page], [3, end]] as const) {
      await store.stageBatch({ tenantId: TENANT, collection, revisionId: rev, seq, body: b.body, contentDigest: b.digest, ttlMs: 60_000 });
    }
    const res = await store.finalCommit({ tenantId: TENANT, collection, revisionId: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.missingRanges).toEqual([{ from: 2, to: 2 }]);
    }
    await drain();
    expect(await searchTerm("lastold")).toHaveLength(1);
    expect(await searchTerm("lastnew")).toHaveLength(0);
  });

  it("reaper vs pending commit: an accepted commit is never reaped, the old revision stays until the switch", async () => {
    const ref = "reaper-vis.pdf";
    const oldRev = await stageAndProcess(ref, 1, "reapold", "progressive");
    expect((await store.finalCommit({ tenantId: TENANT, collection, revisionId: oldRev })).ok).toBe(true);
    const created = await store.createRevision({ tenantId: TENANT, collection, reference: ref, ttlMs: -1_000 });
    if (!created.ok) throw new Error("create failed");
    const rev = created.result.revision.revisionId;
    for (const [seq, b] of [[1, pageBatch(1, "reapnew")], [2, endBatch(ref, 1)]] as const) {
      await store.stageBatch({ tenantId: TENANT, collection, revisionId: rev, seq, body: b.body, contentDigest: b.digest, ttlMs: -1_000 });
    }
    const [commit, reap] = await Promise.all([
      store.finalCommit({ tenantId: TENANT, collection, revisionId: rev }),
      store.reapExpired(new Date()),
    ]);
    expect(reap.ok).toBe(true);
    await drain();
    if (commit.ok) {
      expect(await searchTerm("reapnew")).toHaveLength(1);
      expect(await searchTerm("reapold")).toHaveLength(0);
    } else {
      // The reaper won the race: the new revision is gone, the old one remains.
      expect(await searchTerm("reapnew")).toHaveLength(0);
      expect(await searchTerm("reapold")).toHaveLength(1);
    }
  });

  it("a v2 replace of a legacy (null-revision) document hides the legacy rows in the same switch", async () => {
    const ref = "legacy-replaced";
    const upserted = await pg.upsert(
      {
        tenantId: TENANT,
        reference: ref,
        baseRef: ref,
        content: "Alte legacyold Fassung.",
        vector: new Array<number>(VECTOR_SIZE).fill(0).map((_, i) => (i === 0 ? 1 : 0.01)),
        metadata: {},
      },
      collection,
    );
    expect(upserted.ok).toBe(true);
    expect(await searchTerm("legacyold")).toHaveLength(1);

    // A legacy document counts as existing → the v2 revision defaults to on_commit.
    const rev = await stageOnly(ref, "legacynew");
    const created = await pool.query<{ visibility: string }>(
      `SELECT visibility FROM vs_revisions WHERE tenant_id = $1 AND revision_id = $2`,
      [TENANT, rev],
    );
    expect(created.rows[0]?.visibility).toBe("on_commit");
    await drain();
    expect(await searchTerm("legacyold")).toHaveLength(1);
    expect(await searchTerm("legacynew")).toHaveLength(0);

    expect((await store.finalCommit({ tenantId: TENANT, collection, revisionId: rev })).ok).toBe(true);
    expect(await searchTerm("legacynew")).toHaveLength(1);
    expect(await searchTerm("legacyold")).toHaveLength(0);
  });
});

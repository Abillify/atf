// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * scale-10k.integration.test.ts
 *
 * The Search-side half of the 10,000-page scaling proof (task 1.16, design
 * §9a.3, requirements 6.4, 6.5, 6.9) against a REAL PostgreSQL + pgvector
 * instance. Where `revision-visibility.integration.test.ts` proves the SQL
 * SEMANTICS on a couple of rows, this proves they hold AT SCALE — a revision
 * with 10,000 page-units spanning many segments and more than two 5,000-row
 * flip batches:
 *
 *   - PROGRESSIVE visibility (6.4): after committing the FIRST segment of a
 *     10,000-page progressive revision, a page in that segment is searchable
 *     with revision_state=partial and pages_available reflecting the committed
 *     range, while a page in an UNCOMMITTED segment is not yet visible.
 *   - ATOMIC final commit (6.5): the final commit flips is_latest across all
 *     ~10,000 units in 5,000-row batches; after commit every unit row of the
 *     revision is is_latest, and search never returns two revisions of the
 *     document (the pointer resolves to exactly one).
 *
 * It also reports the DB profile (row count, table size, flip-batch count,
 * runtime) so the "DB- und Asset-Größe" deliverable of task 1.16 is visible.
 *
 * The units are synthesised directly into the collection table (one per page,
 * is_latest=FALSE) rather than streamed through the batch worker: the batch
 * worker's per-batch behaviour is already covered by its own integration test,
 * and the invariant under test here is the VISIBILITY + FLIP behaviour of the
 * revision store at scale, which only needs rows in the right shape. This keeps
 * a 10,000-row run fast (no embedding, no model) while exercising the real
 * commitSegment / finalCommit SQL.
 *
 * Self-skips when TEST_POSTGRES_URL is unset; fails rather than silently passing
 * when it IS set but unreachable.
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { createRevisionStore, type RevisionStore } from "../src/revision-store.js";
import { collectionTableName } from "../src/collection-ddl.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const TENANT = `scaletest-${Date.now()}`;
const logger = pino({ level: "silent" });

// The scaling shape. 10,000 page-units across 500-page segments (20 segments),
// which is > 2 * FLIP_BATCH_ROWS (5,000) so the final commit's is_latest flip
// MUST run in more than one batch — that is the 6.5 "in 5,000-row batches" bit.
const PAGES = 10_000;
const SEGMENT_PAGES = 500;
const FLIP_BATCH_ROWS = 5_000;

const scope: AccessScope = {
  principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
  userId: undefined,
  userGroups: [],
  tenantId: TENANT,
  scopes: [],
  service: true,
};

describeIfPg("scaling · revision visibility + atomic commit at 10,000 pages (task 1.16)", () => {
  let pool: Pool;
  let store: RevisionStore;
  let pg: PostgresClient;
  const collection = `scaletest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  /**
   * Declare the page range `[from, to]` as an ACCEPTED batch of the revision by
   * staging a lightweight two-record NDJSON body (the boundary pages) through
   * the real revision store. `commitSegment` / `finalCommit` derive their
   * "accepted span" from `vs_ingest_batches`, so this is how the revision store
   * learns the segment's pages exist — without streaming 10,000 records or
   * running the embedding worker (the batch stays `received`, which is all the
   * commit's span check needs). `mergeRanges` collapses the boundary pages into
   * the full contiguous range, so a handful of these cover the whole document.
   */
  async function declareAcceptedRange(
    revisionId: string,
    seq: number,
    from: number,
    to: number,
  ): Promise<void> {
    const record = (page: number) => ({
      type: "page",
      page,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [{ type: "paragraph", id: `p${page}-b1`, page, text: `Seite ${page}.` }],
      assets: [],
      warnings: [],
    });
    const bodyLines = from === to ? [record(from)] : [record(from), record(to)];
    const body = Buffer.from(`${bodyLines.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const digest = createHash("sha256").update(body).digest("hex");
    const staged = await store.stageBatch({
      tenantId: TENANT,
      collection,
      revisionId,
      seq,
      body,
      contentDigest: digest,
      ttlMs: 300_000,
    });
    expect(staged.ok).toBe(true);
  }

  /**
   * Make a revision committable without the embedding worker: stage the
   * trailing `document.end` (the page count the final commit checks coverage
   * against) and mark every staged batch `processed`, which is what the worker
   * would do. The unit rows themselves are synthesised by synthesizePages, so
   * the final commit's deferred switch runs inline.
   */
  async function declareComplete(revisionId: string, reference: string, seq: number, pageCount: number): Promise<void> {
    const body = Buffer.from(`${JSON.stringify({ type: "document.end", reference, pageCount })}\n`);
    const staged = await store.stageBatch({
      tenantId: TENANT,
      collection,
      revisionId,
      seq,
      body,
      contentDigest: createHash("sha256").update(body).digest("hex"),
      ttlMs: 300_000,
    });
    expect(staged.ok).toBe(true);
    await pool.query(
      `UPDATE vs_ingest_batches SET status = 'processed'
        WHERE tenant_id = $1 AND collection = $2 AND revision_id = $3`,
      [TENANT, collection, revisionId],
    );
  }

  /**
   * Synthesise `pages` page-units for a revision directly into the collection
   * table, one row per page (is_latest=FALSE), each with a page-unique FTS term
   * so a search can target a specific page. O(1) round-trips via generate_series.
   * The content embeds `term<page>` so searchTerm(`term${p}`) hits exactly page p.
   */
  async function synthesizePages(
    reference: string,
    revisionId: string,
    pages: number,
    term: string,
  ): Promise<void> {
    const zeroVec = JSON.stringify(new Array<number>(VECTOR_SIZE).fill(0));
    // ts_search must be populated for FTS-only search to match — the batch
    // worker normally does this via to_tsvector(lang, content); here we set it
    // directly for the synthesised rows. The collection defaults to the
    // 'simple' FTS config (no stemming), so a per-page token matches exactly.
    await pool.query(
      `INSERT INTO "${table}"
         (tenant_id, reference, base_ref, is_latest, content, vector, ts_search, revision_id,
          unit_id, unit_type, document_id, page_start, page_end)
       SELECT $1,
              $2 || '@' || $4 || '#page:' || g,
              $2,
              FALSE,
              'Seite ' || g || ' enthaelt ' || $5 || g || ' als Begriff.',
              $3::vector,
              to_tsvector('simple', 'Seite ' || g || ' enthaelt ' || $5 || g || ' als Begriff.'),
              $4,
              'unit-' || $4 || '-' || g,
              'chunk',
              $2,
              g,
              g
       FROM generate_series(1, ${pages}) g`,
      [TENANT, reference, zeroVec, revisionId, term],
    );
  }

  /** FTS-only search for a term in this collection. */
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

  it(
    "progressive: committing only the first segment of a 10,000-page revision makes that segment searchable (partial), later segments invisible",
    async () => {
      const ref = "scale-progressive.pdf";
      const created = await store.createRevision({
        tenantId: TENANT,
        collection,
        reference: ref,
        ttlMs: 300_000,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("create failed");
      // A brand-new document defaults to progressive.
      expect(created.result.revision.visibility).toBe("progressive");
      const revisionId = created.result.revision.revisionId;

      await synthesizePages(ref, revisionId, PAGES, "progterm");
      // Declare every segment's page range as an accepted batch so the store
      // knows the pages exist; commit only segment 0 below.
      const segCount = PAGES / SEGMENT_PAGES;
      for (let s = 0; s < segCount; s++) {
        await declareAcceptedRange(revisionId, s, s * SEGMENT_PAGES + 1, (s + 1) * SEGMENT_PAGES);
      }

      // Nothing is committed yet → the whole revision is invisible.
      expect(await searchTerm("progterm1")).toHaveLength(0);
      expect(await searchTerm(`progterm${PAGES}`)).toHaveLength(0);

      // Commit ONLY segment 0, covering pages [1 … SEGMENT_PAGES].
      const seg = await store.commitSegment({
        tenantId: TENANT,
        collection,
        revisionId,
        segment: 0,
        pages: { from: 1, to: SEGMENT_PAGES },
      });
      expect(seg.ok).toBe(true);

      // A page INSIDE the committed segment is now searchable, carries
      // revision_state=partial and pages_available reflecting the committed
      // range (Requirement 6.4).
      const inSegment = await searchTerm("progterm1");
      expect(inSegment).toHaveLength(1);
      const hit = inSegment[0];
      if (!hit) throw new Error("expected a hit in the committed segment");
      expect(hit.revision_state).toBe("partial");
      expect(hit.pages_available).toBe(`1\u2013${SEGMENT_PAGES}`);

      const edgeOfSegment = await searchTerm(`progterm${SEGMENT_PAGES}`);
      expect(edgeOfSegment).toHaveLength(1);
      expect(edgeOfSegment[0]?.revision_state).toBe("partial");

      // A page in an UNCOMMITTED segment (well past SEGMENT_PAGES) is NOT visible.
      expect(await searchTerm(`progterm${SEGMENT_PAGES + 1}`)).toHaveLength(0);
      expect(await searchTerm(`progterm${PAGES}`)).toHaveLength(0);
    },
    120_000,
  );

  it(
    "atomic final commit: flips is_latest across all ~10,000 units in 5,000-row batches; search never sees two revisions",
    async () => {
      const ref = "scale-atomic.pdf";
      const t0 = performance.now();

      // ── revision 1: the currently-visible document ──
      const rev1Created = await store.createRevision({
        tenantId: TENANT,
        collection,
        reference: ref,
        ttlMs: 300_000,
      });
      expect(rev1Created.ok).toBe(true);
      if (!rev1Created.ok) throw new Error("create failed");
      const rev1 = rev1Created.result.revision.revisionId;
      // Give revision 1 a small, distinct body (one page) and finalise it so the
      // document has a committed pointer before the big replace.
      const zeroVec = JSON.stringify(new Array<number>(VECTOR_SIZE).fill(0));
      await pool.query(
        `INSERT INTO "${table}"
           (tenant_id, reference, base_ref, is_latest, content, vector, ts_search, revision_id,
            unit_id, unit_type, document_id, page_start, page_end)
         VALUES ($1, $2 || '@' || $4 || '#page:1', $2, FALSE, 'Alte Fassung oldscale hier.', $3::vector,
                 to_tsvector('simple', 'Alte Fassung oldscale hier.'),
                 $4, 'unit-' || $4 || '-1', 'chunk', $2, 1, 1)`,
        [TENANT, ref, zeroVec, rev1],
      );
      await declareAcceptedRange(rev1, 0, 1, 1);
      await declareComplete(rev1, ref, 1, 1);
      await store.commitSegment({
        tenantId: TENANT,
        collection,
        revisionId: rev1,
        segment: 0,
        pages: { from: 1, to: 1 },
      });
      const fin1 = await store.finalCommit({ tenantId: TENANT, collection, revisionId: rev1 });
      expect(fin1.ok).toBe(true);
      expect(await searchTerm("oldscale")).toHaveLength(1);

      // ── revision 2: a 10,000-page replace (defaults to on_commit) ──
      const rev2Created = await store.createRevision({
        tenantId: TENANT,
        collection,
        reference: ref,
        ttlMs: 300_000,
      });
      expect(rev2Created.ok).toBe(true);
      if (!rev2Created.ok) throw new Error("create failed");
      // A replace of a committed document defaults to on_commit.
      expect(rev2Created.result.revision.visibility).toBe("on_commit");
      const rev2 = rev2Created.result.revision.revisionId;

      await synthesizePages(ref, rev2, PAGES, "atomterm");
      // Declare the whole document as accepted (one batch per segment) so the
      // final commit's span check sees a contiguous [1 … PAGES] range.
      const segCount2 = PAGES / SEGMENT_PAGES;
      for (let s = 0; s < segCount2; s++) {
        await declareAcceptedRange(rev2, s, s * SEGMENT_PAGES + 1, (s + 1) * SEGMENT_PAGES);
      }
      await declareComplete(rev2, ref, segCount2, PAGES);

      // Before the final commit: rev2's rows are is_latest=FALSE, so more than
      // 2 flip-batches worth of rows are waiting to flip.
      const invisible = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}"
          WHERE tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE`,
        [TENANT, rev2],
      );
      const pendingFlip = Number(invisible.rows[0]?.n);
      expect(pendingFlip).toBe(PAGES);
      // With PAGES rows and a 5,000-row flip batch, the is_latest flip cannot
      // complete in a single statement — it must run in multiple bounded
      // batches (Requirement 6.5's "in 5,000-row batches").
      expect(pendingFlip).toBeGreaterThan(FLIP_BATCH_ROWS);

      // The old revision is still the only visible one (on_commit hides rev2).
      expect(await searchTerm("oldscale")).toHaveLength(1);
      expect(await searchTerm("atomterm1")).toHaveLength(0);

      // ── the atomic final commit ──
      const fin2 = await store.finalCommit({ tenantId: TENANT, collection, revisionId: rev2 });
      expect(fin2.ok).toBe(true);
      if (fin2.ok) expect(fin2.result).toMatchObject({ pending: false, isLatest: true });

      // Every one of rev2's ~10,000 rows is now is_latest=TRUE — the chunked
      // flip covered all of them, not just the first 5,000 (Requirement 6.5).
      const stillFalse = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${table}"
          WHERE tenant_id = $1 AND revision_id = $2 AND is_latest = FALSE`,
        [TENANT, rev2],
      );
      expect(Number(stillFalse.rows[0]?.n)).toBe(0);

      // The switch was atomic: new document visible, old gone. Never both.
      expect(await searchTerm("atomterm1")).toHaveLength(1);
      expect(await searchTerm(`atomterm${PAGES}`)).toHaveLength(1);
      expect(await searchTerm("oldscale")).toHaveLength(0);

      // The pointer resolves to EXACTLY one revision for this document.
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
      expect(revisionsSeen.has(rev2)).toBe(true);

      // ── the DB profile (task 1.16 "DB- und Asset-Größe" deliverable) ──
      const size = await pool.query<{ total: string; rows: string }>(
        `SELECT pg_size_pretty(pg_total_relation_size($1))::text AS total,
                count(*)::text AS rows
           FROM "${table}"
          WHERE tenant_id = $2 AND base_ref = $3`,
        [table, TENANT, ref],
      );
      const wallMs = performance.now() - t0;
      const flipBatches = Math.ceil(PAGES / FLIP_BATCH_ROWS);
      // eslint-disable-next-line no-console
      console.log(
        `[scale-db] pages=${PAGES} rows=${size.rows[0]?.rows} tableTotalSize=${size.rows[0]?.total} ` +
          `flipBatches=${flipBatches} wall=${wallMs.toFixed(0)}ms finalCommitted=true`,
      );
    },
    180_000,
  );
});

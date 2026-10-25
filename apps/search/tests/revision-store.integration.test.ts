// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the revision store against a REAL PostgreSQL instance
 * These verify the SQL-level semantics that unit tests cannot:
 * idempotency-key round-trips, the same-seq/same-digest 200 no-op vs the
 * different-digest 409, staging-before-ack durability, the RevisionState
 * report, idempotent segment/final commits, the 409-with-missing-ranges
 * rejection (including missing first/last pages against the declared page
 * count), the deferred final switch, :ref / Idempotency-Key reference checks,
 * concurrent same-seq PUTs, DELETE cleanup, and the TTL reap + heartbeat
 * extension (including reaper-vs-commit races).
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites);
 * when it IS set and the database is unreachable, the suite fails rather than
 * silently passing.
 *
 *   TEST_POSTGRES_URL=postgres://user:pw@localhost:5432/db npx vitest run
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { buildAssetId } from "@atf/extract-contract";
import {
  createRevisionStore,
  type RevisionScope,
  type RevisionStore,
} from "../src/revision-store.js";
import { createBatchWorker } from "../src/batch-worker.js";
import type { EmbeddingClient } from "../src/embedding-client.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const TENANT = `revtest-${Date.now()}`;
const COLLECTION = "documents";

/** Build a valid NDJSON page batch covering [from,to] and its Content-Digest. */
function pageBatch(from: number, to: number): { body: Buffer; digest: string } {
  const lines: string[] = [];
  for (let p = from; p <= to; p++) {
    lines.push(
      JSON.stringify({ type: "page", page: p, size: { wPt: 595, hPt: 842 }, class: "text", blocks: [] }),
    );
  }
  const body = Buffer.from(`${lines.join("\n")}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

/** A `document.begin` batch declaring the page count. */
function beginBatch(reference: string, pageCount?: number, firstPage?: number): { body: Buffer; digest: string } {
  const record = {
    type: "document.begin",
    contract: "atf-extract/2.0.0",
    reference,
    source: { filename: "doc.pdf", mimeType: "application/pdf", bytes: 1, sha256: "a".repeat(64) },
    pipeline: { extractor: "test" },
    ...(pageCount !== undefined ? { pageCount } : {}),
    ...(firstPage !== undefined ? { firstPage } : {}),
  };
  const body = Buffer.from(`${JSON.stringify(record)}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

/** The trailing `document.end` batch (authoritative page count). */
function endBatch(reference: string, pageCount: number): { body: Buffer; digest: string } {
  const body = Buffer.from(`${JSON.stringify({ type: "document.end", reference, pageCount })}\n`);
  return { body, digest: createHash("sha256").update(body).digest("hex") };
}

/** The worker never embeds here: these page batches carry no blocks. */
const noEmbedder: EmbeddingClient = {
  async embed() {
    throw new Error("unexpected embed");
  },
  async embedBatch() {
    throw new Error("unexpected embed");
  },
};

describeIfPg("revision store · real postgres", () => {
  let pool: Pool;
  let store: RevisionStore;
  const scope: RevisionScope = { tenantId: TENANT, collection: COLLECTION };

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    store = createRevisionStore(pool);
    await store.ensureSchema();
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query(`DELETE FROM vs_ingest_batches WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_segments WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_document_revisions WHERE tenant_id = $1`, [TENANT]);
      await pool.query(`DELETE FROM vs_revisions WHERE tenant_id = $1`, [TENANT]);
    } catch {
      /* best-effort */
    }
    await pool.end();
  });

  async function stage(rev: string, seq: number, batch: { body: Buffer; digest: string }): Promise<void> {
    const res = await store.stageBatch({ ...scope, revisionId: rev, seq, body: batch.body, contentDigest: batch.digest, ttlMs: 60_000 });
    if (!res.ok) throw new Error(`stage failed: ${JSON.stringify(res.error)}`);
  }

  async function drainWorker(): Promise<void> {
    const worker = createBatchWorker(pool, noEmbedder, { intervalMs: 0, onlyTenantId: TENANT });
    const outcomes = await worker.drain();
    worker.stop();
    const failed = outcomes.filter((o) => o.kind === "error" || o.kind === "deferred");
    if (failed.length > 0) throw new Error(`worker failed: ${JSON.stringify(failed)}`);
  }

  async function newRevision(reference: string, key?: string): Promise<string> {
    const r = await store.createRevision({ ...scope, reference, idempotencyKey: key, ttlMs: 60_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("create failed");
    return r.result.revision.revisionId;
  }

  it("returns the SAME revision for a repeated Idempotency-Key (Req 5.1)", async () => {
    const first = await store.createRevision({ ...scope, reference: "idem.pdf", idempotencyKey: "job-1", ttlMs: 60_000 });
    const second = await store.createRevision({ ...scope, reference: "idem.pdf", idempotencyKey: "job-1", ttlMs: 60_000 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.result.created).toBe(true);
    expect(second.result.created).toBe(false);
    expect(second.result.revision.revisionId).toBe(first.result.revision.revisionId);
  });

  it("stages a batch, then a replay with the same digest is a 200 no-op (Req 5.2)", async () => {
    const rev = await newRevision("digest.pdf");
    const { body, digest } = pageBatch(1, 10);
    const staged = await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    if (!staged.ok) throw new Error(JSON.stringify(staged.error));
    if (staged.ok) expect(staged.result.noop).toBe(false);

    const replay = await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.result.noop).toBe(true);
  });

  it("rejects the same seq with a different digest (409, Req 5.2)", async () => {
    const rev = await newRevision("conflict.pdf");
    const a = pageBatch(1, 5);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: a.body, contentDigest: a.digest, ttlMs: 60_000 });
    const b = pageBatch(6, 10); // same seq, different content ⇒ different digest
    const res = await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: b.body, contentDigest: b.digest, ttlMs: 60_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.code).toBe("BATCH_DIGEST_CONFLICT");
    }
  });

  it("rejects a batch whose body does not match the Content-Digest (400)", async () => {
    const rev = await newRevision("mismatch.pdf");
    const { body } = pageBatch(1, 3);
    const res = await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body, contentDigest: "b".repeat(64), ttlMs: 60_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.status).toBe(400);
  });

  it("rejects a malformed record with the contract issue list (422, Req 5.2/3.5)", async () => {
    const rev = await newRevision("badrecord.pdf");
    const bad = Buffer.from(`${JSON.stringify({ type: "page", page: 1, class: "text", blocks: [] })}\n`);
    const digest = createHash("sha256").update(bad).digest("hex");
    const res = await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: bad, contentDigest: digest, ttlMs: 60_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(422);
      expect(res.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it("reports the RevisionState (accepted batches, missing assets, status, Req 5.6)", async () => {
    const reference = "state.pdf";
    const rev = await newRevision(reference);
    // A batch that references a figure asset that has NOT been uploaded.
    const figureAssetId = buildAssetId(reference, "p1-f1");
    const page = JSON.stringify({
      type: "page",
      page: 1,
      size: { wPt: 595, hPt: 842 },
      class: "text",
      blocks: [
        { type: "figure", id: "b1", page: 1, figureId: "p1-f1", kind: "diagram", description: "A diagram.", assetId: figureAssetId },
      ],
    });
    const body = Buffer.from(`${page}\n`);
    const digest = createHash("sha256").update(body).digest("hex");
    await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });

    const state = await store.getRevisionState(scope, rev);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.result.acceptedBatches).toEqual([0]);
    expect(state.result.status).toBe("partial");
    expect(state.result.missingAssets).toContain(figureAssetId);
    // Leave no figure batch behind for the shared worker drains below (it would
    // need the embedder and the collection table).
    expect((await store.abortRevision(scope, rev)).ok).toBe(true);
  });

  it("commits a segment idempotently and the final commit idempotently (Req 5.9)", async () => {
    const rev = await newRevision("commit.pdf");
    await stage(rev, 0, pageBatch(1, 250));
    await stage(rev, 1, endBatch("commit.pdf", 250));

    const seg1 = await store.commitSegment({ ...scope, revisionId: rev, segment: 0, pages: { from: 1, to: 250 } });
    const seg2 = await store.commitSegment({ ...scope, revisionId: rev, segment: 0, pages: { from: 1, to: 250 } });
    expect(seg1.ok && seg2.ok).toBe(true);

    // Batches are still 'received': the commit is ACCEPTED but the switch is
    // deferred until the worker processed them (pending, not yet latest).
    const c1 = await store.finalCommit({ ...scope, revisionId: rev });
    const c2 = await store.finalCommit({ ...scope, revisionId: rev });
    if (!c1.ok || !c2.ok) throw new Error(`commit failed: ${JSON.stringify([c1, c2])}`);
    if (c1.ok) expect(c1.result).toMatchObject({ committed: true, pending: true, isLatest: false });
    if (c2.ok) expect(c2.result).toMatchObject({ committed: true, pending: true, isLatest: false });
    const pendingState = await store.getRevisionState(scope, rev);
    expect(pendingState.ok && pendingState.result.status).toBe("partial");
    expect(pendingState.ok && pendingState.result.commitPending).toBe(true);
    // No further batches once the commit is accepted.
    const late = await store.stageBatch({ ...scope, revisionId: rev, seq: 9, ...(() => { const b = pageBatch(251, 251); return { body: b.body, contentDigest: b.digest }; })(), ttlMs: 60_000 });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe("REVISION_COMMIT_PENDING");

    // The worker processes the last batch and completes the switch itself.
    await drainWorker();
    const done = await store.getRevisionState(scope, rev);
    expect(done.ok && done.result.status).toBe("committed");
    expect(done.ok && done.result.commitPending).toBe(false);
    const c3 = await store.finalCommit({ ...scope, revisionId: rev });
    expect(c3.ok).toBe(true);
    if (c3.ok) expect(c3.result).toMatchObject({ committed: true, pending: false, isLatest: true });
  });

  it("rejects a final commit whose LAST page is missing against document.begin's page count (409)", async () => {
    const rev = await newRevision("lastpage.pdf");
    await stage(rev, 0, beginBatch("lastpage.pdf", 10));
    await stage(rev, 1, pageBatch(1, 9));
    const res = await store.finalCommit({ ...scope, revisionId: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.missingRanges).toEqual([{ from: 10, to: 10 }]);
    }
  });

  it("rejects a final commit whose FIRST pages are missing against document.end's page count (409)", async () => {
    const rev = await newRevision("firstpages.pdf");
    await stage(rev, 0, pageBatch(3, 10));
    await stage(rev, 1, endBatch("firstpages.pdf", 10));
    const res = await store.finalCommit({ ...scope, revisionId: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.missingRanges).toEqual([{ from: 1, to: 2 }]);
    }
  });

  it("commits a pages window [5, 9] without pages 1-4, and still rejects a gap inside it (contract 2.4)", async () => {
    const complete = await newRevision("window-ok.pdf");
    // Batch seqs stay absolute for a window; document.begin rides in the first batch sent.
    const begin = beginBatch("window-ok.pdf", 9, 5).body;
    const pages = pageBatch(5, 9).body;
    const first = Buffer.concat([begin, pages]);
    await stage(complete, 1, { body: first, digest: createHash("sha256").update(first).digest("hex") });
    const ok = await store.finalCommit({ ...scope, revisionId: complete });
    expect(ok.ok).toBe(true);

    const gap = await newRevision("window-gap.pdf");
    await stage(gap, 0, beginBatch("window-gap.pdf", 9, 5));
    await stage(gap, 1, pageBatch(5, 6));
    await stage(gap, 3, pageBatch(8, 9));
    const rejected = await store.finalCommit({ ...scope, revisionId: gap });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.status).toBe(409);
      expect(rejected.error.missingRanges).toEqual([{ from: 7, to: 7 }]);
    }
  });
  it("rejects a final commit with an unknown page count and no document.end (409)", async () => {
    const rev = await newRevision("noend.pdf");
    await stage(rev, 0, beginBatch("noend.pdf"));
    await stage(rev, 1, pageBatch(1, 5));
    const res = await store.finalCommit({ ...scope, revisionId: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.code).toBe("COMMIT_DOCUMENT_END_MISSING");
      expect(res.error.missingRanges).toEqual([]);
    }
  });

  it("rejects a :ref that names a different document, and a reused Idempotency-Key for another document (409)", async () => {
    const rev = await newRevision("owner.pdf", "job-ref-1");
    const other: RevisionScope = { ...scope, reference: "someone-else.pdf" };
    const state = await store.getRevisionState(other, rev);
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.code).toBe("REVISION_REFERENCE_MISMATCH");
    const b = pageBatch(1, 1);
    const put = await store.stageBatch({ ...other, revisionId: rev, seq: 0, body: b.body, contentDigest: b.digest, ttlMs: 60_000 });
    expect(put.ok).toBe(false);
    if (!put.ok) expect(put.error.status).toBe(409);
    for (const res of [
      await store.commitSegment({ ...other, revisionId: rev, segment: 0 }),
      await store.finalCommit({ ...other, revisionId: rev }),
      await store.heartbeat(other, rev, 60_000),
      await store.abortRevision(other, rev),
    ]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("REVISION_REFERENCE_MISMATCH");
    }
    // The matching reference still works.
    expect((await store.getRevisionState({ ...scope, reference: "owner.pdf" }, rev)).ok).toBe(true);

    const reused = await store.createRevision({ ...scope, reference: "different.pdf", idempotencyKey: "job-ref-1", ttlMs: 60_000 });
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("concurrent PUTs of the same seq are a no-op / 409, never a 5xx", async () => {
    const rev = await newRevision("concurrent.pdf");
    const same = pageBatch(1, 3);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: same.body, contentDigest: same.digest, ttlMs: 60_000 }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.result.noop)).toHaveLength(1);

    const variants = Array.from({ length: 6 }, (_, i) => pageBatch(10 + i, 10 + i));
    const racing = await Promise.all(
      variants.map((v) =>
        store.stageBatch({ ...scope, revisionId: rev, seq: 1, body: v.body, contentDigest: v.digest, ttlMs: 60_000 }),
      ),
    );
    expect(racing.filter((r) => r.ok)).toHaveLength(1);
    for (const r of racing) {
      if (!r.ok) expect(r.error.status).toBe(409);
    }
  });

  it("rejects a final commit with missing batches (409 + missing ranges, Req 5.9)", async () => {
    const rev = await newRevision("gap.pdf");
    const a = pageBatch(1, 100);
    const b = pageBatch(201, 300);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: a.body, contentDigest: a.digest, ttlMs: 60_000 });
    await store.stageBatch({ ...scope, revisionId: rev, seq: 1, body: b.body, contentDigest: b.digest, ttlMs: 60_000 });
    const res = await store.finalCommit({ ...scope, revisionId: rev });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.status).toBe(409);
      expect(res.error.missingRanges).toEqual([{ from: 101, to: 200 }]);
    }
  });

  it("aborts a revision and cleans up its batches (DELETE)", async () => {
    const rev = await newRevision("abort.pdf");
    const { body, digest } = pageBatch(1, 5);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body, contentDigest: digest, ttlMs: 60_000 });
    const res = await store.abortRevision(scope, rev);
    expect(res.ok).toBe(true);
    const after = await store.getRevisionState(scope, rev);
    expect(after.ok).toBe(false); // revision no longer exists
    const batches = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2`,
      [TENANT, rev],
    );
    expect(batches.rows[0].n).toBe(0);
  });

  it("reaps an expired uncommitted revision and a heartbeat prevents the reap (Req 5.10)", async () => {
    // A revision that expires immediately.
    const expiring = await store.createRevision({ ...scope, reference: "expire.pdf", ttlMs: -1000 });
    expect(expiring.ok).toBe(true);
    // A revision kept alive by a fresh heartbeat.
    const alive = await newRevision("alive.pdf");
    const hb = await store.heartbeat(scope, alive, 60_000);
    expect(hb.ok).toBe(true);

    const reap = await store.reapExpired(new Date());
    expect(reap.ok).toBe(true);
    if (reap.ok) expect(reap.result.reaped).toBeGreaterThanOrEqual(1);

    // The heartbeated revision survives; the expired one is gone.
    const aliveState = await store.getRevisionState(scope, alive);
    expect(aliveState.ok).toBe(true);
    if (expiring.ok) {
      const goneState = await store.getRevisionState(scope, expiring.result.revision.revisionId);
      expect(goneState.ok).toBe(false);
    }
  });

  it("does not reap a committed revision (its TTL is cleared)", async () => {
    const rev = await newRevision("committed.pdf");
    const { body, digest } = pageBatch(1, 10);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body, contentDigest: digest, ttlMs: -1000 });
    const end = endBatch("committed.pdf", 10);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 1, body: end.body, contentDigest: end.digest, ttlMs: -1000 });
    await store.finalCommit({ ...scope, revisionId: rev });
    await drainWorker();
    await store.reapExpired(new Date());
    const state = await store.getRevisionState(scope, rev);
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.result.status).toBe("committed");
  });

  it("does not reap an expired revision whose final commit was accepted (commit pending)", async () => {
    const rev = await newRevision("pending-reap.pdf");
    const b = pageBatch(1, 2);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: b.body, contentDigest: b.digest, ttlMs: -1000 });
    const end = endBatch("pending-reap.pdf", 2);
    await store.stageBatch({ ...scope, revisionId: rev, seq: 1, body: end.body, contentDigest: end.digest, ttlMs: -1000 });
    const commit = await store.finalCommit({ ...scope, revisionId: rev });
    expect(commit.ok && commit.result.pending).toBe(true);
    await store.reapExpired(new Date());
    const state = await store.getRevisionState(scope, rev);
    expect(state.ok && state.result.commitPending).toBe(true);
    await drainWorker();
    const after = await store.getRevisionState(scope, rev);
    expect(after.ok && after.result.status).toBe("committed");
  });

  it("reaper vs commit race: exactly one wins, never a half state", async () => {
    for (let i = 0; i < 5; i++) {
      const ref = `race-${i}.pdf`;
      const rev = await newRevision(ref);
      const b = pageBatch(1, 1);
      await store.stageBatch({ ...scope, revisionId: rev, seq: 0, body: b.body, contentDigest: b.digest, ttlMs: -1000 });
      const end = endBatch(ref, 1);
      await store.stageBatch({ ...scope, revisionId: rev, seq: 1, body: end.body, contentDigest: end.digest, ttlMs: -1000 });
      const [commit] = await Promise.all([
        store.finalCommit({ ...scope, revisionId: rev }),
        store.reapExpired(new Date()),
      ]);
      const state = await store.getRevisionState(scope, rev);
      if (commit.ok) {
        // The commit won: the reaper re-checked under the lock and left it.
        expect(state.ok && state.result.commitPending).toBe(true);
      } else {
        // The reaper won: the revision and its batches are gone.
        expect(state.ok).toBe(false);
        const left = await pool.query(
          `SELECT COUNT(*)::int AS n FROM vs_ingest_batches WHERE tenant_id = $1 AND revision_id = $2`,
          [TENANT, rev],
        );
        expect(left.rows[0].n).toBe(0);
      }
    }
    await drainWorker();
  });
});

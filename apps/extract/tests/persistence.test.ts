// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * persistence.test.ts
 *
 * Unit tests for the extract persistence layer that need no live database:
 * migration-SQL construction, forward-only schema-version tracking, and the
 * parameterised query builders. Mirrors how search tests its DDL with a
 * recording pg-client mock (see apps/search/tests/collection-ddl.test.ts).
 *
 * A guarded integration block at the end exercises the real store against a
 * PostgreSQL given via TEST_POSTGRES_URL, and self-skips when it is unset —
 * same convention as search's pgvector-integration suite — so the default
 * suite passes with no database present.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pino } from "pino";
import {
  EXTRACT_SCHEMA,
  EXTRACT_SCHEMA_VERSION,
  EXTRACT_MIGRATIONS,
  applyPendingMigrations,
  ensureExtractSchema,
  type MigrationClient,
} from "../src/persistence/extract-ddl.js";
import * as q from "../src/persistence/extract-queries.js";
import { createExtractStore } from "../src/persistence/extract-store.js";

const silentLogger = pino({ level: "silent" });

/**
 * A recording pg-client mock. `versionRow` seeds what the schema-version SELECT
 * returns, so a test can simulate an already-migrated database.
 */
function recordingClient(options: { appliedVersion?: number } = {}): {
  client: MigrationClient;
  queries: string[];
} {
  const queries: string[] = [];
  const client: MigrationClient = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes("MAX(version)")) {
        return { rows: [{ version: options.appliedVersion ?? 0 }] };
      }
      return { rows: [] };
    },
  };
  return { client, queries };
}

describe("extract schema bootstrap", () => {
  it("creates the extract schema and a schema_migrations log", async () => {
    const { client, queries } = recordingClient();
    await ensureExtractSchema(client);
    const joined = queries.join("\n");
    expect(joined).toContain(`CREATE SCHEMA IF NOT EXISTS ${EXTRACT_SCHEMA}`);
    expect(joined).toContain(`${EXTRACT_SCHEMA}.schema_migrations`);
  });
});

describe("forward-only migration runner", () => {
  it("applies every table, keyed under the extract schema, on a fresh database", async () => {
    const { client, queries } = recordingClient({ appliedVersion: 0 });
    await ensureExtractSchema(client);
    const version = await applyPendingMigrations(client, silentLogger);
    expect(version).toBe(EXTRACT_SCHEMA_VERSION);

    const joined = queries.join("\n");
    for (const table of [
      "jobs",
      "page_stages",
      "figure_stages",
      "tile_stages",
      "docpass_state",
      "emit_outbox",
      "asset_outbox",
      "uploads",
    ]) {
      expect(joined).toContain(`${EXTRACT_SCHEMA}.${table}`);
    }
    // Every migration step runs inside its own transaction.
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("COMMIT");
    // The applied version is recorded.
    expect(joined).toContain(`${EXTRACT_SCHEMA}.schema_migrations`);
  });

  it("creates the worker-query indices: status and (status, next_attempt_at)", async () => {
    const { client, queries } = recordingClient({ appliedVersion: 0 });
    await ensureExtractSchema(client);
    await applyPendingMigrations(client, silentLogger);
    const joined = queries.join("\n");

    // status-only and (status, next_attempt_at) on jobs and every stage table
    for (const table of ["jobs", "page_stages", "figure_stages", "tile_stages"]) {
      expect(joined).toContain(`${table}_status_idx`);
      expect(joined).toContain(`${table}_status_next_attempt_idx`);
    }
    // jobs.next_attempt_at backoff scheduling is part of the composite index
    expect(joined).toContain("(status, next_attempt_at, priority DESC, created_at)");
    // lease-takeover scan index
    expect(joined).toContain("jobs_lease_expires_idx");
  });

  it("is a no-op when the database is already at the current version", async () => {
    const { client, queries } = recordingClient({ appliedVersion: EXTRACT_SCHEMA_VERSION });
    await ensureExtractSchema(client);
    const beforeCount = queries.length;
    const version = await applyPendingMigrations(client, silentLogger);
    expect(version).toBe(EXTRACT_SCHEMA_VERSION);
    // Only the version SELECT ran; no BEGIN/CREATE TABLE.
    expect(queries.slice(beforeCount).some((s) => s.includes("BEGIN"))).toBe(false);
    expect(queries.slice(beforeCount).some((s) => s.includes("CREATE TABLE"))).toBe(false);
  });

  it("rolls back and rethrows when a migration step fails", async () => {
    const queries: string[] = [];
    const failing: MigrationClient = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("MAX(version)")) return { rows: [{ version: 0 }] };
        if (sql.startsWith("\n      CREATE TABLE") || sql.includes("CREATE TABLE")) {
          throw new Error("boom");
        }
        return { rows: [] };
      },
    };
    await expect(applyPendingMigrations(failing, silentLogger)).rejects.toThrow("boom");
    expect(queries).toContain("ROLLBACK");
  });

  it("keeps migration steps unique and strictly ascending", () => {
    const versions = EXTRACT_MIGRATIONS.map((m) => m.toVersion);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
    expect(Math.max(...versions)).toBe(EXTRACT_SCHEMA_VERSION);
  });
});

describe("query builders", () => {
  it("insertJobQuery parameterises every value and never inlines the reference", () => {
    const query = q.insertJobQuery({
      id: "00000000-0000-0000-0000-000000000001",
      reference: "tests/handbuch.pdf",
      source_sha256: "a".repeat(64),
      collection: "documents",
    });
    expect(query.text).toContain(`INSERT INTO ${EXTRACT_SCHEMA}.jobs`);
    expect(query.text).toContain("$13");
    expect(query.text).not.toContain("tests/handbuch.pdf");
    expect(query.values).toContain("tests/handbuch.pdf");
    // status/resume_policy/visibility default to the contract vocabulary.
    expect(query.values).toContain("queued");
    expect(query.values).toContain("pin");
    expect(query.values).toContain("progressive");
  });

  it("listJobsQuery orders newest-first, paginates, and joins no stage tables", () => {
    const query = q.listJobsQuery(25, 50);
    expect(query.text).toContain(`SELECT * FROM ${EXTRACT_SCHEMA}.jobs`);
    // Newest-first with a total order (id tie-break) so pagination is stable.
    expect(query.text).toContain("ORDER BY created_at DESC, id DESC");
    expect(query.text).toContain("LIMIT $1 OFFSET $2");
    expect(query.values).toEqual([25, 50]);
    // Cheap by design: it must not join the per-page/figure/tile stage tables.
    expect(query.text).not.toContain("page_stages");
    expect(query.text).not.toContain("figure_stages");
    expect(query.text).not.toContain("tile_stages");
    expect(query.text.toUpperCase()).not.toContain("JOIN");
  });

  it("claimNextJobQuery uses FOR UPDATE SKIP LOCKED and bumps the lease epoch", () => {
    const query = q.claimNextJobQuery("worker-1", 60);
    expect(query.text).toContain("SKIP LOCKED");
    expect(query.text).toContain("lease_epoch      = j.lease_epoch + 1");
    // With the default (no-cap) thresholds, the lane guard never excludes a job.
    // The sentinel is the 32-bit signed INTEGER max (2^31 − 1); a larger value
    // (e.g. Number.MAX_SAFE_INTEGER) overflows the INTEGER-typed page_count /
    // COUNT(*)::int comparisons the parameters are bound into.
    expect(query.values).toEqual([
      "worker-1",
      "60",
      2_147_483_647,
      2_147_483_647,
    ]);
  });

  it("claimNextJobQuery lanes large jobs behind a bounded-concurrency cap (requirement 6.6)", () => {
    const query = q.claimNextJobQuery("worker-1", 60, 1000, 2);
    // The large lane's live-lease count is computed in-statement, so the cap is
    // consistent across concurrent workers.
    expect(query.text).toContain("large_lane");
    expect(query.text).toContain("active_large");
    expect(query.text).toContain("page_count > $3");
    // A large job is only eligible when the lane has a free slot; an unsized
    // (null page_count) job is normal-lane and always eligible.
    expect(query.text).toContain("j.page_count IS NULL");
    expect(query.text).toContain("j.page_count <= $3");
    expect(query.text).toContain("large_lane.active_large < $4");
    // Deterministic, total order: priority, then due time, then age, then id.
    expect(query.text).toContain(
      "ORDER BY j.priority DESC, j.next_attempt_at, j.created_at, j.id",
    );
    // Locks only the picked job row, skipping rows another worker holds.
    expect(query.text).toContain("FOR UPDATE OF j SKIP LOCKED");
    expect(query.values).toEqual(["worker-1", "60", 1000, 2]);
  });

  it("heartbeatJobQuery fences on holder AND epoch so a zombie worker is a no-op", () => {
    const query = q.heartbeatJobQuery("job-1", "worker-1", 3, 60);
    expect(query.text).toContain("lease_holder = $2 AND lease_epoch = $3");
    expect(query.values).toEqual(["job-1", "worker-1", 3, "60"]);
  });

  it("getStageQuery keys page/figure/tile units on their natural keys", () => {
    const page = q.getStageQuery("page", { job_id: "j", page: 3, stage: "vision1" });
    expect(page.text).toContain(`${EXTRACT_SCHEMA}.page_stages`);
    expect(page.text).toContain("job_id = $1 AND page = $2 AND stage = $3");
    expect(page.values).toEqual(["j", 3, "vision1"]);

    const figure = q.getStageQuery("figure", {
      job_id: "j",
      page: 3,
      figure_id: "fig-1",
      stage: "vision2",
    });
    expect(figure.text).toContain(`${EXTRACT_SCHEMA}.figure_stages`);
    expect(figure.text).toContain("figure_id = $3");
    expect(figure.values).toEqual(["j", 3, "fig-1", "vision2"]);

    const tile = q.getStageQuery("tile", {
      job_id: "j",
      page: 3,
      tile_id: "t-1",
      stage: "tiled",
    });
    expect(tile.text).toContain(`${EXTRACT_SCHEMA}.tile_stages`);
    expect(tile.values).toEqual(["j", 3, "t-1", "tiled"]);
  });

  it("upsertStageQuery increments attempts on conflict and casts output to jsonb", () => {
    const query = q.upsertStageQuery("page", {
      job_id: "j",
      page: 1,
      stage: "vision1",
      input_hash: "h1",
      status: "done",
      output: { raw: "…" },
    });
    expect(query.text).toContain("ON CONFLICT (job_id, page, stage) DO UPDATE SET");
    expect(query.text).toContain("attempts        = page_stages.attempts + 1");
    expect(query.text).toContain("::jsonb");
    // output is serialised to a JSON string parameter, not inlined.
    expect(query.values).toContain(JSON.stringify({ raw: "…" }));
    expect(query.values).toContain("h1");
  });

  it("upsertDocpassStateQuery upserts per (job, page)", () => {
    const query = q.upsertDocpassStateQuery("j", 5, { outline: ["A"] });
    expect(query.text).toContain("ON CONFLICT (job_id, page) DO UPDATE SET");
    expect(query.values).toEqual(["j", 5, JSON.stringify({ outline: ["A"] })]);
  });

  it("emit-outbox status builder moves a batch through its lifecycle", () => {
    const query = q.setEmitOutboxStatusQuery("j", 2, "acked");
    expect(query.text).toContain(`UPDATE ${EXTRACT_SCHEMA}.emit_outbox`);
    expect(query.values).toEqual(["j", 2, "acked"]);
  });

  it("pendingEmitOutboxQuery selects everything not yet acked for reconciliation", () => {
    const query = q.pendingEmitOutboxQuery("j");
    expect(query.text).toContain("status <> 'acked'");
    expect(query.values).toEqual(["j"]);
  });

  it("fences worker writes to the job row on holder AND epoch in the same statement", () => {
    const fence = { jobId: "j", holder: "w", epoch: 7 };
    const status = q.updateJobStatusQuery("j", "processing", null, fence);
    expect(status.text).toContain("AND lease_holder = $4 AND lease_epoch = $5");
    expect(status.values).toEqual(["j", "processing", null, "w", 7]);
    // Unfenced (operator) writes carry no lease condition.
    expect(q.updateJobStatusQuery("j", "processing").text).not.toContain("lease_epoch");
    const check = q.fenceCheckQuery(fence, "share");
    expect(check.text).toContain("lease_holder = $2 AND lease_epoch = $3");
    expect(check.text).toContain("FOR SHARE");
    expect(q.fenceCheckQuery(fence, "update").text).toContain("FOR NO KEY UPDATE");
  });

  it("operator transitions revoke the lease atomically and guard on the expected status", () => {
    const query = q.operatorTransitionQuery("j", {
      expectedStatus: "processing",
      status: "cancelled",
      pauseReason: null,
    });
    expect(query.text).toContain("lease_epoch      = lease_epoch + 1");
    expect(query.text).toContain("lease_holder     = NULL");
    expect(query.text).toContain("WHERE id = $1 AND status = $2");
    expect(q.requeueJobQuery("j").text).toContain("lease_epoch      = lease_epoch + 1");
  });

  it("reserves budget atomically in one conditional UPDATE", () => {
    const query = q.reserveJobTokensQuery("j", 30);
    expect(query.text).toContain("tokens_reserved = tokens_reserved + $2");
    expect(query.text).toContain("token_budget - tokens_used - tokens_reserved >= $2");
  });

  it("the claim auto-resumes due dependency pauses and drops stale reservations", () => {
    const query = q.claimNextJobQuery("w", 60);
    expect(query.text).toContain("j.status = 'paused' AND j.auto_resume AND j.next_attempt_at <= NOW()");
    expect(query.text).toContain("tokens_reserved  = 0");
  });

  it("the page scheduler excludes pages with any unit in backoff", () => {
    const query = q.nextRunnablePagesQuery("j", 10, "emitted", 4, new Date(0));
    for (const table of ["page_stages", "figure_stages", "tile_stages"]) {
      expect(query.text).toContain(`${EXTRACT_SCHEMA}.${table} b`);
    }
    expect(query.text).toContain("b.next_attempt_at > $5");
  });
  it("the page scheduler generates from firstPage, defaulting to 1", () => {
    const whole = q.nextRunnablePagesQuery("j", 10, "emitted", 4, new Date(0));
    expect(whole.text).toContain("generate_series($6::int, $2)");
    expect(whole.values[5]).toBe(1);
    expect(q.nextRunnablePagesQuery("j", 10, "emitted", 4, new Date(0), 7).values[5]).toBe(7);
  });

  it("re-staging an emit row replaces a changed, unacknowledged payload only", () => {
    const query = q.insertEmitOutboxQuery({ job_id: "j", seq: 1, digest: "d", page_from: 1, page_to: 1 });
    expect(query.text).toContain("WHERE emit_outbox.status <> 'acked'");
    expect(query.text).toContain("emit_outbox.digest IS DISTINCT FROM EXCLUDED.digest");
  });

  it("updateUploadOffsetQuery advances the confirmed byte offset", () => {
    const query = q.updateUploadOffsetQuery("u1", 1024, "open");
    expect(query.text).toContain("received_offset = $2");
    expect(query.values).toEqual(["u1", 1024, "open", null]);
  });
  it("lockUploadForAppendQuery row-locks the session", () => {
    const query = q.lockUploadForAppendQuery("u1");
    expect(query.text).toMatch(/SELECT \* FROM extract\.uploads WHERE upload_id = \$1 FOR UPDATE/);
    expect(query.values).toEqual(["u1"]);
  });
  it("advanceUploadOffsetQuery only advances an open session at the expected offset", () => {
    const query = q.advanceUploadOffsetQuery("u1", 8, 20);
    expect(query.text).toMatch(/SET received_offset = \$3/);
    expect(query.text).toMatch(/WHERE upload_id = \$1\s+AND received_offset = \$2\s+AND status = 'open'/);
    expect(query.values).toEqual(["u1", 8, 20]);
  });
});

// ─── Live-database integration (guarded) ─────────────────────────────────────

const CONNECTION = process.env["TEST_POSTGRES_URL"];
const describeIfPg = CONNECTION ? describe : describe.skip;

describeIfPg("extract-store · real PostgreSQL", () => {
  // Guarded by describeIfPg: this block only runs when CONNECTION is set.
  const connectionUrl = CONNECTION ?? "";
  const store = createExtractStore(
    { url: connectionUrl, poolMax: 4, statementTimeoutMs: 30_000 },
    silentLogger,
  );
  const jobId = crypto.randomUUID();

  beforeAll(async () => {
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  it("migrates, creates a job and reads it back", async () => {
    const created = await store.createJob({
      id: jobId,
      reference: "tests/handbuch.pdf",
      source_sha256: "a".repeat(64),
      collection: "documents",
    });
    expect(created.id).toBe(jobId);
    expect(created.status).toBe("queued");

    const fetched = await store.getJob(jobId);
    expect(fetched?.reference).toBe("tests/handbuch.pdf");
  });

  it("listJobs returns newest-first with a working limit/offset window", async () => {
    // Insert a few more jobs; created_at is stamped by the DB in insert order.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await store.createJob({ id, reference: `tests/list-${i}.pdf`, source_sha256: "c".repeat(64) });
      // A tiny gap so created_at differs even at coarse clock resolution.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const page = await store.listJobs(2, 0);
    expect(page).toHaveLength(2);
    // Newest-first: the last-created id leads.
    expect(page[0]?.id).toBe(ids[2]);
    expect(page[1]?.id).toBe(ids[1]);
    // The offset window continues from where the first page stopped.
    const next = await store.listJobs(2, 2);
    expect(next[0]?.id).toBe(ids[0]);
  });

  it("lists in queue order with a status filter, counts, summarises and folds stage counts", async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const ids = { queued: crypto.randomUUID(), running: crypto.randomUUID(), done: crypto.randomUUID() };
    for (const [name, id] of Object.entries(ids)) {
      await store.createJob({ id, reference: `tests/overview-${tag}-${name}.pdf`, source_sha256: "e".repeat(64) });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await store.setJobStatus(ids.running, "processing");
    await store.setJobPageCount(ids.running, 3);
    await store.setJobStatus(ids.done, "completed");
    await store.consumeJobTokens(ids.done, 1_000, undefined, 0.5);
    await store.upsertStage("page", {
      job_id: ids.running, page: 1, stage: "emitted", input_hash: "h", status: "done",
      output: null, next_attempt_at: null, error: null,
    });

    const active = await store.listJobs(10, 0, { order: "queue", statuses: ["processing"] });
    expect(active.map((r) => r.id)).toContain(ids.running);
    expect(active.every((r) => r.status === "processing")).toBe(true);
    const queue = await store.listJobs(1000, 0, { order: "queue" });
    const order = queue.map((r) => r.id).filter((id) => Object.values(ids).includes(id));
    expect(order).toEqual([ids.running, ids.queued, ids.done]);
    expect(await store.countJobs(["processing"])).toBe(active.length);

    const counts = await store.pageStageCounts([ids.running, ids.queued]);
    expect(counts).toEqual([
      expect.objectContaining({ job_id: ids.running, stage: "emitted", status: "done", n: "1" }),
    ]);
    const summary = await store.jobStatusSummary();
    const completed = summary.filter((g) => g.status === "completed").reduce((sum, g) => sum + Number(g.cost_usd), 0);
    expect(completed).toBeGreaterThanOrEqual(0.5);
    const pages = await store.activePageProgress();
    expect(pages.total).toBeGreaterThanOrEqual(3);
    expect(pages.done).toBeGreaterThanOrEqual(1);
    expect(Number((await store.getJob(ids.done))?.cost_usd)).toBeCloseTo(0.5);
  });
  it("knownEmailMessageIds finds recorded Message-IDs of the collection, not of failed jobs", async () => {
    const collection = `mail-${crypto.randomUUID()}`;
    const ok = crypto.randomUUID();
    const failed = crypto.randomUUID();
    await store.createJob({ id: ok, reference: "mail/1.eml", source_sha256: "d".repeat(64), collection, config: { email: { messageId: "m1@x" } } });
    await store.createJob({ id: failed, reference: "mail/2.eml", source_sha256: "d".repeat(64), collection, config: { email: { messageId: "m2@x" } } });
    await store.setJobStatus(failed, "failed");
    await store.createJob({ id: crypto.randomUUID(), reference: "mail/3.eml", source_sha256: "d".repeat(64), collection: "other", config: { email: { messageId: "m3@x" } } });
    const known = await store.knownEmailMessageIds(collection, ["m1@x", "m2@x", "m3@x", "nope@x"]);
    expect([...known]).toEqual(["m1@x"]);
    expect((await store.knownEmailMessageIds(collection, [])).size).toBe(0);
  });

  it("reuses a stage checkpoint by input_hash and increments attempts on retry", async () => {
    const first = await store.upsertStage("page", {
      job_id: jobId,
      page: 1,
      stage: "vision1",
      input_hash: "hash-1",
      status: "done",
      output: { raw: "hello" },
    });
    expect(first.attempts).toBe(0);

    const retry = await store.upsertStage("page", {
      job_id: jobId,
      page: 1,
      stage: "vision1",
      input_hash: "hash-1",
      status: "done",
      output: { raw: "hello" },
    });
    expect(retry.attempts).toBe(1);

    const found = await store.getStage("page", { job_id: jobId, page: 1, stage: "vision1" });
    expect(found?.input_hash).toBe("hash-1");
  });

  it("persists and restores the latest document-pass state", async () => {
    await store.saveDocpassState(jobId, 1, { outline: ["A"] });
    await store.saveDocpassState(jobId, 2, { outline: ["A", "B"] });
    const latest = await store.latestDocpassState(jobId);
    expect(latest?.page).toBe(2);
  });

  it("claims a runnable job with a fresh lease and fences stale heartbeats", async () => {
    const other = crypto.randomUUID();
    await store.createJob({ id: other, reference: "tests/other.pdf", source_sha256: "b".repeat(64) });
    const claimed = await store.claimNextJob("worker-1", 60);
    expect(claimed).not.toBeNull();
    if (claimed === null) throw new Error("expected a claimable job");
    // A heartbeat with a stale epoch is rejected (no row).
    const stale = await store.heartbeat(claimed.id, "worker-1", claimed.lease_epoch - 1, 60);
    expect(stale).toBeNull();
    const fresh = await store.heartbeat(claimed.id, "worker-1", claimed.lease_epoch, 60);
    expect(fresh).not.toBeNull();
  });

  it("caps the large-job lane and lets a normal job through past the cap (requirement 6.6)", async () => {
    // A dedicated store on the same DB so the claim scan is isolated from the
    // rows the other cases left behind: every job here is created cancelled and
    // only the ones under test are re-queued, so the candidate set is known.
    const laneStore = createExtractStore(
      { url: connectionUrl, poolMax: 4, statementTimeoutMs: 30_000 },
      silentLogger,
    );
    await laneStore.init();
    try {
      // Park every pre-existing job so it is not a claim candidate.
      for (const existing of await laneStore.listJobs(1000, 0)) {
        await laneStore.setJobStatus(existing.id, "cancelled").catch(() => {});
      }

      const big1 = crypto.randomUUID();
      const big2 = crypto.randomUUID();
      const small = crypto.randomUUID();
      await laneStore.createJob({ id: big1, reference: "tests/big1.pdf", source_sha256: "d".repeat(64), priority: 10 });
      await laneStore.createJob({ id: big2, reference: "tests/big2.pdf", source_sha256: "d".repeat(64), priority: 10 });
      await laneStore.createJob({ id: small, reference: "tests/small.pdf", source_sha256: "d".repeat(64), priority: 5 });
      // Size the jobs: two large (>1000 pages), one small.
      await laneStore.setJobPageCount(big1, 5000);
      await laneStore.setJobPageCount(big2, 5000);
      await laneStore.setJobPageCount(small, 10);
      // setJobPageCount does not change status; ensure all three are queued+due.
      for (const id of [big1, big2, small]) await laneStore.requeueJob(id);

      // Cap the large lane at 1. The first claim takes a large job (higher
      // priority); the second must skip the remaining large job and hand out
      // the small one instead, even though the large one is older/higher prio.
      const first = await laneStore.claimNextJob("w-large-1", 60, 1000, 1);
      expect(first).not.toBeNull();
      expect((first?.page_count ?? 0) > 1000).toBe(true);
      // Mirror the worker: a claimed job moves into a working state, so it counts
      // against the large-lane cap and leaves the queued candidate set.
      if (first) await laneStore.setJobStatus(first.id, "preparing");

      const second = await laneStore.claimNextJob("w-large-2", 60, 1000, 1);
      expect(second).not.toBeNull();
      // The lane is full (one live-leased large job), so the small job wins.
      expect(second?.id).toBe(small);
      if (second) await laneStore.setJobStatus(second.id, "preparing");

      // With no runnable non-large job left and the lane still full, the third
      // claim finds nothing rather than exceeding the cap.
      const third = await laneStore.claimNextJob("w-large-3", 60, 1000, 1);
      expect(third).toBeNull();
    } finally {
      await laneStore.close();
    }
  });

  it("stages an emit batch and moves it to acked", async () => {
    await store.stageEmitBatch({
      job_id: jobId,
      seq: 0,
      digest: "sha256:deadbeef",
      page_from: 1,
      page_to: 5,
    });
    const pendingBefore = await store.pendingEmitBatches(jobId);
    expect(pendingBefore.some((b) => b.seq === 0)).toBe(true);
    await store.setEmitStatus(jobId, 0, "acked");
    const pendingAfter = await store.pendingEmitBatches(jobId);
    expect(pendingAfter.some((b) => b.seq === 0)).toBe(false);
  });

  it("tracks a resumable upload offset", async () => {
    const uploadId = crypto.randomUUID();
    await store.createUpload({ upload_id: uploadId, reference: "tests/big.pdf", size: 4096 });
    await store.updateUploadOffset(uploadId, 2048);
    const upload = await store.getUpload(uploadId);
    expect(Number(upload?.received_offset)).toBe(2048);
  });
  it("advanceUploadOffset appends under the row lock and rejects a stale offset", async () => {
    const uploadId = crypto.randomUUID();
    await store.createUpload({ upload_id: uploadId, reference: "tests/chunked.pdf", size: 30 });
    let appends = 0;
    const append = async () => {
      appends++;
    };
    const first = await store.advanceUploadOffset({ uploadId, expectedOffset: 0, newOffset: 10, append });
    expect(first.status).toBe("committed");
    if (first.status === "committed") expect(Number(first.row.received_offset)).toBe(10);
    // A replay at the old offset is a conflict and appends nothing.
    const stale = await store.advanceUploadOffset({ uploadId, expectedOffset: 0, newOffset: 10, append });
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(Number(stale.current?.received_offset)).toBe(10);
    expect(appends).toBe(1);
    // A failing append rolls the transaction back; the offset is unchanged.
    await expect(
      store.advanceUploadOffset({
        uploadId,
        expectedOffset: 10,
        newOffset: 20,
        append: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(Number((await store.getUpload(uploadId))?.received_offset)).toBe(10);
  });
});

describeIfPg("extract-store · resume hardening on real PostgreSQL", () => {
  const connectionUrl = CONNECTION ?? "";
  const store = createExtractStore(
    { url: connectionUrl, poolMax: 8, statementTimeoutMs: 30_000 },
    silentLogger,
  );

  beforeAll(async () => {
    await store.init();
  });

  afterAll(async () => {
    await store.close();
  });

  /** Park every other job, create one, and claim it — so the claim is ours. */
  async function claimFresh(overrides: { token_budget?: number } = {}) {
    for (const existing of await store.listJobs(1000, 0)) {
      if (existing.status !== "cancelled") await store.setJobStatus(existing.id, "cancelled");
    }
    const id = crypto.randomUUID();
    await store.createJob({ id, reference: `tests/${id}.pdf`, source_sha256: "e".repeat(64), ...overrides });
    const claimed = await store.claimNextJob("worker-1", 60);
    if (claimed === null || claimed.id !== id) throw new Error("expected to claim the fresh job");
    const fence = { jobId: id, holder: "worker-1", epoch: Number(claimed.lease_epoch) };
    return { id, fence, claimed };
  }

  it("refuses every class of write carrying a revoked fence (operator requeue bumps the epoch)", async () => {
    const { id, fence } = await claimFresh();
    await store.upsertStage("page", { job_id: id, page: 1, stage: "vision1", input_hash: "h", status: "done" }, fence);
    await store.requeueJob(id);
    const { LeaseLostError } = await import("../src/persistence/types.js");
    const writes: Array<() => Promise<unknown>> = [
      () => store.upsertStage("page", { job_id: id, page: 2, stage: "vision1", input_hash: "h" }, fence),
      () => store.stageAsset({ job_id: id, asset_id: "a", page: 2 }, fence),
      () => store.stageEmitBatch({ job_id: id, seq: 2, digest: "d", page_from: 2, page_to: 2 }, fence),
      () => store.saveDocpassState(id, 2, {}, fence),
      () => store.setJobStatus(id, "completed", null, fence),
      () => store.appendJobWarning(id, "zombie", fence),
      () => store.reserveJobTokens(id, 1, fence),
    ];
    for (const write of writes) await expect(write()).rejects.toBeInstanceOf(LeaseLostError);
    expect(await store.getStage("page", { job_id: id, page: 2, stage: "vision1" })).toBeNull();
    expect((await store.getJob(id))?.status).toBe("queued");
  });

  it("reserves budget atomically under concurrency and settles it with the checkpoint", async () => {
    const { id, fence } = await claimFresh({ token_budget: 50 });
    const reservations = await Promise.all([1, 2, 3].map(() => store.reserveJobTokens(id, 20, fence)));
    expect(reservations.filter((r) => r !== null)).toHaveLength(2);
    expect(Number((await store.getJob(id))?.tokens_reserved)).toBe(40);
    const { stage, job } = await store.completeStage(
      "page",
      { job_id: id, page: 1, stage: "vision1", input_hash: "h", status: "done", output: { raw: "r", parsed: 1 } },
      fence,
      { reserved: 20, used: 15 },
    );
    expect(stage.status).toBe("done");
    expect(Number(job?.tokens_used)).toBe(15);
    expect(Number(job?.tokens_reserved)).toBe(20);
  });

  it("the scheduler honours per-unit backoff and reports the earliest retry", async () => {
    const { id, fence } = await claimFresh();
    const now = new Date();
    const retryAt = new Date(now.getTime() + 60_000);
    await store.upsertStage(
      "page",
      { job_id: id, page: 1, stage: "vision1", input_hash: "h", status: "failed", next_attempt_at: retryAt },
      fence,
    );
    await store.upsertStage(
      "figure",
      { job_id: id, page: 2, figure_id: "f", stage: "figure2", input_hash: "h", status: "failed", next_attempt_at: retryAt },
      fence,
    );
    expect(await store.nextRunnablePages(id, 4, "emitted", 10, now)).toEqual([3, 4]);
    expect((await store.earliestRetryAt(id, now))?.getTime()).toBe(retryAt.getTime());
    expect(await store.nextRunnablePages(id, 4, "emitted", 10, new Date(retryAt.getTime() + 1))).toEqual([1, 2, 3, 4]);
  });
  it("the scheduler starts at firstPage for a pages window (contract 2.4)", async () => {
    const { id } = await claimFresh();
    const now = new Date();
    expect(await store.nextRunnablePages(id, 6, "emitted", 10, now, 4)).toEqual([4, 5, 6]);
    expect(await store.nextRunnablePages(id, 6, "emitted", 2, now, 4)).toEqual([4, 5]);
    // A window past the end is empty rather than an error.
    expect(await store.nextRunnablePages(id, 3, "emitted", 10, now, 4)).toEqual([]);
    // Default firstPage is 1.
    expect(await store.nextRunnablePages(id, 3, "emitted", 10, now)).toEqual([1, 2, 3]);
  });

  it("auto-resumes a due dependency pause but not a manual one", async () => {
    const { id, fence } = await claimFresh();
    await store.pauseJob(id, "dependency", new Date(Date.now() - 1_000), { dependencyAttempts: 1 }, fence);
    const reclaimed = await store.claimNextJob("worker-2", 60);
    expect(reclaimed?.id).toBe(id);
    expect(reclaimed?.status).toBe("queued");
    expect(Number(reclaimed?.lease_epoch)).toBe(fence.epoch + 1);

    const fence2 = { jobId: id, holder: "worker-2", epoch: Number(reclaimed?.lease_epoch) };
    await store.pauseJob(id, "manual", null, {}, fence2);
    expect(await store.claimNextJob("worker-3", 60)).toBeNull();
  });

  it("commits a document-pass page atomically and invalidates the downstream in one transaction", async () => {
    const { id, fence } = await claimFresh();
    await store.stageEmitBatch(
      { job_id: id, seq: 1, digest: "base", page_from: 1, page_to: 1, payload: { record: { base: true } } },
      fence,
    );
    await store.stageAsset({ job_id: id, asset_id: "asset-1", page: 1 }, fence);
    await store.commitDocpassPage(
      id,
      {
        page: 1,
        payload: { record: { enriched: true } },
        state: { lastPage: 1 },
        checkpoint: { job_id: id, page: 1, stage: "docpass", input_hash: "h", status: "done" },
      },
      fence,
    );
    expect((await store.getEmitBatch(id, 1))?.payload).toEqual({ record: { enriched: true } });
    expect((await store.latestDocpassState(id))?.page).toBe(1);
    expect((await store.getStage("page", { job_id: id, page: 1, stage: "docpass" }))?.status).toBe("done");

    const job = await store.invalidateDownstream(
      id,
      { fromPage: 1, stages: ["docpass"], deleteAssets: true, configPatch: { reparse: false } },
      fence,
    );
    expect(Number(job?.emit_generation)).toBe(1);
    expect(job?.revision_id).toBeNull();
    expect(await store.latestDocpassState(id)).toBeNull();
    expect(await store.getEmitBatch(id, 1)).toBeNull();
    expect(await store.allAssets(id)).toEqual([]);
    expect((await store.getStage("page", { job_id: id, page: 1, stage: "docpass" }))?.status).toBe("pending");
  });

  it("retry-failed resets failed units, the affected downstream and re-queues with a lease revocation", async () => {
    const { id, fence } = await claimFresh();
    await store.upsertStage("page", { job_id: id, page: 1, stage: "emitted", input_hash: "h", status: "done" }, fence);
    await store.upsertStage("page", { job_id: id, page: 2, stage: "vision1", input_hash: "h", status: "failed" }, fence);
    await store.upsertStage("page", { job_id: id, page: 2, stage: "emitted", input_hash: "h", status: "done" }, fence);
    await store.setJobStatus(id, "completed", null, fence);
    const result = await store.retryFailedUnits(id, "completed", {
      cropStages: ["crops"],
      emitStage: "emitted",
      docpassStage: "docpass",
    });
    expect(result?.reset).toBe(1);
    expect(result?.job.status).toBe("queued");
    expect(Number(result?.job.lease_epoch)).toBe(fence.epoch + 1);
    expect(Number(result?.job.emit_generation)).toBe(1);
    expect((await store.getStage("page", { job_id: id, page: 1, stage: "emitted" }))?.status).toBe("done");
    expect((await store.getStage("page", { job_id: id, page: 2, stage: "emitted" }))?.status).toBe("pending");
    expect((await store.getStage("page", { job_id: id, page: 2, stage: "vision1" }))?.status).toBe("pending");
  });
});

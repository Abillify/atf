// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Task 4.5 — `POST /v1/erasure` against a real Postgres (Requirement 2.5).
 *
 * Inserts documents identified through `allowed_users` and the configurable
 * subject metadata field (plus a child unit folded onto its parent), stats
 * rows keyed by the identifier's query hash, and tenant rows in the revision
 * system tables — then runs the handler directly and verifies: the subject
 * scope removes exactly the subject's documents and stats, a repeated request
 * replays from the ledger without touching data again, and the tenant scope
 * wipes the collection and the tenant's system-table rows.
 *
 * Self-skips when TEST_POSTGRES_URL is unset (matching the other DB suites).
 */

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ErasureResponse } from "@atf/erasure-contract";
import { ensureStatsTables } from "../src/collection-ddl.js";
import { createErasureHandler } from "../src/handlers/erasure.js";
import { MemoryInvocationLedger } from "../src/invocation-ledger.js";
import {
  createPostgresClient,
  type PostgresClient,
} from "../src/postgres-client.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;

const VECTOR_SIZE = 8;
const VECTOR_LITERAL = `[${Array<number>(VECTOR_SIZE).fill(0.1).join(",")}]`;
const TENANT = `erasure-api-${Date.now()}`;
const COLLECTION = `erasure_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const TABLE = `vc_${COLLECTION}`;
const SUBJECT_ID = "subj-77";
const logger = pino({ level: "silent" });

describeIfPg("POST /v1/erasure (integration)", () => {
  let pool: Pool;
  let pg: PostgresClient;
  let handler: ReturnType<typeof createErasureHandler>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({
      connectionString: CONNECTION ?? "",
      logger,
      statsFlushIntervalMs: 3_600_000,
    });
    const ensured = await pg.ensureCollection(COLLECTION, VECTOR_SIZE);
    expect(ensured.ok).toBe(true);
    // vs_search_stats is created by the global migrations, which a bare test
    // database has not run; create it the same way the migration does.
    const client = await pool.connect();
    try {
      await ensureStatsTables(client);
    } finally {
      client.release();
    }
    // The legacy asset table (global migration v4) that delete-by-reference
    // cleans up; a bare test database has not run the migrations.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vs_document_assets (
        tenant_id TEXT NOT NULL, collection TEXT NOT NULL, asset_id TEXT NOT NULL,
        document_reference TEXT NOT NULL, figure_id TEXT NOT NULL, mime_type TEXT NOT NULL,
        data BYTEA NOT NULL, checksum TEXT,
        created TIMESTAMPTZ NOT NULL DEFAULT NOW(), modified TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, collection, asset_id)
      )`).catch(() => {});
    handler = createErasureHandler({
      postgresClient: pg,
      ledger: new MemoryInvocationLedger(),
      subjectMetadataField: "subject",
      statsQueryPepper: null,
      logger,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await pg?.deleteCollection(COLLECTION);
    } catch {
      /* ignore */
    }
    for (const t of [
      "vs_revisions",
      "vs_document_revisions",
      "vs_search_stats",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    }
    await pg?.close();
    await pool.end();
  });

  function mockReq(
    body: unknown,
    headers: Record<string, string> = {},
  ): import("express").Request {
    return {
      body,
      headers: { "x-collection": COLLECTION, ...headers },
      locals: {},
      principal: { userId: undefined, userGroups: undefined, source: "service" },
    } as unknown as import("express").Request;
  }

  async function call(body: unknown, headers: Record<string, string> = {}) {
    const res = {
      statusCode: 200,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(data: unknown) {
        this.body = data;
        return this;
      },
    };
    await handler(mockReq(body, headers), res as never, () => undefined);
    return res;
  }

  async function insertSubjectDocs(): Promise<void> {
    // Document identified through the allowed_users ACL.
    await pool.query(
      `INSERT INTO "${TABLE}" (tenant_id, reference, base_ref, content, vector, allowed_users)
       VALUES ($1,'acl-doc','acl-doc','inhalt',$2::vector,ARRAY[$3])`,
      [TENANT, VECTOR_LITERAL, SUBJECT_ID],
    );
    // Document identified through the metadata field, with a child unit.
    await pool.query(
      `INSERT INTO "${TABLE}" (tenant_id, reference, base_ref, content, vector, metadata)
       VALUES ($1,'meta-doc','meta-doc','inhalt',$2::vector,jsonb_build_object('subject',$3::text))`,
      [TENANT, VECTOR_LITERAL, SUBJECT_ID],
    );
    await pool.query(
      `INSERT INTO "${TABLE}" (tenant_id, reference, base_ref, content, vector, chunk)
       VALUES ($1,'meta-doc/anhang','meta-doc/anhang','kind',$2::vector,jsonb_build_object('parent_ref','meta-doc'))`,
      [TENANT, VECTOR_LITERAL],
    );
    // Unrelated documents of the same tenant and of another tenant.
    await pool.query(
      `INSERT INTO "${TABLE}" (tenant_id, reference, base_ref, content, vector)
       VALUES ($1,'other-doc','other-doc','fremd',$2::vector)`,
      [TENANT, VECTOR_LITERAL],
    );
    await pool.query(
      `INSERT INTO "${TABLE}" (tenant_id, reference, base_ref, content, vector, allowed_users)
       VALUES ($1,'foreign-doc','foreign-doc','fremd',$2::vector,ARRAY[$3])`,
      [`other-${TENANT}`, VECTOR_LITERAL, SUBJECT_ID],
    );
  }

  async function insertStats(): Promise<void> {
    const hash = createHash("sha256").update(SUBJECT_ID).digest("hex");
    await pool.query(
      `INSERT INTO vs_search_stats
         (tenant_id, collection, query_hash, duration_ms, results_count, hybrid_search, reranked)
       VALUES ($1,$2,$3,10,1,false,false), ($1,$2,'andere-hash',10,1,false,false)`,
      [TENANT, COLLECTION, hash],
    );
  }

  it("subject scope erases ACL and metadata documents plus stats", async () => {
    await insertSubjectDocs();
    await insertStats();

    const res = await call({
      requestId: crypto.randomUUID(),
      tenantId: TENANT,
      scope: "subject",
      subject: { userId: SUBJECT_ID },
      dryRun: false,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as ErasureResponse;
    expect(body.service).toBe("search");
    const docs = body.results.find((r) => r.store === "search.documents");
    // acl-doc + meta-doc + child unit (folded onto meta-doc, deleted with it).
    expect(docs).toMatchObject({ status: "ok", erased: 3 });
    const stats = body.results.find((r) => r.store === "search.stats");
    expect(stats).toMatchObject({ status: "ok", erased: 1 });

    const remaining = await pool.query(
      `SELECT reference FROM "${TABLE}" WHERE tenant_id = $1 ORDER BY reference`,
      [TENANT],
    );
    expect(remaining.rows.map((r) => r.reference)).toEqual(["other-doc"]);
    // The foreign tenant's subject rows survive untouched.
    const foreign = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${TABLE}" WHERE tenant_id = $1`,
      [`other-${TENANT}`],
    );
    expect(foreign.rows[0]?.n).toBe(1);
    const statsLeft = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vs_search_stats WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(statsLeft.rows[0]?.n).toBe(1);
  });

  it("replays the same requestId from the ledger without deleting again", async () => {
    const body = {
      requestId: crypto.randomUUID(),
      tenantId: TENANT,
      scope: "reference" as const,
      references: ["other-doc"],
      dryRun: false,
    };
    const first = await call(body);
    expect(first.statusCode).toBe(200);
    const second = await call(body);
    expect(second.statusCode).toBe(200);
    expect(second.body).toEqual(first.body);
    const remaining = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${TABLE}" WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(remaining.rows[0]?.n).toBe(0);
  });

  it("409s when the requestId is reused with a different payload", async () => {
    const requestId = crypto.randomUUID();
    await call({
      requestId,
      tenantId: TENANT,
      scope: "reference",
      references: ["x"],
      dryRun: false,
    });
    const res = await call({
      requestId,
      tenantId: TENANT,
      scope: "reference",
      references: ["y"],
      dryRun: false,
    });
    expect(res.statusCode).toBe(409);
    expect((res.body as { code: string }).code).toBe(
      "IDEMPOTENCY_KEY_MISMATCH",
    );
  });

  it("dryRun counts without deleting", async () => {
    await pool.query(
      `INSERT INTO "${TABLE}" (tenant_id, reference, base_ref, content, vector, metadata)
       VALUES ($1,'dry-doc','dry-doc','inhalt',$2::vector,jsonb_build_object('subject',$3::text))`,
      [TENANT, VECTOR_LITERAL, SUBJECT_ID],
    );
    const res = await call({
      requestId: crypto.randomUUID(),
      tenantId: TENANT,
      scope: "subject",
      subject: { userId: SUBJECT_ID },
      dryRun: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as ErasureResponse;
    expect(
      body.results.find((r) => r.store === "search.documents")?.erased,
    ).toBe(1);
    const still = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${TABLE}" WHERE tenant_id = $1 AND reference = 'dry-doc'`,
      [TENANT],
    );
    expect(still.rows[0]?.n).toBe(1);
  });

  it("tenant scope wipes the collection and the tenant's system rows", async () => {
    await pool.query(
      `INSERT INTO vs_revisions (tenant_id, collection, revision_id, reference, status)
       VALUES ($1,$2,'rev-1','dry-doc','committed')`,
      [TENANT, COLLECTION],
    );
    await pool.query(
      `INSERT INTO vs_search_stats
         (tenant_id, collection, query_hash, duration_ms, results_count, hybrid_search, reranked)
       VALUES ($1,$2,'h',10,1,false,false)`,
      [TENANT, COLLECTION],
    );
    const res = await call(
      {
        requestId: crypto.randomUUID(),
        tenantId: TENANT,
        scope: "tenant",
        dryRun: false,
      },
      // Restrict to this test's collection — the shared DB has others.
      { "x-collection": COLLECTION },
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as ErasureResponse;
    expect(
      body.results.find((r) => r.store === "search.documents")?.status,
    ).toBe("ok");
    const left = await pool.query(
      `SELECT COUNT(*)::int AS n FROM "${TABLE}" WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(left.rows[0]?.n).toBe(0);
    const revs = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vs_revisions WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(revs.rows[0]?.n).toBe(0);
    const stats = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vs_search_stats WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(stats.rows[0]?.n).toBe(0);
  });
});

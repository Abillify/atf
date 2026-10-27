// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * JSONB parameters through Bun's SQL client, against a REAL Postgres.
 *
 * Bun binds a string cast as `$n::jsonb` as a JSON string scalar, so a
 * `JSON.stringify(...)` value used to land as `"{…}"` and JSON operators on
 * the column matched nothing. This suite proves the writers now store objects
 * (erasure receipts are found by id, the invocation ledger transitions), and
 * that the repair statement of migration 51 converts rows written before.
 *
 * Env-gated via TEST_POSTGRES_URL like `audit-log.pg.test.ts`; the tables are
 * created with the DDL of their migrations and dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wrapBunSql, type Database } from "../database.js";
import { repairStringScalarJsonSql } from "../json-column.js";
import { PostgresOperationStore, type ErasureOperation } from "../../compliance/erasure-orchestrator.js";
import { PostgresInvocationLedger } from "../../transaction/ledger.js";

const PG_URL = process.env["TEST_POSTGRES_URL"];

const ERASURE_DDL = `CREATE TABLE IF NOT EXISTS erasure_requests (
  id          BIGSERIAL PRIMARY KEY,
  request_id  TEXT NOT NULL UNIQUE,
  tenant_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,
  subject     JSONB,
  doc_references JSONB,
  status      TEXT NOT NULL,
  results     JSONB NOT NULL DEFAULT '[]'::jsonb,
  store_groups   JSONB NOT NULL DEFAULT '[]'::jsonb,
  receipt     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token TEXT
)`;

function operation(requestId: string): ErasureOperation {
  return {
    requestId,
    tenantId: "jsonb-tenant",
    scope: "subject",
    subject: { userId: "user@example.com", externalIds: [] },
    status: "in_progress",
    results: [],
    erased: 0,
    storeGroups: [{ service: "runtime", stores: ["semantic_cache"] }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as ErasureOperation;
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "JSONB parameters (real Postgres)",
  () => {
    let sql: InstanceType<typeof Bun.SQL>;
    let db: Database;

    beforeAll(async () => {
      sql = new Bun.SQL(PG_URL ?? "");
      db = wrapBunSql(sql);
      await sql.unsafe(`DROP TABLE IF EXISTS erasure_requests`);
      await sql.unsafe(`DROP TABLE IF EXISTS invocation_ledger`);
      await sql.unsafe(ERASURE_DDL);
    });

    afterAll(async () => {
      await sql?.unsafe(`DROP TABLE IF EXISTS erasure_requests`).catch(() => {});
      await sql?.unsafe(`DROP TABLE IF EXISTS invocation_ledger`).catch(() => {});
      await sql?.close();
    });

    test("erasure operations store objects and are found by receipt id", async () => {
      const store = new PostgresOperationStore(db);
      const op = operation("jsonb-req-1");
      expect(await store.insert(op, "lease-1")).toBeNull();
      op.status = "complete";
      op.results = [{ service: "runtime", store: "semantic_cache", erased: 2 } as never];
      op.receipt = { payload: { receiptId: "rcpt-jsonb-1" }, signature: "sig" };
      await store.update(op);

      const types = await sql.unsafe(
        `SELECT jsonb_typeof(subject) s, jsonb_typeof(results) r, jsonb_typeof(receipt) c
           FROM erasure_requests WHERE request_id = 'jsonb-req-1'`,
      );
      expect(types[0]).toEqual({ s: "object", r: "array", c: "object" });

      const found = await store.loadByReceiptId("rcpt-jsonb-1");
      expect(found?.requestId).toBe("jsonb-req-1");
      expect(found?.erased).toBe(2);
      expect(found?.subject).toEqual({ userId: "user@example.com", externalIds: [] });
    });

    test("migration 51 repairs erasure rows written as string scalars", async () => {
      // The shape the old writer produced: a stringified object bound to ::jsonb.
      await sql.unsafe(
        `INSERT INTO erasure_requests (request_id, tenant_id, scope, status, results, store_groups, receipt)
         VALUES ('jsonb-legacy', 'jsonb-tenant', 'tenant', 'complete', $1::jsonb, $2::jsonb, $3::jsonb)`,
        [JSON.stringify([]), JSON.stringify([]), JSON.stringify({ payload: { receiptId: "rcpt-legacy" } })],
      );
      const store = new PostgresOperationStore(db);
      // Readers accept the legacy shape …
      expect((await store.load("jsonb-legacy"))?.receipt).toEqual({ payload: { receiptId: "rcpt-legacy" } });
      // … but the JSON-operator lookup only works after the repair.
      expect(await store.loadByReceiptId("rcpt-legacy")).toBeNull();
      await sql.unsafe(repairStringScalarJsonSql("erasure_requests", "receipt"));
      expect((await store.loadByReceiptId("rcpt-legacy"))?.requestId).toBe("jsonb-legacy");
    });

    test("the invocation ledger stores an object record and transitions", async () => {
      const ledger = new PostgresInvocationLedger(db);
      const claim = await ledger.claim({ invocationId: "inv-jsonb-1" } as never);
      expect(claim.acquired).toBe(true);
      expect(claim.record.state).toBe("pending");
      const running = await ledger.transition("inv-jsonb-1", "running");
      expect(running.state).toBe("running");
      expect((await ledger.get("inv-jsonb-1"))?.state).toBe("running");
      const stale = await ledger.listStale(Date.now() + 60_000, ["running"]);
      expect(stale.map((r) => r.invocationId)).toContain("inv-jsonb-1");
      const t = await sql.unsafe(`SELECT jsonb_typeof(record) t FROM invocation_ledger`);
      expect(t[0]?.t).toBe("object");
    });
  },
);

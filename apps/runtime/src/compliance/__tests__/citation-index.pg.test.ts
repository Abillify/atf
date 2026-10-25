// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Answer citation index against a REAL Postgres.
 *
 * Proves the pieces the in-memory twin cannot: the batched parameterised
 * `INSERT` of `PostgresCitationIndexStore` (column order, null handling), and
 * that the retention target's age purge and subject erasure delete exactly
 * the right `answer_citations` rows.
 *
 * Env-gated via TEST_POSTGRES_URL like `audit-log.pg.test.ts`. The table DDL
 * mirrors migration 50; the test user owns the table and bypasses RLS.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wrapBunSql, type Database } from "../../db/database.js";
import {
  PostgresCitationIndexStore,
  type CitationIndexRow,
} from "../citation-index.js";
import { answerCitationsRetentionTarget } from "../../observability/retention-db-targets.js";

const PG_URL = process.env["TEST_POSTGRES_URL"];

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS answer_citations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL,
  user_id        TEXT,
  execution_id   TEXT NOT NULL,
  flow_id        TEXT NOT NULL,
  flow_version   TEXT,
  base_ref       TEXT NOT NULL,
  chunk_id       TEXT NOT NULL,
  revision       TEXT,
  citation_index INTEGER NOT NULL,
  cited          BOOLEAN NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

function row(overrides: Partial<CitationIndexRow>): CitationIndexRow {
  return {
    tenantId: "cit-tenant",
    executionId: "cit-exec-1",
    flowId: "cit-flow",
    baseRef: "/akte/A",
    chunkId: "chunk-a",
    citationIndex: 1,
    cited: true,
    ...overrides,
  };
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "citation index · real Postgres",
  () => {
    let sql: InstanceType<typeof Bun.SQL>;
    let db: Database;

    beforeAll(async () => {
      sql = new Bun.SQL(PG_URL ?? "");
      await sql.unsafe(TABLE_DDL);
      db = wrapBunSql(sql);
    });

    afterAll(async () => {
      await sql?.unsafe(`DROP TABLE IF EXISTS answer_citations`).catch(() => {});
      await sql?.close();
    });

    const selectAll = async (tenantId: string) =>
      (await sql.unsafe(
        `SELECT tenant_id, user_id, execution_id, flow_id, flow_version,
                base_ref, chunk_id, revision, citation_index, cited
           FROM answer_citations WHERE tenant_id = $1
          ORDER BY citation_index ASC`,
        [tenantId],
      )) as unknown as {
        tenant_id: string;
        user_id: string | null;
        execution_id: string;
        flow_id: string;
        flow_version: string | null;
        base_ref: string;
        chunk_id: string;
        revision: string | null;
        citation_index: number;
        cited: boolean;
      }[];

    test("recordExecution writes every column of a batch", async () => {
      const tenant = `cit-batch-${crypto.randomUUID()}`;
      const store = new PostgresCitationIndexStore(db);
      await store.recordExecution([
        row({
          tenantId: tenant,
          userId: "user-1",
          executionId: "exec-9",
          flowId: "flow-9",
          flowVersion: "2.0.0",
          baseRef: "/akte/A",
          chunkId: "chunk-a",
          revision: "v7",
          citationIndex: 1,
          cited: true,
        }),
        row({
          tenantId: tenant,
          executionId: "exec-9",
          flowId: "flow-9",
          baseRef: "/akte/B",
          chunkId: "chunk-b",
          citationIndex: 2,
          cited: false,
        }),
      ]);

      const rows = await selectAll(tenant);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        tenant_id: tenant,
        user_id: "user-1",
        execution_id: "exec-9",
        flow_id: "flow-9",
        flow_version: "2.0.0",
        base_ref: "/akte/A",
        chunk_id: "chunk-a",
        revision: "v7",
        citation_index: 1,
        cited: true,
      });
      // Optional columns round-trip as NULL.
      expect(rows[1]?.user_id).toBeNull();
      expect(rows[1]?.flow_version).toBeNull();
      expect(rows[1]?.revision).toBeNull();
      expect(rows[1]?.cited).toBe(false);
    });

    test("eraseSubject removes only the subject's rows", async () => {
      const tenant = `cit-erase-${crypto.randomUUID()}`;
      const store = new PostgresCitationIndexStore(db);
      await store.recordExecution([
        row({ tenantId: tenant, userId: "victim", executionId: "e1" }),
        row({ tenantId: tenant, userId: "victim", executionId: "e2" }),
        row({ tenantId: tenant, userId: "bystander", executionId: "e3" }),
        row({ tenantId: tenant, executionId: "e4" }),
      ]);

      const target = answerCitationsRetentionTarget(db);
      const erased = await target.eraseSubject?.({
        tenantId: tenant,
        userId: "victim",
      });
      expect(erased).toBe(2);

      const remaining = await selectAll(tenant);
      expect(remaining).toHaveLength(2);
      expect(remaining.map((r) => r.execution_id).sort()).toEqual(["e3", "e4"]);
    });

    test("purgeOlderThan removes aged rows and keeps recent ones", async () => {
      const tenant = `cit-purge-${crypto.randomUUID()}`;
      const store = new PostgresCitationIndexStore(db);
      await store.recordExecution([
        row({ tenantId: tenant, executionId: "old" }),
        row({ tenantId: tenant, executionId: "fresh" }),
      ]);
      await sql.unsafe(
        `UPDATE answer_citations
            SET created_at = now() - interval '40 days'
          WHERE tenant_id = $1 AND execution_id = 'old'`,
        [tenant],
      );

      const target = answerCitationsRetentionTarget(db);
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const purged = await target.purgeOlderThan?.(cutoff);
      expect(purged).toBe(1);

      const remaining = await selectAll(tenant);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.execution_id).toBe("fresh");
    });
  },
);

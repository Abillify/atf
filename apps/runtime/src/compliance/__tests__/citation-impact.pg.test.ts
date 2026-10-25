// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Citation impact source against a REAL Postgres.
 *
 * Proves `PostgresCitationImpactSource.citedPairs()` on real SQL: the
 * cited-only filter, the `since` window, the tenant and base_ref filters,
 * and that `limit` caps the execution set (newest first) while keeping every
 * cited pair of the executions it retained.
 *
 * Env-gated via TEST_POSTGRES_URL like `citation-index.pg.test.ts`. The table
 * DDL mirrors migration 50; the test user owns the table and bypasses RLS.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { wrapBunSql, type Database } from "../../db/database.js";
import { PostgresCitationImpactSource } from "../citation-impact.js";

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

async function insert(
  sql: InstanceType<typeof Bun.SQL>,
  rows: Array<{
    tenant_id: string;
    execution_id: string;
    flow_id: string;
    base_ref: string;
    chunk_id: string;
    citation_index: number;
    cited: boolean;
    created_at: string;
  }>,
): Promise<void> {
  for (const r of rows) {
    await sql.unsafe(
      `INSERT INTO answer_citations
         (tenant_id, execution_id, flow_id, base_ref, chunk_id,
          citation_index, cited, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [
        r.tenant_id,
        r.execution_id,
        r.flow_id,
        r.base_ref,
        r.chunk_id,
        r.citation_index,
        r.cited,
        r.created_at,
      ],
    );
  }
}

describe.skipIf(PG_URL === undefined || PG_URL === "")(
  "citation impact · real Postgres",
  () => {
    let sql: InstanceType<typeof Bun.SQL>;
    let db: Database;
    let source: PostgresCitationImpactSource;

    beforeAll(async () => {
      sql = new Bun.SQL(PG_URL ?? "");
      await sql.unsafe(TABLE_DDL);
      db = wrapBunSql(sql);
      source = new PostgresCitationImpactSource(db);
      await insert(sql, [
        // Tenant acme: e-new cites two pairs (one twice), e-old cites one.
        {
          tenant_id: "ci-acme",
          execution_id: "ci-e-new",
          flow_id: "ci-flow",
          base_ref: "/akte/A",
          chunk_id: "chunk-a",
          citation_index: 1,
          cited: true,
          created_at: "2026-10-10T10:00:00Z",
        },
        {
          tenant_id: "ci-acme",
          execution_id: "ci-e-new",
          flow_id: "ci-flow",
          base_ref: "/akte/A",
          chunk_id: "chunk-a",
          citation_index: 2,
          cited: true,
          created_at: "2026-10-10T10:00:05Z",
        },
        {
          tenant_id: "ci-acme",
          execution_id: "ci-e-new",
          flow_id: "ci-flow",
          base_ref: "/akte/B",
          chunk_id: "chunk-b",
          citation_index: 3,
          cited: true,
          created_at: "2026-10-10T10:00:10Z",
        },
        {
          tenant_id: "ci-acme",
          execution_id: "ci-e-old",
          flow_id: "ci-flow",
          base_ref: "/akte/C",
          chunk_id: "chunk-c",
          citation_index: 1,
          cited: true,
          created_at: "2026-06-01T10:00:00Z",
        },
        // Uncited rows never appear in the impact analysis.
        {
          tenant_id: "ci-acme",
          execution_id: "ci-e-uncited",
          flow_id: "ci-flow",
          base_ref: "/akte/D",
          chunk_id: "chunk-d",
          citation_index: 1,
          cited: false,
          created_at: "2026-10-11T10:00:00Z",
        },
        // Tenant beta: isolated from acme reports.
        {
          tenant_id: "ci-beta",
          execution_id: "ci-e-beta",
          flow_id: "ci-flow",
          base_ref: "/akte/E",
          chunk_id: "chunk-e",
          citation_index: 1,
          cited: true,
          created_at: "2026-10-09T10:00:00Z",
        },
      ]);
    });

    afterAll(async () => {
      await sql?.unsafe(`DROP TABLE IF EXISTS answer_citations`).catch(() => {});
      await sql?.close();
    });

    test("returns cited pairs since the window, grouped with executions", async () => {
      const groups = await source.citedPairs({
        since: "2026-09-01T00:00:00Z",
        limit: 100,
        tenantId: "ci-acme",
      });
      const keys = groups.map((g) => `${g.baseRef}#${g.chunkId}`);
      expect(keys).toEqual(["/akte/A#chunk-a", "/akte/B#chunk-b"]);
      const a = groups.find((g) => g.baseRef === "/akte/A");
      // The duplicate row of ci-e-new is deduplicated.
      expect(a?.executions.map((e) => e.executionId)).toEqual(["ci-e-new"]);
      expect(a?.executions[0]?.createdAt).toBe("2026-10-10 10:00:00+00");
    });

    test("the since window excludes older executions", async () => {
      const groups = await source.citedPairs({
        since: "2026-01-01T00:00:00Z",
        limit: 100,
        tenantId: "ci-acme",
      });
      const keys = groups.map((g) => `${g.baseRef}#${g.chunkId}`);
      expect(keys).toEqual([
        "/akte/A#chunk-a",
        "/akte/B#chunk-b",
        "/akte/C#chunk-c",
      ]);
    });

    test("tenant isolation: a scoped report never sees another tenant", async () => {
      const acme = await source.citedPairs({
        since: "2026-01-01T00:00:00Z",
        limit: 100,
        tenantId: "ci-acme",
      });
      const beta = await source.citedPairs({
        since: "2026-01-01T00:00:00Z",
        limit: 100,
        tenantId: "ci-beta",
      });
      expect(
        acme.every((g) => g.executions.every((e) => e.executionId !== "ci-e-beta")),
      ).toBe(true);
      expect(beta.map((g) => `${g.baseRef}#${g.chunkId}`)).toEqual([
        "/akte/E#chunk-e",
      ]);
    });

    test("base_ref restricts the pairs to one document", async () => {
      const groups = await source.citedPairs({
        since: "2026-01-01T00:00:00Z",
        limit: 100,
        tenantId: "ci-acme",
        baseRef: "/akte/B",
      });
      expect(groups.map((g) => `${g.baseRef}#${g.chunkId}`)).toEqual([
        "/akte/B#chunk-b",
      ]);
    });

    test("limit caps the execution set to the most recent executions", async () => {
      // Only the newest cited execution (ci-e-new) survives the cap; the
      // older ci-e-old pair drops out, uncited rows never count.
      const groups = await source.citedPairs({
        since: "2026-01-01T00:00:00Z",
        limit: 1,
        tenantId: "ci-acme",
      });
      const executionIds = new Set(
        groups.flatMap((g) => g.executions.map((e) => e.executionId)),
      );
      expect([...executionIds].sort()).toEqual(["ci-e-new"]);
    });
  },
);

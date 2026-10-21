// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Parts of one split document (`metadata.split_of`) against a REAL PostgreSQL +
 * pgvector: they register as a `split_document` group, and `getSplitSiblings`
 * lists the other parts of the same folder in `split_order`. Documents without
 * `split_of`, or with another folder or another `split_of`, are not siblings.
 *
 * Self-skips when TEST_POSTGRES_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { pino } from "pino";
import { createPostgresClient, type PostgresClient } from "../src/postgres-client.js";
import { collectionTableName } from "../src/collection-ddl.js";
import { ensureRevisionTables } from "../src/revision-schema.js";
import { registerDocumentGroup, resolveDocumentGroups } from "../src/document-identity.js";
import type { AccessScope } from "../src/access-scope.js";

const CONNECTION = process.env.TEST_POSTGRES_URL;
const describeIfPg = CONNECTION ? describe : describe.skip;
const TENANT = `splittest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const logger = pino({ level: "silent" });

const scope: AccessScope = {
  principal: { userId: undefined, userGroups: [], scopes: [], source: "asserted" },
  userId: undefined,
  userGroups: [],
  tenantId: TENANT,
  scopes: [],
  service: true,
};

describeIfPg("split documents · real postgres", () => {
  let pool: Pool;
  let pg: PostgresClient;
  const collection = `split_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  async function insert(ref: string, title: string, metadata: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO "${collectionTableName(collection)}"
         (tenant_id, reference, base_ref, is_latest, content, vector, title, metadata)
       VALUES ($1, $2, $3, TRUE, $4, '[1,0,0,0]'::vector, $5, $6::jsonb)`,
      [TENANT, ref, ref, `Inhalt ${ref}`, title, JSON.stringify(metadata)],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION });
    pg = createPostgresClient({ connectionString: CONNECTION ?? "", logger, statsFlushIntervalMs: 3_600_000 });
    expect((await pg.ensureCollection(collection, 4)).ok).toBe(true);
    // Three parts of "spec-1" in one folder, inserted out of order.
    await insert("/specs/part-c.pdf", "Part C", { split_of: "spec-1", split_order: 3 });
    await insert("/specs/part-a.pdf", "Part A", { split_of: "spec-1", split_order: 1 });
    await insert("/specs/part-b.pdf", "Part B", { split_of: "spec-1", split_order: 2 });
    // Same split_of in ANOTHER folder, another split_of in the same folder, no split_of.
    await insert("/other/part-a.pdf", "Other A", { split_of: "spec-1", split_order: 1 });
    await insert("/specs/appendix.pdf", "Appendix", { split_of: "spec-2", split_order: 1 });
    await insert("/specs/plain.pdf", "Plain", {});
    for (let attempt = 1; ; attempt++) {
      const client = await pool.connect();
      try {
        await ensureRevisionTables(client);
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (attempt >= 5 || (code !== "40P01" && code !== "23505")) throw err;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      } finally {
        client.release();
      }
    }
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS "${collectionTableName(collection)}" CASCADE`).catch(() => {});
    await pool?.query(`DELETE FROM vs_document_groups WHERE tenant_id = $1`, [TENANT]).catch(() => {});
    await pg?.close();
    await pool?.end();
  });

  it("lists the other parts of the same folder and split_of in split_order", async () => {
    const res = await pg.getSplitSiblings(collection, scope, [
      { reference: "/specs/part-b.pdf", splitOf: "spec-1" },
    ]);
    expect(res.ok, res.ok ? "" : JSON.stringify(res.error)).toBe(true);
    if (!res.ok) return;
    expect(res.result["/specs/part-b.pdf"]).toEqual([
      { base_ref: "/specs/part-a.pdf", title: "Part A", order: 1 },
      { base_ref: "/specs/part-c.pdf", title: "Part C", order: 3 },
    ]);
  });

  it("siblings are mutual", async () => {
    const res = await pg.getSplitSiblings(collection, scope, [
      { reference: "/specs/part-a.pdf", splitOf: "spec-1" },
      { reference: "/specs/part-c.pdf", splitOf: "spec-1" },
    ]);
    if (!res.ok) throw new Error("expected ok");
    expect(res.result["/specs/part-a.pdf"]?.map((s) => s.base_ref)).toEqual(["/specs/part-b.pdf", "/specs/part-c.pdf"]);
    expect(res.result["/specs/part-c.pdf"]?.map((s) => s.base_ref)).toEqual(["/specs/part-a.pdf", "/specs/part-b.pdf"]);
  });

  it("a part alone in its folder / split_of has no siblings and is absent from the result", async () => {
    const res = await pg.getSplitSiblings(collection, scope, [
      { reference: "/other/part-a.pdf", splitOf: "spec-1" },
      { reference: "/specs/appendix.pdf", splitOf: "spec-2" },
    ]);
    if (!res.ok) throw new Error("expected ok");
    expect(res.result).toEqual({});
  });

  it("registers the group kind split_document for parts of one folder and split_of", async () => {
    const register = async (reference: string, metadata: Record<string, unknown> | undefined) => {
      const client = await pool.connect();
      try {
        await registerDocumentGroup(client, {
          tenantId: TENANT,
          collection,
          reference,
          info: { title: reference, ...(metadata !== undefined ? { metadata } : {}) },
        });
      } finally {
        client.release();
      }
    };
    await register("/specs/part-a.pdf", { split_of: "spec-1", split_order: 1 });
    await register("/specs/part-b.pdf", { split_of: "spec-1", split_order: 2 });
    await register("/other/part-a.pdf", { split_of: "spec-1" });
    await register("/specs/plain.pdf", undefined);
    const groups = await resolveDocumentGroups(pool, {
      tenantId: TENANT,
      collection,
      references: ["/specs/part-a.pdf", "/specs/part-b.pdf", "/other/part-a.pdf", "/specs/plain.pdf"],
    });
    const a = groups.get("/specs/part-a.pdf");
    expect(a?.kind).toBe("split_document");
    expect(groups.get("/specs/part-b.pdf")?.id).toBe(a?.id);
    expect(groups.get("/other/part-a.pdf")?.kind).toBe("split_document");
    expect(groups.get("/other/part-a.pdf")?.id).not.toBe(a?.id);
    expect(groups.has("/specs/plain.pdf")).toBe(false);
  });
});

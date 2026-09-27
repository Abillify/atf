// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  ensureRevisionSchema,
  ensureRevisionTables,
  ensureAssetsTable,
  backfillAssetsFromDocumentAssets,
  VS_ASSETS_TABLE,
  VS_DOCUMENT_REVISIONS_TABLE,
  VS_INGEST_BATCHES_TABLE,
  VS_REVISIONS_TABLE,
  VS_SEGMENTS_TABLE,
} from "../src/revision-schema.js";

/**
 * Recording mock in the same shape the collection-ddl tests use: capture every
 * SQL string, and answer the `to_regclass` legacy-table probe based on a flag so
 * the backfill path can be exercised both ways.
 */
function schemaClientMock(options?: { legacyAssetsExist?: boolean }): {
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  queries: string[];
} {
  const queries: string[] = [];
  const query = async (
    sql: string,
    _params?: unknown[],
  ): Promise<{ rows: unknown[] }> => {
    queries.push(sql);
    if (sql.includes("to_regclass")) {
      return {
        rows: [{ t: options?.legacyAssetsExist ? "vs_document_assets" : null }],
      };
    }
    return { rows: [] };
  };
  return { client: { query }, queries };
}

describe("revision + staging schema (task 1.8)", () => {
  it("creates the revision, batch, segment and pointer tables", async () => {
    const { client, queries } = schemaClientMock();
    await ensureRevisionTables(client as never);
    const all = queries.join("\n");
    expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${VS_REVISIONS_TABLE}`);
    expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${VS_INGEST_BATCHES_TABLE}`);
    expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${VS_SEGMENTS_TABLE}`);
    expect(all).toContain(
      `CREATE TABLE IF NOT EXISTS ${VS_DOCUMENT_REVISIONS_TABLE}`,
    );
  });

  it("stores revision status/visibility as TEXT with the staging defaults", async () => {
    const { client, queries } = schemaClientMock();
    await ensureRevisionTables(client as never);
    const revisions = queries.find((q) =>
      q.includes(`CREATE TABLE IF NOT EXISTS ${VS_REVISIONS_TABLE}`),
    );
    expect(revisions).toBeDefined();
    expect(revisions).toContain("status          TEXT NOT NULL DEFAULT 'staging'");
    expect(revisions).toContain("visibility      TEXT NOT NULL DEFAULT 'on_commit'");
    expect(revisions).toContain("idempotency_key TEXT");
    expect(revisions).toContain("ttl_expires_at  TIMESTAMPTZ");
  });

  it("indexes the idempotency key uniquely, the TTL, and the worker claim order", async () => {
    const { client, queries } = schemaClientMock();
    await ensureRevisionTables(client as never);
    const all = queries.join("\n");
    // idempotent POST returns the same revision → unique on the key
    const idem = queries.find((q) => q.includes("idx_vs_revisions_idempotency"));
    expect(idem).toContain("UNIQUE INDEX");
    expect(idem).toContain("WHERE idempotency_key IS NOT NULL");
    // TTL cleaner + SKIP LOCKED worker ordering
    expect(all).toContain("idx_vs_revisions_ttl");
    const worker = queries.find((q) => q.includes("idx_vs_ingest_batches_worker"));
    expect(worker).toContain("(status, next_attempt_at, created)");
  });

  it("stages batches with a digest and a page range for later processing", async () => {
    const { client, queries } = schemaClientMock();
    await ensureRevisionTables(client as never);
    const batches = queries.find((q) =>
      q.includes(`CREATE TABLE IF NOT EXISTS ${VS_INGEST_BATCHES_TABLE}`),
    );
    expect(batches).toContain("digest          TEXT NOT NULL");
    expect(batches).toContain("page_start      INTEGER");
    expect(batches).toContain("page_end        INTEGER");
    expect(batches).toContain("payload         BYTEA");
    expect(batches).toContain("status          TEXT NOT NULL DEFAULT 'received'");
  });

  it("creates vs_assets with kind, page, bbox, variants and a nullable revision_id", async () => {
    const { client, queries } = schemaClientMock();
    await ensureAssetsTable(client as never);
    const assets = queries.find((q) =>
      q.includes(`CREATE TABLE IF NOT EXISTS ${VS_ASSETS_TABLE}`),
    );
    expect(assets).toBeDefined();
    expect(assets).toContain("kind               TEXT NOT NULL DEFAULT 'figure'");
    expect(assets).toContain("revision_id        TEXT"); // nullable: legacy rows keep resolving
    expect(assets).toContain("page               INTEGER");
    expect(assets).toContain("bbox               JSONB");
    expect(assets).toContain("width              INTEGER");
    expect(assets).toContain("height             INTEGER");
    expect(assets).toContain("variant            TEXT NOT NULL DEFAULT 'full'");
    // variant is part of the key so a single asset can hold thumb/preview/full
    expect(assets).toContain("PRIMARY KEY (tenant_id, collection, asset_id, variant)");
    // bound to a revision for cleanup (Req 14.3)
    const all = queries.join("\n");
    expect(all).toContain("idx_vs_assets_revision");
  });

  it("backfills vs_assets from vs_document_assets as kind='figure' with a null revision_id", async () => {
    const { client, queries } = schemaClientMock({ legacyAssetsExist: true });
    await backfillAssetsFromDocumentAssets(client as never);
    const insert = queries.find((q) => q.includes(`INSERT INTO ${VS_ASSETS_TABLE}`));
    expect(insert).toBeDefined();
    expect(insert).toContain("FROM vs_document_assets");
    // literal 'figure' kind and NULL revision_id in the SELECT projection
    expect(insert).toContain("'figure'");
    expect(insert).toContain("NULL");
    expect(insert).toContain("'full'");
    // additive + idempotent
    expect(insert).toContain(
      "ON CONFLICT (tenant_id, collection, asset_id, variant) DO NOTHING",
    );
  });

  it("skips the backfill entirely on a fresh deployment with no legacy table", async () => {
    const { client, queries } = schemaClientMock({ legacyAssetsExist: false });
    await backfillAssetsFromDocumentAssets(client as never);
    // only the to_regclass probe ran; no INSERT was issued
    expect(queries.some((q) => q.includes("to_regclass"))).toBe(true);
    expect(queries.some((q) => q.includes(`INSERT INTO ${VS_ASSETS_TABLE}`))).toBe(false);
  });

  it("ensureRevisionSchema wires tables, assets and the guarded backfill together", async () => {
    const { client, queries } = schemaClientMock({ legacyAssetsExist: true });
    await ensureRevisionSchema(client as never);
    const all = queries.join("\n");
    expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${VS_REVISIONS_TABLE}`);
    expect(all).toContain(`CREATE TABLE IF NOT EXISTS ${VS_ASSETS_TABLE}`);
    expect(all).toContain(`INSERT INTO ${VS_ASSETS_TABLE}`);
  });
});

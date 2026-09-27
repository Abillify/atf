// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  ensureCollectionDDL,
  ensureIdentifiersTable,
  ensureStatsTables,
  ftsSearchRecomputeSql,
  withSchemaDdlLock,
  SCHEMA_DDL_LOCK_NAME,
  CURRENT_SCHEMA_VERSION,
  type CollectionMeta,
} from "../src/collection-ddl.js";
import {
  COLLECTION_MIGRATIONS,
  GLOBAL_MIGRATIONS,
  GLOBAL_SCHEMA_VERSION,
} from "../src/migrations.js";

/**
 * Build a pg-client mock for ensureCollectionDDL. `existingLanguage` lets a
 * test simulate a collection that already exists with a given FTS language so
 * the language-change migration path can be exercised.
 */
function ddlClientMock(options?: {
  existingLanguage?: string;
  tableExists?: boolean;
}): {
  client: { query: (sql: string) => Promise<{ rows: unknown[] }> };
  queries: string[];
} {
  const queries: string[] = [];
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    queries.push(sql);
    // loadCollectionMeta SELECT
    if (sql.includes("FROM vs_collection_config WHERE collection_table")) {
      if (options?.existingLanguage) {
        return {
          rows: [
            {
              fts_language: options.existingLanguage,
              sparse_enabled: false,
              sparse_vocab_size: null,
              quantization: "none",
              vector_size: 3,
              allowed_users: [],
              allowed_groups: [],
              embedding_model: null,
              embedding_model_revision: null,
              index_build_version: null,
              index_algorithm: null,
              index_parameters: null,
            },
          ],
        };
      }
      return { rows: [] };
    }
    // to_regclass table existence probe
    if (sql.includes("to_regclass")) {
      return {
        rows: [{ table_name: options?.tableExists ? "vc_x" : null }],
      };
    }
    return { rows: [] };
  };
  return { client: { query }, queries };
}

const meta: CollectionMeta = {
  language: "simple",
  sparseEnabled: true,
  sparseVocabSize: 30522,
  quantization: "none",
  vectorSize: 3,
};

describe("collection DDL", () => {
  it("migrates schema 11 with nullable validity storage and the temporal index", async () => {
    const migration = COLLECTION_MIGRATIONS.find((step) => step.toVersion === 11);
    expect(migration).toBeDefined();
    const queries: string[] = [];
    if (!migration) throw new Error("schema 11 migration missing");
    await migration.up({ query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as never, "vc_legacy", meta, {} as never);
    expect(queries.join("\n")).toContain("ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ");
    expect(queries.join("\n")).toContain("vc_legacy_temporal_version_idx");
  });

  it("bumps the current schema version to 14 for the ts_ident identifier vector", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(14);
  });

  it("adds the ts_ident FTS vector and its GIN index in the schema-14 migration", async () => {
    const migration = COLLECTION_MIGRATIONS.find((step) => step.toVersion === 14);
    expect(migration).toBeDefined();
    if (!migration) throw new Error("schema 14 migration missing");
    const queries: string[] = [];
    await migration.up(
      { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as never,
      "vc_legacy",
      meta,
      {} as never,
    );
    const all = queries.join("\n");
    // ts_ident is additive/nullable and gets its own GIN index (Req 12.1).
    expect(all).toContain("ADD COLUMN IF NOT EXISTS ts_ident       tsvector");
    expect(all).toContain('"vc_legacy_ts_ident_gin_idx"');
    expect(all).toContain("gin(ts_ident)");
  });

  it("keeps the schema-6 vs_identifiers migration step", () => {
    const step = GLOBAL_MIGRATIONS.find((s) => s.toVersion === 6);
    expect(step).toBeDefined();
  });

  it("targets the highest global migration step, so a database at 7 still records 8", () => {
    expect(GLOBAL_SCHEMA_VERSION).toBe(8);
    expect(Math.max(...GLOBAL_MIGRATIONS.map((s) => s.toVersion))).toBe(GLOBAL_SCHEMA_VERSION);
  });

  it("keeps the schema-8 document identity step", async () => {
    const step = GLOBAL_MIGRATIONS.find((s) => s.toVersion === 8);
    expect(step).toBeDefined();
    if (!step) throw new Error("global schema 8 migration missing");
    const queries: string[] = [];
    await step.up({
      query: async (sql: string) => { queries.push(sql); return { rows: [] }; },
      getTransactionStatus: () => "T",
    } as never);
    const all = queries.join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS vs_document_sources");
  });

  it("keeps the schema-7 step that eagerly reconciles the v2 system tables", async () => {
    const step = GLOBAL_MIGRATIONS.find((s) => s.toVersion === 7);
    expect(step).toBeDefined();
    if (!step) throw new Error("global schema 7 migration missing");
    const queries: string[] = [];
    // Simulate the migration transaction (status "T"): the ensure helpers must
    // join it under the schema-DDL lock instead of opening their own.
    await step.up({
      query: async (sql: string) => { queries.push(sql); return { rows: [] }; },
      getTransactionStatus: () => "T",
    } as never);
    const all = queries.join("\n");
    expect(all).not.toContain("BEGIN");
    expect(all).toContain("pg_advisory_xact_lock");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS vs_document_revisions");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS vs_revisions");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS vs_assets");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS vs_identifiers");
  });

  it("ensureCollectionDDL creates the revision pointer table under the schema-DDL lock when missing", async () => {
    const { client, queries } = ddlClientMock();
    await ensureCollectionDDL(client as never, "vc_fresh", 3, { ...meta }, {
      vecType: "vector", cosineOps: "vector_cosine_ops", hnswM: 16, efConstruction: 64,
    });
    const lockIdx = queries.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    const pointerIdx = queries.findIndex((q) =>
      q.includes("CREATE TABLE IF NOT EXISTS vs_document_revisions"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(pointerIdx).toBeGreaterThan(lockIdx);
    expect(queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS vs_identifiers"))).toBe(true);
    // Joined the collection DDL transaction: exactly one BEGIN/COMMIT.
    expect(queries.filter((q) => q === "BEGIN")).toHaveLength(1);
  });

  it("ensureCollectionDDL skips the revision DDL when the catalog shows it is current", async () => {
    const { client: base, queries } = ddlClientMock();
    const client = {
      query: async (sql: string) => {
        if (sql.includes("AS current")) {
          queries.push(sql);
          return { rows: [{ current: true }] };
        }
        return base.query(sql);
      },
    };
    await ensureCollectionDDL(client as never, "vc_fresh", 3, { ...meta }, {
      vecType: "vector", cosineOps: "vector_cosine_ops", hnswM: 16, efConstruction: 64,
    });
    const all = queries.join("\n");
    expect(all).not.toContain("vs_document_revisions (");
    expect(all).not.toContain("ALTER TABLE vs_revisions");
    expect(all).not.toContain("CREATE TABLE IF NOT EXISTS vs_identifiers");
  });

  it("creates vs_identifiers with the design's columns and lookup indexes", async () => {
    const queries: string[] = [];
    await ensureIdentifiersTable({
      query: async (sql: string) => { queries.push(sql); return { rows: [] }; },
    } as never);
    const all = queries.join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS vs_identifiers");
    for (const col of ["tenant_id", "collection", "value_norm", "unit_id", "page", "kind"]) {
      expect(all).toContain(col);
    }
    expect(all).toContain(
      "PRIMARY KEY (tenant_id, collection, value_norm, unit_id, page)",
    );
    expect(all).toContain("idx_vs_identifiers_lookup");
    expect(all).toContain("idx_vs_identifiers_unit");
  });

  it("adds v2 unit columns as real indexed columns in the schema-12 migration", async () => {
    const migration = COLLECTION_MIGRATIONS.find((step) => step.toVersion === 12);
    expect(migration).toBeDefined();
    if (!migration) throw new Error("schema 12 migration missing");
    const queries: string[] = [];
    await migration.up(
      { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as never,
      "vc_legacy",
      meta,
      {} as never,
    );
    const all = queries.join("\n");
    // filter-relevant fields become real columns (design §6.2, Req 11.5)
    for (const col of [
      "unit_id",
      "unit_type",
      "revision_id",
      "section_id",
      "section_path   TEXT[]",
      "page_start",
      "page_end",
      "figure_kind",
      "document_id",
    ]) {
      expect(all).toContain(col);
    }
    // and their indexes, including a partial unique on unit_id and a gin on the path
    expect(all).toContain('"vc_legacy_unit_id_key"');
    expect(all).toContain("WHERE unit_id IS NOT NULL");
    expect(all).toContain('"vc_legacy_section_path_gin_idx"');
    expect(all).toContain("gin(section_path)");
    expect(all).toContain('"vc_legacy_page_range_idx"');
  });

  it("adds the multi-level unit relationship columns and indexes in the schema-13 migration", async () => {
    const migration = COLLECTION_MIGRATIONS.find((step) => step.toVersion === 13);
    expect(migration).toBeDefined();
    if (!migration) throw new Error("schema 13 migration missing");
    const queries: string[] = [];
    await migration.up(
      { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } } as never,
      "vc_legacy",
      meta,
      {} as never,
    );
    const all = queries.join("\n");
    // Relationship-graph columns become real columns (Req 11.1 / 11.5).
    for (const col of [
      "parent_unit_id TEXT",
      "prev_unit_id   TEXT",
      "next_unit_id   TEXT",
      "block_ids      TEXT[]",
      "figure_refs    TEXT[]",
      "table_id       TEXT",
    ]) {
      expect(all).toContain(col);
    }
    // and their traversal/filter indexes.
    expect(all).toContain('"vc_legacy_parent_unit_id_idx"');
    expect(all).toContain('"vc_legacy_prev_unit_id_idx"');
    expect(all).toContain('"vc_legacy_next_unit_id_idx"');
    expect(all).toContain('"vc_legacy_table_id_idx"');
    expect(all).toContain('"vc_legacy_figure_refs_gin_idx"');
    expect(all).toContain("gin(figure_refs)");
  });

  it("also creates the v2 unit columns when a brand-new collection table is built", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    };
    await ensureCollectionDDL(client as never, "vc_units_new", 3, meta, {
      vecType: "vector",
      cosineOps: "vector_cosine_ops",
      hnswM: 16,
      efConstruction: 64,
    });
    const all = queries.join("\n");
    expect(all).toContain("ADD COLUMN IF NOT EXISTS unit_id");
    expect(all).toContain('"vc_units_new_unit_type_idx"');
    expect(all).toContain('"vc_units_new_section_path_gin_idx"');
  });

  it("creates a sparsevec inner-product HNSW index, not an invalid access method", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
    };
    await ensureCollectionDDL(client as never, "vc_sparse_test", 3, meta, {
      vecType: "vector",
      cosineOps: "vector_cosine_ops",
      hnswM: 16,
      efConstruction: 64,
    });
    const sparseDdl = queries.find((sql) => sql.includes("sparse_vector_idx"));
    expect(sparseDdl).toContain("USING hnsw (sparse_vector sparsevec_ip_ops)");
    expect(sparseDdl).not.toContain("USING sparsevec");
    expect(queries.join("\n")).toContain("valid_from     TIMESTAMPTZ");
    const temporalDdl = queries.find((sql) => sql.includes("temporal_version_idx"));
    expect(temporalDdl).toContain("COALESCE(valid_from, created)");
    expect(temporalDdl).toContain("tenant_id, base_ref");
  });

  it("discards unmapped legacy stats before making tenant columns mandatory", async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql.replace(/\s+/g, " ").trim());
        return { rows: [] };
      },
    };

    await ensureStatsTables(client as never);

    for (const table of ["vs_ingest_stats", "vs_search_stats"]) {
      const deleteIndex = queries.findIndex((sql) =>
        sql.includes(`DELETE FROM ${table} WHERE tenant_id IS NULL`),
      );
      const notNullIndex = queries.findIndex((sql) =>
        sql.includes(`ALTER TABLE ${table} ALTER COLUMN tenant_id SET NOT NULL`),
      );
      expect(deleteIndex).toBeGreaterThan(-1);
      expect(notNullIndex).toBeGreaterThan(deleteIndex);
    }
    expect(queries.join(" ")).not.toContain("SET tenant_id = 'default'");
  });
});

describe("FTS language migration (Requirement 2.6)", () => {
  const ddlConfig = {
    vecType: "vector",
    cosineOps: "vector_cosine_ops",
    hnswM: 16,
    efConstruction: 64,
  } as const;

  it("wraps the reconstructed FTS text in to_tsvector with the given language", () => {
    const sql = ftsSearchRecomputeSql("german");
    expect(sql.startsWith("to_tsvector('german',")).toBe(true);
    // chunk-0 rows are enriched with identity fields, mirroring buildFtsText
    expect(sql).toContain("chunk->>'chunk_index'");
    expect(sql).toContain("base_ref");
    expect(sql).toContain("title");
    expect(sql).toContain("prefix");
    expect(sql).toContain("content");
    // preprocessing cleanups are reproduced in SQL
    expect(sql).toContain("regexp_replace");
  });

  it("interpolates the (pre-validated) language into to_tsvector", () => {
    // ftsSearchRecomputeSql trusts a pre-validated language; the whitelist guard
    // lives in validateFtsLanguage, exercised by recomputeFtsLanguage.
    expect(ftsSearchRecomputeSql("english").startsWith("to_tsvector('english',")).toBe(true);
    expect(ftsSearchRecomputeSql("simple").startsWith("to_tsvector('simple',")).toBe(true);
  });

  it("recomputes ts_search when an existing collection's language changes", async () => {
    const { client, queries } = ddlClientMock({
      existingLanguage: "simple",
      tableExists: true,
    });
    const meta: CollectionMeta = {
      language: "german",
      sparseEnabled: false,
      sparseVocabSize: null,
      quantization: "none",
      vectorSize: 3,
    };
    await ensureCollectionDDL(client as never, "vc_lang_test", 3, meta, ddlConfig);
    const recompute = queries.find(
      (sql) =>
        sql.includes("SET ts_search =") && sql.includes("to_tsvector('german'"),
    );
    expect(recompute).toBeDefined();
    expect(recompute).toContain('UPDATE "vc_lang_test"');
  });

  it("does not recompute for a brand-new collection", async () => {
    const { client, queries } = ddlClientMock({ tableExists: false });
    const meta: CollectionMeta = {
      language: "german",
      sparseEnabled: false,
      sparseVocabSize: null,
      quantization: "none",
      vectorSize: 3,
    };
    await ensureCollectionDDL(client as never, "vc_new", 3, meta, ddlConfig);
    const recompute = queries.find((sql) => sql.includes("SET ts_search ="));
    expect(recompute).toBeUndefined();
  });

  it("does not recompute when the language is unchanged", async () => {
    const { client, queries } = ddlClientMock({
      existingLanguage: "german",
      tableExists: true,
    });
    const meta: CollectionMeta = {
      language: "german",
      sparseEnabled: false,
      sparseVocabSize: null,
      quantization: "none",
      vectorSize: 3,
    };
    await ensureCollectionDDL(client as never, "vc_same", 3, meta, ddlConfig);
    const recompute = queries.find((sql) => sql.includes("SET ts_search ="));
    expect(recompute).toBeUndefined();
  });
});

describe("schema DDL advisory lock", () => {
  function recorder(txStatus?: () => string) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [] };
      },
      ...(txStatus ? { getTransactionStatus: txStatus } : {}),
    };
    return { client, queries };
  }

  it("opens its own transaction and takes the xact lock before any DDL", async () => {
    const { client, queries } = recorder(() => "I");
    await ensureIdentifiersTable(client as never);
    expect(queries[0]?.sql).toBe("BEGIN");
    expect(queries[1]?.sql).toContain("pg_advisory_xact_lock");
    expect(queries[1]?.params).toEqual([SCHEMA_DDL_LOCK_NAME]);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(queries.some((q) => q.sql.includes("CREATE TABLE IF NOT EXISTS vs_identifiers"))).toBe(true);
  });

  it("joins an already open transaction without nested BEGIN/COMMIT", async () => {
    const { client, queries } = recorder(() => "T");
    await withSchemaDdlLock(client as never, async () => {
      await client.query("SELECT 1");
    });
    expect(queries.map((q) => q.sql)).toEqual([
      "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
      "SELECT 1",
    ]);
  });

  it("rolls back and rethrows when the DDL fails", async () => {
    const { client, queries } = recorder(() => "I");
    await expect(
      withSchemaDdlLock(client as never, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(queries.map((q) => q.sql).at(-1)).toBe("ROLLBACK");
  });

  it("ensureCollectionDDL takes the lock before CREATE EXTENSION and the config table", async () => {
    const { client, queries } = recorder(() => "I");
    const meta: CollectionMeta = { language: "simple", sparseEnabled: false, sparseVocabSize: null, quantization: "none", vectorSize: 3 };
    await ensureCollectionDDL(client as never, "vc_locked", 3, meta, { vecType: "vector", cosineOps: "vector_cosine_ops", hnswM: 16, efConstruction: 64 });
    const sqls = queries.map((q) => q.sql);
    const lock = sqls.findIndex((q) => q.includes("pg_advisory_xact_lock"));
    expect(sqls[0]).toBe("BEGIN");
    expect(lock).toBe(1);
    expect(sqls.findIndex((q) => q.includes("CREATE EXTENSION"))).toBeGreaterThan(lock);
    expect(sqls.findIndex((q) => q.includes("vs_collection_config ("))).toBeGreaterThan(lock);
    expect(sqls.filter((q) => q === "BEGIN")).toHaveLength(1);
    expect(sqls.at(-1)).toBe("COMMIT");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  ensureCollectionDDL,
  ensureStatsTables,
  type CollectionMeta,
} from "../src/collection-ddl.js";

const meta: CollectionMeta = {
  language: "simple",
  sparseEnabled: true,
  sparseVocabSize: 30522,
  quantization: "none",
  vectorSize: 3,
};

describe("collection DDL", () => {
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

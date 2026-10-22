// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { DocumentPoint } from "../src/pg-types.js";

const query = vi.fn();
const release = vi.fn();
const end = vi.fn();

vi.mock("pg", () => ({
  Pool: class {
    on() {}
    query(...args: unknown[]) {
      return query(...args);
    }
    async connect() {
      return { query, release };
    }
    async end() {
      end();
    }
  },
}));

const { createPostgresClient } = await import("../src/postgres-client.js");
const { buildFtsContextHeader } = await import("../src/pg-helpers.js");

function client(ftsContextualHeader?: boolean) {
  return createPostgresClient({
    connectionString: "postgres://unused",
    logger: pino({ level: "silent" }),
    statementTimeoutMs: 0,
    statsFlushIntervalMs: 3_600_000,
    ftsContextualHeader,
  });
}

function installFakePg() {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT fts_language")) {
      return {
        rows: [
          {
            fts_language: "german",
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
    if (sql.includes('INSERT INTO "vc_documents"')) {
      return { rows: [{ id: "1", reference: "doc", was_insert: true }] };
    }
    return { rows: [], rowCount: 0 };
  });
}

const point: DocumentPoint = {
  tenantId: "tenant-a",
  reference: "doc",
  content: "Der Inhalt erwaehnt keine Produktnamen.",
  vector: [0.1, 0.2, 0.3],
  metadata: {},
  title: "Produktdoku Fernwartung",
  chunk: {
    chunk_index: 0,
    chunk_total: 1,
    chunk_size: 500,
    section_path: ["Kapitel 1", "Grundlagen"],
  },
};

function insertSqlAndParams(): [string, unknown[]] {
  const call = query.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO "vc_documents"'),
  );
  if (!call) throw new Error("no INSERT captured");
  return [String(call[0]), call[1] as unknown[]];
}

describe("buildFtsContextHeader", () => {
  it("joins title and section path", () => {
    expect(buildFtsContextHeader(point)).toBe(
      "Produktdoku Fernwartung\nKapitel 1 \u203a Grundlagen",
    );
  });

  it("uses the title alone without a section path", () => {
    expect(
      buildFtsContextHeader({ ...point, chunk: undefined }),
    ).toBe("Produktdoku Fernwartung");
  });

  it("uses the section path alone without a title", () => {
    expect(
      buildFtsContextHeader({ ...point, title: undefined }),
    ).toBe("Kapitel 1 \u203a Grundlagen");
  });

  it("returns an empty string when neither is present", () => {
    expect(
      buildFtsContextHeader({ ...point, title: undefined, chunk: undefined }),
    ).toBe("");
  });
});

describe("FTS_CONTEXTUAL_HEADER ingest SQL", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    installFakePg();
  });

  it("writes setweight(..., 'D') into ts_search when enabled", async () => {
    const postgres = client(true);
    const result = await postgres.upsert(point, "documents");
    expect(result.ok).toBe(true);

    const [sql, params] = insertSqlAndParams();
    expect(sql).toContain("setweight(");
    expect(sql).toContain("'D'");
    expect(sql).toContain(
      "setweight(to_tsvector('german', $16), 'D') || to_tsvector('german', $15)",
    );
    // The header is passed as its own parameter right after the content.
    expect(params).toContain("Produktdoku Fernwartung\nKapitel 1 \u203a Grundlagen");
    await postgres.close();
  });

  it("keeps the plain to_tsvector when disabled", async () => {
    const postgres = client(false);
    const result = await postgres.upsert(point, "documents");
    expect(result.ok).toBe(true);

    const [sql, params] = insertSqlAndParams();
    expect(sql).not.toContain("setweight(");
    expect(sql).toContain("to_tsvector('german', $15)");
    expect(params).not.toContain(
      "Produktdoku Fernwartung\nKapitel 1 \u203a Grundlagen",
    );
    await postgres.close();
  });

  it("keeps the plain to_tsvector when enabled but no header exists", async () => {
    const postgres = client(true);
    const result = await postgres.upsert(
      { ...point, title: undefined, chunk: undefined },
      "documents",
    );
    expect(result.ok).toBe(true);

    const [sql] = insertSqlAndParams();
    expect(sql).not.toContain("setweight(");
    expect(sql).toContain("to_tsvector('german', $15)");
    await postgres.close();
  });

  it("adds the header per row in batchUpsert", async () => {
    const postgres = client(true);
    const result = await postgres.batchUpsert(
      [point, { ...point, reference: "doc-2" }],
      "documents",
    );
    expect(result.ok).toBe(true);

    const [sql, params] = insertSqlAndParams();
    expect(sql.match(/setweight\(/g)).toHaveLength(2);
    expect(
      params.filter((p) => p === "Produktdoku Fernwartung\nKapitel 1 \u203a Grundlagen"),
    ).toHaveLength(2);
    await postgres.close();
  });
});

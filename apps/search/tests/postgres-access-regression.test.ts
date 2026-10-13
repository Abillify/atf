// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { AccessScope } from "../src/access-scope.js";

const query = vi.fn();
const release = vi.fn();
const end = vi.fn();

vi.mock("pg", () => ({
  Pool: class {
    on() {}
    async connect() {
      return { query, release };
    }
    async end() {
      end();
    }
  },
}));

const { createPostgresClient } = await import("../src/postgres-client.js");

const userScope = (userId: string, groups: string[] = []): AccessScope => ({
  principal: { userId, userGroups: groups, tenantId: "tenant-a", source: "jwt" },
  userId,
  userGroups: groups,
  tenantId: "tenant-a",
  service: false,
});

const serviceScope: AccessScope = {
  principal: { userId: undefined, userGroups: undefined, tenantId: "tenant-a", source: "service" },
  userId: undefined,
  userGroups: [],
  tenantId: "tenant-a",
  service: true,
};

function client() {
  return createPostgresClient({
    connectionString: "postgres://unused",
    logger: pino({ level: "silent" }),
    statementTimeoutMs: 0,
    statsFlushIntervalMs: 3_600_000,
  });
}

function configRows() {
  return ["vs_collection_alpha", "vs_collection_beta"].map((collection_table) => ({
    collection_table,
    fts_language: "simple",
    sparse_enabled: false,
    sparse_vocab_size: null,
    quantization: "none",
    vector_size: 3,
    allowed_users: [],
    allowed_groups: [],
    created: new Date(0),
    updated_at: new Date(0),
  }));
}

describe("postgres access regressions", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("preserves persisted ACL columns on bypass conflicts", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT fts_language")) {
        return {
          rows: [{
            fts_language: "simple",
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
          }],
        };
      }
      if (sql.includes('INSERT INTO "vc_documents"')) {
        return { rows: [{ id: "1", reference: "doc", was_insert: false }] };
      }
      return { rows: [], rowCount: 0 };
    });
    const postgres = client();
    const result = await postgres.upsert({
      tenantId: "tenant-a",
      reference: "doc",
      vector: [0.1, 0.2, 0.3],
      content: "updated",
      metadata: {},
      allowedUsers: ["collection-user"],
      allowedGroups: ["collection-group"],
      preserveExistingAclOnConflict: true,
    }, "documents");

    expect(result.ok).toBe(true);
    const upsertCall = query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO "vc_documents"'),
    );
    expect(upsertCall[0]).not.toContain("allowed_users = EXCLUDED.allowed_users");
    expect(upsertCall[0]).not.toContain("allowed_groups = EXCLUDED.allowed_groups");
    expect(upsertCall[1]).toContainEqual(["collection-user"]);
    expect(upsertCall[1]).toContainEqual(["collection-group"]);
    await postgres.close();
  });

  it("fails closed when a collection table exists but its config row is missing", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ t: "vs_collection_orphan" }] };
      if (sql.includes("SELECT allowed_users, allowed_groups")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    const postgres = client();
    const result = await postgres.getCollectionAcl("orphan");
    expect(result).toMatchObject({ ok: false, error: { code: "COLLECTION_NOT_FOUND" } });
    await postgres.close();
  });

  it("fails closed before ACL lookup when the collection table is unknown", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass")) return { rows: [{ t: null }] };
      return { rows: [], rowCount: 0 };
    });
    const postgres = client();
    const result = await postgres.getCollectionAcl("missing");
    expect(result).toMatchObject({ ok: false, error: { code: "COLLECTION_NOT_FOUND" } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SELECT allowed_users"))).toBe(false);
    await postgres.close();
  });

  it.each([
    ["alice", userScope("alice"), ["tenant-a", "alice", "tenant-a", "alice"]],
    ["bob with group", userScope("bob", ["legal"]), ["tenant-a", "bob", ["legal"], "tenant-a", "bob", ["legal"]]],
  ] as const)("builds globally indexed row-visibility parameters for %s", async (_name, scope, expected) => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM vs_collection_config") && sql.includes("ORDER BY created")) {
        return { rows: configRows() };
      }
      if (sql.includes(" UNION ALL ")) {
        return {
          rows: [
            { tbl: "vs_collection_alpha", total_chunks: "2", total_docs: "1" },
            { tbl: "vs_collection_beta", total_chunks: "3", total_docs: "2" },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const postgres = client();
    const result = await postgres.listCollections(scope);
    expect(result.ok).toBe(true);
    const countCall = query.mock.calls.find(([sql]) => String(sql).includes(" UNION ALL "));
    expect(countCall[0]).toContain("allowed_users");
    expect(countCall[0]).toContain("allowed_groups");
    // Empty row ACLs remain public, while identified users/groups add their
    // own alternatives in every UNION branch.
    expect(countCall[0]).toContain("COALESCE(cardinality(allowed_users), 0) = 0");
    expect(countCall[0]).toContain(`$${expected.length}`);
    expect(countCall[1]).toEqual(expected);
    await postgres.close();
  });

  it("lets service scope see total counts without row ACL parameters", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM vs_collection_config") && sql.includes("ORDER BY created")) {
        return { rows: configRows() };
      }
      if (sql.includes(" UNION ALL ")) {
        return { rows: configRows().map((r) => ({ tbl: r.collection_table, total_chunks: "9", total_docs: "4" })) };
      }
      return { rows: [], rowCount: 0 };
    });
    const postgres = client();
    const result = await postgres.listCollections(serviceScope);
    expect(result.ok && result.result.every((r) => r.totalChunks === 9)).toBe(true);
    const countCall = query.mock.calls.find(([sql]) => String(sql).includes(" UNION ALL "));
    expect(countCall[0]).not.toContain("allowed_users");
    expect(countCall[1]).toEqual(["tenant-a", "tenant-a"]);
    await postgres.close();
  });
});

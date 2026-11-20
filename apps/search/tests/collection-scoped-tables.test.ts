// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { pino } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const release = vi.fn();

vi.mock("pg", () => ({
  Pool: class {
    on() {}
    async connect() {
      return { query, release };
    }
    async end() {}
  },
}));

const { createPostgresClient } = await import("../src/postgres-client.js");

function client() {
  return createPostgresClient({
    connectionString: "postgres://unused",
    logger: pino({ level: "silent" }),
    statementTimeoutMs: 0,
    statsFlushIntervalMs: 3_600_000,
  });
}

/** Tables the fake database reports as existing. */
const EXISTING_TABLES = [
  "vs_revisions",
  "vs_segments",
  "vs_identifiers",
  "vs_ingest_stats",
  "vs_search_stats",
];

function sqlCalls(): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

describe("renameCollection", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("rewrites the collection name in every scoped vs_* table", async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("to_regclass")) {
        return {
          rows: EXISTING_TABLES.map((name) => ({ name, present: true })),
        };
      }
      if (sql.includes("collection_table = $1")) {
        // source exists, target free — the table name is a parameter
        const table = (params as string[])[0];
        return { rows: [{ exists: table === "vc_old" }] };
      }
      if (sql.includes("pg_indexes")) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await client().renameCollection("old", "new");

    expect(res.ok).toBe(true);
    const calls = sqlCalls();
    const updates = calls.filter((s) => s.includes("UPDATE "));
    // config + document assets are handled explicitly; every existing scoped
    // table must get its collection column rewritten inside the transaction.
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UPDATE vs_collection_config"),
        expect.stringContaining("UPDATE vs_document_assets"),
        expect.stringContaining("UPDATE vs_revisions"),
        expect.stringContaining("UPDATE vs_segments"),
        expect.stringContaining("UPDATE vs_identifiers"),
        expect.stringContaining("UPDATE vs_ingest_stats"),
        expect.stringContaining("UPDATE vs_search_stats"),
      ]),
    );
    // Tables that don't exist in this database must be skipped.
    expect(updates).not.toEqual(
      expect.arrayContaining([expect.stringContaining("vs_mail_messages")]),
    );
    // All updates happen between BEGIN and COMMIT.
    const begin = calls.indexOf("BEGIN");
    const commit = calls.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    for (const u of updates) {
      expect(calls.indexOf(u)).toBeGreaterThan(begin);
      expect(calls.indexOf(u)).toBeLessThan(commit);
    }
    // The table itself is renamed.
    expect(calls).toContain('ALTER TABLE "vc_old" RENAME TO "vc_new"');
  });

  it("rejects a rename into a taken collection name with COLLECTION_EXISTS", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass")) {
        return { rows: [{ name: "vs_revisions", present: true }] };
      }
      if (sql.includes("collection_table = $1")) {
        // source exists AND target config row exists
        return { rows: [{ exists: true }] };
      }
      return { rows: [] };
    });

    const res = await client().renameCollection("old", "new");

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe("COLLECTION_EXISTS");
    // Nothing may have been written.
    expect(sqlCalls()).not.toEqual(
      expect.arrayContaining([expect.stringContaining("UPDATE ")]),
    );
  });

  it("rejects a rename when rows already exist under the target name", async () => {
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("to_regclass")) {
        return { rows: [{ name: "vs_revisions", present: true }] };
      }
      if (sql.includes("collection_table = $1")) {
        const table = (params as string[])[0];
        return { rows: [{ exists: table === "vc_old" }] };
      }
      if (sql.includes("bool_or")) {
        expect(params).toEqual(["new"]);
        return { rows: [{ taken: true }] };
      }
      return { rows: [] };
    });

    const res = await client().renameCollection("old", "new");

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.code).toBe("COLLECTION_EXISTS");
  });

  it("keeps the source name out of pending stat rows after a rename", async () => {
    const { createStatsBuffer } = await import("../src/stats-buffer.js");
    const pool = {
      connect: async () => ({ query, release }),
    } as unknown as import("pg").Pool;
    const buffer = createStatsBuffer(
      pool,
      pino({ level: "silent" }),
      30,
      3_600_000,
    );
    buffer.recordIngest({
      collection: "old",
      documentId: "doc-1",
      status: "ok",
      durationMs: 1,
      chunks: 1,
      tokens: 1,
      warnings: 0,
      tenantId: "tenant-a",
    });
    buffer.renameCollection("old", "new");
    query.mockResolvedValue({ rows: [] });
    await buffer.flush();
    const insert = sqlCalls().find((s) =>
      s.includes("INSERT INTO vs_ingest_stats"),
    );
    expect(insert).toBeDefined();
    const params = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO vs_ingest_stats"),
    )?.[1] as unknown[];
    expect(params).toContain("new");
    expect(params).not.toContain("old");
  });
});

describe("deleteCollection", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("removes the collection rows from every scoped vs_* table", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("to_regclass")) {
        return {
          rows: EXISTING_TABLES.map((name) => ({ name, present: true })),
        };
      }
      return { rows: [] };
    });

    const res = await client().deleteCollection("old");

    expect(res.ok).toBe(true);
    const calls = sqlCalls();
    const deletes = calls.filter((s) => s.startsWith("DELETE FROM "));
    expect(deletes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("DELETE FROM vs_collection_config"),
        expect.stringContaining("DELETE FROM vs_document_assets"),
        expect.stringContaining("DELETE FROM vs_revisions"),
        expect.stringContaining("DELETE FROM vs_segments"),
        expect.stringContaining("DELETE FROM vs_identifiers"),
        expect.stringContaining("DELETE FROM vs_ingest_stats"),
        expect.stringContaining("DELETE FROM vs_search_stats"),
      ]),
    );
    // Tables that don't exist in this database must be skipped.
    expect(deletes).not.toEqual(
      expect.arrayContaining([expect.stringContaining("vs_mail_messages")]),
    );
    // Everything happens between BEGIN and COMMIT, together with the DROP.
    const begin = calls.indexOf("BEGIN");
    const commit = calls.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    expect(calls.indexOf('DROP TABLE IF EXISTS "vc_old"')).toBeGreaterThan(
      begin,
    );
    for (const d of deletes) {
      expect(calls.indexOf(d)).toBeGreaterThan(begin);
      expect(calls.indexOf(d)).toBeLessThan(commit);
    }
  });

  it("drops pending stat rows for the deleted collection", async () => {
    const { createStatsBuffer } = await import("../src/stats-buffer.js");
    const pool = {
      connect: async () => ({ query, release }),
    } as unknown as import("pg").Pool;
    const buffer = createStatsBuffer(
      pool,
      pino({ level: "silent" }),
      30,
      3_600_000,
    );
    buffer.recordIngest({
      collection: "gone",
      documentId: "doc-1",
      status: "ok",
      durationMs: 1,
      chunks: 1,
      tokens: 1,
      warnings: 0,
      tenantId: "tenant-a",
    });
    buffer.recordIngest({
      collection: "kept",
      documentId: "doc-2",
      status: "ok",
      durationMs: 1,
      chunks: 1,
      tokens: 1,
      warnings: 0,
      tenantId: "tenant-a",
    });
    buffer.dropCollection("gone");
    query.mockResolvedValue({ rows: [] });
    await buffer.flush();
    const call = query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO vs_ingest_stats"),
    );
    expect(call).toBeDefined();
    const params = call?.[1] as unknown[];
    expect(params).toContain("kept");
    expect(params).not.toContain("gone");
  });
});

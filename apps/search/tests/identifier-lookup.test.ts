// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for the identifier lookup's failure handling (Requirement 12.3):
 * a vs_identifiers error must degrade to "no exact list" WITHOUT aborting the
 * surrounding search transaction (SAVEPOINT) and must be logged (warn), not
 * silently swallowed. Also covers sourceSha256FromPayloadHead.
 */

import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type pino from "pino";
import {
  lookupIdentifierUnitIds,
  sourceSha256FromPayloadHead,
} from "../src/postgres-client.js";

function fakeLogger(): pino.Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
}

function fakeClient(failSelect: boolean): { client: PoolClient; sql: string[] } {
  const sql: string[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text.trim().split(/\s+/).slice(0, 4).join(" "));
      if (text.includes("FROM vs_identifiers")) {
        if (failSelect) throw new Error('relation "vs_identifiers" does not exist');
        return { rows: [{ unit_id: "u-1" }, { unit_id: "u-2" }] };
      }
      return { rows: [] };
    }),
  } as unknown as PoolClient;
  return { client, sql };
}

describe("lookupIdentifierUnitIds", () => {
  it("returns unit ids inside a released savepoint", async () => {
    const { client, sql } = fakeClient(false);
    const logger = fakeLogger();
    const ids = await lookupIdentifierUnitIds(client, ["WE01A"], "t1", "docs", logger);
    expect(ids).toEqual(["u-1", "u-2"]);
    expect(sql[0]).toBe("SAVEPOINT identifier_lookup");
    expect(sql.at(-1)).toBe("RELEASE SAVEPOINT identifier_lookup");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("on error: rolls back to the savepoint, logs a warning and degrades to []", async () => {
    const { client, sql } = fakeClient(true);
    const logger = fakeLogger();
    const ids = await lookupIdentifierUnitIds(client, ["WE01A"], "t1", "docs", logger);
    expect(ids).toEqual([]);
    expect(sql).toContain("ROLLBACK TO SAVEPOINT identifier_lookup");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.err).toBeInstanceOf(Error);
    expect(fields.collection).toBe("docs");
    expect(message).toContain("Identifier lookup");
  });

  it("does not query without a tenant or without identifiers", async () => {
    const { client, sql } = fakeClient(false);
    const logger = fakeLogger();
    expect(await lookupIdentifierUnitIds(client, ["WE01A"], undefined, "docs", logger)).toEqual([]);
    expect(await lookupIdentifierUnitIds(client, [], "t1", "docs", logger)).toEqual([]);
    expect(sql).toHaveLength(0);
  });
});

describe("sourceSha256FromPayloadHead", () => {
  const sha = "a".repeat(64);
  const begin = JSON.stringify({ type: "document.begin", source: { sha256: sha } });

  it("reads document.begin.source.sha256 from the first records", () => {
    expect(sourceSha256FromPayloadHead(Buffer.from(`${begin}\n{"type":"page"}\n`))).toBe(sha);
  });

  it("tolerates a truncated trailing line and non-JSON noise", () => {
    expect(sourceSha256FromPayloadHead(`garbage\n${begin}\n{"type":"pa`)).toBe(sha);
  });

  it("rejects a non-hex / upper-case digest and a payload without document.begin", () => {
    expect(sourceSha256FromPayloadHead(begin.replace(sha, sha.toUpperCase()))).toBeNull();
    expect(sourceSha256FromPayloadHead(begin.replace(sha, "../x"))).toBeNull();
    expect(sourceSha256FromPayloadHead(`{"type":"page"}\n`)).toBeNull();
    expect(sourceSha256FromPayloadHead(null)).toBeNull();
  });
});

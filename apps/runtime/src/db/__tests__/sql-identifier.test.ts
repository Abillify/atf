// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the central SQL-identifier whitelist (Requirement 7.10).
 */

import { describe, expect, it } from "bun:test";
import { isSafeSqlIdentifier, safeSqlIdentifier } from "../sql-identifier.js";

describe("isSafeSqlIdentifier (Req 7.10)", () => {
  it("accepts plain lowercase identifiers", () => {
    for (const name of [
      "api_keys",
      "store_kv",
      "store_counters",
      "distributed_semaphore",
      "rag_documents",
      "daily_budget",
      "treatment_runs",
      "_private",
      "a1",
    ]) {
      expect(isSafeSqlIdentifier(name)).toBe(true);
    }
  });

  it("rejects injection attempts and malformed identifiers", () => {
    for (const name of [
      "",
      "1table", // leading digit
      "Table", // uppercase
      "my table", // whitespace
      "my-table", // dash
      "tbl; DROP TABLE users", // statement injection
      'tbl"; DROP', // quote injection
      "tbl--", // comment marker
      "tbl/*x*/", // block comment
      "tbl.name", // schema-qualified dot
      "tbl\u00e4", // non-ASCII
      "a".repeat(64), // beyond the 63-byte Postgres limit
    ]) {
      expect(isSafeSqlIdentifier(name)).toBe(false);
    }
  });

  it("accepts exactly 63 characters but not 64", () => {
    expect(isSafeSqlIdentifier("a".repeat(63))).toBe(true);
    expect(isSafeSqlIdentifier("a".repeat(64))).toBe(false);
  });
});

describe("safeSqlIdentifier (Req 7.10)", () => {
  it("returns the identifier unchanged when safe", () => {
    expect(safeSqlIdentifier("api_keys")).toBe("api_keys");
    expect(safeSqlIdentifier("api_keys", "api key table")).toBe("api_keys");
  });

  it("throws on unsafe identifiers, with context in the message", () => {
    expect(() => safeSqlIdentifier("bad name")).toThrow(
      /Unsafe SQL identifier rejected/,
    );
    expect(() => safeSqlIdentifier("bad;name", "vector store table name")).toThrow(
      /vector store table name/,
    );
  });
});

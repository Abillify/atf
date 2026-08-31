// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cursor encoding — the v2 (score-bearing) format and v1 backward compatibility.
 *
 * The cursor is the pagination contract: a client holds an opaque string across
 * requests, possibly across a deploy. So both directions matter — a v2 cursor
 * must round-trip the score exactly, and a v1 cursor minted by the previous
 * version must still decode instead of turning into a 400 mid-pagination.
 */

import { describe, expect, it } from "vitest";
import { encodeCursor, decodeCursor } from "../src/postgres-client.js";

const CREATED = "2026-01-15T10:00:00.000Z";

describe("v2 cursor (with score)", () => {
  it("round-trips created, id and score", () => {
    const encoded = encodeCursor({ created: CREATED, id: "42", score: 0.8321 });
    expect(decodeCursor(encoded)).toEqual({
      created: CREATED,
      id: "42",
      score: 0.8321,
    });
  });

  it("is opaque (base64url, no readable payload)", () => {
    const encoded = encodeCursor({ created: CREATED, id: "42", score: 0.5 });
    expect(encoded).not.toContain("|");
    expect(encoded).not.toContain(CREATED);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("preserves a zero score rather than dropping it as falsy", () => {
    // A ts_rank of 0 is a legitimate score; treating it as "absent" would
    // silently downgrade the cursor to the (created, id) fallback.
    const decoded = decodeCursor(
      encodeCursor({ created: CREATED, id: "1", score: 0 }),
    );
    expect(decoded?.score).toBe(0);
  });

  it("preserves a negative score", () => {
    const decoded = decodeCursor(
      encodeCursor({ created: CREATED, id: "1", score: -0.25 }),
    );
    expect(decoded?.score).toBe(-0.25);
  });

  it("survives an id containing a pipe character", () => {
    // ids are taken from the END of the payload, so a delimiter inside the id
    // cannot shift the parse.
    const decoded = decodeCursor(
      encodeCursor({ created: CREATED, id: "a|b", score: 0.1 }),
    );
    expect(decoded).toEqual({ created: `${CREATED}|a`, id: "b", score: 0.1 });
  });

  it("falls back to the v1 format when the score is not finite", () => {
    const encoded = encodeCursor({
      created: CREATED,
      id: "42",
      score: Number.NaN,
    });
    const decoded = decodeCursor(encoded);
    expect(decoded?.score).toBeUndefined();
    expect(decoded?.created).toBe(CREATED);
  });
});

describe("v1 cursor (legacy, no score)", () => {
  it("still decodes so in-flight pagination survives a deploy", () => {
    const legacy = Buffer.from(`${CREATED}|42`, "utf-8").toString("base64url");
    expect(decodeCursor(legacy)).toEqual({ created: CREATED, id: "42" });
  });

  it("round-trips when encoded without a score", () => {
    const encoded = encodeCursor({ created: CREATED, id: "42" });
    expect(decodeCursor(encoded)).toEqual({ created: CREATED, id: "42" });
  });
});

describe("malformed input", () => {
  it("rejects a payload with no separator", () => {
    const bad = Buffer.from("no-separator", "utf-8").toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("rejects an empty created or id", () => {
    expect(
      decodeCursor(Buffer.from("|42", "utf-8").toString("base64url")),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from(`${CREATED}|`, "utf-8").toString("base64url")),
    ).toBeNull();
  });

  it("rejects a v2 payload with a non-numeric score", () => {
    const bad = Buffer.from(`v2|abc|${CREATED}|42`, "utf-8").toString(
      "base64url",
    );
    expect(decodeCursor(bad)).toBeNull();
  });

  it("rejects a truncated v2 payload", () => {
    expect(
      decodeCursor(Buffer.from("v2|0.5", "utf-8").toString("base64url")),
    ).toBeNull();
    expect(
      decodeCursor(Buffer.from("v2|", "utf-8").toString("base64url")),
    ).toBeNull();
  });

  it("returns null for a non-base64 string instead of throwing", () => {
    expect(decodeCursor("!!!not-base64!!!")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

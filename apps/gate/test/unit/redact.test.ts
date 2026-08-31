// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structural redaction of monitor events and log context.
 *
 * The guarantee under test is narrow and worth stating: sensitive-*named* keys
 * are masked, token claims are allowlisted, and payload size is bounded. It is
 * not "no PII can ever appear" — a column called `name` still comes through.
 * The tests are written to pin exactly that boundary so nobody later reads more
 * into it than it delivers.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CLAIM_ALLOWLIST,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_OPTIONS,
  REDACTED,
  redact,
  redactClaims,
  redactEventMeta,
  resolveRedactOptions,
  type RedactOptions,
} from "../../src/observability/redact.ts";

const opts = (over: Partial<RedactOptions> = {}): RedactOptions => ({
  ...DEFAULT_REDACT_OPTIONS,
  ...over,
});

describe("redact · key denylist", () => {
  test("masks credential-shaped keys at any depth", () => {
    const out = redact({
      user: "alice",
      password: "hunter2",
      nested: { api_key: "abc", deeper: { authorization: "Bearer x" } },
    }) as Record<string, unknown>;

    expect(out.user).toBe("alice");
    expect(out.password).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).api_key).toBe(REDACTED);
    expect(
      ((out.nested as Record<string, unknown>).deeper as Record<string, unknown>)
        .authorization,
    ).toBe(REDACTED);
  });

  test("matches on key substring, so casing and separators are covered", () => {
    const out = redact({
      apiKey: "a",
      API_KEY: "b",
      "x-api-key": "c",
      clientSecret: "d",
      refresh_token: "e",
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  test("does NOT mask an innocuous key that merely holds personal data", () => {
    // Documented limitation: this is the per-tool `redact` config's job.
    const out = redact({ debtor_name: "Alice Example" }) as Record<string, unknown>;
    expect(out.debtor_name).toBe("Alice Example");
  });

  test("masks the finance/identifier-shaped defaults", () => {
    for (const key of ["iban", "bic", "creditCard", "cvv", "taxId", "ssn", "pin_code"]) {
      const out = redact({ [key]: "x" }) as Record<string, unknown>;
      expect(out[key]).toBe(REDACTED);
    }
  });

  /**
   * Substring matching on a canonicalised key is powerful enough to be
   * dangerous: a fragment that is too short swallows unrelated fields and
   * quietly makes the monitor useless. These are the ones that bit during
   * development.
   */
  test("does not false-positive on ordinary words that contain a short fragment", () => {
    const out = redact({
      mapping: "a->b",
      shipping: "DHL",
      typing: "strict",
      publicUrl: "https://example.test",
    }) as Record<string, unknown>;
    expect(out.mapping).toBe("a->b");
    expect(out.shipping).toBe("DHL");
    expect(out.typing).toBe("strict");
    expect(out.publicUrl).toBe("https://example.test");
  });
});

describe("redact · size bounds", () => {
  test("truncates a long string and reports how much was cut", () => {
    const out = redact({ content: "x".repeat(50) }, opts({ maxStringLength: 10 })) as Record<
      string,
      unknown
    >;
    expect(out.content).toBe(`${"x".repeat(10)}…[+40 chars]`);
  });

  test("leaves a string at exactly the limit untouched", () => {
    const out = redact({ c: "abcde" }, opts({ maxStringLength: 5 })) as Record<string, unknown>;
    expect(out.c).toBe("abcde");
  });

  test("maxStringLength 0 disables truncation", () => {
    const long = "y".repeat(5000);
    const out = redact({ c: long }, opts({ maxStringLength: 0 })) as Record<string, unknown>;
    expect(out.c).toBe(long);
  });

  test("caps array length and appends a remainder marker", () => {
    const out = redact(
      { rows: [1, 2, 3, 4, 5] },
      opts({ maxArrayLength: 2 }),
    ) as Record<string, unknown>;
    expect(out.rows).toEqual([1, 2, "[+3 more]"]);
  });

  test("collapses beyond the depth limit instead of recursing", () => {
    const deep = { a: { b: { c: { d: { e: "leaf" } } } } };
    const out = redact(deep, opts({ maxDepth: 3 })) as Record<string, unknown>;
    const a = out.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    expect(b.c).toBe("[depth limit]");
  });

  test("survives a circular structure", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    const out = redact(node) as Record<string, unknown>;
    expect(out.name).toBe("root");
    expect(out.self).toBe("[circular]");
  });

  test("survives a circular array", () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    const out = redact({ arr }) as Record<string, unknown>;
    expect((out.arr as unknown[])[1]).toBe("[circular]");
  });
});

describe("redact · value kinds", () => {
  test("passes primitives through and normalises exotic ones", () => {
    const out = redact({
      n: 42,
      b: true,
      nil: null,
      big: 10n,
      fn: () => 1,
      date: new Date("2026-01-02T03:04:05.000Z"),
      buf: Buffer.from("abcd"),
      err: new Error("boom"),
    }) as Record<string, unknown>;

    expect(out.n).toBe(42);
    expect(out.b).toBe(true);
    expect(out.nil).toBeNull();
    expect(out.big).toBe("10");
    expect(out.fn).toBe("[function]");
    expect(out.date).toBe("2026-01-02T03:04:05.000Z");
    expect(out.buf).toBe("[buffer 4 bytes]");
    expect(out.err).toEqual({ name: "Error", message: "boom" });
  });

  test("disabled redaction returns the input unchanged", () => {
    const input = { password: "hunter2" };
    expect(redact(input, opts({ enabled: false }))).toBe(input);
  });
});

describe("redactClaims · allowlist", () => {
  test("keeps allowlisted claims and drops the rest with a count", () => {
    const out = redactClaims({
      sub: "user-1",
      preferred_username: "alice",
      scope: "read write",
      email: "alice@example.com",
      phone_number: "+49 30 1234",
      address: { street: "Musterweg 1" },
    }) as Record<string, unknown>;

    expect(out.sub).toBe("user-1");
    expect(out.preferred_username).toBe("alice");
    expect(out.scope).toBe("read write");
    expect(out.email).toBeUndefined();
    expect(out.phone_number).toBeUndefined();
    expect(out.address).toBeUndefined();
    expect(out._redactedClaims).toBe(3);
  });

  test("omits the counter when nothing was dropped", () => {
    const out = redactClaims({ sub: "u", iat: 1 }) as Record<string, unknown>;
    expect(out._redactedClaims).toBeUndefined();
  });

  test("allowlist matching is case-insensitive", () => {
    const out = redactClaims({ SUB: "u" }) as Record<string, unknown>;
    expect(out.SUB).toBe("u");
  });

  test("a custom allowlist replaces the default", () => {
    const out = redactClaims(
      { sub: "u", email: "a@b.c" },
      opts({ claimAllowlist: ["email"] }),
    ) as Record<string, unknown>;
    expect(out.email).toBe("a@b.c");
    expect(out.sub).toBeUndefined();
  });

  test("non-object claims fall back to generic redaction", () => {
    expect(redactClaims("plain")).toBe("plain");
    expect(redactClaims(null)).toBeNull();
    expect(redactClaims([1, 2])).toEqual([1, 2]);
  });

  test("the default allowlist carries identity but not contact details", () => {
    expect(DEFAULT_CLAIM_ALLOWLIST).toContain("sub");
    expect(DEFAULT_CLAIM_ALLOWLIST).toContain("scope");
    expect(DEFAULT_CLAIM_ALLOWLIST).not.toContain("email");
    expect(DEFAULT_CLAIM_ALLOWLIST).not.toContain("name");
  });
});

describe("redactEventMeta", () => {
  test("allowlists claims but denylists everything else", () => {
    const out = redactEventMeta({
      claims: { sub: "u", email: "a@b.c" },
      arguments: { customer: "Alice", token: "secret" },
      rowCount: 3,
    }) as Record<string, unknown>;

    expect((out.claims as Record<string, unknown>).sub).toBe("u");
    expect((out.claims as Record<string, unknown>).email).toBeUndefined();
    expect((out.arguments as Record<string, unknown>).customer).toBe("Alice");
    expect((out.arguments as Record<string, unknown>).token).toBe(REDACTED);
    expect(out.rowCount).toBe(3);
  });

  test("masks a sensitively-named top-level meta key", () => {
    const out = redactEventMeta({ access_token: "abc" }) as Record<string, unknown>;
    expect(out.access_token).toBe(REDACTED);
  });

  test("undefined meta stays undefined", () => {
    expect(redactEventMeta(undefined)).toBeUndefined();
  });

  test("disabled redaction returns the same reference", () => {
    const meta = { claims: { email: "a@b.c" } };
    expect(redactEventMeta(meta, opts({ enabled: false }))).toBe(meta);
  });
});

describe("resolveRedactOptions", () => {
  test("extraKeys EXTENDS the built-in denylist", () => {
    const resolved = resolveRedactOptions({
      enabled: true,
      extraKeys: ["schuldner_name"],
      maxStringLength: 100,
      maxArrayLength: 10,
      maxDepth: 5,
    });
    expect(resolved.keys).toContain("schuldner_name");
    for (const k of DEFAULT_REDACT_KEYS) expect(resolved.keys).toContain(k);
  });

  test("keys REPLACES the built-in denylist", () => {
    const resolved = resolveRedactOptions({
      enabled: true,
      extraKeys: [],
      keys: ["only_this"],
      maxStringLength: 100,
      maxArrayLength: 10,
      maxDepth: 5,
    });
    expect(resolved.keys).toEqual(["only_this"]);
    expect(resolved.keys).not.toContain("password");
  });

  test("lower-cases and de-duplicates the merged list", () => {
    const resolved = resolveRedactOptions({
      enabled: true,
      extraKeys: ["PASSWORD", "Custom", "custom"],
      maxStringLength: 1,
      maxArrayLength: 1,
      maxDepth: 1,
    });
    expect(resolved.keys.filter((k) => k === "password")).toHaveLength(1);
    expect(resolved.keys.filter((k) => k === "custom")).toHaveLength(1);
  });

  test("falls back to the default claim allowlist when unset", () => {
    const resolved = resolveRedactOptions({
      enabled: true,
      extraKeys: [],
      maxStringLength: 1,
      maxArrayLength: 1,
      maxDepth: 1,
    });
    expect(resolved.claimAllowlist).toEqual(DEFAULT_CLAIM_ALLOWLIST);
  });
});

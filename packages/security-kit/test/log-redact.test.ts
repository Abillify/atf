// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  LOG_REDACTED,
  hashIdentifier,
  isSensitiveLogKey,
  redactLogFields,
  redactLogString,
} from "../src/log-redact.ts";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEiLCJyb2xlIjoiYWRtaW4ifQ.c2lnbmF0dXJlX2J5dGVz";

describe("isSensitiveLogKey", () => {
  test("credential names in every spelling", () => {
    for (const key of ["password", "client_secret", "apiKey", "x-api-key", "Authorization", "access_token", "refreshToken", "id_token", "token", "jwt", "Cookie", "iban"]) {
      expect({ key, sensitive: isSensitiveLogKey(key) }).toEqual({ key, sensitive: true });
    }
  });

  test("token counters and ordinary fields stay", () => {
    for (const key of ["prompt_tokens", "completion_tokens", "max_tokens", "tokenCount", "mapping", "shipping", "flowId", "keyCount"]) {
      expect({ key, sensitive: isSensitiveLogKey(key) }).toEqual({ key, sensitive: false });
    }
  });
});

describe("redactLogFields", () => {
  test("replaces credential fields at any depth and keeps the rest", () => {
    const out = redactLogFields({
      flowId: "helpdesk",
      prompt_tokens: 12,
      headers: { authorization: "Bearer abc", accept: "json" },
      nested: [{ client_secret: "s3cr3t", ok: true }],
    });
    expect(out).toEqual({
      flowId: "helpdesk",
      prompt_tokens: 12,
      headers: { authorization: LOG_REDACTED, accept: "json" },
      nested: [{ client_secret: LOG_REDACTED, ok: true }],
    });
  });

  test("scrubs credential-shaped values in innocuously named fields and errors", () => {
    const out = redactLogFields({
      error: `upstream said: invalid ${JWT}`,
      detail: "sent Authorization: Bearer abcdefghijklmnop",
      key: "aip-0123456789abcdef0123",
      err: new Error(`token ${JWT} expired`),
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(out.detail).toBe(`sent Authorization: Bearer ${LOG_REDACTED}`);
    expect(out.key).toBe(LOG_REDACTED);
    expect((out.err as { message: string }).message).toBe(`token ${LOG_REDACTED} expired`);
  });

  test("bounds long strings and survives cycles", () => {
    const cyclic: Record<string, unknown> = { a: "x".repeat(10_000) };
    cyclic.self = cyclic;
    const out = redactLogFields(cyclic) as Record<string, unknown>;
    expect((out.a as string).length).toBeLessThan(4200);
    expect(out.self).toBe("[circular]");
  });

  test("redactLogString leaves ordinary text alone", () => {
    expect(redactLogString("Flow helpdesk finished in 120 ms")).toBe("Flow helpdesk finished in 120 ms");
  });
});
describe("hashIdentifier", () => {
  test("12 hex chars, stable across case and whitespace, differs per identifier", () => {
    const h = hashIdentifier("Alice@Example.test");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(hashIdentifier("  alice@example.test ")).toBe(h);
    expect(hashIdentifier("bob@example.test")).not.toBe(h);
    expect(h).not.toContain("alice");
  });
  test("missing or blank input yields undefined", () => {
    expect(hashIdentifier(undefined)).toBeUndefined();
    expect(hashIdentifier(null)).toBeUndefined();
    expect(hashIdentifier("   ")).toBeUndefined();
  });
  test("email stays a plain log key (hashing happens at the call site)", () => {
    expect(isSensitiveLogKey("email")).toBe(false);
    expect(redactLogFields({ email: "a@b.test" })).toEqual({ email: "a@b.test" });
  });
});

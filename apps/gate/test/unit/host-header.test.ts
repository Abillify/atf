// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Host-header parsing (Req 6.12): IPv6 literals must parse correctly and an
 * empty Host header must be rejected — the two defects the old inline
 * middleware had (`"[::1]:3000".split(":")[0]` → `"["`, and a falsy empty host
 * bypassing the allow-list entirely).
 */

import { describe, expect, test } from "bun:test";
import { parseHostHostname } from "../../src/server/host-header.ts";

describe("parseHostHostname (Req 6.12)", () => {
  test("parses a plain hostname", () => {
    expect(parseHostHostname("example.com")).toBe("example.com");
  });

  test("strips the port", () => {
    expect(parseHostHostname("example.com:8080")).toBe("example.com");
  });

  test("lowercases", () => {
    expect(parseHostHostname("Example.COM")).toBe("example.com");
  });

  test("parses a bracketed IPv6 literal with port", () => {
    // The old split(":")[0] returned "[" here — never matchable.
    expect(parseHostHostname("[::1]:3000")).toBe("::1");
  });

  test("parses a bracketed IPv6 literal without port", () => {
    expect(parseHostHostname("[::1]")).toBe("::1");
  });

  test("parses a full bracketed IPv6 address", () => {
    expect(parseHostHostname("[2001:db8::ff00:42:8329]:443")).toBe(
      "2001:db8::ff00:42:8329",
    );
  });

  test("rejects a malformed bracketed literal", () => {
    expect(parseHostHostname("[::1")).toBeUndefined();
  });

  test("empty, whitespace-only, and missing are undefined", () => {
    expect(parseHostHostname("")).toBeUndefined();
    expect(parseHostHostname("   ")).toBeUndefined();
    expect(parseHostHostname(undefined)).toBeUndefined();
    expect(parseHostHostname(":")).toBeUndefined();
  });
});

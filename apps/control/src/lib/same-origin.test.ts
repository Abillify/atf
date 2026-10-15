// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { afterEach, describe, expect, test, vi } from "vitest";
import { hasJsonContentType, isSameOriginRequest } from "./same-origin";

function req(headers: Record<string, string>, url = "https://control.local/x"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("isSameOriginRequest", () => {
  test("passes requests without browser provenance headers", () => {
    expect(isSameOriginRequest(req({}))).toBe(true);
  });
  test("passes same-origin and user-initiated fetch sites", () => {
    expect(isSameOriginRequest(req({ "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(isSameOriginRequest(req({ "Sec-Fetch-Site": "none" }))).toBe(true);
  });
  test("rejects cross-site and same-site fetch sites", () => {
    expect(isSameOriginRequest(req({ "Sec-Fetch-Site": "cross-site" }))).toBe(false);
    expect(isSameOriginRequest(req({ "Sec-Fetch-Site": "same-site" }))).toBe(false);
  });
  test("compares Origin with the request host", () => {
    expect(isSameOriginRequest(req({ Origin: "https://control.local" }))).toBe(true);
    expect(isSameOriginRequest(req({ Origin: "https://attacker.example" }))).toBe(false);
    expect(isSameOriginRequest(req({ Origin: "null" }))).toBe(false);
  });
  test("accepts the public host from x-forwarded-host behind a proxy", () => {
    expect(
      isSameOriginRequest(
        req(
          { Origin: "https://ops.example", "X-Forwarded-Host": "ops.example" },
          "http://control:3000/x",
        ),
      ),
    ).toBe(true);
  });
});

describe("isSameOriginRequest with CONTROL_PUBLIC_ORIGIN", () => {
  afterEach(() => vi.unstubAllEnvs());
  test("accepts only the pinned host", () => {
    vi.stubEnv("CONTROL_PUBLIC_ORIGIN", "https://ops.example");
    expect(isSameOriginRequest(req({ Origin: "https://ops.example" }, "http://control:3000/x"))).toBe(true);
    expect(isSameOriginRequest(req({ Origin: "https://attacker.example" }, "http://control:3000/x"))).toBe(false);
  });
  test("ignores a client-supplied X-Forwarded-Host and Host", () => {
    vi.stubEnv("CONTROL_PUBLIC_ORIGIN", "https://ops.example");
    expect(
      isSameOriginRequest(
        req(
          { Origin: "https://attacker.example", "X-Forwarded-Host": "attacker.example", Host: "attacker.example" },
          "https://attacker.example/x",
        ),
      ),
    ).toBe(false);
  });
  test("still rejects cross-site fetch metadata", () => {
    vi.stubEnv("CONTROL_PUBLIC_ORIGIN", "https://ops.example");
    expect(isSameOriginRequest(req({ "Sec-Fetch-Site": "cross-site", Origin: "https://ops.example" }))).toBe(false);
  });
  test("an invalid value fails closed for requests with an Origin", () => {
    for (const bad of ["not a url", "ftp://ops.example", "javascript:alert(1)"]) {
      vi.stubEnv("CONTROL_PUBLIC_ORIGIN", bad);
      expect(isSameOriginRequest(req({ Origin: "https://control.local" }))).toBe(false);
    }
  });
  test("unset or blank keeps the legacy behaviour", () => {
    vi.stubEnv("CONTROL_PUBLIC_ORIGIN", "  ");
    expect(isSameOriginRequest(req({ Origin: "https://control.local" }))).toBe(true);
  });
});

describe("hasJsonContentType", () => {
  test("accepts application/json with parameters", () => {
    expect(hasJsonContentType(req({ "Content-Type": "application/json; charset=utf-8" }))).toBe(true);
  });
  test("rejects other or missing types", () => {
    expect(hasJsonContentType(req({ "Content-Type": "text/plain" }))).toBe(false);
    expect(hasJsonContentType(new Request("https://control.local/x"))).toBe(false);
  });
});

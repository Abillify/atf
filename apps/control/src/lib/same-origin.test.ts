// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { describe, expect, test } from "vitest";
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

describe("hasJsonContentType", () => {
  test("accepts application/json with parameters", () => {
    expect(hasJsonContentType(req({ "Content-Type": "application/json; charset=utf-8" }))).toBe(true);
  });
  test("rejects other or missing types", () => {
    expect(hasJsonContentType(req({ "Content-Type": "text/plain" }))).toBe(false);
    expect(hasJsonContentType(new Request("https://control.local/x"))).toBe(false);
  });
});

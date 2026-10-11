// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import {
  BFF_SESSION_COOKIE,
  backendOrigin,
  clearSessionCookieHeader,
  fetchBackendAuthConfig,
  readSessionCookie,
  requestIsSecure,
  resolveSession,
  sealTokenForCookie,
  sessionCookieHeader,
  __resetBackendConfigCache,
} from "./bff-session";
import { MIN_SESSION_SECRET_LENGTH } from "./session-crypto";

const SECRET = "s".repeat(MIN_SESSION_SECRET_LENGTH);

function makeJwt(payload: object): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

function requestWithCookie(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("cookie", `${BFF_SESSION_COOKIE}=${value}`);
  return new Request("http://control.local/api/backend/flows", { headers });
}

beforeEach(() => {
  process.env["CONTROL_SESSION_SECRET"] = SECRET;
  delete process.env["CONTROL_BACKEND_URL"];
  delete process.env["NEXT_PUBLIC_BACKEND_URL"];
  __resetBackendConfigCache();
});

afterEach(() => {
  delete process.env["CONTROL_SESSION_SECRET"];
  delete process.env["CONTROL_BACKEND_URL"];
  vi.unstubAllGlobals();
});

describe("backendOrigin", () => {
  test("prefers CONTROL_BACKEND_URL", () => {
    process.env["CONTROL_BACKEND_URL"] = "https://runtime.internal:8443/base";
    process.env["NEXT_PUBLIC_BACKEND_URL"] = "http://localhost:3000";
    expect(backendOrigin()).toBe("https://runtime.internal:8443");
  });

  test("falls back to NEXT_PUBLIC_BACKEND_URL", () => {
    process.env["NEXT_PUBLIC_BACKEND_URL"] = "http://127.0.0.1:4000";
    expect(backendOrigin()).toBe("http://127.0.0.1:4000");
  });

  test("falls back to the Runtime default port", () => {
    expect(backendOrigin()).toBe("http://127.0.0.1:3000");
  });

  test("rejects non-HTTP protocols and garbage", () => {
    process.env["CONTROL_BACKEND_URL"] = "file:///etc/passwd";
    expect(backendOrigin()).toBeNull();
    process.env["CONTROL_BACKEND_URL"] = "not a url";
    expect(backendOrigin()).toBeNull();
  });
});

describe("requestIsSecure", () => {
  test("trusts x-forwarded-proto", () => {
    const https = new Request("http://control.local/", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(requestIsSecure(https)).toBe(true);
    const http = new Request("https://control.local/", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(requestIsSecure(http)).toBe(false);
  });

  test("falls back to the request URL protocol", () => {
    expect(requestIsSecure(new Request("https://control.local/"))).toBe(true);
    expect(requestIsSecure(new Request("http://control.local/"))).toBe(false);
  });
});

describe("readSessionCookie", () => {
  test("extracts the session cookie among others", () => {
    const headers = new Headers({
      cookie: `other=1; ${BFF_SESSION_COOKIE}=abc.def.ghi; third=2`,
    });
    const request = new Request("http://control.local/", { headers });
    expect(readSessionCookie(request)).toBe("abc.def.ghi");
  });

  test("null when absent or empty", () => {
    expect(readSessionCookie(new Request("http://control.local/"))).toBeNull();
    const empty = new Request("http://control.local/", {
      headers: { cookie: "" },
    });
    expect(readSessionCookie(empty)).toBeNull();
  });
});

describe("sessionCookieHeader", () => {
  test("HttpOnly + SameSite=Strict always, Secure only on TLS", () => {
    const insecure = sessionCookieHeader("v1.a.b", false, null);
    expect(insecure).toContain(`${BFF_SESSION_COOKIE}=`);
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Strict");
    expect(insecure).toContain("Path=/");
    expect(insecure).not.toContain("Secure");
    // No token exp → capped at the 12 h upper bound.
    expect(insecure).toContain(`Max-Age=${12 * 60 * 60}`);

    const secure = sessionCookieHeader("v1.a.b", true, null);
    expect(secure).toContain("Secure");
  });

  test("Max-Age mirrors the token exp and is capped", () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    const header = sessionCookieHeader("v1.a.b", false, soon);
    const match = /Max-Age=(\d+)/.exec(header);
    const maxAge = Number(match?.[1] ?? Number.NaN);
    expect(Number.isNaN(maxAge)).toBe(false);
    // ~60 s remain, allowing for a second of clock drift in the assertion.
    expect(maxAge).toBeGreaterThanOrEqual(58);
    expect(maxAge).toBeLessThanOrEqual(60);
    // A far-future exp is capped at 12 h; a past exp floors at 1 s.
    expect(sessionCookieHeader("v1.a.b", false, 4_000_000_000)).toContain(
      `Max-Age=${12 * 60 * 60}`,
    );
    expect(sessionCookieHeader("v1.a.b", false, 1)).toContain("Max-Age=1");
  });
});

describe("clearSessionCookieHeader", () => {
  test("expires immediately with the same attributes", () => {
    const header = clearSessionCookieHeader(true);
    expect(header).toContain(`${BFF_SESSION_COOKIE}=`);
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
  });
});

describe("sealTokenForCookie / resolveSession", () => {
  test("round-trips a token through the sealed cookie", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwt({ role: "operator", exp });
    const sealed = await sealTokenForCookie(token);
    if (sealed === null) throw new Error("expected the token to seal");
    expect(sealed.role).toBe("operator");
    expect(sealed.expiresAt).toBe(exp);
    const session = await resolveSession(requestWithCookie(sealed.sealed));
    expect(session).toEqual({ token, role: "operator", expiresAt: exp });
  });

  test("resolveSession is null without a cookie", async () => {
    expect(await resolveSession(requestWithCookie(null))).toBeNull();
  });

  test("resolveSession is null for a tampered cookie", async () => {
    const sealed = await sealTokenForCookie(makeJwt({ role: "admin" }));
    if (sealed === null) throw new Error("expected the token to seal");
    const [version, iv, ct] = sealed.sealed.split(".");
    const bad = `${version}.${iv}.${(ct ?? "").slice(0, -2)}AA`;
    expect(await resolveSession(requestWithCookie(bad))).toBeNull();
  });

  test("resolveSession is null once the token expired", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const sealed = await sealTokenForCookie(makeJwt({ role: "admin", exp: past }));
    if (sealed === null) throw new Error("expected the token to seal");
    expect(await resolveSession(requestWithCookie(sealed.sealed))).toBeNull();
  });

  test("fails closed when CONTROL_SESSION_SECRET is unusable", async () => {
    process.env["CONTROL_SESSION_SECRET"] = "too-short";
    __resetBackendConfigCache();
    expect(await sealTokenForCookie(makeJwt({ role: "admin" }))).toBeNull();
    expect(await resolveSession(requestWithCookie("v1.a.b"))).toBeNull();
  });
});

describe("fetchBackendAuthConfig", () => {
  test("reads enabled/required/issuerHost from the Runtime", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({
        enabled: true,
        required: false,
        issuerHost: "id.example.com",
      }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const config = await fetchBackendAuthConfig();
    expect(config).toEqual({
      enabled: true,
      required: false,
      issuerHost: "id.example.com",
    });
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/monitoring/auth/config",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  test("caches for subsequent calls", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ enabled: false, required: true }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    await fetchBackendAuthConfig();
    await fetchBackendAuthConfig();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("fail-closed defaults on failure", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    expect(await fetchBackendAuthConfig()).toEqual({
      enabled: false,
      required: true,
      issuerHost: null,
    });
  });

  test("missing required field stays fail-closed", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ enabled: true }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const config = await fetchBackendAuthConfig();
    expect(config.required).toBe(true);
  });
});

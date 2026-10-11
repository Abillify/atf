// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { DELETE, GET, POST } from "./route";
import {
  BFF_SESSION_COOKIE,
  __resetBackendConfigCache,
  sealTokenForCookie,
} from "../../../lib/bff-session";
import { MIN_SESSION_SECRET_LENGTH } from "../../../lib/session-crypto";

const SECRET = "k".repeat(MIN_SESSION_SECRET_LENGTH);
const JSON_HEADERS = { "Content-Type": "application/json" };

function makeJwt(payload: object): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

beforeEach(() => {
  vi.stubEnv("CONTROL_SESSION_MODE", "bff");
  vi.stubEnv("CONTROL_SESSION_SECRET", SECRET);
  delete process.env["CONTROL_BACKEND_URL"];
  __resetBackendConfigCache();
  // Default: the backend config probe answers with a disabled-auth Runtime.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ enabled: false, required: true })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetBackendConfigCache();
});

describe("GET /api/session", () => {
  test("404 outside bff mode", async () => {
    vi.stubEnv("CONTROL_SESSION_MODE", "token");
    const res = await GET(new Request("http://control.local/api/session"));
    expect(res.status).toBe(404);
  });

  test("reports an unauthenticated session with config", async () => {
    const res = await GET(new Request("http://control.local/api/session"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      mode: "bff",
      authenticated: false,
      role: null,
      config: { enabled: false, required: true, issuerHost: null },
    });
  });

  test("reports the sealed session's role", async () => {
    const sealed = await sealTokenForCookie(makeJwt({ role: "admin" }));
    if (sealed === null) throw new Error("expected the token to seal");
    const request = new Request("http://control.local/api/session", {
      headers: { cookie: `${BFF_SESSION_COOKIE}=${sealed.sealed}` },
    });
    const data = await (await GET(request)).json();
    expect(data.authenticated).toBe(true);
    expect(data.role).toBe("admin");
  });
});

describe("POST /api/session", () => {
  test("404 outside bff mode", async () => {
    vi.stubEnv("CONTROL_SESSION_MODE", "token");
    const res = await POST(
      new Request("http://control.local/api/session", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: "t" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("rejects invalid bodies", async () => {
    const bad = await POST(
      new Request("http://control.local/api/session", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "not json",
      }),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_json");

    const missing = await POST(
      new Request("http://control.local/api/session", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      }),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe("token_required");
  });

  test("503 when the session secret is unconfigured (fail closed)", async () => {
    vi.stubEnv("CONTROL_SESSION_SECRET", "too-short");
    __resetBackendConfigCache();
    const res = await POST(
      new Request("http://control.local/api/session", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: makeJwt({ role: "admin" }) }),
      }),
    );
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("session_secret_unconfigured");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("seals the token into an HttpOnly cookie and never returns it", async () => {
    const token = makeJwt({ role: "operator", exp: 4_000_000_000 });
    const res = await POST(
      new Request("https://control.local/api/session", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token }),
      }),
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.role).toBe("operator");
    // Req 8.7: the token itself must not appear in the response body.
    expect(JSON.stringify(data)).not.toContain(token);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${BFF_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain(token);
  });
});

describe("POST /api/session cross-site guard", () => {
  test("rejects a cross-site Sec-Fetch-Site (login CSRF)", async () => {
    const res = await POST(
      new Request("https://control.local/api/session", {
        method: "POST",
        headers: { ...JSON_HEADERS, "Sec-Fetch-Site": "cross-site" },
        body: JSON.stringify({ token: makeJwt({ role: "admin" }) }),
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  test("rejects a foreign Origin", async () => {
    const res = await POST(
      new Request("https://control.local/api/session", {
        method: "POST",
        headers: { ...JSON_HEADERS, Origin: "https://attacker.example" },
        body: JSON.stringify({ token: makeJwt({ role: "admin" }) }),
      }),
    );
    expect(res.status).toBe(403);
  });
  test("accepts a same-origin browser request", async () => {
    const res = await POST(
      new Request("https://control.local/api/session", {
        method: "POST",
        headers: {
          ...JSON_HEADERS,
          Origin: "https://control.local",
          "Sec-Fetch-Site": "same-origin",
        },
        body: JSON.stringify({ token: makeJwt({ role: "admin" }) }),
      }),
    );
    expect(res.status).toBe(200);
  });
  test("415 without a JSON content type", async () => {
    const res = await POST(
      new Request("https://control.local/api/session", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ token: makeJwt({ role: "admin" }) }),
      }),
    );
    expect(res.status).toBe(415);
  });
});
describe("DELETE /api/session", () => {
  test("rejects a cross-site request", async () => {
    const res = await DELETE(
      new Request("https://control.local/api/session", {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "cross-site" },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  test("clears the cookie", async () => {
    const sealed = await sealTokenForCookie(makeJwt({ role: "admin" }));
    if (sealed === null) throw new Error("expected the token to seal");
    const res = await DELETE(
      new Request("https://control.local/api/session", {
        headers: { cookie: `${BFF_SESSION_COOKIE}=${sealed.sealed}` },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).cleared).toBe(true);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${BFF_SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});

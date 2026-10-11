// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { GET, POST } from "./route";
import {
  BFF_SESSION_COOKIE,
  __resetBackendConfigCache,
  sealTokenForCookie,
} from "../../../../lib/bff-session";
import { MIN_SESSION_SECRET_LENGTH } from "../../../../lib/session-crypto";

const SECRET = "p".repeat(MIN_SESSION_SECRET_LENGTH);

function makeJwt(payload: object): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

type Params = { params: Promise<{ path: string[] }> };

function paramsFor(...path: string[]): Params {
  return { params: Promise.resolve({ path }) };
}

async function cookieHeader(): Promise<string> {
  const sealed = await sealTokenForCookie(
    makeJwt({ role: "operator", exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  if (sealed === null) throw new Error("expected the token to seal");
  return `${BFF_SESSION_COOKIE}=${sealed.sealed}`;
}

beforeEach(() => {
  vi.stubEnv("CONTROL_SESSION_MODE", "bff");
  vi.stubEnv("CONTROL_SESSION_SECRET", SECRET);
  vi.stubEnv("CONTROL_BACKEND_URL", "http://runtime.test:3000");
  __resetBackendConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetBackendConfigCache();
});

describe("backend proxy — mode gating", () => {
  test("404 outside bff mode", async () => {
    vi.stubEnv("CONTROL_SESSION_MODE", "token");
    const res = await GET(
      new Request("http://control.local/api/backend/flows"),
      paramsFor("flows"),
    );
    expect(res.status).toBe(404);
  });
});

describe("backend proxy — allowlist & session", () => {
  test("401 without a session cookie", async () => {
    const res = await GET(
      new Request("http://control.local/api/backend/flows"),
      paramsFor("flows"),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthenticated");
  });

  test("404 for paths outside the allowlist — backend never contacted", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const res = await GET(
      new Request("http://control.local/api/backend/health", {
        headers: { cookie: await cookieHeader() },
      }),
      paramsFor("health"),
    );
    expect(res.status).toBe(404);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("404 for OIDC dance paths", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const res = await GET(
      new Request("http://control.local/api/backend/monitoring/auth/login", {
        headers: { cookie: await cookieHeader() },
      }),
      paramsFor("monitoring", "auth", "login"),
    );
    expect(res.status).toBe(404);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("backend proxy — path consistency", () => {
  async function forwardedUrl(...path: string[]): Promise<string | null> {
    const fetchFn = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchFn);
    const res = await GET(
      new Request("http://control.local/api/backend/x", {
        headers: { cookie: await cookieHeader() },
      }),
      paramsFor(...path),
    );
    if (res.status === 404) {
      expect(fetchFn).not.toHaveBeenCalled();
      return null;
    }
    const call = fetchFn.mock.calls[0] as unknown as [string] | undefined;
    return call?.[0] ?? null;
  }
  test("encoded dot segments are resolved before the allowlist check", async () => {
    expect(await forwardedUrl("flows", "%2e%2e", "health")).toBeNull();
    expect(await forwardedUrl("flows", "..", "health")).toBeNull();
  });
  test("forwards the normalised path that was validated", async () => {
    expect(await forwardedUrl("flows", "%2e%2e", "admin", "tenants")).toBe(
      "http://runtime.test:3000/admin/tenants",
    );
  });
  test("encoded slashes and backslashes stay inside their segment", async () => {
    expect(await forwardedUrl("flows", "crm%2Fcancel_booking")).toBe(
      "http://runtime.test:3000/flows/crm%2Fcancel_booking",
    );
    expect(await forwardedUrl("flows", "a\\..\\..\\health")).toBe(
      "http://runtime.test:3000/flows/a%5C..%5C..%5Chealth",
    );
  });
});
describe("backend proxy — forwarding", () => {
  test("injects the session bearer token and forwards the allowlisted path", async () => {
    const token = makeJwt({ role: "operator", exp: 4_000_000_000 });
    const sealed = await sealTokenForCookie(token);
    if (sealed === null) throw new Error("expected the token to seal");
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        Response.json({ ok: true }, { status: 201 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const res = await GET(
      new Request("http://control.local/api/backend/flows/abc?limit=10", {
        headers: {
          cookie: `${BFF_SESSION_COOKIE}=${sealed.sealed}`,
          accept: "application/json",
        },
      }),
      paramsFor("flows", "abc"),
    );
    expect(res.status).toBe(201);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = (
      fetchFn as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0];
    if (call === undefined) throw new Error("expected the backend fetch call");
    const [url, init] = call;
    expect(url).toBe("http://runtime.test:3000/flows/abc?limit=10");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("accept")).toBe("application/json");
  });

  test("strips hop-by-hop response headers, including backend Set-Cookie", async () => {
    const sealedCookie = await cookieHeader();
    const fetchFn = vi.fn(
      async () =>
        new Response("body", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "set-cookie": "runtime_session=leak; Path=/",
            connection: "keep-alive",
            "x-request-id": "rid-1",
          },
        }),
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const res = await GET(
      new Request("http://control.local/api/backend/monitoring/state", {
        headers: { cookie: sealedCookie },
      }),
      paramsFor("monitoring", "state"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("x-request-id")).toBe("rid-1");
    // The Runtime's own cookies must never be relayed to the browser (Req 8.7).
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("connection")).toBeNull();
  });

  test("502 when the backend is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    const res = await GET(
      new Request("http://control.local/api/backend/flows", {
        headers: { cookie: await cookieHeader() },
      }),
      paramsFor("flows"),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("backend_unreachable");
  });

  test("POST forwards the request body", async () => {
    let seenBody = "";
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        // The proxy forwards a streaming body (duplex: "half") — read it back.
        seenBody = await new Response(init?.body as BodyInit).text();
        return Response.json({ ok: true });
      },
    ) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchFn);
    const res = await POST(
      new Request("http://control.local/api/backend/flows/f1/run", {
        method: "POST",
        headers: {
          cookie: await cookieHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hi" }),
      }),
      paramsFor("flows", "f1", "run"),
    );
    expect(res.status).toBe(200);
    expect(seenBody).toContain("hi");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auth middleware tests for vectorsearch-api
 *
 * Validates: Requirements 2.1–2.8, 13.4
 */

import * as fc from "fast-check";
import type { JwtVerifier } from "../src/jwt-verifier.js";
import {
  createAuthMiddleware,
  createWebAuthMiddleware,
  createLoginHandler,
} from "../src/auth.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Minimal Express-shaped stand-ins: the middleware only touches the fields
// below, so the mocks are cast at the call sites instead of modelling the
// full Request/Response interfaces.
function mockReq(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {},
) {
  // biome-ignore lint/suspicious/noExplicitAny: minimal Express req stand-in
  return { headers, body } as any;
}

function mockRes() {
  // biome-ignore lint/suspicious/noExplicitAny: minimal Express res stand-in
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as unknown,
    redirectUrl: null as string | null,
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: unknown) => {
    res.body = data;
    return res;
  };
  res.send = (data: unknown) => {
    res.body = data;
    return res;
  };
  res.type = (_t: string) => res;
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value;
    return res;
  };
  res.redirect = (url: string) => {
    res.redirectUrl = url;
    return res;
  };
  return res;
}

// ---------------------------------------------------------------------------
// createAuthMiddleware (Bearer token for API endpoints)
// ---------------------------------------------------------------------------

describe("createAuthMiddleware", () => {
  const CONFIGURED_TOKEN = "secret-api-token";

  it("calls next() when a valid Bearer token is provided", () => {
    const middleware = createAuthMiddleware(CONFIGURED_TOKEN);
    const req = mockReq({ authorization: `Bearer ${CONFIGURED_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });

  it('returns HTTP 401 {"error":"Unauthorized"} when Authorization header is missing', () => {
    const middleware = createAuthMiddleware(CONFIGURED_TOKEN);
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it('returns HTTP 401 {"error":"Unauthorized"} when the token is wrong', () => {
    const middleware = createAuthMiddleware(CONFIGURED_TOKEN);
    const req = mockReq({ authorization: "Bearer wrong-token" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it.each([
    `session_token=${CONFIGURED_TOKEN}`,
    "oidc_session=browser-session",
  ])("does not accept browser cookie %s as API authentication", (cookie) => {
    const oidc = {
      loginPath: "/auth/login",
      verifySession: vi.fn(async () => ({ sub: "browser-user" })),
    };
    const middleware = createAuthMiddleware(
      CONFIGURED_TOKEN,
      oidc,
      CONFIGURED_TOKEN,
      null,
      undefined,
      { mode: "token" },
    );
    const req = mockReq({ cookie });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(oidc.verifySession).not.toHaveBeenCalled();
  });

  it("does not accept the static API token in OIDC-only mode", async () => {
    const verifier: JwtVerifier = {
      verify: vi.fn(async () => null),
    };
    const middleware = createAuthMiddleware(
      CONFIGURED_TOKEN,
      undefined,
      null,
      verifier,
      undefined,
      { mode: "oidc" },
    );
    const req = mockReq({ authorization: `Bearer ${CONFIGURED_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    await vi.waitFor(() => expect(res.statusCode).toBe(401));
    expect(next).not.toHaveBeenCalled();
    expect(verifier.verify).toHaveBeenCalledWith(CONFIGURED_TOKEN);
  });

  it("calls next() regardless of header when auth is disabled (apiToken = null)", () => {
    const middleware = createAuthMiddleware(null);
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("calls next() even with a wrong token when auth is disabled (apiToken = null)", () => {
    const middleware = createAuthMiddleware(null);
    const req = mockReq({ authorization: "Bearer anything" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Token rotation (Req 11.8): API_TOKEN_NEXT keeps both tokens valid
// ---------------------------------------------------------------------------

describe("createAuthMiddleware token rotation (Req 11.8)", () => {
  const OLD_TOKEN = "rotation-old-token-0123456789abcdef";
  const NEXT_TOKEN = "rotation-next-token-0123456789abcdef0";

  const withNext = () =>
    createAuthMiddleware(OLD_TOKEN, undefined, null, null, undefined, {
      apiTokenNext: NEXT_TOKEN,
    });

  it("accepts the primary token while a rotation token is set", () => {
    const middleware = withNext();
    const req = mockReq({ authorization: `Bearer ${OLD_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts the rotation token alongside the primary token", () => {
    const middleware = withNext();
    const req = mockReq({ authorization: `Bearer ${NEXT_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects tokens that match neither the primary nor the rotation token", () => {
    const middleware = withNext();
    const req = mockReq({ authorization: "Bearer not-a-configured-token" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("enforces auth when only the rotation token is configured (no API_TOKEN)", () => {
    const middleware = createAuthMiddleware(null, undefined, null, null, undefined, {
      apiTokenNext: NEXT_TOKEN,
    });
    const okReq = mockReq({ authorization: `Bearer ${NEXT_TOKEN}` });
    const okRes = mockRes();
    const okNext = vi.fn();
    middleware(okReq, okRes, okNext);
    expect(okNext).toHaveBeenCalledOnce();

    const oldReq = mockReq({ authorization: `Bearer ${OLD_TOKEN}` });
    const oldRes = mockRes();
    const oldNext = vi.fn();
    middleware(oldReq, oldRes, oldNext);
    expect(oldNext).not.toHaveBeenCalled();
    expect(oldRes.statusCode).toBe(401);
  });

  it("ignores an empty rotation token (single-token setups unchanged)", () => {
    const middleware = createAuthMiddleware(OLD_TOKEN, undefined, null, null, undefined, {
      apiTokenNext: "",
    });
    const req = mockReq({ authorization: `Bearer ${OLD_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createWebAuthMiddleware (session_token cookie for web UI)
// ---------------------------------------------------------------------------

describe("createWebAuthMiddleware", () => {
  const CONFIGURED_TOKEN = "web-secret-token";

  it("calls next() when a valid session_token cookie is present", () => {
    const middleware = createWebAuthMiddleware(CONFIGURED_TOKEN);
    const req = mockReq({ cookie: `session_token=${CONFIGURED_TOKEN}` });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("serves login page HTML (HTTP 200) when cookie is missing", () => {
    const middleware = createWebAuthMiddleware(CONFIGURED_TOKEN);
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe("string");
    expect((res.body as string).toLowerCase()).toContain("<!doctype html");
  });

  it("serves login page HTML (HTTP 200) when cookie has wrong token", () => {
    const middleware = createWebAuthMiddleware(CONFIGURED_TOKEN);
    const req = mockReq({ cookie: "session_token=wrong-token" });
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe("string");
    expect((res.body as string).toLowerCase()).toContain("<!doctype html");
  });

  it("calls next() regardless of cookie when auth is disabled (apiToken = null)", () => {
    const middleware = createWebAuthMiddleware(null);
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// createLoginHandler (POST /login)
// ---------------------------------------------------------------------------

describe("createLoginHandler", () => {
  const CONFIGURED_TOKEN = "login-secret-token";

  it("sets only an HttpOnly session_token cookie and redirects to / when token is valid", () => {
    const handler = createLoginHandler(CONFIGURED_TOKEN);
    const req = mockReq({}, { token: CONFIGURED_TOKEN });
    const res = mockRes();
    const next = vi.fn();

    handler(req, res, next);

    expect(res.redirectUrl).toBe("/");
    const cookies: string[] = res.headers["Set-Cookie"];
    const sessionCookie = cookies.find((c: string) =>
      c.startsWith("session_token="),
    );
    // api_token cookie removed — API middleware now accepts the HttpOnly session cookie directly
    const apiCookie = cookies.find((c: string) => c.startsWith("api_token="));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(apiCookie).toBeUndefined();
  });

  it("re-renders login page with error when token is invalid", () => {
    const handler = createLoginHandler(CONFIGURED_TOKEN);
    const req = mockReq({}, { token: "wrong-token" });
    const res = mockRes();
    const next = vi.fn();

    handler(req, res, next);

    expect(res.redirectUrl).toBeNull();
    expect(typeof res.body).toBe("string");
    expect((res.body as string).toLowerCase()).toContain("<!doctype html");
    // Should contain an error indication
    expect(res.body as string).toContain("Invalid token");
  });

  it("redirects to / immediately when auth is disabled (apiToken = null)", () => {
    const handler = createLoginHandler(null);
    const req = mockReq({}, { token: "anything" });
    const res = mockRes();
    const next = vi.fn();

    handler(req, res, next);

    expect(res.redirectUrl).toBe("/");
    // No cookie should be set when auth is disabled
    expect(res.headers["Set-Cookie"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 6: Auth Middleware Accepts Exactly the Configured Token
// **Validates: Requirements 2.1, 2.2**
// ---------------------------------------------------------------------------

describe("Property 6: Auth Middleware Accepts Exactly the Configured Token", () => {
  /**
   * For any string value used as a Bearer token in the Authorization header,
   * the auth middleware should accept the request if and only if the token
   * exactly matches the configured API_TOKEN.
   *
   * Tag: 'Feature: vectorsearch-api, Property 6: Auth Middleware Accepts Exactly the Configured Token'
   */
  it("accepts a request if and only if the Bearer token exactly matches the configured token", () => {
    fc.assert(
      fc.property(
        // The configured API token (non-empty to avoid edge cases with empty tokens)
        fc.string({ minLength: 1 }),
        // The token sent in the request
        fc.string(),
        (configuredToken, requestToken) => {
          const middleware = createAuthMiddleware(configuredToken);
          const req = mockReq({ authorization: `Bearer ${requestToken}` });
          const res = mockRes();
          const next = vi.fn();

          middleware(req, res, next);

          const tokensMatch = requestToken === configuredToken;

          if (tokensMatch) {
            // Should call next() and not return 401
            return (next as ReturnType<typeof vi.fn>).mock.calls.length === 1;
          } else {
            // Should return 401 and not call next()
            return (
              (next as ReturnType<typeof vi.fn>).mock.calls.length === 0 &&
              res.statusCode === 401 &&
              (res.body as { error: string }).error === "Unauthorized"
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

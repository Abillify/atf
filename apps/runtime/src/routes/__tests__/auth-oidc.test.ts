// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Integration tests for the backend-driven (BFF) OIDC login router.
 *
 * A mock IdP is stood up via a stubbed `fetch`: discovery, JWKS (a real RS256
 * key pair generated with jose) and the token endpoint. The full flow is
 * exercised — login redirect + signed state cookie, then callback code-exchange
 * + id_token verification + minted session token.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { generateKeyPair, exportJWK, SignJWT, jwtVerify, type JWK } from "jose";
import { createOidcAuthRouter, type OidcAuthConfig } from "../auth-oidc.js";

const ISSUER = "https://idp.example.com/application/o/app/";
const CLIENT_ID = "test-client";
const SESSION_SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars
const DASHBOARD = "https://dash.example.com";
const KID = "test-key-1";

const AUTH_EP = "https://idp.example.com/authorize";
const TOKEN_EP = "https://idp.example.com/token";
const JWKS_URI = "https://idp.example.com/jwks";
const LOGOUT_EP = "https://idp.example.com/logout";

let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: JWK;
let realFetch: typeof fetch;
let lastTokenBody: string | undefined;

async function makeIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Installs a stubbed IdP. `idToken` is returned by the token endpoint.
 * Req 7.2: the router takes the stub through its `fetchFn` dependency now
 * (`idpFetch`); the globalThis assignment only covers any stray call.
 */
let currentIdpStub: typeof fetch = (async () => {
  throw new Error("installIdp() was not called");
}) as unknown as typeof fetch;

/** Lazy delegator: routers capture this once but always see the latest stub. */
const idpFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  currentIdpStub(input, init)) as typeof fetch;

function installIdp(idToken: string): void {
  lastTokenBody = undefined;
  currentIdpStub = (async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : (input as { url: string }).url;
    if (url.includes("/.well-known/openid-configuration")) {
      return jsonResponse({
        // The Security_Kit discovery client requires an exact issuer match.
        issuer: ISSUER,
        authorization_endpoint: AUTH_EP,
        token_endpoint: TOKEN_EP,
        jwks_uri: JWKS_URI,
        end_session_endpoint: LOGOUT_EP,
      });
    }
    if (url === JWKS_URI) {
      return jsonResponse({ keys: [publicJwk] });
    }
    if (url === TOKEN_EP) {
      lastTokenBody = String(init?.body ?? "");
      return jsonResponse({ id_token: idToken });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  globalThis.fetch = currentIdpStub;
}

function baseConfig(overrides: Partial<OidcAuthConfig> = {}): OidcAuthConfig {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "shhh-secret",
    sessionSecret: SESSION_SECRET,
    sessionTtlSeconds: 3600,
    scopes: "openid profile email groups",
    audience: CLIENT_ID,
    dashboardUrl: DASHBOARD,
    autoLogin: true,
    roleClaim: "role",
    groupsClaim: "groups",
    roleMap: { "aiperator-admins": "admin" },
    ...overrides,
  };
}

/** Reads a Set-Cookie header value for a given cookie name. */
function cookieValue(setCookie: string | null, name: string): string | null {
  if (setCookie === null) return null;
  const m = new RegExp(`${name}=([^;]+)`).exec(setCookie);
  return m ? decodeURIComponent(m[1] ?? "") : null;
}

/** A required response header value, asserting the header is actually set. */
function requiredHeader(res: Response, name: string): string {
  const value = res.headers.get(name);
  if (value === null) throw new Error(`expected response header "${name}" to be set`);
  return value;
}

/** A required cookie value, asserting the cookie is actually set. */
function requiredCookie(setCookie: string | null, name: string): string {
  const value = cookieValue(setCookie, name);
  if (value === null) throw new Error(`expected cookie "${name}" to be set`);
  return value;
}

/** A required URL search param, asserting it is actually present. */
function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) throw new Error(`expected URL param "${name}" to be set`);
  return value;
}

beforeAll(async () => {
  // Generate the key ONCE: jose's remote JWKS is cached by URL across the
  // suite, so a per-test key would fail signature checks after the first.
  const kp = await generateKeyPair("RS256");
  privateKey = kp.privateKey;
  publicJwk = {
    ...(await exportJWK(kp.publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
});

beforeEach(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OIDC BFF router", () => {
  test("GET /monitoring/auth/config reports enabled + autoLogin", async () => {
    installIdp(await makeIdToken({ nonce: "x" }));
    const app = createOidcAuthRouter({
      config: baseConfig(),
      fetchFn: idpFetch,
    });
    const res = await app.request("http://localhost/monitoring/auth/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      autoLogin: true,
      required: true,
      // Req 8.4: the dashboard validates endSessionUrl against this host.
      issuerHost: "idp.example.com",
    });
  });

  test("GET /monitoring/auth/login redirects to the IdP and sets a state cookie", async () => {
    installIdp(await makeIdToken({ nonce: "x" }));
    const app = createOidcAuthRouter({
      config: baseConfig(),
      fetchFn: idpFetch,
    });
    const res = await app.request("http://localhost/monitoring/auth/login");
    expect(res.status).toBe(302);
    const loc = new URL(requiredHeader(res, "location"));
    expect(`${loc.origin}${loc.pathname}`).toBe(AUTH_EP);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("state")).toBeTruthy();
    const flow = cookieValue(
      res.headers.get("set-cookie"),
      "aiperator_oidc_flow",
    );
    expect(flow).toBeTruthy();
  });

  test("full flow: callback exchanges code, verifies id_token, mints a session token with the mapped role", async () => {
    const cfg = baseConfig();
    // 1. Login to obtain the signed flow cookie (carries state + nonce).
    installIdp(await makeIdToken({ nonce: "placeholder" }));
    const app = createOidcAuthRouter({ config: cfg, fetchFn: idpFetch });
    const loginRes = await app.request(
      "http://localhost/monitoring/auth/login",
    );
    const flowCookie = requiredCookie(
      loginRes.headers.get("set-cookie"),
      "aiperator_oidc_flow",
    );
    const state = requiredParam(
      new URL(requiredHeader(loginRes, "location")),
      "state",
    );

    // Recover the nonce the backend stored (we hold the session secret in-test).
    const key = new TextEncoder().encode(SESSION_SECRET);
    const { payload: flowPayload } = await jwtVerify(flowCookie, key);
    const nonce = String(flowPayload.nonce);

    // 2. IdP now returns an id_token bound to that nonce, in an admin group.
    installIdp(
      await makeIdToken({
        nonce,
        groups: ["aiperator-admins"],
        email: "op@corp.example",
      }),
    );

    const cbRes = await app.request(
      `http://localhost/monitoring/auth/callback?code=the-code&state=${state}`,
      {
        headers: {
          Cookie: `aiperator_oidc_flow=${encodeURIComponent(flowCookie)}`,
        },
      },
    );
    expect(cbRes.status).toBe(302);
    const loc = requiredHeader(cbRes, "location");
    expect(loc.startsWith(`${DASHBOARD}#session=`)).toBe(true);

    // The token exchange sent client_secret + PKCE verifier.
    expect(lastTokenBody).toContain("grant_type=authorization_code");
    expect(lastTokenBody).toContain("client_secret=");
    expect(lastTokenBody).toContain("code_verifier=");

    // The minted session token verifies under the session secret and carries role.
    const session = loc.slice(`${DASHBOARD}#session=`.length);
    const { payload } = await jwtVerify(session, key);
    expect(payload.role).toBe("admin");
    expect(payload.email).toBe("op@corp.example");
    expect(payload.iss).toBe("aiperator");
  });

  test("callback with a mismatched state fails with an auth_error (CSRF guard)", async () => {
    const cfg = baseConfig();
    installIdp(await makeIdToken({ nonce: "n" }));
    const app = createOidcAuthRouter({ config: cfg, fetchFn: idpFetch });
    const loginRes = await app.request(
      "http://localhost/monitoring/auth/login",
    );
    const flowCookie = requiredCookie(
      loginRes.headers.get("set-cookie"),
      "aiperator_oidc_flow",
    );

    const cbRes = await app.request(
      "http://localhost/monitoring/auth/callback?code=c&state=WRONG",
      {
        headers: {
          Cookie: `aiperator_oidc_flow=${encodeURIComponent(flowCookie)}`,
        },
      },
    );
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toContain(
      "auth_error=state_mismatch",
    );
  });

  test("callback denies an identity with no mappable role", async () => {
    const cfg = baseConfig({ roleMap: { "aiperator-admins": "admin" } });
    installIdp(await makeIdToken({ nonce: "n" }));
    const app = createOidcAuthRouter({ config: cfg, fetchFn: idpFetch });
    const loginRes = await app.request(
      "http://localhost/monitoring/auth/login",
    );
    const flowCookie = requiredCookie(
      loginRes.headers.get("set-cookie"),
      "aiperator_oidc_flow",
    );
    const state = requiredParam(
      new URL(requiredHeader(loginRes, "location")),
      "state",
    );
    const key = new TextEncoder().encode(SESSION_SECRET);
    const { payload } = await jwtVerify(flowCookie, key);

    installIdp(
      await makeIdToken({
        nonce: String(payload.nonce),
        groups: ["random-group"],
      }),
    );
    const cbRes = await app.request(
      `http://localhost/monitoring/auth/callback?code=c&state=${state}`,
      {
        headers: {
          Cookie: `aiperator_oidc_flow=${encodeURIComponent(flowCookie)}`,
        },
      },
    );
    expect(cbRes.headers.get("location")).toContain("auth_error=forbidden");
  });

  test("defaultRole lets any verified identity in without group mapping", async () => {
    const cfg = baseConfig({ roleMap: {}, defaultRole: "admin" });
    installIdp(await makeIdToken({ nonce: "n" }));
    const app = createOidcAuthRouter({ config: cfg, fetchFn: idpFetch });
    const loginRes = await app.request(
      "http://localhost/monitoring/auth/login",
    );
    const flowCookie = requiredCookie(
      loginRes.headers.get("set-cookie"),
      "aiperator_oidc_flow",
    );
    const state = requiredParam(
      new URL(requiredHeader(loginRes, "location")),
      "state",
    );
    const key = new TextEncoder().encode(SESSION_SECRET);
    const { payload } = await jwtVerify(flowCookie, key);

    installIdp(
      await makeIdToken({
        nonce: String(payload.nonce),
        email: "any@corp.example",
      }),
    );
    const cbRes = await app.request(
      `http://localhost/monitoring/auth/callback?code=c&state=${state}`,
      {
        headers: {
          Cookie: `aiperator_oidc_flow=${encodeURIComponent(flowCookie)}`,
        },
      },
    );
    const loc = requiredHeader(cbRes, "location");
    expect(loc.startsWith(`${DASHBOARD}#session=`)).toBe(true);
    const { payload: sess } = await jwtVerify(
      loc.slice(`${DASHBOARD}#session=`.length),
      key,
    );
    expect(sess.role).toBe("admin");
  });
});

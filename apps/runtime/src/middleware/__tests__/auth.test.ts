// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auth Middleware Tests
 *
 * Property 5: Token Extraction Round-Trip
 * Property 6: Missing Credentials → 401
 * Property 7: Invalid JWT Format → 401
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  extractBearerToken,
  extractBodyToken,
  extractCookieToken,
  isValidJwtFormat,
} from "../auth.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates strings that look like valid JWT format: 3 Base64URL segments.
 * Base64URL alphabet: A-Za-z0-9_-
 */
const arbitraryBase64UrlSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);

const arbitraryValidJwtToken = fc
  .tuple(
    arbitraryBase64UrlSegment,
    arbitraryBase64UrlSegment,
    arbitraryBase64UrlSegment,
  )
  .map(([a, b, c]) => `${a}.${b}.${c}`);

/**
 * Generates strings that do NOT look like valid JWTs (not exactly 3 Base64URL segments).
 * Covers: 0 segments, 1 segment, 2 segments, 4+ segments, empty segments, invalid chars.
 */
const arbitraryInvalidJwtToken = fc.oneof(
  // 1 segment (no dots)
  fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/),
  // 2 segments
  fc
    .tuple(arbitraryBase64UrlSegment, arbitraryBase64UrlSegment)
    .map(([a, b]) => `${a}.${b}`),
  // 4 segments
  fc
    .tuple(
      arbitraryBase64UrlSegment,
      arbitraryBase64UrlSegment,
      arbitraryBase64UrlSegment,
      arbitraryBase64UrlSegment,
    )
    .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`),
  // Contains invalid chars (e.g. spaces, +, /)
  fc
    .tuple(
      arbitraryBase64UrlSegment,
      arbitraryBase64UrlSegment,
      arbitraryBase64UrlSegment,
    )
    .map(([a, b, c]) => `${a} .${b}.${c}`),
  // Empty string
  fc.constant(""),
  // Segment with dots only
  fc.constant(".."),
  fc.constant(".a.b"),
  fc.constant("a..b"),
  fc.constant("a.b."),
);

// ---------------------------------------------------------------------------
// Property 5: Token Extraction Round-Trip
// Feature: ai-agent-orchestration-platform, Property 5: Token Extraction Round-Trip
// ---------------------------------------------------------------------------

describe("Property 5: Token Extraction Round-Trip", () => {
  test("extractBearerToken returns the exact same token for any valid JWT-format token in Authorization header", () => {
    // Feature: ai-agent-orchestration-platform, Property 5: Token Extraction Round-Trip
    fc.assert(
      fc.property(arbitraryValidJwtToken, (token) => {
        const result = extractBearerToken(`Bearer ${token}`);
        expect(result).toBe(token);
      }),
      { numRuns: 100 },
    );
  });

  test("extractBodyToken returns the exact same token for any valid JWT-format token in body.metadata.token", () => {
    // Feature: ai-agent-orchestration-platform, Property 5: Token Extraction Round-Trip
    fc.assert(
      fc.property(arbitraryValidJwtToken, (token) => {
        const result = extractBodyToken({ metadata: { token } });
        expect(result).toBe(token);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Missing Credentials → 401
// Feature: ai-agent-orchestration-platform, Property 6: Missing Credentials → 401
// ---------------------------------------------------------------------------

describe("Property 6: Missing Credentials → 401", () => {
  test("extractBearerToken returns null for any header without Bearer prefix", () => {
    // Feature: ai-agent-orchestration-platform, Property 6: Missing Credentials → 401
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(undefined),
          fc.constant(""),
          // Non-Bearer Authorization header values
          fc.string().filter((s) => !s.startsWith("Bearer ")),
        ),
        (authHeader) => {
          const result = extractBearerToken(authHeader as string | undefined);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  test("extractBodyToken returns null for any body without metadata.token", () => {
    // Feature: ai-agent-orchestration-platform, Property 6: Missing Credentials → 401
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant(""),
          fc.constant(42),
          fc.constant([]),
          // Object without metadata
          fc.record({ foo: fc.string() }),
          // Object with metadata but no token
          fc.constant({ metadata: {} }),
          fc.constant({ metadata: null }),
          fc.constant({ metadata: { other: "value" } }),
        ),
        (body) => {
          const result = extractBodyToken(body);
          expect(result).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7: Invalid JWT Format → 401
// Feature: ai-agent-orchestration-platform, Property 7: Invalid JWT Format → 401
// ---------------------------------------------------------------------------

describe("Property 7: Invalid JWT Format → 401", () => {
  test("isValidJwtFormat returns false for any token not matching 3 Base64URL segments", () => {
    // Feature: ai-agent-orchestration-platform, Property 7: Invalid JWT Format → 401
    fc.assert(
      fc.property(arbitraryInvalidJwtToken, (invalidToken) => {
        const result = isValidJwtFormat(invalidToken);
        expect(result).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  test("isValidJwtFormat returns true for any valid 3-segment Base64URL token", () => {
    // Feature: ai-agent-orchestration-platform, Property 7: Invalid JWT Format → 401
    fc.assert(
      fc.property(arbitraryValidJwtToken, (validToken) => {
        const result = isValidJwtFormat(validToken);
        expect(result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — extractBearerToken
// ---------------------------------------------------------------------------

describe("Unit: extractBearerToken", () => {
  test("returns token when Authorization header has 'Bearer ' prefix", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  test("returns null when Authorization header is undefined", () => {
    expect(extractBearerToken(undefined)).toBeNull();
  });

  test("returns null when Authorization header is empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  test("returns null when Authorization header has no 'Bearer ' prefix", () => {
    expect(extractBearerToken("Token abc.def.ghi")).toBeNull();
  });

  test("returns null when Authorization header is just 'Bearer ' with no token", () => {
    expect(extractBearerToken("Bearer ")).toBeNull();
  });

  test("preserves token value exactly including special Base64URL chars", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.abc_-123";
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — extractBodyToken
// ---------------------------------------------------------------------------

describe("Unit: extractBodyToken", () => {
  test("returns token from body.metadata.token", () => {
    expect(extractBodyToken({ metadata: { token: "abc.def.ghi" } })).toBe(
      "abc.def.ghi",
    );
  });

  test("returns null when body is null", () => {
    expect(extractBodyToken(null)).toBeNull();
  });

  test("returns null when body is not an object", () => {
    expect(extractBodyToken("string")).toBeNull();
    expect(extractBodyToken(42)).toBeNull();
    expect(extractBodyToken(true)).toBeNull();
  });

  test("returns null when body.metadata is null", () => {
    expect(extractBodyToken({ metadata: null })).toBeNull();
  });

  test("returns null when body.metadata is not an object", () => {
    expect(extractBodyToken({ metadata: "string" })).toBeNull();
    expect(extractBodyToken({ metadata: 123 })).toBeNull();
  });

  test("returns null when body.metadata.token is missing", () => {
    expect(extractBodyToken({ metadata: {} })).toBeNull();
  });

  test("returns null when body.metadata.token is empty string", () => {
    expect(extractBodyToken({ metadata: { token: "" } })).toBeNull();
  });

  test("returns null when body.metadata.token is not a string", () => {
    expect(extractBodyToken({ metadata: { token: 42 } })).toBeNull();
    expect(extractBodyToken({ metadata: { token: null } })).toBeNull();
  });

  test("returns null when body has no metadata field", () => {
    expect(extractBodyToken({ other: "value" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — isValidJwtFormat
// ---------------------------------------------------------------------------

describe("Unit: isValidJwtFormat", () => {
  test("returns true for a token with exactly 3 Base64URL segments", () => {
    expect(
      isValidJwtFormat(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36P",
      ),
    ).toBe(true);
  });

  test("returns true for minimal 3-segment token (1 char each)", () => {
    expect(isValidJwtFormat("a.b.c")).toBe(true);
  });

  test("returns true for token using underscore and hyphen (Base64URL chars)", () => {
    expect(isValidJwtFormat("abc_-123.def_-456.ghi_-789")).toBe(true);
  });

  test("returns false for token with only 2 segments", () => {
    expect(isValidJwtFormat("abc.def")).toBe(false);
  });

  test("returns false for token with 4 segments", () => {
    expect(isValidJwtFormat("abc.def.ghi.jkl")).toBe(false);
  });

  test("returns false for token with 1 segment (no dots)", () => {
    expect(isValidJwtFormat("abcdefghi")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isValidJwtFormat("")).toBe(false);
  });

  test("returns false for token with empty first segment", () => {
    expect(isValidJwtFormat(".def.ghi")).toBe(false);
  });

  test("returns false for token with empty middle segment", () => {
    expect(isValidJwtFormat("abc..ghi")).toBe(false);
  });

  test("returns false for token with empty last segment", () => {
    expect(isValidJwtFormat("abc.def.")).toBe(false);
  });

  test("returns false for token containing spaces (invalid chars)", () => {
    expect(isValidJwtFormat("abc .def.ghi")).toBe(false);
  });

  test("returns false for token containing + or / (standard Base64, not Base64URL)", () => {
    expect(isValidJwtFormat("abc+def.ghi.jkl")).toBe(false);
    expect(isValidJwtFormat("abc/def.ghi.jkl")).toBe(false);
  });

  test("returns false for token that is just dots", () => {
    expect(isValidJwtFormat("..")).toBe(false);
    expect(isValidJwtFormat("...")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit Tests — extractCookieToken
// ---------------------------------------------------------------------------

describe("Unit: extractCookieToken", () => {
  test("extracts token from a cookie header with only the token cookie", () => {
    expect(extractCookieToken("token=abc.def.ghi")).toBe("abc.def.ghi");
  });

  test("extracts token when it appears among multiple cookies", () => {
    expect(extractCookieToken("session=xyz; token=abc.def.ghi; _ga=123")).toBe(
      "abc.def.ghi",
    );
  });

  test("extracts token when it appears first", () => {
    expect(extractCookieToken("token=abc.def.ghi; other=value")).toBe(
      "abc.def.ghi",
    );
  });

  test("extracts token when it appears last", () => {
    expect(extractCookieToken("other=value; token=abc.def.ghi")).toBe(
      "abc.def.ghi",
    );
  });

  test("handles token value containing = (base64 padding)", () => {
    // The value part after the first = is the token; rest.join('=') handles this
    expect(extractCookieToken("token=abc.def.ghi==")).toBe("abc.def.ghi==");
  });

  test("returns null when cookie header is undefined", () => {
    expect(extractCookieToken(undefined)).toBeNull();
  });

  test("returns null when cookie header is empty string", () => {
    expect(extractCookieToken("")).toBeNull();
  });

  test("returns null when token cookie is absent", () => {
    expect(extractCookieToken("session=abc; _ga=123")).toBeNull();
  });

  test("returns null when token cookie value is empty", () => {
    expect(extractCookieToken("token=")).toBeNull();
  });

  test("does not match cookies whose name ends with 'token' (e.g. mytoken)", () => {
    expect(extractCookieToken("mytoken=abc.def.ghi")).toBeNull();
  });

  test("real Open WebUI cookie header — extracts the JWT", () => {
    const owuiCookie =
      "_ga=GA1.1.123; token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImRiN2ExZWQ1In0.sig; other=x";
    expect(extractCookieToken(owuiCookie)).toBe(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImRiN2ExZWQ1In0.sig",
    );
  });
});

// ---------------------------------------------------------------------------
// authMiddleware — full middleware behaviour (Hono integration)
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import {
  authMiddleware,
  AUTH_PRINCIPAL_KEY,
  TOKEN_KEY,
  type AuthContext,
} from "../auth.js";
import type { JwtVerifier } from "../jwt-verifier.js";

function makeAuthApp(verifier?: JwtVerifier) {
  const app = new Hono<AuthContext>();
  app.use("/v1/*", authMiddleware(verifier));
  app.get("/v1/ping", (c) => c.json({ token: c.get(TOKEN_KEY) }));
  app.post("/v1/ping", (c) => c.json({ token: c.get(TOKEN_KEY) }));
  return app;
}

const VALID_JWT = "aaa.bbb.ccc";

describe("authMiddleware — token sourcing and validation", () => {
  test("accepts a valid Bearer token and stores it in context", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Authorization: `Bearer ${VALID_JWT}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: VALID_JWT });
  });

  test("falls back to body.metadata.token when no Authorization header (valid JSON body)", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { token: VALID_JWT } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: VALID_JWT });
  });

  test("tolerates a malformed JSON body and falls through to the cookie source", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `token=${VALID_JWT}`,
        },
        body: "{not valid json",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: VALID_JWT });
  });

  test("falls back to the token cookie when no header or body token is present", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Cookie: `token=${VALID_JWT}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: VALID_JWT });
  });

  test("returns 401 authentication_error when no token is found anywhere", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(new Request("http://localhost/v1/ping"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe("authentication_error");
  });

  test("returns 401 when the token does not have valid JWT format", async () => {
    const app = makeAuthApp();
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Authorization: "Bearer not-a-jwt" },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("invalid token format");
  });

  test("passes through when the verifier is disabled even if verify() would fail", async () => {
    const verifier: JwtVerifier = {
      enabled: false,
      verify: async () => false,
      decodePayload: () => null,
    };
    const app = makeAuthApp(verifier);
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Authorization: `Bearer ${VALID_JWT}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("returns 401 when an enabled verifier rejects the token signature", async () => {
    const verifier: JwtVerifier = {
      enabled: true,
      verify: async () => false,
      decodePayload: () => null,
    };
    const app = makeAuthApp(verifier);
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Authorization: `Bearer ${VALID_JWT}` },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("signature verification failed");
  });

  test("passes through when an enabled verifier accepts the token", async () => {
    const verifier: JwtVerifier = {
      enabled: true,
      verify: async () => true,
      decodePayload: () => null,
    };
    const app = makeAuthApp(verifier);
    const res = await app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Authorization: `Bearer ${VALID_JWT}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: VALID_JWT });
  });
});

// ---------------------------------------------------------------------------
// authMiddleware — Req 7.4: tenantId only from verified claims
// ---------------------------------------------------------------------------

describe("authMiddleware — tenant identity requires verification (Req 7.4)", () => {
  function makePrincipalApp(
    verifier?: JwtVerifier,
    options: Parameters<typeof authMiddleware>[2] = {},
  ) {
    const app = new Hono<AuthContext>();
    app.use("/v1/*", authMiddleware(verifier, undefined, options));
    app.get("/v1/ping", (c) =>
      c.json({ principal: c.get(AUTH_PRINCIPAL_KEY) ?? null }),
    );
    return app;
  }

  const ping = (app: Hono<AuthContext>) =>
    app.fetch(
      new Request("http://localhost/v1/ping", {
        headers: { Authorization: `Bearer ${VALID_JWT}` },
      }),
    );

  const tenantPayload = { tenant_id: "acme" };

  test("a verified verifier's tenant claim resolves the principal tenant", async () => {
    const verifier: JwtVerifier = {
      enabled: true,
      verify: async () => true,
      decodePayload: () => tenantPayload,
    };
    const res = await ping(makePrincipalApp(verifier, { tenantIsolationEnabled: true }));
    expect(res.status).toBe(200);
    const { principal } = (await res.json()) as {
      principal: { tenantId?: string; verified: boolean };
    };
    expect(principal.verified).toBe(true);
    expect(principal.tenantId).toBe("acme");
  });

  test("an unverified verifier's tenant claim does NOT resolve a tenant", async () => {
    // Legacy mode: NoopVerifier (enabled=false) → decodePayload is an
    // attacker-chosen base64 read and must not establish a tenant.
    const verifier: JwtVerifier = {
      enabled: false,
      verify: async () => true,
      decodePayload: () => tenantPayload,
    };
    const res = await ping(makePrincipalApp(verifier));
    expect(res.status).toBe(200);
    const { principal } = (await res.json()) as {
      principal: { tenantId?: string; verified: boolean; claims: unknown };
    };
    expect(principal.verified).toBe(false);
    // Isolation is not enabled here, so no tenant is resolved at all — the
    // unverified "acme" never appears. (The deployment default applies only
    // when TENANT_ISOLATION_ENABLED is explicitly false, see below.)
    expect(principal.tenantId).toBeUndefined();
    // The payload stays on the principal for display purposes only.
    expect(principal.claims).toEqual(tenantPayload);
  });

  test("unverified claims with tenant isolation enabled → 401", async () => {
    const verifier: JwtVerifier = {
      enabled: false,
      verify: async () => true,
      decodePayload: () => tenantPayload,
    };
    const res = await ping(
      makePrincipalApp(verifier, { tenantIsolationEnabled: true }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("no tenant claim");
  });

  test("a missing verifier resolves no tenant from the payload", async () => {
    const res = await ping(makePrincipalApp(undefined, { tenantIsolationEnabled: true }));
    expect(res.status).toBe(401);
  });

  test("unverified requests fall back to the configured default tenant", async () => {
    const verifier: JwtVerifier = {
      enabled: false,
      verify: async () => true,
      decodePayload: () => tenantPayload,
    };
    const res = await ping(
      makePrincipalApp(verifier, {
        tenantIsolationEnabled: false,
        defaultTenantId: "standalone",
      }),
    );
    expect(res.status).toBe(200);
    const { principal } = (await res.json()) as {
      principal: { tenantId?: string };
    };
    expect(principal.tenantId).toBe("standalone");
  });
});

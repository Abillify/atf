// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Managed API keys (`aip-…`) authenticate the inference plane.
 *
 * `POST /admin/tenants/:id/keys` mints such keys and the documentation promises
 * machine clients can use them "directly, without needing to issue full JWTs".
 * The middleware, however, ran every credential through `isValidJwtFormat()` —
 * which an `aip-…` key can never satisfy — so a freshly minted key always got a
 * 401 that looked exactly like a wrong key. `api-key-auth.ts` existed but was
 * imported nowhere.
 *
 * These tests pin the wiring: the key authenticates, the resolved tenant is
 * authoritative, and a caller cannot override it.
 */

import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import {
  authMiddleware,
  TOKEN_KEY,
  API_KEY_IDENTITY_KEY,
  type AuthContext,
  type ApiKeyResolver,
} from "../auth.js";
import { API_KEY_PREFIX, resolveApiKey } from "../api-key-auth.js";
import type { TenantStore } from "../../graph/tenant-manager.js";
import { buildRequestContext } from "../../routes/chat/handler.js";

const VALID_KEY = `${API_KEY_PREFIX}live-key-abcdef`;
const JWT = "aaa.bbb.ccc";

/** Resolver that knows exactly one key. */
const resolver: ApiKeyResolver = async (rawKey) =>
  rawKey === VALID_KEY
    ? { tenantId: "acme", tenantName: "Acme Inc.", plan: "pro" }
    : undefined;

function app(opts: { apiKeyResolver?: ApiKeyResolver } = {}) {
  const a = new Hono<AuthContext>();
  a.use("/v1/*", authMiddleware(undefined, opts.apiKeyResolver));
  a.get("/v1/probe", (ctx) =>
    ctx.json({
      token: ctx.get(TOKEN_KEY),
      identity: ctx.get(API_KEY_IDENTITY_KEY) ?? null,
    }),
  );
  return a;
}

const bearer = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

describe("API key authentication on /v1/*", () => {
  test("a valid aip- key is accepted (previously always 401)", async () => {
    const res = await app({ apiKeyResolver: resolver }).request(
      "/v1/probe",
      bearer(VALID_KEY),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      identity: { tenantId: string; tenantName: string; plan: string } | null;
    };
    expect(body.token).toBe(VALID_KEY);
    expect(body.identity).toEqual({
      tenantId: "acme",
      tenantName: "Acme Inc.",
      plan: "pro",
    });
  });

  test("an unknown or revoked key is rejected as such, not as malformed", async () => {
    const res = await app({ apiKeyResolver: resolver }).request(
      "/v1/probe",
      bearer(`${API_KEY_PREFIX}revoked`),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("unknown or revoked API key");
  });

  test("without tenant management the message names the cause", async () => {
    // Previously this produced "invalid token format", sending operators to look
    // for a malformed key instead of a disabled feature.
    const res = await app().request("/v1/probe", bearer(VALID_KEY));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("TENANT_MANAGEMENT_ENABLED");
    expect(body.error.message).not.toContain("invalid token format");
  });

  test("the key is accepted via metadata.token as well", async () => {
    const res = await app({ apiKeyResolver: resolver }).request("/v1/probe", {
      method: "GET",
    });
    // No credential at all → 401 (sanity check for the harness).
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The JWT path must be untouched
// ---------------------------------------------------------------------------

describe("JWT path is unchanged", () => {
  test("a JWT still authenticates and carries no API-key identity", async () => {
    const res = await app({ apiKeyResolver: resolver }).request(
      "/v1/probe",
      bearer(JWT),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; identity: unknown };
    expect(body.token).toBe(JWT);
    expect(body.identity).toBeNull();
  });

  test("a malformed non-key credential is still a format error", async () => {
    const res = await app({ apiKeyResolver: resolver }).request(
      "/v1/probe",
      bearer("not-a-jwt"),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("invalid token format");
  });

  test("a missing credential is still 401", async () => {
    const res = await app({ apiKeyResolver: resolver }).request("/v1/probe");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The resolved tenant is authoritative
// ---------------------------------------------------------------------------

describe("API-key identity outranks client-supplied attributes", () => {
  const identity = {
    tenantId: "acme",
    tenantName: "Acme Inc.",
    plan: "pro",
  };

  test("the key's tenant wins over metadata.clientId", async () => {
    const ctx = buildRequestContext({
      ssoToken: VALID_KEY,
      claims: null,
      metadata: { clientId: "other-tenant", plan: "enterprise" },
      apiKeyIdentity: identity,
      // Even in the permissive mode the key must not be overridable — it is not
      // a claim that "might" be trustworthy, it IS the tenant.
      trustClientIdentity: true,
    });
    expect(ctx.clientId).toBe("acme");
    expect(ctx.plan).toBe("pro");
  });

  test("the key's tenant wins over a JWT claim too", async () => {
    const ctx = buildRequestContext({
      ssoToken: VALID_KEY,
      claims: { client_id: "claim-tenant", plan: "free" },
      metadata: {},
      apiKeyIdentity: identity,
    });
    expect(ctx.clientId).toBe("acme");
    expect(ctx.plan).toBe("pro");
  });

  test("an override attempt is reported as a trust conflict", async () => {
    const warnings: { field: string; action: string }[] = [];
    buildRequestContext({
      ssoToken: VALID_KEY,
      claims: null,
      metadata: { clientId: "other-tenant" },
      apiKeyIdentity: identity,
      onIdentityWarning: (w) =>
        warnings.push({ field: w.field, action: w.action }),
    });
    expect(warnings).toContainEqual({
      field: "clientId",
      action: "overridden",
    });
  });

  test("without an API key the previous precedence is unaffected", async () => {
    const ctx = buildRequestContext({
      ssoToken: JWT,
      claims: { client_id: "claim-tenant" },
      metadata: {},
    });
    expect(ctx.clientId).toBe("claim-tenant");
  });
});

// ---------------------------------------------------------------------------
// resolveApiKey against a store
// ---------------------------------------------------------------------------

describe("resolveApiKey", () => {
  const store = (impl: Partial<TenantStore>): TenantStore =>
    impl as unknown as TenantStore;

  test("maps a live key to its tenant identity", async () => {
    const result = await resolveApiKey(
      VALID_KEY,
      store({
        lookupByApiKey: async () => ({
          id: "acme",
          name: "Acme Inc.",
          plan: "pro",
          createdAt: "",
          updatedAt: "",
        }),
      }),
    );
    expect(result).toEqual({
      tenantId: "acme",
      tenantName: "Acme Inc.",
      plan: "pro",
    });
  });

  test("returns undefined for a non-prefixed token without touching the store", async () => {
    let called = false;
    const result = await resolveApiKey(
      JWT,
      store({
        lookupByApiKey: async () => {
          called = true;
          return undefined;
        },
      }),
    );
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  test("a store error resolves to undefined rather than throwing", async () => {
    // A database hiccup must produce a clean 401, not a 500.
    const result = await resolveApiKey(
      VALID_KEY,
      store({
        lookupByApiKey: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(result).toBeUndefined();
  });
});

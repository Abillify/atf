// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Issuer → tenant binding, the Gate's counterpart of the Runtime's
 * JWT_ISSUER_TENANTS. A valid signature proves who issued a token, not that the
 * issuer may speak for the tenant its claim names: with several trusted issuers
 * and no binding, any of them can assert any tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { Authenticator, AuthError } from "../../src/auth/authenticator.ts";
import {
  OAuthAuthSchema,
  TenantIsolationConfigSchema,
  type AuthConfig,
  type TenantIsolationConfig,
} from "../../src/config/schema.ts";

interface Idp {
  server: Server;
  jwksUri: string;
  issuer: string;
  privateKey: KeyLike;
}

async function startIdp(kid: string): Promise<Idp> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const server = createServer((req, res) => {
    if (req.url === "/jwks") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { server, jwksUri: `${base}/jwks`, issuer: base, privateKey };
}

async function mint(idp: Idp, kid: string, audience: string, tenant: string): Promise<string> {
  return new SignJWT({ preferred_username: "alice", scope: "query:read", tenant_id: tenant })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(idp.issuer)
    .setAudience(audience)
    .setSubject("alice")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idp.privateKey);
}

let primary: Idp;
let extra: Idp;
let authConfig: AuthConfig;

beforeAll(async () => {
  primary = await startIdp("primary-key");
  extra = await startIdp("extra-key");
  const oauth = OAuthAuthSchema.parse({
    jwksUri: primary.jwksUri,
    issuer: primary.issuer,
    audience: "owui-client",
    additionalIssuers: [
      { jwksUri: extra.jwksUri, issuer: extra.issuer, audience: "taiga-client" },
    ],
  });
  authConfig = { mode: "oauth", oauth } as unknown as AuthConfig;
});

afterAll(() => {
  primary.server.close();
  extra.server.close();
});

function tenancy(issuerTenants: Record<string, string[]>, enabled = true): TenantIsolationConfig {
  return TenantIsolationConfigSchema.parse({
    enabled,
    claimNames: ["tenant_id"],
    issuerTenants,
  });
}

describe("Authenticator · tenantIsolation.issuerTenants", () => {
  it("without a binding any trusted issuer may assert any tenant (previous behaviour)", async () => {
    const auth = new Authenticator(authConfig, tenancy({}));
    const ctx = await auth.authenticate(await mint(extra, "extra-key", "taiga-client", "acme"), {});
    expect(ctx.tenantId).toBe("acme");
  });

  it("accepts the tenant an issuer is bound to", async () => {
    const auth = new Authenticator(
      authConfig,
      tenancy({ [primary.issuer]: ["acme"], [extra.issuer]: ["taiga"] }),
    );
    expect(
      (await auth.authenticate(await mint(primary, "primary-key", "owui-client", "acme"), {})).tenantId,
    ).toBe("acme");
    expect(
      (await auth.authenticate(await mint(extra, "extra-key", "taiga-client", "taiga"), {})).tenantId,
    ).toBe("taiga");
  });

  it("refuses a tenant the issuer is not bound to (403)", async () => {
    const auth = new Authenticator(
      authConfig,
      tenancy({ [primary.issuer]: ["acme"], [extra.issuer]: ["taiga"] }),
    );
    const err = await auth
      .authenticate(await mint(extra, "extra-key", "taiga-client", "acme"), {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
  });

  it("refuses an issuer that is not listed at all once a binding exists (401)", async () => {
    const auth = new Authenticator(authConfig, tenancy({ [primary.issuer]: ["acme"] }));
    const err = await auth
      .authenticate(await mint(extra, "extra-key", "taiga-client", "acme"), {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
  });

  it('"*" lets an issuer act for any tenant', async () => {
    const auth = new Authenticator(
      authConfig,
      tenancy({ [primary.issuer]: ["*"], [extra.issuer]: ["taiga"] }),
    );
    expect(
      (await auth.authenticate(await mint(primary, "primary-key", "owui-client", "whoever"), {})).tenantId,
    ).toBe("whoever");
  });

  it("the binding is not enforced when tenant isolation is off", async () => {
    const auth = new Authenticator(
      authConfig,
      tenancy({ [primary.issuer]: ["acme"] }, false),
    );
    const ctx = await auth.authenticate(await mint(extra, "extra-key", "taiga-client", "acme"), {});
    expect(ctx.tenantId).toBe("default");
  });
});

describe("issuerTenants configuration", () => {
  const baseConfig = (issuerTenants: Record<string, string[]>, issuer = "https://id.example.com/") => ({
    server: { port: 3000 },
    tenantIsolation: { enabled: true, claimNames: ["tenant"], issuerTenants },
    auth: {
      mode: "oauth",
      oauth: {
        issuer,
        audience: "gate",
        jwksUri: "https://id.example.com/jwks",
      },
    },
  });

  it("normalizes trailing slashes in the keys", async () => {
    const { AppConfigSchema } = await import("../../src/config/schema.ts");
    const parsed = AppConfigSchema.parse(baseConfig({ "https://id.example.com/": ["acme"] }));
    expect(Object.keys(parsed.tenantIsolation.issuerTenants)).toEqual(["https://id.example.com"]);
  });

  it("accepts a key that matches the configured issuer despite a trailing slash", async () => {
    const { AppConfigSchema } = await import("../../src/config/schema.ts");
    expect(() => AppConfigSchema.parse(baseConfig({ "https://id.example.com": ["acme"] }))).not.toThrow();
  });

  it("refuses a key that is not a configured issuer", async () => {
    const { AppConfigSchema } = await import("../../src/config/schema.ts");
    expect(() => AppConfigSchema.parse(baseConfig({ "https://other.example.com": ["acme"] }))).toThrow(
      "tenantIsolation.issuerTenants has a key that is not a configured issuer: https://other.example.com",
    );
  });

  it("enforces the binding for a token issuer that differs only by a trailing slash", async () => {
    const { enforceIssuerTenant } = await import("../../src/auth/authenticator.ts");
    const isolation = TenantIsolationConfigSchema.parse({
      enabled: true,
      issuerTenants: { "https://id.example.com": ["acme"] },
    });
    expect(() => enforceIssuerTenant("https://id.example.com/", "acme", isolation)).not.toThrow();
    expect(() => enforceIssuerTenant("https://id.example.com/", "other", isolation)).toThrow(AuthError);
  });
});

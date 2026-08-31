// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { Authenticator, AuthError } from "../../src/auth/authenticator.ts";
import { OAuthAuthSchema, type AuthConfig } from "../../src/config/schema.ts";

interface Idp {
  server: Server;
  jwksUri: string;
  issuer: string;
  privateKey: KeyLike;
}

/** Spin up a tiny HTTP server that serves a single-key JWKS document. */
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

async function mint(
  idp: Idp,
  kid: string,
  audience: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ preferred_username: "alice", scope: "query:read", ...claims })
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
let auth: Authenticator;

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
  const config: AuthConfig = { mode: "oauth", oauth } as unknown as AuthConfig;
  auth = new Authenticator(config);
});

afterAll(() => {
  primary.server.close();
  extra.server.close();
});

describe("Authenticator — multiple OAuth issuers", () => {
  it("accepts a token from the primary issuer", async () => {
    const token = await mint(primary, "primary-key", "owui-client");
    const ctx = await auth.authenticate(token, {});
    expect(ctx.method).toBe("oauth");
    expect(ctx.username).toBe("alice");
    expect(ctx.scopes).toEqual(["query:read"]);
  });

  it("accepts a token from an additional issuer", async () => {
    const token = await mint(extra, "extra-key", "taiga-client");
    const ctx = await auth.authenticate(token, {});
    expect(ctx.method).toBe("oauth");
    expect(ctx.username).toBe("alice");
  });

  it("maps configured verified JWT groups to additional scopes", async () => {
    const oauth = OAuthAuthSchema.parse({
      jwksUri: primary.jwksUri,
      issuer: primary.issuer,
      audience: "owui-client",
      groupScopes: { SuperUsers: ["tools:read", "tools:write"], DEV: ["tools:read"] },
      requiredScopes: ["tools:read"],
    });
    const groupAuth = new Authenticator({ mode: "oauth", oauth } as AuthConfig);
    const token = await mint(primary, "primary-key", "owui-client", {
      groups: ["DEV", "SuperUsers", "unknown"],
    });
    const ctx = await groupAuth.authenticate(token, {});
    expect(ctx.scopes).toEqual(["query:read", "tools:read", "tools:write"]);
  });

  it("rejects a token whose audience matches no configured issuer", async () => {
    const token = await mint(extra, "extra-key", "wrong-aud");
    await expect(auth.authenticate(token, {})).rejects.toBeInstanceOf(AuthError);
  });

  it("rejects a token signed by an untrusted key", async () => {
    const rogue = await startIdp("rogue-key");
    try {
      // Impersonate the primary issuer (same iss/kid/aud) but sign with a key
      // that is not in the primary JWKS — signature verification must fail.
      const token = await new SignJWT({ preferred_username: "mallory" })
        .setProtectedHeader({ alg: "RS256", kid: "primary-key" })
        .setIssuer(primary.issuer)
        .setAudience("owui-client")
        .setSubject("mallory")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(rogue.privateKey);
      await expect(auth.authenticate(token, {})).rejects.toBeInstanceOf(AuthError);
    } finally {
      rogue.server.close();
    }
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Gate authenticator — RFC 8693 actor (`act`) parsing and policy.
 *
 * Verifies that a delegated (on-behalf-of) token's `act` claim is parsed onto
 * the AuthContext, that the subject stays the end user, and that the optional
 * actor policy gates requests as configured. A local JWKS HTTP server signs the
 * tokens so verification runs for real.
 */

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

async function mint(idp: Idp, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ preferred_username: "alice", scope: "query:read", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "key" })
    .setIssuer(idp.issuer)
    .setAudience("vectorsearch")
    .setSubject("alice")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idp.privateKey);
}

let idp: Idp;

beforeAll(async () => {
  idp = await startIdp("key");
});
afterAll(() => idp.server.close());

function authWith(actorPolicy?: Record<string, unknown>): Authenticator {
  const oauth = OAuthAuthSchema.parse({
    jwksUri: idp.jwksUri,
    issuer: idp.issuer,
    audience: "vectorsearch",
    ...(actorPolicy !== undefined ? { actorPolicy } : {}),
  });
  return new Authenticator({ mode: "oauth", oauth } as unknown as AuthConfig);
}

describe("Authenticator — actor (act) parsing", () => {
  it("parses the act claim onto the context and keeps the subject as the user", async () => {
    const token = await mint(idp, { act: { sub: "atf-runtime" } });
    const ctx = await authWith().authenticate(token, {});
    expect(ctx.subject).toBe("alice");
    expect(ctx.actor?.subject).toBe("atf-runtime");
  });

  it("follows one level of nested act into parent", async () => {
    const token = await mint(idp, { act: { sub: "atf-runtime", act: { sub: "gateway" } } });
    const ctx = await authWith().authenticate(token, {});
    expect(ctx.actor?.subject).toBe("atf-runtime");
    expect(ctx.actor?.parent?.subject).toBe("gateway");
  });

  it("yields no actor for a plain (non-delegated) token", async () => {
    const token = await mint(idp, {});
    const ctx = await authWith().authenticate(token, {});
    expect(ctx.actor).toBeUndefined();
  });
});

describe("Authenticator — actor policy", () => {
  it("rejects a token without an actor when requireActor is set", async () => {
    const token = await mint(idp, {});
    await expect(
      authWith({ requireActor: true }).authenticate(token, {}),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("accepts a delegated token when requireActor is set", async () => {
    const token = await mint(idp, { act: { sub: "atf-runtime" } });
    const ctx = await authWith({ requireActor: true }).authenticate(token, {});
    expect(ctx.actor?.subject).toBe("atf-runtime");
  });

  it("rejects an actor subject not on the allowlist", async () => {
    const token = await mint(idp, { act: { sub: "rogue-service" } });
    await expect(
      authWith({ allowedActorSubjects: ["atf-runtime"] }).authenticate(token, {}),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("accepts an actor subject on the allowlist", async () => {
    const token = await mint(idp, { act: { sub: "atf-runtime" } });
    const ctx = await authWith({ allowedActorSubjects: ["atf-runtime"] }).authenticate(token, {});
    expect(ctx.actor?.subject).toBe("atf-runtime");
  });

  it("honours a custom actorClaim name", async () => {
    const token = await mint(idp, { on_behalf_of: { sub: "atf-runtime" } });
    const ctx = await authWith({ actorClaim: "on_behalf_of" }).authenticate(token, {});
    expect(ctx.actor?.subject).toBe("atf-runtime");
  });
});

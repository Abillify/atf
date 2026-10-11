// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Task 9.10: characterization tests (Req 11.2, 6.9–6.11, 6.14).
 *
 * These tests pin the BEHAVIOR of the Gate BEFORE the switch to
 * `@atf/security-kit`. Deliberately different behavior changes are
 * inverted at the migration point (below) and justified in the CHANGELOG:
 *
 *  1. `isForbiddenAddress` (outbound.ts) did NOT know 198.18.0.0/15, 192.0.0.0/24,
 *     64:ff9b::/96 (NAT64) and 2002::/16 (6to4) → these addresses were let
 *     through as public. The Security_Kit address catalog blocks them
 *     (Req 6.14) → inversion.
 *  2. On verification errors the authenticator returned jose internals
 *     (`Token verification failed: <jose detail>`) to clients
 *     (WWW-Authenticate error_description) → generic message (Req 6.11) → inversion.
 *  3. Tokens WITHOUT `exp` were accepted → Security_Kit requires `exp`
 *     (hardening) → inversion.
 *  4. The identity rate-limit key used to be ONLY the subject;
 *     Req 6.9 requires issuer+tenant+subject → change at the call site.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { Authenticator, AuthError } from "../../src/auth/authenticator.ts";
import { isForbiddenAddress } from "../../src/tools/outbound.ts";
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

let idp: Idp;
let auth: Authenticator;

beforeAll(async () => {
  idp = await startIdp("char-key");
  const oauth = OAuthAuthSchema.parse({
    jwksUri: idp.jwksUri,
    issuer: idp.issuer,
    audience: "atf-client",
  });
  auth = new Authenticator({ mode: "oauth", oauth } as unknown as AuthConfig);
});

afterAll(() => {
  idp.server.close();
});

describe("9.10 characterization: egress address catalog (Req 6.14)", () => {
  // MIGRATION POINT 9.10: these four ranges were NOT blocked BEFORE the switch
  // to the Security_Kit address catalog. The kit blocks them; the
  // expectation was inverted to `true` (deliberate hardening, CHANGELOG).
  it("now blocks 198.18.0.0/15 (benchmarking), previously let through", () => {
    expect(isForbiddenAddress("198.18.0.1")).toBe(true);
    expect(isForbiddenAddress("198.19.255.254")).toBe(true);
  });

  it("now blocks 192.0.0.0/24 (IETF protocol assignments), previously let through", () => {
    expect(isForbiddenAddress("192.0.0.1")).toBe(true);
    expect(isForbiddenAddress("192.0.0.255")).toBe(true);
  });

  it("now blocks NAT64 64:ff9b::/96 and 6to4 2002::/16, previously let through", () => {
    // 64:ff9b::1 wraps 0.0.0.1, 2002::1 wraps 0.0.0.0; both blocked via the
    // kit's embedded-IPv4 evaluation.
    expect(isForbiddenAddress("64:ff9b::1")).toBe(true);
    expect(isForbiddenAddress("2002::1")).toBe(true);
    // 6to4 onto a public embedded IPv4 stays allowed:
    expect(isForbiddenAddress("2002:8888:8888::1")).toBe(false);
  });

  it("still allows legitimate public addresses", () => {
    expect(isForbiddenAddress("8.8.8.8")).toBe(false);
    expect(isForbiddenAddress("93.184.216.34")).toBe(false);
  });
});

describe("9.10 characterization: auth error details (Req 6.11)", () => {
  // MIGRATION POINT 9.10: BEFORE, the AuthError message contained the jose
  // internals (`Token verification failed: <detail>`), which flowed to clients
  // via WWW-Authenticate error_description. NOW generic.
  it("reports expired tokens generically without library details", async () => {
    const expired = await new SignJWT({ preferred_username: "alice" })
      .setProtectedHeader({ alg: "RS256", kid: "char-key" })
      .setIssuer(idp.issuer)
      .setAudience("atf-client")
      .setSubject("alice")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(idp.privateKey);
    const err = await auth.authenticate(expired, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    const message = (err as AuthError).message;
    expect(message).toBe("Token verification failed");
    // No jose detail visible any more (e.g. "exp", "JWS", claim names):
    expect(message).not.toMatch(/exp|jose|JWS|claim/i);
  });

  it("rejects tokens of unknown issuers with a generic message", async () => {
    const rogue = await startIdp("rogue-910");
    try {
      const token = await new SignJWT({ sub: "mallory" })
        .setProtectedHeader({ alg: "RS256", kid: "rogue-910" })
        .setIssuer("https://evil.invalid/")
        .setAudience("atf-client")
        .setSubject("mallory")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(rogue.privateKey);
      const err = await auth.authenticate(token, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).message).toBe("Token verification failed");
    } finally {
      rogue.server.close();
    }
  });

  // MIGRATION POINT 9.10: BEFORE, tokens WITHOUT exp were accepted; the
  // Security_Kit requires `exp` (requireExpiry). Expectation inverted.
  it("rejects tokens without an exp claim (hardening, Req 6.10/kit default)", async () => {
    const noExpiry = await new SignJWT({ preferred_username: "alice" })
      .setProtectedHeader({ alg: "RS256", kid: "char-key" })
      .setIssuer(idp.issuer)
      .setAudience("atf-client")
      .setSubject("alice")
      .setIssuedAt()
      .sign(idp.privateKey);
    await expect(auth.authenticate(noExpiry, {})).rejects.toBeInstanceOf(AuthError);
  });

  it("accepts normal tokens unchanged (scope/group mapping stays)", async () => {
    const token = await new SignJWT({
      preferred_username: "alice",
      scope: "query:read",
      groups: ["DEV"],
    })
      .setProtectedHeader({ alg: "RS256", kid: "char-key" })
      .setIssuer(idp.issuer)
      .setAudience("atf-client")
      .setSubject("alice")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(idp.privateKey);
    const ctx = await auth.authenticate(token, {});
    expect(ctx.method).toBe("oauth");
    expect(ctx.subject).toBe("alice");
    expect(ctx.scopes).toEqual(["query:read"]);
    expect(ctx.claims.iss).toBe(idp.issuer);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Multi-issuer JWT verification.
 *
 * Previously at 0% coverage, and now load-bearing for access control: the
 * principal this returns is what the row- and collection-level ACLs evaluate
 * against. In particular `userId` resolution matters — `sub` is often an opaque
 * UUID while `allowed_users` holds usernames, and a mismatch used to fail *open*
 * (no identity meant service context), so it produced no visible error.
 *
 * Signing keys are generated in-process and the JWKS is served by a local HTTP
 * server, so there is no network dependency and no fixture to expire.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from "jose";
import {
  createJwtVerifier,
  normaliseGroupsClaim,
  normaliseScopesClaim,
} from "../src/jwt-verifier.js";

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe("normaliseGroupsClaim", () => {
  /**
   * IdPs are genuinely inconsistent here — Keycloak emits an array, some
   * gateways a space-separated string, others comma-separated. Accepting only
   * one shape would silently yield an empty group list for the others, which
   * reads as "this user is in no groups" rather than as a configuration error.
   */
  it("accepts a JSON array", () => {
    expect(normaliseGroupsClaim(["legal", "staff"])).toEqual(["legal", "staff"]);
  });

  it("accepts a space-separated string", () => {
    expect(normaliseGroupsClaim("legal staff")).toEqual(["legal", "staff"]);
  });

  it("accepts a comma-separated string", () => {
    expect(normaliseGroupsClaim("legal, staff")).toEqual(["legal", "staff"]);
  });

  it("trims and drops empties", () => {
    expect(normaliseGroupsClaim([" legal ", "", "staff"])).toEqual([
      "legal",
      "staff",
    ]);
    expect(normaliseGroupsClaim("  ")).toEqual([]);
  });

  it("coerces non-string array entries", () => {
    expect(normaliseGroupsClaim([1, 2])).toEqual(["1", "2"]);
  });

  it("returns an empty list for absent or unusable values", () => {
    expect(normaliseGroupsClaim(undefined)).toEqual([]);
    expect(normaliseGroupsClaim(null)).toEqual([]);
    expect(normaliseGroupsClaim({ a: 1 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Local IdP
// ---------------------------------------------------------------------------

interface Idp {
  server: Server;
  issuer: string;
  privateKey: KeyLike;
}

async function startIdp(): Promise<Idp> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";

  let issuer = "";
  const server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  issuer = `http://127.0.0.1:${port}`;
  return { server, issuer, privateKey };
}

let idp: Idp;
beforeAll(async () => {
  idp = await startIdp();
});
afterAll(() => {
  idp.server.close();
});

/** Mint a token against the local IdP. */
async function mint(
  claims: Record<string, unknown>,
  opts: { audience?: string; expiresIn?: string; issuer?: string } = {},
): Promise<string> {
  let jwt = new SignJWT({ tenantId: "tenant-test", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(opts.issuer ?? idp.issuer)
    .setExpirationTime(opts.expiresIn ?? "5m");
  if (opts.audience) jwt = jwt.setAudience(opts.audience);
  return jwt.sign(idp.privateKey);
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

describe("createJwtVerifier", () => {
  it("returns null when no issuers are configured", () => {
    expect(createJwtVerifier([])).toBeNull();
  });

  it("verifies a well-formed token and returns the principal", async () => {
    const verifier = createJwtVerifier([
      { issuer: idp.issuer, audience: "vectorsearch" },
    ])!;
    const token = await mint({ sub: "sub-123" }, { audience: "vectorsearch" });
    const principal = await verifier.verify(token);
    expect(principal).toMatchObject({ sub: "sub-123", userId: "sub-123" });
    expect(principal?.groups).toEqual([]);
  });

  it("tolerates a trailing slash difference in the configured issuer", () => {
    // Trailing-slash mismatches between config and discovery are a classic
    // source of "works locally, 401 in prod".
    expect(createJwtVerifier([{ issuer: `${idp.issuer}/` }])).not.toBeNull();
  });

  describe("userId resolution", () => {
    it("defaults to sub", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      const token = await mint({ sub: "sub-123", email: "a@b.c" });
      expect((await verifier.verify(token))?.userId).toBe("sub-123");
    });

    it("uses the configured claim when set", async () => {
      const verifier = createJwtVerifier([
        { issuer: idp.issuer, userClaim: "email" },
      ])!;
      const token = await mint({ sub: "sub-123", email: "alice@example.com" });
      expect((await verifier.verify(token))?.userId).toBe("alice@example.com");
    });

    it("falls back to sub when the configured claim is missing or blank", async () => {
      // Returning an EMPTY identity here would be dangerous: downstream, no
      // identity means service context, i.e. unrestricted read access.
      const verifier = createJwtVerifier([
        { issuer: idp.issuer, userClaim: "email" },
      ])!;
      expect((await verifier.verify(await mint({ sub: "sub-1" })))?.userId).toBe(
        "sub-1",
      );
      expect(
        (await verifier.verify(await mint({ sub: "sub-1", email: "   " })))?.userId,
      ).toBe("sub-1");
      expect(
        (await verifier.verify(await mint({ sub: "sub-1", email: 42 })))?.userId,
      ).toBe("sub-1");
    });

    it("trims the resolved identity", async () => {
      const verifier = createJwtVerifier([
        { issuer: idp.issuer, userClaim: "email" },
      ])!;
      const token = await mint({ sub: "s", email: "  alice@example.com  " });
      expect((await verifier.verify(token))?.userId).toBe("alice@example.com");
    });
  });

  describe("groups resolution", () => {
    it("reads the default `groups` claim", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      const token = await mint({ sub: "s", groups: ["legal", "staff"] });
      expect((await verifier.verify(token))?.groups).toEqual(["legal", "staff"]);
    });

    it("reads a configured claim, including the string form", async () => {
      const verifier = createJwtVerifier([
        { issuer: idp.issuer, groupsClaim: "roles" },
      ])!;
      const token = await mint({ sub: "s", roles: "admin auditor" });
      expect((await verifier.verify(token))?.groups).toEqual(["admin", "auditor"]);
    });

    it("yields an empty list when the claim is absent", async () => {
      const verifier = createJwtVerifier([
        { issuer: idp.issuer, groupsClaim: "roles" },
      ])!;
      expect((await verifier.verify(await mint({ sub: "s" })))?.groups).toEqual([]);
    });
  });

  describe("rejection", () => {
    it("rejects an unknown issuer without any network call", async () => {
      const verifier = createJwtVerifier([{ issuer: "https://other.example.com" }])!;
      expect(await verifier.verify(await mint({ sub: "s" }))).toBeNull();
    });

    it("rejects a token with no iss claim", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      const token = await new SignJWT({ sub: "s" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(idp.privateKey);
      expect(await verifier.verify(token)).toBeNull();
    });

    it("rejects a token with no sub claim", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      expect(await verifier.verify(await mint({ name: "no sub" }))).toBeNull();
    });

    it("rejects an expired token", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      const token = await mint({ sub: "s" }, { expiresIn: "-1s" });
      expect(await verifier.verify(token)).toBeNull();
    });

    /**
     * Audience confusion: a token the same IdP minted for a different service
     * must not authenticate here. This is exactly what the production gate warns
     * about when `audience` is left unset.
     */
    it("rejects a token minted for a different audience", async () => {
      const verifier = createJwtVerifier([
        { issuer: idp.issuer, audience: "vectorsearch" },
      ])!;
      const token = await mint({ sub: "s" }, { audience: "some-other-service" });
      expect(await verifier.verify(token)).toBeNull();
    });

    it("accepts any audience when none is configured (documented risk)", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      const token = await mint({ sub: "s" }, { audience: "some-other-service" });
      expect(await verifier.verify(token)).not.toBeNull();
    });

    it("rejects a garbage string instead of throwing", async () => {
      const verifier = createJwtVerifier([{ issuer: idp.issuer }])!;
      expect(await verifier.verify("not-a-jwt")).toBeNull();
      expect(await verifier.verify("")).toBeNull();
    });

    it("rejects when discovery is unreachable", async () => {
      const verifier = createJwtVerifier([
        { issuer: "http://127.0.0.1:1/unreachable" },
      ])!;
      const token = await mint({ sub: "s" }, { issuer: "http://127.0.0.1:1/unreachable" });
      expect(await verifier.verify(token)).toBeNull();
    });
  });
});


describe("scope and tenant claim normalization", () => {
  it("accepts string and string-array scopes, drops non-strings and de-duplicates", () => {
    expect(normaliseScopesClaim("vectorsearch.read, vectorsearch.write vectorsearch.read")).toEqual(["vectorsearch.read", "vectorsearch.write"]);
    expect(normaliseScopesClaim(["vectorsearch.read", 1, " vectorsearch.read ", "tool:search"])).toEqual(["vectorsearch.read", "tool:search"]);
  });

  it("uses the server fallback tenant only when the verified claim is absent", async () => {
    const verifier = createJwtVerifier(
      [{ issuer: idp.issuer, tenantClaim: "tid" }],
      "tenant-default",
    )!;
    expect(
      (await verifier.verify(await mint({ sub: "alice", tid: "tenant-claim" })))?.tenantId,
    ).toBe("tenant-claim");
    expect(
      (await verifier.verify(await mint({ sub: "alice" })))?.tenantId,
    ).toBe("tenant-default");
    expect(
      (await verifier.verify(await mint({ sub: "alice", tid: "  " })))?.tenantId,
    ).toBe("tenant-default");
  });

  it("rejects a verified JWT with no usable tenant and no configured fallback", async () => {
    const verifier = createJwtVerifier([{ issuer: idp.issuer, tenantClaim: "tid" }])!;
    expect(await verifier.verify(await mint({ sub: "alice" }))).toBeNull();
  });

  it("returns configured verified tenant, scope, client and credential claims", async () => {
    const verifier = createJwtVerifier([{ issuer: idp.issuer, tenantClaim: "tid", scopesClaim: "permissions", clientIdClaim: "azp" }])!;
    const principal = await verifier.verify(await mint({ sub: "alice", tid: "tenant-a", permissions: "vectorsearch.read tool:search", azp: "client-a", jti: "credential-1" }));
    expect(principal).toMatchObject({ tenantId: "tenant-a", scopes: ["vectorsearch.read", "tool:search"], clientId: "client-a", jti: "credential-1" });
  });
});

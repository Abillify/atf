// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * whoami.test.ts
 *
 * `GET /v1/whoami` (extract-outpost E1, requirements 5.1, 5.2). The route is
 * what a client checks *before* its first upload, so the answer must reflect
 * the real principal the auth chain resolved and the real routes this instance
 * mounted — a feature flag that lies is worse than no flag at all.
 *
 * The JWT case runs against a local in-process IdP (same pattern as
 * `apps/search/tests/jwt-verifier.test.ts`): signing keys are generated per
 * test run, so there is no network dependency and no fixture to expire.
 */

import { createServer, type Server } from "node:http";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type AppOverrides } from "../src/index.js";
import { createFakeJobStore } from "./job-store-fake.js";
import {
  loadTestConfig,
  stubExtractor,
  stubSearchClient,
  stubVisionClient,
  testLogger,
} from "./helpers.js";

const availableBinary = vi.fn(async () => ({ available: true, version: "stub" }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function app(
  configOverrides: Record<string, string | undefined> = {},
  overrides: AppOverrides = {},
) {
  const config = loadTestConfig(configOverrides);
  const created = createApp(config, {
    logger: testLogger,
    vision: stubVisionClient(),
    extractor: stubExtractor(),
    probeBinary: availableBinary,
    ...overrides,
  });
  cleanups.push(created.cleanup);
  return created.app;
}

// ── Local IdP ────────────────────────────────────────────────────────────────

interface Idp {
  issuer: string;
  privateKey: CryptoKey;
  close: () => Promise<void>;
}

let idpSingleton: Idp | null = null;

async function getIdp(): Promise<Idp> {
  if (idpSingleton !== null) return idpSingleton;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "whoami-test-key";
  jwk.alg = "RS256";
  let issuer = "";
  const server: Server = createServer((req, res) => {
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
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  issuer = `http://127.0.0.1:${address.port}`;
  idpSingleton = {
    issuer,
    privateKey,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return idpSingleton;
}

async function signToken(
  idp: Idp,
  claims: Record<string, unknown>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "whoami-test-key" })
    .setIssuer(idp.issuer)
    .setAudience("atf-extract")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(idp.privateKey);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /v1/whoami", () => {
  const token = "t".repeat(40);
  const tokenEnv = { AUTHN_MODE: "token", API_TOKEN: token };

  it("refuses an unauthenticated request with WWW-Authenticate", async () => {
    const response = await request(app(tokenEnv)).get("/v1/whoami");
    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("refuses a wrong bearer token", async () => {
    const response = await request(app(tokenEnv))
      .get("/v1/whoami")
      .set("Authorization", `Bearer ${"x".repeat(40)}`);
    expect(response.status).toBe(401);
  });

  it("reports a static-token caller as a service principal", async () => {
    const response = await request(
      app({ ...tokenEnv, API_SERVICE_SCOPES: "extract.ingest,extract.delete" }),
    )
      .get("/v1/whoami")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("service");
    expect(response.body.subject).toBeUndefined();
    expect(response.body.scopes).toEqual(["extract.ingest", "extract.delete"]);
    expect(response.body.service).toEqual({ name: "atf-extract", version: "0.11.0" });
  });

  it("reports an asserted caller with the X-User identity", async () => {
    const response = await request(app(tokenEnv))
      .get("/v1/whoami")
      .set("Authorization", `Bearer ${token}`)
      .set("X-User", "anna@example.com")
      .set("X-Groups", "legal,staff");
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("asserted");
    expect(response.body.subject).toBe("anna@example.com");
  });

  it("reports a verified JWT with issuer, audience and scopes", async () => {
    const idp = await getIdp();
    const jwt = await signToken(idp, {
      sub: "user-42",
      scope: "extract.ingest extract.delete",
      tenant: "tenant-a",
    });
    const response = await request(
      app({
        AUTHN_MODE: "oidc",
        TENANT_ISOLATION_ENABLED: "true",
        API_OIDC_ISSUERS: JSON.stringify([
          { issuer: idp.issuer, audience: "atf-extract", tenantClaim: "tenant" },
        ]),
      }),
    )
      .get("/v1/whoami")
      .set("Authorization", `Bearer ${jwt}`);
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("jwt");
    expect(response.body.subject).toBe("user-42");
    expect(response.body.tenantId).toBe("tenant-a");
    expect(response.body.issuer).toBe(idp.issuer);
    expect(response.body.audience).toBe("atf-extract");
    expect(response.body.scopes).toEqual(["extract.ingest", "extract.delete"]);
  });

  it("advertises the mounted capabilities (full instance)", async () => {
    // store + searchClient → all features on
    const response = await request(
      app({ AUTHN_MODE: "disabled" }, { store: createFakeJobStore(), searchClient: stubSearchClient() }),
    ).get("/v1/whoami");
    expect(response.status).toBe(200);
    expect(response.body.source).toBe("anonymous");
    expect(response.body.features).toEqual({
      ingest: true,
      resumableUploads: true,
      deleteByReference: true,
      ownJobRead: true,
    });
  });

  it("advertises no features on a bare instance", async () => {
    const response = await request(app({ AUTHN_MODE: "disabled" })).get("/v1/whoami");
    expect(response.status).toBe(200);
    expect(response.body.features).toEqual({
      ingest: false,
      resumableUploads: false,
      deleteByReference: false,
      ownJobRead: false,
    });
  });

  it("reports maxUploadBytes from MAX_UPLOAD_BYTES", async () => {
    const response = await request(
      app({ AUTHN_MODE: "disabled", MAX_UPLOAD_BYTES: "1048576" }),
    ).get("/v1/whoami");
    expect(response.status).toBe(200);
    expect(response.body.limits.maxUploadBytes).toBe(1_048_576);
  });

  it("answers a shape the shared contract accepts", async () => {
    const { whoamiResponseSchema } = await import("@atf/extract-contract/v2");
    const response = await request(app({ AUTHN_MODE: "disabled" })).get("/v1/whoami");
    expect(() => whoamiResponseSchema.parse(response.body)).not.toThrow();
  });
});

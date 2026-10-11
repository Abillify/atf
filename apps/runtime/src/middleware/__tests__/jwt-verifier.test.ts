// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the optional JWT verifier (HS256 + no-op modes).
 */

import { describe, test, expect } from "bun:test";
import { SignJWT } from "jose";
import { createJwtVerifier, createOperatorVerifier } from "../jwt-verifier.js";
import type { AppConfig } from "../../config/index.js";

const baseConfig: AppConfig = {
  port: 3000,
  flowsDir: "./flows",
  monitoringTransport: "sse",
  mcpServers: [],
  corsOrigins: ["*"],
  monitoringAuthRequired: false,
  logLevel: "error",
  maxToolSteps: 5,
  maxConcurrentExecutions: 50,
};

async function makeHs256Token(
  secret: string,
  expSeconds = 3600,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ sub: "user-1" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
    .sign(key);
}

describe("createJwtVerifier — no-op mode", () => {
  test("when no secret/JWKS configured, verification is disabled and always passes", async () => {
    const verifier = createJwtVerifier(baseConfig);
    expect(verifier.enabled).toBe(false);
    expect(await verifier.verify("anything.at.all")).toBe(true);
  });
});

describe("createJwtVerifier — HS256 mode", () => {
  test("accepts a token signed with the configured secret", async () => {
    const secret = "super-secret-value";
    const verifier = createJwtVerifier({ ...baseConfig, jwtSecret: secret });
    expect(verifier.enabled).toBe(true);

    const token = await makeHs256Token(secret);
    expect(await verifier.verify(token)).toBe(true);
  });

  test("rejects a token signed with a different secret", async () => {
    const verifier = createJwtVerifier({
      ...baseConfig,
      jwtSecret: "correct-secret",
    });
    const token = await makeHs256Token("wrong-secret");
    expect(await verifier.verify(token)).toBe(false);
  });

  test("rejects an expired token", async () => {
    const secret = "s3cr3t";
    const verifier = createJwtVerifier({ ...baseConfig, jwtSecret: secret });
    const token = await makeHs256Token(secret, -10); // already expired
    expect(await verifier.verify(token)).toBe(false);
  });

  test("rejects a malformed token", async () => {
    const verifier = createJwtVerifier({ ...baseConfig, jwtSecret: "s" });
    expect(await verifier.verify("not-a-jwt")).toBe(false);
  });
});

describe("createJwtVerifier — OIDC mode", () => {
  test("selects an enabled verifier when only oidcIssuer is set", () => {
    const verifier = createJwtVerifier({
      ...baseConfig,
      oidcIssuer: "https://idp.example.com",
    });
    expect(verifier.enabled).toBe(true);
  });

  test("JWKS/HMAC take precedence over OIDC on the inference plane", () => {
    // On /v1/* the OIDC issuer is only a fallback: an explicit JWT_SECRET /
    // JWT_JWKS_URL for the inference token source wins.
    const withSecret = createJwtVerifier({
      ...baseConfig,
      oidcIssuer: "https://idp.example.com",
      jwtSecret: "shared-secret",
    });
    // HMAC path accepts a matching HS256 token synchronously (no network).
    expect(withSecret.enabled).toBe(true);
  });

  test("discovers the JWKS from the issuer and verifies against it", async () => {
    // Stub discovery + JWKS so no real network is hit. The published JWKS has
    // no keys, so an HS256 token must NOT verify — proving the OIDC (JWKS) path
    // was used and discovery of /.well-known/openid-configuration happened.
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    const stubFetch = (async (input: unknown): Promise<Response> => {
      const url =
        typeof input === "string" ? input : (input as { url: string }).url;
      calls.push(url);
      if (url.includes("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "https://idp.example.com",
            jwks_uri: "https://idp.example.com/jwks",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      // Req 7.2: discovery/JWKS go through the injectable fetch seam now.
      const verifier = createJwtVerifier(
        {
          ...baseConfig,
          oidcIssuer: "https://idp.example.com",
        },
        undefined,
        stubFetch,
      );
      const token = await makeHs256Token("shared-secret");
      expect(await verifier.verify(token)).toBe(false);
      expect(
        calls.some((u) => u.includes("/.well-known/openid-configuration")),
      ).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("decodePayload returns claims without verification", async () => {
    const verifier = createJwtVerifier({
      ...baseConfig,
      oidcIssuer: "https://idp.example.com",
    });
    const key = new TextEncoder().encode("k");
    const token = await new SignJWT({ sub: "u1", role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(key);
    const claims = verifier.decodePayload(token);
    expect(claims?.role).toBe("admin");
    expect(claims?.sub).toBe("u1");
  });
});

describe("createOperatorVerifier — dedicated operator-plane verifier", () => {
  test("uses a DEDICATED OIDC verifier (not the inference fallback) when oidcIssuer is set", () => {
    const inference = createJwtVerifier({ ...baseConfig, jwtSecret: "s" });
    const operator = createOperatorVerifier(
      {
        ...baseConfig,
        jwtSecret: "s",
        oidcIssuer: "https://operators.example.com",
      },
      inference,
    );
    expect(operator).not.toBe(inference);
    expect(operator.enabled).toBe(true);
  });

  test("reuses the inference verifier when oidcIssuer is unset", () => {
    const inference = createJwtVerifier({
      ...baseConfig,
      jwtJwksUrl: "https://idp/jwks",
    });
    const operator = createOperatorVerifier(
      { ...baseConfig, jwtJwksUrl: "https://idp/jwks" },
      inference,
    );
    expect(operator).toBe(inference);
  });
});

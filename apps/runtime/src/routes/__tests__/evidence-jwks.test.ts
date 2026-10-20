// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the public evidence-chain JWKS route (ADR 0030) — the endpoint
 * that lets third parties verify Ed25519 audit anchors, Evidence Bundles, and
 * Erasure Receipts offline, without any shared secret.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createEvidenceJwksRouter } from "../evidence-jwks.js";
import { parseEvidenceSigningKey } from "../../observability/evidence-key.js";

const SEED_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString(
  "base64",
);

describe("GET /.well-known/atf-evidence-jwks.json", () => {
  it("publishes the Ed25519 public key with kid/alg/use", async () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const app = new Hono();
    app.route("/", createEvidenceJwksRouter(key));
    const res = await app.request("/.well-known/atf-evidence-jwks.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("public");
    const body = (await res.json()) as {
      keys: { kid: string; kty: string; crv: string; x: string; alg: string; use: string }[];
    };
    expect(body.keys).toHaveLength(1);
    const jwk = body.keys[0];
    expect(jwk.kid).toBe(key.kid);
    expect(jwk.kty).toBe("OKP");
    expect(jwk.crv).toBe("Ed25519");
    expect(jwk.x).toBe(key.jwk.x);
    expect(jwk.alg).toBe("EdDSA");
    expect(jwk.use).toBe("sig");
    // The private key must never leak into the public JWKS.
    expect(jwk).not.toHaveProperty("d");
  });
});

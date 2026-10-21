// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { buildVerifiedEvidencePack } from "../src/evidence-pack.js";
import {
  evidenceJwks,
  evidencePackSigningBytes,
  parseEvidenceSigningKey,
  signEvidencePack,
} from "../src/evidence-signing.js";

const instant = new Date("2026-03-01T00:00:00.000Z");

function pack() {
  return buildVerifiedEvidencePack({
    collection: "documents",
    query: "miete",
    effectiveQuery: "miete",
    accessScopeFingerprint: "fp",
    results: [
      {
        id: "a",
        score: 0.5,
        content: "Pflichtfeld Lieferant",
        metadata: {},
        reference: "a#0",
        base_ref: "a",
        created: instant,
        modified: instant,
        valid_from: null,
        effective_valid_from: instant,
      } as never,
    ],
    requestedLimit: 5,
    retrievedAt: instant.toISOString(),
    hybrid: true,
    hydeApplied: false,
    reranked: false,
    includeAllVersions: false,
    candidateMultiplier: 4,
    fetchLimit: 20,
    sparseApplied: false,
  });
}

describe("evidence pack signing", () => {
  it("returns null without a key and leaves the pack unsigned", () => {
    expect(parseEvidenceSigningKey(undefined)).toBeNull();
    expect(parseEvidenceSigningKey("  ")).toBeNull();
    expect(pack()).not.toHaveProperty("signature");
  });

  it("rejects malformed key material", () => {
    expect(() => parseEvidenceSigningKey("not-a-key")).toThrow(/SEARCH_EVIDENCE_SIGNING_KEY/);
  });

  it("signature verifies with the published JWK (PEM key)", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const key = parseEvidenceSigningKey(pem);
    if (key === null) throw new Error("key not parsed");
    const signed = signEvidencePack(pack(), key);
    const signature = signed.signature?.value ?? "";
    expect(signed.signature?.alg).toBe("EdDSA");
    expect(signed.signature?.kid).toBe(key.kid);

    const jwk = evidenceJwks(key).keys[0];
    expect(jwk.kid).toBe(key.kid);
    const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    const ok = verify(
      null,
      evidencePackSigningBytes(signed),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);

    const tampered = { ...signed, resultCount: 99 };
    expect(
      verify(
        null,
        evidencePackSigningBytes(tampered),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
  });

  it("accepts a base64 seed and yields the same kid as the PEM form", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
    const fromSeed = parseEvidenceSigningKey(seed.toString("base64"));
    const fromPem = parseEvidenceSigningKey(
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    );
    expect(fromSeed?.kid).toBe(fromPem?.kid);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import {
  evidencePublicKeyFromRaw,
  parseEvidenceSigningKey,
  signEvidenceBytes,
  verifyEvidenceBytes,
} from "../evidence-key.js";

/** Deterministic 32-byte seed for reproducible keys in tests. */
const SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const SEED_B64 = Buffer.from(SEED).toString("base64");

function generatePem(): string {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

describe("parseEvidenceSigningKey", () => {
  it("returns undefined for undefined or blank input", () => {
    expect(parseEvidenceSigningKey(undefined)).toBeUndefined();
    expect(parseEvidenceSigningKey("")).toBeUndefined();
    expect(parseEvidenceSigningKey("   ")).toBeUndefined();
  });

  it("parses a base64 32-byte seed and derives kid + JWK", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    expect(key).toBeDefined();
    const k = key as NonNullable<typeof key>;
    expect(k.publicKeyRaw.length).toBe(32);
    expect(k.kid).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(k.jwk.kty).toBe("OKP");
    expect(k.jwk.crv).toBe("Ed25519");
    expect(k.jwk.kid).toBe(k.kid);
  });

  it("is deterministic: same seed yields same kid", () => {
    const a = parseEvidenceSigningKey(SEED_B64);
    const b = parseEvidenceSigningKey(SEED_B64);
    expect(a?.kid).toBe(b?.kid);
  });

  it("parses a PEM PKCS#8 private key", () => {
    const pem = generatePem();
    const key = parseEvidenceSigningKey(pem);
    expect(key).toBeDefined();
    expect((key as NonNullable<typeof key>).publicKeyRaw.length).toBe(32);
  });

  it("throws on a non-32-byte base64 seed", () => {
    expect(() => parseEvidenceSigningKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /EVIDENCE_SIGNING_KEY/,
    );
  });

  it("throws on a malformed PEM", () => {
    expect(() => parseEvidenceSigningKey("-----BEGIN PRIVATE KEY-----\nbroken\n")).toThrow(
      /EVIDENCE_SIGNING_KEY/,
    );
  });
});

describe("signEvidenceBytes / verifyEvidenceBytes", () => {
  it("round-trips a signature over a string", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const sig = signEvidenceBytes(key, "the quick brown fox");
    expect(verifyEvidenceBytes(key.publicKeyRaw, "the quick brown fox", sig)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const sig = signEvidenceBytes(key, '{"a":1}');
    expect(verifyEvidenceBytes(key.publicKeyRaw, '{"a":2}', sig)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = parseEvidenceSigningKey(SEED_B64);
    const b = parseEvidenceSigningKey(Buffer.alloc(32, 9).toString("base64"));
    if (a === undefined || b === undefined) throw new Error("expected keys");
    const sig = signEvidenceBytes(a, "payload");
    expect(verifyEvidenceBytes(b.publicKeyRaw, "payload", sig)).toBe(false);
  });

  it("never throws on malformed signature input", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    expect(verifyEvidenceBytes(key.publicKeyRaw, "payload", "not base64url at all!!")).toBe(false);
    expect(verifyEvidenceBytes(key.publicKeyRaw, "payload", "")).toBe(false);
  });

  it("accepts a KeyObject public key imported from raw bytes", () => {
    const key = parseEvidenceSigningKey(SEED_B64);
    if (key === undefined) throw new Error("expected a key");
    const pub = evidencePublicKeyFromRaw(key.publicKeyRaw);
    const sig = signEvidenceBytes(key, "bytes");
    expect(verifyEvidenceBytes(pub, "bytes", sig)).toBe(true);
  });

  it("throws on a raw public key of wrong length", () => {
    expect(() => evidencePublicKeyFromRaw(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the AES-256-GCM SecretCipher.
 */

import { describe, it, expect } from "bun:test";
import crypto from "node:crypto";
import {
  SecretCipher,
  createSecretCipher,
  InvalidEncryptionKeyError,
  SecretDecryptError,
} from "../secret-cipher.js";

const key = () => crypto.randomBytes(32);
const b64key = () => crypto.randomBytes(32).toString("base64");

describe("SecretCipher", () => {
  it("round-trips a secret", () => {
    const c = new SecretCipher(key());
    const secret = "sk-proj-abcdef1234567890";
    const token = c.encrypt(secret);
    expect(token).not.toContain(secret);
    expect(c.decrypt(token)).toBe(secret);
  });

  it("produces a different token each time (random IV) but decrypts to the same value", () => {
    const c = new SecretCipher(key());
    const a = c.encrypt("same");
    const b = c.encrypt("same");
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe("same");
    expect(c.decrypt(b)).toBe("same");
  });

  it("rejects a key of the wrong length", () => {
    expect(() => new SecretCipher(crypto.randomBytes(16))).toThrow(
      InvalidEncryptionKeyError,
    );
  });

  it("fails to decrypt with a different key", () => {
    const token = new SecretCipher(key()).encrypt("secret");
    expect(() => new SecretCipher(key()).decrypt(token)).toThrow(
      SecretDecryptError,
    );
  });

  it("fails to decrypt a tampered token", () => {
    const c = new SecretCipher(key());
    const token = c.encrypt("secret");
    const buf = Buffer.from(token, "base64");
    const lastByte = buf[buf.length - 1];
    if (lastByte === undefined) throw new Error("expected a non-empty token");
    buf[buf.length - 1] = (lastByte ^ 0xff) & 0xff; // flip a ciphertext bit
    expect(() => c.decrypt(buf.toString("base64"))).toThrow(SecretDecryptError);
  });

  it("rejects a too-short token", () => {
    const c = new SecretCipher(key());
    expect(() => c.decrypt(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(
      SecretDecryptError,
    );
  });

  describe("associated data (AAD) binding", () => {
    it("round-trips a secret when the same AAD is supplied on encrypt and decrypt", () => {
      const c = new SecretCipher(key());
      const token = c.encrypt("sk-tenant-a", "tenant:a:openai");
      expect(c.decrypt(token, "tenant:a:openai")).toBe("sk-tenant-a");
    });

    it("fails to decrypt with a DIFFERENT aad than was used to encrypt (cross-tenant regression)", () => {
      // This is the exact scenario the AAD binding closes: a ciphertext
      // encrypted for tenant A's row decrypted as if it belonged to tenant B.
      const c = new SecretCipher(key());
      const token = c.encrypt("sk-tenant-a", "tenant:a:openai");
      expect(() => c.decrypt(token, "tenant:b:openai")).toThrow(
        SecretDecryptError,
      );
    });

    it("fails to decrypt a version-2 (AAD) token with NO aad supplied", () => {
      const c = new SecretCipher(key());
      const token = c.encrypt("secret", "ctx");
      expect(() => c.decrypt(token)).toThrow(SecretDecryptError);
    });

    it("a token encrypted WITHOUT aad still decrypts without aad (back-compat, version 1)", () => {
      const c = new SecretCipher(key());
      const token = c.encrypt("legacy-secret"); // no aad — version-1 format
      expect(c.decrypt(token)).toBe("legacy-secret");
    });

    it("a token encrypted WITHOUT aad ignores an aad passed at decrypt time", () => {
      // Version-1 tokens were never bound to any context, so a caller passing
      // an aad against an old (pre-AAD) row must not break — the version byte
      // decides which mode applies, not the presence of a decrypt-time aad.
      const c = new SecretCipher(key());
      const token = c.encrypt("legacy-secret");
      expect(c.decrypt(token, "some-context")).toBe("legacy-secret");
    });
  });
});

describe("createSecretCipher", () => {
  it("returns undefined when no key is configured", () => {
    expect(createSecretCipher(undefined)).toBeUndefined();
    expect(createSecretCipher("   ")).toBeUndefined();
  });

  it("builds a working cipher from a base64 key", () => {
    const c = createSecretCipher(b64key());
    expect(c).toBeInstanceOf(SecretCipher);
    if (c === undefined) throw new Error("expected a cipher");
    expect(c.decrypt(c.encrypt("x"))).toBe("x");
  });

  it("throws on a malformed key length", () => {
    expect(() =>
      createSecretCipher(Buffer.from("short").toString("base64")),
    ).toThrow(InvalidEncryptionKeyError);
  });
});

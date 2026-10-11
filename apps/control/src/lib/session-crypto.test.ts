// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";

import {
  deriveSessionKey,
  sealSessionPayload,
  unsealSessionPayload,
  MIN_SESSION_SECRET_LENGTH,
  type SessionPayload,
} from "./session-crypto";

const SECRET = "x".repeat(MIN_SESSION_SECRET_LENGTH);

function payload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    token: "header.payload.signature",
    role: "operator",
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

/** Derives the key or fails the test — keeps the assertions free of `!`. */
async function key(secret: string = SECRET): Promise<CryptoKey> {
  const derived = await deriveSessionKey(secret);
  if (derived === null) throw new Error("expected a derived session key");
  return derived;
}

describe("deriveSessionKey", () => {
  test("returns null for a secret shorter than the minimum", async () => {
    expect(await deriveSessionKey("short")).toBeNull();
    expect(await deriveSessionKey("")).toBeNull();
  });

  test("accepts a secret at exactly the minimum length", async () => {
    const key = await deriveSessionKey("a".repeat(MIN_SESSION_SECRET_LENGTH));
    expect(key).not.toBeNull();
  });
});

describe("sealSessionPayload / unsealSessionPayload", () => {
  test("round-trips the payload through the seal", async () => {
    const k = await key();
    const original = payload();
    const sealed = await sealSessionPayload(original, k);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed.split(".")).toHaveLength(3);
    // The plaintext token must never appear verbatim in the cookie value.
    expect(sealed).not.toContain("header.payload.signature");
    const opened = await unsealSessionPayload(sealed, k);
    expect(opened).toEqual(original);
  });

  test("null role and expiry survive the round-trip", async () => {
    const k = await key();
    const original = payload({ role: null, expiresAt: null });
    const sealed = await sealSessionPayload(original, k);
    expect(await unsealSessionPayload(sealed, k)).toEqual(original);
  });

  test("rejects a tampered ciphertext (GCM auth failure)", async () => {
    const k = await key();
    const sealed = await sealSessionPayload(payload(), k);
    const parts = sealed.split(".");
    const iv = parts[1] ?? "";
    const ct = parts[2] ?? "";
    // Flip the last ciphertext character into a different valid base64url char.
    const flipped = ct.endsWith("A") ? `${ct.slice(0, -1)}B` : `${ct.slice(0, -1)}A`;
    expect(
      await unsealSessionPayload(`v1.${iv}.${flipped}`, k),
    ).toBeNull();
  });

  test("rejects a cookie sealed with a different key", async () => {
    const keyA = await key();
    const keyB = await key(`b${SECRET.slice(1)}`);
    const sealed = await sealSessionPayload(payload(), keyA);
    expect(await unsealSessionPayload(sealed, keyB)).toBeNull();
  });

  test("rejects malformed cookie values", async () => {
    const k = await key();
    for (const bad of [
      "",
      "v1",
      "v1.onlytwoparts",
      "v2.aaa.bbb",
      "v1.!!!.bbb",
      "v1.aaa.!!!",
      "garbage-value",
    ]) {
      expect(await unsealSessionPayload(bad, k)).toBeNull();
    }
  });

  test("drops unknown roles and non-numeric expiry on unseal", async () => {
    // Seal a payload directly through the crypto layer to simulate a cookie
    // written by an older/other producer with unexpected field values.
    const k = await key();
    const forged = JSON.stringify({
      token: "t",
      role: "superuser",
      expiresAt: "soon",
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      k,
      new TextEncoder().encode(forged),
    );
    const { base64UrlEncode } = await import("@atf/security-kit/browser");
    const value = `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
    expect(await unsealSessionPayload(value, k)).toEqual({
      token: "t",
      role: null,
      expiresAt: null,
    });
  });

  test("rejects a sealed payload with an empty token", async () => {
    const k = await key();
    const sealed = await sealSessionPayload(payload({ token: "" }), k);
    expect(await unsealSessionPayload(sealed, k)).toBeNull();
  });
});

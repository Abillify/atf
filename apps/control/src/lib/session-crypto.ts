// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Server-side session encryption for the optional BFF mode (Req 8.7).
 *
 * The operator access token must never reach the browser when
 * `CONTROL_SESSION_MODE=bff`; it lives in a cookie that is encrypted with
 * AES-256-GCM (an `iron-session`-style seal, implemented directly on Web
 * Crypto so no new dependency is added — see the Phase-12 design note).
 *
 * Cookie value format: `v1.<iv-b64url>.<ciphertext+tag-b64url>`. The key is
 * `SHA-256(CONTROL_SESSION_SECRET)`; the secret must be at least 32
 * characters (fail closed otherwise — an unset or short secret disables the
 * BFF rather than falling back to a guessable key).
 *
 * Server-only: uses SubtleCrypto and the deployment secret; never import
 * from client components.
 */

import { base64UrlDecode, base64UrlEncode } from "@atf/security-kit/browser";

/** Minimum secret length before it is accepted as a session key source. */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** A sealed BFF session: the operator token plus the claims the UI needs. */
export interface SessionPayload {
  /** Operator session token (JWT) — server-side only, never sent to the browser. */
  token: string;
  /** Role claim decoded from the token (`null` when absent/unknown). */
  role: string | null;
  /** Token `exp` in seconds since epoch (`null` when the token has none). */
  expiresAt: number | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Derives the AES-256-GCM key from the raw secret (SHA-256). */
export async function deriveSessionKey(
  secret: string,
): Promise<CryptoKey | null> {
  if (secret.length < MIN_SESSION_SECRET_LENGTH) return null;
  const keyBytes = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(secret),
  );
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Encrypts and seals a session payload into a cookie value. */
export async function sealSessionPayload(
  payload: SessionPayload,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(
    new Uint8Array(ciphertext),
  )}`;
}

/**
 * Verifies and decrypts a cookie value. Returns `null` on ANY failure —
 * malformed format, tampered ciphertext (GCM auth), wrong key — so callers
 * treat every failure as "no session" (fail closed).
 */
export async function unsealSessionPayload(
  value: string,
  key: CryptoKey,
): Promise<SessionPayload | null> {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const ivB64 = parts[1];
  const ctB64 = parts[2];
  if (ivB64 === undefined || ctB64 === undefined) return null;
  try {
    const iv = new Uint8Array(base64UrlDecode(ivB64));
    const ciphertext = new Uint8Array(base64UrlDecode(ctB64));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    const parsed = JSON.parse(decoder.decode(plaintext)) as Partial<
      Record<keyof SessionPayload, unknown>
    >;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    return {
      token: parsed.token,
      role:
        parsed.role === "viewer" ||
        parsed.role === "operator" ||
        parsed.role === "admin"
          ? parsed.role
          : null,
      expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
    };
  } catch {
    return null;
  }
}

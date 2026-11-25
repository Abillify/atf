// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AEAD-sealed cookies for the monitor dashboard.
 *
 * The session cookie carries verified id_token claims (subject, e-mail,
 * tenant, tool scopes), so it must be confidential as well as authentic:
 * the browser stores it, and a base64url body with an HMAC would let anyone
 * with access to the cookie jar read those claims. Payloads are sealed with
 * AES-256-GCM instead; the GCM tag replaces the HMAC as the integrity check,
 * so a forged or tampered cookie fails to decrypt — every failure is handled
 * identically (fail closed), exactly like a bad MAC was before.
 *
 * The key is derived from the configured secret with HKDF-SHA256 and a fixed
 * context string, so the cookie key never equals the configured secret and
 * cannot collide with any other use of it. Rotating `monitoring.oidc.sessionSecret`
 * (or the monitoring token, for the token-session cookie) invalidates every
 * cookie sealed under the old key.
 *
 * Wire format: `v1.<base64url(iv || tag || ciphertext)>`.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/** HKDF context string: binds derived keys to this exact use. */
const KEY_INFO = "mcpgate-monitor-cookie/v1";
/** Format marker; a value without it is not a sealed cookie. */
const PREFIX = "v1.";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function cookieKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), Buffer.from(KEY_INFO), 32),
  );
}

/** Seal a JSON payload into a cookie value (AES-256-GCM). */
export function encryptCookiePayload(payload: object, secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", cookieKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/**
 * Open a cookie value. Returns `undefined` on any failure — wrong key,
 * tampered payload, foreign or pre-sealing format — without distinguishing
 * them, so callers cannot probe why a cookie was rejected.
 */
export function decryptCookiePayload<T>(
  value: string | undefined,
  secret: string,
): T | undefined {
  if (!value?.startsWith(PREFIX)) return undefined;
  const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cookieKey(secret),
      raw.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Secret cipher (`src/graph/secret-cipher.ts`)
 *
 * Symmetric authenticated encryption (AES-256-GCM) for secrets that must be
 * stored *reversibly* — unlike an incoming API key (stored as a one-way hash for
 * verification), a tenant's BYOK provider key has to be recovered to actually
 * call the provider. Storing such a secret in plaintext in a database is a
 * liability; this cipher encrypts it at rest with a key held only in the
 * environment/secret store, so a database compromise alone does not leak it.
 *
 * Token format (base64): `version(1) | iv(12) | authTag(16) | ciphertext`.
 * AES-GCM provides confidentiality *and* integrity — a tampered token fails to
 * decrypt rather than returning garbage.
 *
 * ## Associated data (AAD) binding
 *
 * `encrypt`/`decrypt` accept an optional `aad` (Additional Authenticated Data)
 * string. When supplied, the ciphertext is bound to that context via GCM's AAD
 * mechanism: decrypting with a DIFFERENT (or absent) `aad` than the one used to
 * encrypt fails the auth-tag check, even with the correct key. Callers pass a
 * stable identifier of the row's owner — e.g. `${tenantId}:${provider}` for a
 * BYOK key — so that copying an `encrypted_key` column value from one tenant's
 * row into another's (a SQL-injection, backup-restore, or insider-access
 * scenario) produces a ciphertext that no longer decrypts, instead of silently
 * decrypting under the *wrong* tenant's authority. Without this, GCM alone only
 * proves the ciphertext was produced by a holder of the key — it says nothing
 * about *which* record it was meant for, since the key is shared across every
 * row.
 *
 * Tokens written with `aad` use format version 2; tokens written without it
 * (or by a version predating this feature) use version 1. Both remain
 * decryptable with their original `aad` (or lack thereof) — this is a strict
 * addition, not a breaking format change. A version-2 token decrypted with a
 * missing or mismatched `aad` throws {@link SecretDecryptError}, exactly like a
 * tampered ciphertext or wrong key (the failure is indistinguishable from the
 * caller's perspective, which is the point: no separate "AAD mismatch" oracle).
 *
 * The encryption key is supplied as base64 of exactly 32 bytes (256-bit). Use
 * `openssl rand -base64 32` to generate one. Pure aside from the system CSPRNG;
 * round-trips are fully unit-testable.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** No associated data was bound at encryption time (pre-AAD format). */
const VERSION_NO_AAD = 1;
/** Associated data WAS bound at encryption time; required again to decrypt. */
const VERSION_WITH_AAD = 2;

export class InvalidEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEncryptionKeyError";
  }
}

export class SecretDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretDecryptError";
  }
}

/** Authenticated symmetric cipher for at-rest secret storage. */
export class SecretCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new InvalidEncryptionKeyError(
        `Encryption key must be ${KEY_BYTES} bytes (got ${key.length}).`,
      );
    }
    this.key = key;
  }

  /**
   * Encrypts a UTF-8 string, returning a self-describing base64 token. When
   * `aad` is supplied, the ciphertext is bound to it (see the module doc) —
   * pass the same `aad` to {@link decrypt}, or decryption fails.
   */
  encrypt(plaintext: string, aad?: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    const version = aad !== undefined ? VERSION_WITH_AAD : VERSION_NO_AAD;
    return Buffer.concat([
      Buffer.from([version]),
      iv,
      tag,
      ciphertext,
    ]).toString("base64");
  }

  /**
   * Decrypts a token produced by {@link encrypt}. Throws on tamper, wrong key,
   * or — for a token encrypted with `aad` — a missing/mismatched `aad`.
   */
  decrypt(token: string, aad?: string): string {
    let buf: Buffer;
    try {
      buf = Buffer.from(token, "base64");
    } catch {
      throw new SecretDecryptError("Token is not valid base64.");
    }
    if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
      throw new SecretDecryptError("Token is too short to be a valid secret.");
    }
    const version = buf[0];
    if (version !== VERSION_NO_AAD && version !== VERSION_WITH_AAD) {
      throw new SecretDecryptError(
        `Unsupported secret token version ${String(version)}.`,
      );
    }
    const iv = buf.subarray(1, 1 + IV_BYTES);
    const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
      // A version-1 (no-AAD) token must decrypt WITHOUT AAD even if the caller
      // passes one — `setAAD` changes the tag computation, so mismatching modes
      // here would always fail. A version-2 token requires the caller's `aad`
      // to match exactly what was used at encryption time.
      if (version === VERSION_WITH_AAD && aad !== undefined) {
        decipher.setAAD(Buffer.from(aad, "utf8"));
      }
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new SecretDecryptError(
        "Failed to decrypt secret (wrong key, mismatched context, or tampered token).",
      );
    }
  }
}

/**
 * Builds a {@link SecretCipher} from a base64-encoded 256-bit key, or undefined
 * when no key is configured. Throws {@link InvalidEncryptionKeyError} when the
 * key is present but malformed (wrong length / not base64) so a misconfiguration
 * fails loudly rather than silently disabling encryption.
 */
export function createSecretCipher(
  base64Key: string | undefined,
): SecretCipher | undefined {
  if (base64Key === undefined || base64Key.trim().length === 0)
    return undefined;
  let key: Buffer;
  try {
    key = Buffer.from(base64Key.trim(), "base64");
  } catch {
    throw new InvalidEncryptionKeyError("Encryption key must be valid base64.");
  }
  return new SecretCipher(key);
}

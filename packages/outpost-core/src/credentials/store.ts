// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Credential_Store abstraction (requirements 1.10, 15.4).
 *
 * Every failure is reported as {@link CredentialStoreError}; there is never a
 * plaintext fallback (15.4) — callers must discard the secret and surface the
 * error instead of writing it somewhere less safe.
 */

export interface CredentialStore {
  /** Returns the stored value or `null` when the key does not exist. */
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`, replacing any previous value. */
  set(key: string, value: string): Promise<void>;
  /** Removes `key`; deleting a non-existent key is a no-op (idempotent). */
  delete(key: string): Promise<void>;
}

/** Raised on any Credential_Store access failure (15.4). */
export class CredentialStoreError extends Error {
  constructor(
    message: string,
    readonly options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

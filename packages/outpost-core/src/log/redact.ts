// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Secret redaction for log output (requirements 4.6, 11.2).
 *
 * Two complementary mechanisms:
 *
 * 1. Path-based redaction ({@link REDACT_PATHS}) applied by pino: values under
 *    well-known key names (`authorization`, `*.token`, `*.secret`,
 *    `*.refresh_token`, `*.client_secret`) never reach the stream.
 * 2. Value-based redaction ({@link SecretRedactor}): every secret is
 *    registered when it is loaded (from the Credential_Store, the
 *    environment, or a `_FILE`), and any occurrence of a registered value is
 *    replaced in the serialized log line. This catches secrets stored under
 *    arbitrary key names.
 */

/** Replacement written in place of a redacted value. */
export const REDACTION_MARKER = "[REDACTED]";

/**
 * Key paths redacted by pino's `redact` option (fast-redact syntax), exactly
 * as specified in the design.
 */
export const REDACT_PATHS: readonly string[] = [
  "authorization",
  "*.authorization",
  "*.token",
  "*.secret",
  "*.refresh_token",
  "*.client_secret",
];

/**
 * Collects known secret values and removes them from arbitrary text.
 * Registration happens wherever a secret is loaded; redaction happens at
 * write time, so values registered after logger creation still apply.
 */
export class SecretRedactor {
  private readonly values = new Set<string>();

  /** Register a secret value so future output never contains it verbatim. */
  register(value: string): void {
    // An empty value would match everywhere and destroy the log line.
    if (value.length === 0) return;
    this.values.add(value);
  }

  /** Replace every registered secret occurrence with {@link REDACTION_MARKER}. */
  redact(text: string): string {
    if (this.values.size === 0) return text;
    let out = text;
    for (const secret of this.values) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTION_MARKER);
    }
    return out;
  }

  /** Number of registered values (never exposes the values themselves). */
  get size(): number {
    return this.values.size;
  }
}

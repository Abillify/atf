// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Canonical JSON used for fingerprints. Keys are sorted by UTF-16 code unit
 * (`<`/`>`), never by `localeCompare`, so the digest is locale-independent
 * (Req 6.4).
 */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** SHA-256 HMAC over `data`, base64url-encoded (no padding). */
export function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Constant-time comparison of two signatures; false on length mismatch. */
export function signaturesMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}


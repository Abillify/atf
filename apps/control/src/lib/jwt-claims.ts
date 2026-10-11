// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Minimal JWT claim decoding shared by client and server (no signature
 * verification — used only for UI role display and renewal scheduling;
 * every authorisation decision is made by the backend).
 *
 * Decoding goes through the shared padding-correct base64url codec from
 * `@atf/security-kit/browser` (Req 8.5).
 */

import { base64UrlDecodeToString } from "@atf/security-kit/browser";

export type JwtRoleClaim = "viewer" | "operator" | "admin";

export interface JwtClaims {
  /** The `role` claim when it is one of the known roles, else `null`. */
  role: JwtRoleClaim | null;
  /** The `exp` claim in seconds since epoch when numeric, else `null`. */
  exp: number | null;
}

export function decodeJwtClaims(token: string): JwtClaims {
  const parts = token.split(".");
  const empty: JwtClaims = { role: null, exp: null };
  if (parts.length !== 3) return empty;
  const payloadB64 = parts[1];
  if (payloadB64 === undefined) return empty;
  try {
    const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as {
      role?: unknown;
      exp?: unknown;
    };
    return {
      role:
        payload.role === "viewer" ||
        payload.role === "operator" ||
        payload.role === "admin"
          ? payload.role
          : null,
      exp: typeof payload.exp === "number" ? payload.exp : null,
    };
  } catch {
    return empty;
  }
}

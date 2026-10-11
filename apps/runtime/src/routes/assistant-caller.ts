// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Caller identity for the assistant plane (`src/routes/assistant-caller.ts`).
 *
 * One implementation, deliberately. Every assistant route and the model listing
 * decide what a request may reach from the caller's identity, so two copies of this
 * extraction would be two isolation boundaries that can drift apart — and the drift
 * would show up as one surface admitting a request the other rejects.
 *
 * Reads the same headers the chat path reads. It does NOT accept an identity from a
 * body or a query string: on this plane the caller's identity decides what they may
 * touch, so a client-supplied one would be an authorisation bypass.
 */

import type { AuthPrincipal } from "../middleware/auth.js";

/** The identity signals the assistant plane scopes by. */
export interface AssistantCaller {
  userId?: string;
  tenantId?: string;
  userName?: string;
}

export function resolveAssistantCaller(
  headers: Headers,
  principal?: AuthPrincipal,
): AssistantCaller {
  const userId =
    (typeof principal?.claims?.sub === "string"
      ? principal.claims.sub
      : undefined) ??
    (typeof principal?.claims?.email === "string"
      ? principal.claims.email
      : undefined) ??
    headers.get("X-OpenWebUI-User-Id") ??
    headers.get("X-OpenWebUI-User-Email") ??
    undefined;
  // Req 7.4: once the auth middleware supplied a principal, the tenant is
  // whatever that principal resolved from verified claims (or the deployment
  // default) — a request header must never substitute or re-fill it, even when
  // the principal itself carries no tenant. The header fallback therefore
  // applies only when there is no principal at all, i.e. routers directly
  // embedded without the platform auth middleware.
  //
  // `X-Mandant-Id` is the pre-1.0 spelling of `X-Tenant-Id`, still accepted so
  // existing callers keep working. Prefer `X-Tenant-Id`; the legacy name will be
  // dropped in a future major.
  const tenantId =
    principal !== undefined
      ? principal.tenantId
      : (headers.get("X-Tenant-Id") ??
        headers.get("X-Mandant-Id") ??
        undefined);
  const rawName = headers.get("X-OpenWebUI-User-Name");
  let userName: string | undefined;
  if (rawName !== null) {
    try {
      userName = decodeURIComponent(rawName);
    } catch {
      // A malformed percent-encoding is cosmetic here; the raw value still serves as
      // a display name and must not fail the request.
      userName = rawName;
    }
  }
  return {
    ...(userId !== undefined ? { userId } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(userName !== undefined ? { userName } : {}),
  };
}

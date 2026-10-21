// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Actor, GatePrincipalInput } from "@atf/identity-contract";

/**
 * The acting party of a delegated (RFC 8693 on-behalf-of) token. The `subject`
 * stays the end user; this names the service that acted for them. The shape is
 * the shared `Actor` from `@atf/identity-contract` (Req 11.3).
 */
export type ActorContext = Actor;

/**
 * Request-scoped, verified security context supplied to every tool invocation.
 * The identity fields (method/subject/username/scopes/claims/tenantId/actor)
 * come from `GatePrincipalInput` in `@atf/identity-contract` (Req 11.3); the
 * Gate adds request-scoped transport fields on top.
 */
export interface AuthContext extends GatePrincipalInput {
  /** Verified claim aliases used to detect forbidden header-based tenant bindings. */
  tenantClaimNames?: string[];
  /** Non-authoritative request metadata. Never use headers for tenant/security decisions. */
  headers: Record<string, string>;
  rawToken: string;
  sessionId?: string;
}

export function verifiedTenantClaim(
  ctx: Pick<AuthContext, "claims">,
  claimNames: readonly string[] = ["tenant_id", "tenant", "tid", "client_id"],
): string | undefined {
  const values = claimNames
    .map((key) => ctx.claims[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const unique = [...new Set(values)];
  if (unique.length > 1) {
    throw new Error(`Authenticated tenant claims ${claimNames.join("/")} conflict`);
  }
  return unique[0];
}

/**
 * Context paths that hand out the caller's bearer token. Binding them would
 * copy the credential into SQL parameters, URLs, bodies and from there into
 * logs and downstream systems; tools that need it use the dedicated token
 * exchange or passthrough features.
 */
export const FORBIDDEN_CONTEXT_PATHS: readonly string[] = ["rawToken", "headers.authorization"];

/** The forbidden context path `path` names, or undefined (case-insensitive). */
export function forbiddenContextPath(path: string): string | undefined {
  const lowered = path.trim().toLowerCase();
  return FORBIDDEN_CONTEXT_PATHS.find((forbidden) => forbidden.toLowerCase() === lowered);
}

/** Resolve a dotted context path while preventing request headers becoming security authority. */
export function resolveContextPath(ctx: AuthContext, path: string): unknown {
  const forbidden = forbiddenContextPath(path);
  if (forbidden !== undefined) throw new Error(`Binding :ctx.${forbidden} is not allowed`);
  if (path.startsWith("headers.")) {
    const normalizedHeader = path.slice("headers.".length).replace(/[^a-z0-9]/gi, "").toLowerCase();
    const aliases = [
      "tenant",
      "org",
      "organization",
      "security",
      ...(ctx.tenantClaimNames ?? []),
    ].map((name) => name.replace(/[^a-z0-9]/gi, "").toLowerCase());
    if (aliases.some((alias) => alias.length > 0 && normalizedHeader.includes(alias))) {
      throw new Error("Tenant/security bindings must use :ctx.tenantId, never request headers");
    }
  }
  const parts = path.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

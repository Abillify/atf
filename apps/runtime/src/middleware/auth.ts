// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auth Middleware (`src/middleware/auth.ts`)
 *
 * Responsible for extracting and validating the credential from every request
 * that hits a `/v1/` route. Sources in priority order:
 *   1. `Authorization: Bearer <token>` header
 *   2. `body.metadata.token` (Open WebUI pipe / n8n webhook style)
 *   3. `token` cookie (Open WebUI OAuth connection mode)
 *
 * Two credential KINDS are accepted from those sources:
 *   - a JWT (3-segment Base64URL), optionally signature-verified;
 *   - a managed aiperator API key (`aip-…`), resolved against the tenant store.
 *
 * The API-key path exists because `POST /admin/tenants/:id/keys` issues such
 * keys and the documentation promises machine clients can use them directly,
 * "without needing to issue full JWTs". Without this branch an issued key was
 * run through `isValidJwtFormat()`, failed the shape check and produced a 401 —
 * indistinguishable from a wrong key, so the platform rejected the very
 * credentials it had just minted.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import type { RuntimePrincipalInput } from "@atf/identity-contract";
import type { MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import type { JwtVerifier } from "./jwt-verifier.js";
import {
  API_KEY_PREFIX,
  type ResolvedApiKeyIdentity,
} from "./api-key-auth.js";

// ---------------------------------------------------------------------------
// Context keys
// ---------------------------------------------------------------------------

/** Hono context key under which the validated SSO token is stored. */
export const TOKEN_KEY = "sso_token" as const;
/** Verified/synthetic identity established once by the auth middleware. */
export const AUTH_PRINCIPAL_KEY = "auth_principal" as const;

/**
 * The middleware principal shape is the shared identity contract
 * (`RuntimePrincipalInput` from `@atf/identity-contract`, Req 11.3) — the
 * Runtime no longer keeps its own copy of the wire shape.
 */
export type AuthPrincipal = RuntimePrincipalInput;

/**
 * Resolves the canonical tenant claim from an authenticated token payload.
 * Keep this precedence in one place so every principal uses the same identity.
 */
export function resolveTenantClaim(
  claims: Record<string, unknown> | null,
): string | undefined {
  if (typeof claims?.tenant_id === "string" && claims.tenant_id !== "") {
    return claims.tenant_id;
  }
  if (typeof claims?.client_id === "string" && claims.client_id !== "") {
    return claims.client_id;
  }
  if (typeof claims?.tid === "string" && claims.tid !== "") {
    return claims.tid;
  }
  return undefined;
}

/**
 * Derives a stable owner from the identity established by auth middleware.
 * The raw credential is retained only as a compatibility fallback for legacy
 * contexts that do not carry a tenant identity.
 */
export function deriveAuthenticatedOwner(
  principal: AuthPrincipal | undefined,
  rawCredential: string,
): string {
  return principal?.tenantId ?? rawCredential;
}

export interface AuthMiddlewareOptions {
  mode?: "disabled" | "token" | "oidc" | "token_or_oidc";
  tenantIsolationEnabled?: boolean;
  defaultTenantId?: string;
  /** Issuer → allowed tenants (`JWT_ISSUER_TENANTS`); see {@link issuerMayClaimTenant}. */
  issuerTenants?: Record<string, readonly string[]>;
}

/**
 * Whether a verified token from `issuer` may assert `tenantId`. Several
 * issuers can be trusted at once; without a binding each of them could claim
 * any tenant, so a user of one IdP application would act inside another
 * application's tenant. A token without `iss` is looked up under `""`.
 */
export function issuerMayClaimTenant(
  binding: Record<string, readonly string[]>,
  issuer: string | undefined,
  tenantId: string,
): boolean {
  const allowed = binding[issuer ?? ""];
  return allowed !== undefined && (allowed.includes("*") || allowed.includes(tenantId));
}

/**
 * Hono context key under which the per-request distributed-trace context is
 * stored by the root tracing middleware.
 */
export const TRACE_CONTEXT_KEY = "trace_context" as const;

/**
 * Hono context key carrying the tenant identity resolved from an `aip-…` API
 * key, when the request authenticated that way.
 *
 * This identity is AUTHORITATIVE: it comes from a hash lookup against the
 * tenant store, not from a client-supplied attribute, so it outranks even a
 * verified JWT claim (there is no JWT) and certainly the
 * `X-OpenWebUI-User-*` headers. See `resolveTrustedIdentityField` in
 * `routes/chat/handler.ts` for the surrounding precedence rules.
 */
export const API_KEY_IDENTITY_KEY = "api_key_identity" as const;

/**
 * Resolves a raw `aip-…` key to a tenant identity, or `undefined` when the key
 * is unknown/revoked. Injected so the middleware stays free of a tenant-store
 * dependency (and so the API-key path is simply absent — and cleanly rejected —
 * when tenant management is disabled).
 */
export type ApiKeyResolver = (
  rawKey: string,
) => Promise<ResolvedApiKeyIdentity | undefined>;

/** Minimal W3C trace context shape. */
export interface TraceContextValue {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

// ---------------------------------------------------------------------------
// AuthContext — Hono generic for typed ctx.get / ctx.set
// ---------------------------------------------------------------------------

export interface AuthContext {
  Variables: {
    [TOKEN_KEY]: string;
    [AUTH_PRINCIPAL_KEY]: AuthPrincipal;
    [TRACE_CONTEXT_KEY]?: TraceContextValue;
    [API_KEY_IDENTITY_KEY]?: ResolvedApiKeyIdentity;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the token from an `Authorization: Bearer <token>` header value.
 */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (authHeader === undefined || authHeader === "") return null;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return null;
  const token = authHeader.slice(prefix.length);
  return token.length > 0 ? token : null;
}

/**
 * Extracts `body.metadata.token` from a parsed request body.
 */
export function extractBodyToken(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const metadata = record.metadata;
  if (metadata === null || typeof metadata !== "object") return null;
  const metadataRecord = metadata as Record<string, unknown>;
  const token = metadataRecord.token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/**
 * Extracts the `token` cookie value from a `Cookie` header string.
 * Open WebUI sends its JWT as `token=<jwt>` cookie when using the OAuth
 * connection type (no Authorization header is set in that mode).
 */
export function extractCookieToken(
  cookieHeader: string | undefined,
): string | null {
  if (cookieHeader === undefined || cookieHeader === "") return null;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === "token") {
      const value = part.slice(eqIdx + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * Checks whether `token` has the 3-segment Base64URL format of a JWT.
 * Format-only — no signature verification.
 */
export function isValidJwtFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

// ---------------------------------------------------------------------------
// authMiddleware factory
// ---------------------------------------------------------------------------

/**
 * Hono middleware applied to all `/v1/*` routes.
 *
 * 1. Extracts the credential from Bearer header, body.metadata.token, or the
 *    `token` cookie.
 * 2. If it carries the `aip-` prefix, resolves it as a managed API key against
 *    the tenant store and stores the resulting tenant identity in context.
 * 3. Otherwise treats it as a JWT: format check, then optional signature
 *    verification.
 * 4. Rejects with 401 when no credential is present, the key is unknown, or the
 *    JWT is malformed / fails verification.
 * 5. Stores the credential in context under TOKEN_KEY.
 */
export function authMiddleware(
  verifier?: JwtVerifier,
  apiKeyResolver?: ApiKeyResolver,
  options: AuthMiddlewareOptions = {},
): MiddlewareHandler<AuthContext> {
  return createMiddleware<AuthContext>(async (ctx, next) => {
    const mode = options.mode;
    const defaultTenantId = options.defaultTenantId ?? "default";
    const tenantIsolationEnabled = options.tenantIsolationEnabled ?? false;
    if (mode === "disabled") {
      ctx.set(TOKEN_KEY, "");
      ctx.set(AUTH_PRINCIPAL_KEY, {
        method: "anonymous",
        verified: true,
        claims: {
          sub: "anonymous",
          ...(!tenantIsolationEnabled ? { tenant_id: defaultTenantId } : {}),
        },
        ...(!tenantIsolationEnabled ? { tenantId: defaultTenantId } : {}),
      });
      await next();
      return;
    }

    // 1a. Authorization: Bearer header
    let token = extractBearerToken(ctx.req.header("Authorization"));

    // 1b. body.metadata.token
    if (token === null) {
      let body: unknown;
      try {
        body = await ctx.req.json();
      } catch {
        body = null;
      }
      token = extractBodyToken(body);
    }

    // 1c. token cookie (Open WebUI OAuth mode)
    if (token === null) {
      token = extractCookieToken(ctx.req.header("Cookie"));
    }

    // 2. No token found
    if (token === null) {
      return ctx.json(
        {
          error: {
            message: "Authentication required: no token provided.",
            type: "authentication_error",
          },
        },
        401,
      );
    }

    // 2b. Managed API key (`aip-…`) — resolved instead of JWT-verified.
    //
    // Checked BEFORE the JWT format test: an API key is not a JWT, so running it
    // through `isValidJwtFormat()` would always 401. That was the actual defect —
    // a key minted by `POST /admin/tenants/:id/keys` could never authenticate.
    if (token.startsWith(API_KEY_PREFIX)) {
      if (mode === "oidc") {
        return ctx.json(
          {
            error: {
              message:
                "API key authentication is not accepted in OIDC-only mode.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
      if (apiKeyResolver === undefined) {
        // Tenant management is off, so no key can be valid. Say why rather than
        // returning the generic "invalid token format" that sent operators
        // looking for a malformed key.
        return ctx.json(
          {
            error: {
              message:
                "API key authentication is not enabled on this deployment " +
                "(set TENANT_MANAGEMENT_ENABLED=true). Use a JWT instead.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
      const identity = await apiKeyResolver(token);
      if (identity === undefined) {
        return ctx.json(
          {
            error: {
              message: "Authentication failed: unknown or revoked API key.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
      const tenantId =
        options.tenantIsolationEnabled === false
          ? defaultTenantId
          : identity.tenantId;
      ctx.set(TOKEN_KEY, token);
      ctx.set(API_KEY_IDENTITY_KEY, { ...identity, tenantId });
      ctx.set(AUTH_PRINCIPAL_KEY, {
        method: "api_key",
        verified: true,
        claims: null,
        tenantId,
      });
      await next();
      return;
    }

    // 3. Format check
    if (!isValidJwtFormat(token)) {
      return ctx.json(
        {
          error: {
            message: "Authentication failed: invalid token format.",
            type: "authentication_error",
          },
        },
        401,
      );
    }

    // Explicit modes never accept format-only credentials.
    if (mode !== undefined && verifier?.enabled !== true) {
      return ctx.json(
        {
          error: {
            message:
              "Authentication failed: configured verifier is unavailable.",
            type: "authentication_error",
          },
        },
        401,
      );
    }

    // 4. Cryptographic verification (legacy mode remains compatible).
    if (verifier?.enabled) {
      const valid = await verifier.verify(token);
      if (!valid) {
        return ctx.json(
          {
            error: {
              message:
                "Authentication failed: token signature verification failed.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
    }

    const claims = verifier?.decodePayload(token) ?? null;
    // Req 7.4: a tenant identity may only ever come from a cryptographically
    // verified credential. `decodePayload` is an unverified base64 read, so in
    // legacy mode (no AUTHN_MODE, no verifier configured → NoopVerifier) the
    // payload is attacker-chosen: it stays on the principal for display, but it
    // must not resolve a tenant. With isolation enabled that means 401; without
    // it the request falls back to the deployment's default tenant.
    const claimedTenant =
      verifier?.enabled === true ? resolveTenantClaim(claims) : undefined;
    const tenantId =
      options.tenantIsolationEnabled === false
        ? defaultTenantId
        : claimedTenant;
    if (options.tenantIsolationEnabled === true && tenantId === undefined) {
      return ctx.json(
        {
          error: {
            message:
              "Authentication failed: verified credential has no tenant claim.",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    if (
      options.issuerTenants !== undefined &&
      claimedTenant !== undefined &&
      !issuerMayClaimTenant(
        options.issuerTenants,
        typeof claims?.iss === "string" ? claims.iss : undefined,
        claimedTenant,
      )
    ) {
      return ctx.json(
        {
          error: {
            message:
              "Authentication failed: the token's issuer is not bound to the claimed tenant.",
            type: "authentication_error",
          },
        },
        401,
      );
    }

    ctx.set(TOKEN_KEY, token);
    ctx.set(AUTH_PRINCIPAL_KEY, {
      method: "token",
      verified: verifier?.enabled === true,
      claims,
      ...(tenantId !== undefined ? { tenantId } : {}),
    });
    await next();
  });
}

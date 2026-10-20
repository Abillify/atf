// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import {
  createDiscoveryClient,
  createJwtVerifier,
  safeEqual,
  type DiscoveryClient,
  type IssuerConfig,
  type JwtVerifier,
} from "@atf/security-kit";
// The RFC 8693 `act`-claim parser lives in @atf/identity-contract (Req 11.3);
// the gate no longer keeps its own copy.
import { actorFromClaim } from "@atf/identity-contract";
import type { JWTPayload } from "jose";
import type {
  AdditionalIssuer,
  AuthConfig,
  OAuthAuth,
  StaticToken,
  TenantIsolationConfig,
} from "../config/schema.ts";
import {
  normalizeHeaders,
  verifiedTenantClaim,
  type ActorContext,
  type AuthContext,
} from "./context.ts";

export class AuthError extends Error {
  constructor(message: string, readonly status: number = 401) {
    super(message);
    this.name = "AuthError";
  }
}

function extractScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/\s+/).filter(Boolean);
  return [];
}

function mappedGroupScopes(
  groups: unknown,
  groupScopes: Readonly<Record<string, readonly string[]>>,
): string[] {
  return extractScopes(groups).flatMap((group) => groupScopes[group] ?? []);
}

export function extractBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Discovery for a configured `discoveryUrl` (which may differ from the
 * standard `<issuer>/.well-known` location) via the Security_Kit client:
 * single-flight, positive cache floored at 5 min, negative cache with
 * exponential back-off (Req 6.10). The kit validates every document: exact
 * issuer match and `jwks_uri` (Req 7.3 — HTTPS whenever discovery is HTTPS,
 * host must be the issuer or discovery host), so no local wrapper is needed.
 */
function buildDiscoveryClient(target: AdditionalIssuer): DiscoveryClient {
  return createDiscoveryClient(String(target.issuer), {
    ...(target.discoveryUrl ? { discoveryUrl: target.discoveryUrl } : {}),
    fetchImpl: (url, init) =>
      fetch(url, {
        ...(init?.headers ? { headers: init.headers } : {}),
        signal: AbortSignal.timeout(10_000),
      }),
  });
}

const DEFAULT_TENANT_ISOLATION: TenantIsolationConfig = {
  enabled: false,
  defaultTenantId: "default",
  claimNames: ["tenant_id", "tenant", "tid", "client_id"],
  issuerTenants: {},
  isolatedDatabases: [],
  sqlValidationMode: "report",
};

export class Authenticator {
  private readonly jwtVerifier: JwtVerifier | undefined;

  get authConfig(): AuthConfig {
    return this.config;
  }

  get requiresBearer(): boolean {
    return this.config.mode !== "disabled";
  }

  constructor(
    private readonly config: AuthConfig,
    private readonly tenantIsolation: TenantIsolationConfig = DEFAULT_TENANT_ISOLATION,
  ) {
    if ((config.mode === "oauth" || config.mode === "both") && config.oauth) {
      const targets: AdditionalIssuer[] = [
        config.oauth,
        ...config.oauth.additionalIssuers,
      ];
      const issuers: IssuerConfig[] = targets.map((target) => {
        const audiences = Array.isArray(target.audience)
          ? target.audience
          : target.audience
            ? [target.audience]
            : [];
        return {
          // The config schema pins issuer and audience for every OAuth target.
          issuer: String(target.issuer),
          audiences,
          algorithms: target.algorithms,
          clockToleranceSec: target.clockToleranceSec,
          ...(target.jwksUri ? { jwksUri: target.jwksUri } : {}),
          ...(!target.jwksUri && target.discoveryUrl
            ? { discovery: buildDiscoveryClient(target) }
            : {}),
        };
      });
      this.jwtVerifier = createJwtVerifier({ issuers });
    }
  }

  async authenticate(
    token: string | undefined,
    rawHeaders: Record<string, unknown>,
  ): Promise<AuthContext> {
    const headers = normalizeHeaders(rawHeaders);
    const mode = this.config.mode;

    if (mode === "disabled") {
      return this.context(
        "disabled",
        "anonymous",
        "anonymous",
        [],
        {},
        headers,
        "",
      );
    }
    if (!token) throw new AuthError("Missing bearer token");

    if (mode === "static" || mode === "both") {
      const ctx = this.tryStatic(token, headers);
      if (ctx) return ctx;
      if (mode === "static") throw new AuthError("Invalid bearer token");
    }
    if (mode === "oauth" || mode === "both")
      return this.verifyOAuth(token, headers);
    throw new AuthError("Invalid bearer token");
  }

  private tenantId(claims: Record<string, unknown>): string {
    let verified: string | undefined;
    try {
      verified = verifiedTenantClaim(
        { claims },
        this.tenantIsolation.claimNames,
      );
    } catch {
      throw new AuthError("Conflicting verified tenant claims", 401);
    }
    if (!this.tenantIsolation.enabled)
      return this.tenantIsolation.defaultTenantId;
    if (!verified)
      throw new AuthError("Verified tenant claim is required", 403);
    return verified;
  }

  private context(
    method: AuthContext["method"],
    subject: string,
    username: string,
    scopes: string[],
    claims: Record<string, unknown>,
    headers: Record<string, string>,
    rawToken: string,
    actor?: ActorContext,
  ): AuthContext {
    return {
      method,
      subject,
      username,
      scopes,
      claims,
      tenantId: this.tenantId(claims),
      tenantClaimNames: [...this.tenantIsolation.claimNames],
      headers,
      rawToken,
      ...(actor !== undefined ? { actor } : {}),
    };
  }

  private tryStatic(
    token: string,
    headers: Record<string, string>,
  ): AuthContext | undefined {
    const tokens: StaticToken[] = this.config.static?.tokens ?? [];
    for (const entry of tokens) {
      if (safeEqual(entry.token, token)) {
        const username = entry.username ?? entry.subject ?? "anonymous";
        return this.context(
          "static",
          entry.subject ?? username,
          username,
          entry.scopes,
          { ...entry.claims },
          headers,
          token,
        );
      }
    }
    return undefined;
  }

  private async verifyOAuth(
    token: string,
    headers: Record<string, string>,
  ): Promise<AuthContext> {
    const oauth = this.config.oauth as OAuthAuth;
    const verifier = this.jwtVerifier;
    if (verifier === undefined)
      throw new AuthError("OAuth authentication is not configured", 500);

    let payload: JWTPayload;
    try {
      // Security_Kit routes the token by its (unverified) `iss` claim to the
      // matching issuer configuration (Req 6.10) and reports only coarse,
      // generic reasons — jose internals never reach the client (Req 6.11).
      ({ payload } = await verifier.verify(token));
    } catch {
      throw new AuthError("Token verification failed");
    }

    const scopes = [
      ...new Set([
        ...extractScopes(payload[oauth.scopeClaim]),
        ...mappedGroupScopes(payload[oauth.groupClaim], oauth.groupScopes),
      ]),
    ];
    const missing = oauth.requiredScopes.filter(
      (scope) => !scopes.includes(scope),
    );
    if (missing.length > 0)
      throw new AuthError(
        `Missing required scope(s): ${missing.join(", ")}`,
        403,
      );

    // RFC 8693 actor (`act`): parse for audit, and gate on it when an actor
    // policy is configured. A token without delegation yields no actor.
    const actorPolicy = oauth.actorPolicy;
    const actorClaimName = actorPolicy?.actorClaim ?? "act";
    const actor = actorFromClaim(payload[actorClaimName]);
    if (actorPolicy !== undefined) {
      if (actorPolicy.requireActor && actor === undefined) {
        throw new AuthError(
          "A delegated (on-behalf-of) token is required",
          403,
        );
      }
      if (
        actor !== undefined &&
        actorPolicy.allowedActorSubjects.length > 0 &&
        !actorPolicy.allowedActorSubjects.includes(actor.subject)
      ) {
        throw new AuthError(`Actor '${actor.subject}' is not permitted`, 403);
      }
    }

    const username = String(
      payload[oauth.usernameClaim] ?? payload.sub ?? "anonymous",
    );
    const ctx = this.context(
      "oauth",
      String(payload.sub ?? username),
      username,
      scopes,
      payload as Record<string, unknown>,
      headers,
      token,
      actor,
    );
    this.enforceIssuerTenant(payload.iss, ctx.tenantId);
    return ctx;
  }
  /**
   * Issuer → tenant binding (`tenantIsolation.issuerTenants`). A verified
   * signature proves WHO issued the token, not that this issuer may speak for
   * the tenant its claim names. With a binding configured, an issuer that is
   * not listed, or a tenant it may not act for, is refused — the same contract
   * as the Runtime's JWT_ISSUER_TENANTS. Without a binding (the default) the
   * previous behaviour is unchanged.
   */
  private enforceIssuerTenant(issuer: unknown, tenantId: string): void {
    const binding = this.tenantIsolation.issuerTenants;
    if (!this.tenantIsolation.enabled || Object.keys(binding).length === 0) {
      return;
    }
    const allowed = typeof issuer === "string" ? binding[issuer] : undefined;
    if (allowed === undefined) {
      throw new AuthError("Token issuer is not bound to a tenant", 401);
    }
    if (!allowed.includes("*") && !allowed.includes(tenantId)) {
      throw new AuthError("Token issuer may not act for this tenant", 403);
    }
  }
}

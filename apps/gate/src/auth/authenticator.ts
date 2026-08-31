// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type {
  AuthConfig,
  OAuthAuth,
  StaticToken,
  TenantIsolationConfig,
} from "../config/schema.ts";
import { normalizeHeaders, verifiedTenantClaim, type AuthContext } from "./context.ts";

export class AuthError extends Error {
  constructor(message: string, readonly status: number = 401) {
    super(message);
    this.name = "AuthError";
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
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

interface OAuthVerifier {
  jwksUri?: string;
  discoveryUrl?: string;
  jwks?: ReturnType<typeof createRemoteJWKSet>;
  issuer?: string;
  audience?: string | string[];
  algorithms: string[];
  clockToleranceSec: number;
}

const DEFAULT_TENANT_ISOLATION: TenantIsolationConfig = {
  enabled: false,
  defaultTenantId: "default",
  claimNames: ["tenant_id", "tenant", "tid", "client_id"],
  isolatedDatabases: [],
  sqlValidationMode: "report",
};

export class Authenticator {
  private readonly verifiers: OAuthVerifier[] = [];

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
      const targets = [config.oauth, ...config.oauth.additionalIssuers];
      for (const target of targets) {
        this.verifiers.push({
          ...(target.jwksUri ? { jwksUri: target.jwksUri } : {}),
          ...(target.discoveryUrl ? { discoveryUrl: target.discoveryUrl } : {}),
          ...(target.jwksUri ? { jwks: createRemoteJWKSet(new URL(target.jwksUri)) } : {}),
          issuer: target.issuer,
          audience: target.audience,
          algorithms: target.algorithms,
          clockToleranceSec: target.clockToleranceSec,
        });
      }
    }
  }

  async authenticate(
    token: string | undefined,
    rawHeaders: Record<string, unknown>,
  ): Promise<AuthContext> {
    const headers = normalizeHeaders(rawHeaders);
    const mode = this.config.mode;

    if (mode === "disabled") {
      return this.context("disabled", "anonymous", "anonymous", [], {}, headers, "");
    }
    if (!token) throw new AuthError("Missing bearer token");

    if (mode === "static" || mode === "both") {
      const ctx = this.tryStatic(token, headers);
      if (ctx) return ctx;
      if (mode === "static") throw new AuthError("Invalid bearer token");
    }
    if (mode === "oauth" || mode === "both") return this.verifyOAuth(token, headers);
    throw new AuthError("Invalid bearer token");
  }

  private tenantId(claims: Record<string, unknown>): string {
    let verified: string | undefined;
    try {
      verified = verifiedTenantClaim({ claims }, this.tenantIsolation.claimNames);
    } catch {
      throw new AuthError("Conflicting verified tenant claims", 401);
    }
    if (!this.tenantIsolation.enabled) return this.tenantIsolation.defaultTenantId;
    if (!verified) throw new AuthError("Verified tenant claim is required", 403);
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
    };
  }

  private tryStatic(token: string, headers: Record<string, string>): AuthContext | undefined {
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

  private async verifierJwks(verifier: OAuthVerifier): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (verifier.jwks) return verifier.jwks;
    if (!verifier.discoveryUrl || !verifier.issuer) {
      throw new Error("OAuth verifier has neither JWKS nor valid discovery configuration");
    }
    const response = await fetch(verifier.discoveryUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}`);
    const metadata = (await response.json()) as { issuer?: unknown; jwks_uri?: unknown };
    if (metadata.issuer !== verifier.issuer) {
      throw new Error("OIDC discovery issuer does not exactly match configured issuer");
    }
    if (typeof metadata.jwks_uri !== "string") throw new Error("OIDC discovery has no jwks_uri");
    const discovery = new URL(verifier.discoveryUrl);
    const jwksUrl = new URL(metadata.jwks_uri);
    if (discovery.protocol === "https:" && jwksUrl.protocol !== "https:") {
      throw new Error("OIDC discovery returned a non-HTTPS jwks_uri");
    }
    verifier.jwks = createRemoteJWKSet(jwksUrl);
    return verifier.jwks;
  }

  private async verifyOAuth(token: string, headers: Record<string, string>): Promise<AuthContext> {
    const oauth = this.config.oauth as OAuthAuth;
    if (this.verifiers.length === 0) throw new AuthError("OAuth authentication is not configured", 500);

    let payload: JWTPayload | undefined;
    let lastError: unknown;
    for (const verifier of this.verifiers) {
      try {
        const result = await jwtVerify(token, await this.verifierJwks(verifier), {
          issuer: verifier.issuer,
          audience: verifier.audience,
          algorithms: verifier.algorithms,
          clockTolerance: verifier.clockToleranceSec,
        });
        payload = result.payload;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!payload) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new AuthError(`Token verification failed: ${detail}`);
    }

    const scopes = [...new Set([
      ...extractScopes(payload[oauth.scopeClaim]),
      ...mappedGroupScopes(payload[oauth.groupClaim], oauth.groupScopes),
    ])];
    const missing = oauth.requiredScopes.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) throw new AuthError(`Missing required scope(s): ${missing.join(", ")}`, 403);

    const username = String(payload[oauth.usernameClaim] ?? payload.sub ?? "anonymous");
    return this.context(
      "oauth",
      String(payload.sub ?? username),
      username,
      scopes,
      payload as Record<string, unknown>,
      headers,
      token,
    );
  }
}

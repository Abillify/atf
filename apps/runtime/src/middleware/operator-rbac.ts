// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Operator RBAC (`src/middleware/operator-rbac.ts`)
 *
 * The operator/observability plane (`/monitoring/*`, `/flows/*`, control routes)
 * was gated by a single shared `MONITORING_AUTH` token — anyone holding it had
 * full power (publish flows, approve consequential tool calls, replay, …). This
 * module adds role-based access control over that plane:
 *
 *   - viewer   — read-only (monitoring, flows, experiments, audit)
 *   - operator — viewer + approvals + replay
 *   - admin    — everything, incl. flow authoring (write) and memory admin
 *
 * Identity sources (in order):
 *   1. A static token→role map (`OPERATOR_TOKENS`) — exact token match.
 *   2. A JWT role claim (`OPERATOR_ROLE_CLAIM`, default "role") whose value is
 *      one of viewer|operator|admin — requires JWT verification to be trustworthy.
 *   3. An OIDC groups/role claim (`OPERATOR_GROUPS_CLAIM`) resolved through
 *      `OPERATOR_ROLE_MAP`, or — as a last resort — a fallback `OPERATOR_DEFAULT_ROLE`
 *      granted to any verified token with no mappable role (the "public IdP" case).
 *
 * Backward compatible: when NO RBAC is configured the authorizer reproduces the
 * old `MONITORING_AUTH` behaviour exactly (open when not required; any valid
 * JWT-format token = full admin when required), so existing deployments are
 * unaffected. RBAC is strictly opt-in.
 *
 * No `any` at module boundaries.
 */

import type { JwtVerifier } from "./jwt-verifier.js";

export type OperatorRole = "viewer" | "operator" | "admin";

export type OperatorPermission =
  | "monitoring:read"
  | "monitoring:write"
  | "flows:read"
  | "flows:write"
  | "approvals:write"
  | "replay:write"
  | "experiments:read"
  | "audit:read";

/** Permissions granted to each role (admin is the superset). */
const ROLE_PERMISSIONS: Record<
  OperatorRole,
  ReadonlySet<OperatorPermission>
> = {
  viewer: new Set<OperatorPermission>([
    "monitoring:read",
    "flows:read",
    "experiments:read",
  ]),
  operator: new Set<OperatorPermission>([
    "monitoring:read",
    "monitoring:write",
    "flows:read",
    "experiments:read",
    "approvals:write",
    "replay:write",
  ]),
  admin: new Set<OperatorPermission>([
    "monitoring:read",
    "monitoring:write",
    "flows:read",
    "flows:write",
    "approvals:write",
    "replay:write",
    "experiments:read",
    "audit:read",
  ]),
};

export function roleHasPermission(
  role: OperatorRole,
  perm: OperatorPermission,
): boolean {
  return ROLE_PERMISSIONS[role].has(perm);
}

/** Privilege ordering — used to pick the strongest of several matched roles. */
const ROLE_RANK: Record<OperatorRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

/** Returns the highest-privilege role from a list, or undefined when empty. */
function highestRole(roles: readonly OperatorRole[]): OperatorRole | undefined {
  let best: OperatorRole | undefined;
  for (const r of roles) {
    if (best === undefined || ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  }
  return best;
}

/**
 * Reads a (possibly dot-pathed) claim and normalises its value to a string[].
 * Supports a string, a string[], and a nested object path (e.g.
 * "realm_access.roles" for Keycloak). Non-string array members are dropped.
 */
function readClaimValues(
  claims: Record<string, unknown> | null,
  path: string,
): string[] {
  if (claims === null) return [];
  let cur: unknown = claims;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return [];
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur === "string") return [cur];
  if (Array.isArray(cur))
    return cur.filter((v): v is string => typeof v === "string");
  return [];
}

export interface OperatorIdentity {
  /** Display name for audit (token label, JWT subject/email, or a fallback). */
  name: string;
  role: OperatorRole;
  /** How the identity was established. */
  via: "token" | "jwt" | "open";
}

export interface AuthorizeResult {
  ok: boolean;
  actor?: OperatorIdentity;
}

export interface OperatorAuthorizer {
  /** True when real RBAC (token map or role claim) is configured. */
  readonly rbacEnabled: boolean;
  /**
   * Authorizes a request for a permission. Returns `{ ok, actor }` — `actor` is
   * present whenever the request is identified (even on `ok:false` it may be
   * undefined). `authHeader`/`queryToken` are the two token transports.
   *
   * Async because the JWT role-claim path **cryptographically verifies the
   * token signature** (JWKS/HS256) before trusting the role — a decoded but
   * unverified claim must never grant a role, or a forged `role: admin` JWT
   * could escalate to the operator plane.
   */
  authorize(
    authHeader: string | undefined,
    queryToken: string | undefined,
    permission: OperatorPermission,
  ): Promise<AuthorizeResult>;
}

export interface OperatorTokenEntry {
  token: string;
  role: OperatorRole;
  name?: string;
}

export interface OperatorAuthorizerOptions {
  /** Mirrors MONITORING_AUTH — when false and no RBAC, the plane is open. */
  authRequired: boolean;
  /** Static token→role entries. */
  tokens?: OperatorTokenEntry[];
  /** JWT claim whose value is the operator role. Default "role". */
  roleClaim?: string;
  /**
   * OIDC/SSO group/role claim (dot-path supported, e.g. "realm_access.roles"),
   * carrying the IdP's group or role names as a string or string[]. Read in
   * addition to {@link roleClaim} and resolved through {@link roleMap}.
   */
  groupsClaim?: string;
  /**
   * Maps IdP group/role names → operator role. Applied to both the role claim
   * and the groups claim; the highest-privilege match wins. A claim value that
   * is already a literal operator role (viewer|operator|admin) is honoured
   * directly without needing a map entry.
   */
  roleMap?: Record<string, OperatorRole>;
  /**
   * Fallback role granted to ANY successfully VERIFIED JWT that carries no
   * mappable role/group. Applied only after signature verification, so it never
   * upgrades an unverified/forged token. Lets every authenticated OIDC identity
   * in without per-group mapping. Undefined = strict role resolution.
   */
  defaultRole?: OperatorRole;
  /** Verifier used to decode the JWT claim (decode only; verification elsewhere). */
  jwtVerifier?: JwtVerifier;
  /** Whether role/permission denials are enforced after successful identification. */
  authorizationEnabled?: boolean;
  /** Whether bearer credentials in URLs are accepted. Disable in production. */
  allowQueryToken?: boolean;
  /**
   * Mirrors `JWT_ALLOW_UNVERIFIED`. Gates the legacy "any well-formed
   * 3-segment token grants admin" fallback used when no RBAC is configured but
   * {@link authRequired} is set. Default false — see `authorize()` for why that
   * fallback is a full operator-plane bypass without this gate.
   */
  allowUnverifiedJwt?: boolean;
}

// ---------------------------------------------------------------------------
// Token helpers (kept local to avoid coupling with monitoring-service)
// ---------------------------------------------------------------------------

function extractBearer(authHeader: string | undefined): string | null {
  if (authHeader === undefined) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? (m[1] ?? "").trim() : null;
}

/** A JWT-format token is three non-empty base64url segments. */
function isJwtFormat(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

function isOperatorRole(v: unknown): v is OperatorRole {
  return v === "viewer" || v === "operator" || v === "admin";
}

/** Options controlling how JWT/OIDC claims map to an operator role. */
export interface RoleResolutionOptions {
  /** JWT claim whose value is the operator role. Default "role". */
  roleClaim?: string;
  /** OIDC groups/role claim (dot-path supported). */
  groupsClaim?: string;
  /** IdP group/role name → operator role. */
  roleMap?: Record<string, OperatorRole>;
  /** Fallback role when nothing else maps. */
  defaultRole?: OperatorRole;
}

/**
 * Resolves an operator role from a set of (already VERIFIED) JWT claims. Reads
 * the role claim and the optional groups claim, resolving literal
 * viewer|operator|admin values directly and any other name through `roleMap`;
 * the highest-privilege match wins, else `defaultRole`. Returns undefined when
 * nothing maps. Shared by the operator authorizer and the OIDC login callback.
 */
export function resolveOperatorRoleFromClaims(
  claims: Record<string, unknown> | null,
  opts: RoleResolutionOptions,
): OperatorRole | undefined {
  const roleMap = new Map(Object.entries(opts.roleMap ?? {}));
  const candidates = [
    ...readClaimValues(claims, opts.roleClaim ?? "role"),
    ...(opts.groupsClaim !== undefined
      ? readClaimValues(claims, opts.groupsClaim)
      : []),
  ];
  const matched: OperatorRole[] = [];
  for (const v of candidates) {
    if (isOperatorRole(v)) matched.push(v);
    else {
      const mapped = roleMap.get(v);
      if (mapped !== undefined) matched.push(mapped);
    }
  }
  return highestRole(matched) ?? opts.defaultRole;
}

class OperatorAuthorizerImpl implements OperatorAuthorizer {
  private readonly tokenMap: Map<string, OperatorTokenEntry>;
  private readonly roleClaim: string;
  private readonly groupsClaim: string | undefined;
  private readonly roleMap: Map<string, OperatorRole>;
  private readonly defaultRole: OperatorRole | undefined;

  constructor(private readonly opts: OperatorAuthorizerOptions) {
    this.tokenMap = new Map(
      (opts.tokens ?? [])
        .filter((t) => t.token.length > 0)
        .map((t) => [t.token, t]),
    );
    this.roleClaim = opts.roleClaim ?? "role";
    this.groupsClaim = opts.groupsClaim;
    this.roleMap = new Map(Object.entries(opts.roleMap ?? {}));
    this.defaultRole = opts.defaultRole;
  }

  get rbacEnabled(): boolean {
    return (
      this.tokenMap.size > 0 ||
      (this.opts.authRequired === true &&
        this.opts.jwtVerifier?.enabled === true)
    );
  }

  /** Resolves an operator identity from a raw token, or undefined. */
  private async identify(
    token: string | null,
  ): Promise<OperatorIdentity | undefined> {
    if (token === null) return undefined;

    // 1. Static token map (exact match).
    const entry = this.tokenMap.get(token);
    if (entry !== undefined) {
      return {
        name: entry.name ?? `token:${entry.role}`,
        role: entry.role,
        via: "token",
      };
    }

    // 2. JWT role claim — only after VERIFYING the signature. A self-asserted
    //    (or forged) claim is never authoritative; decoding alone must not
    //    grant a role.
    const verifier = this.opts.jwtVerifier;
    if (verifier?.enabled === true && isJwtFormat(token)) {
      const verified = await verifier.verify(token);
      if (!verified) return undefined;
      const claims = verifier.decodePayload(token);

      // Gather candidate role/group names from the role claim and (when set)
      // the OIDC groups claim, resolve to an operator role (literal role,
      // roleMap entry, or the configured default). The strongest match wins.
      const role = resolveOperatorRoleFromClaims(claims, {
        roleClaim: this.roleClaim,
        ...(this.groupsClaim !== undefined
          ? { groupsClaim: this.groupsClaim }
          : {}),
        roleMap: Object.fromEntries(this.roleMap),
        ...(this.defaultRole !== undefined
          ? { defaultRole: this.defaultRole }
          : {}),
      });
      if (role !== undefined) {
        const name =
          (typeof claims?.email === "string" &&
            (claims.email as string)) ||
          (typeof claims?.sub === "string" && (claims.sub as string)) ||
          `jwt:${role}`;
        return { name, role, via: "jwt" };
      }
    }
    return undefined;
  }

  async authorize(
    authHeader: string | undefined,
    queryToken: string | undefined,
    permission: OperatorPermission,
  ): Promise<AuthorizeResult> {
    const token =
      extractBearer(authHeader) ??
      (this.opts.allowQueryToken === false ? null : queryToken ?? null);

    if (this.rbacEnabled) {
      const actor = await this.identify(token);
      if (actor === undefined) return { ok: false };
      if (this.opts.authorizationEnabled === false) return { ok: true, actor };
      return roleHasPermission(actor.role, permission)
        ? { ok: true, actor }
        : { ok: false, actor };
    }

    // --- Backward-compatible MONITORING_AUTH behaviour (no RBAC configured) ---
    if (!this.opts.authRequired) {
      return {
        ok: true,
        actor: { name: "anonymous", role: "admin", via: "open" },
      };
    }

    // Legacy "any well-formed token = admin" path.
    //
    // `isJwtFormat` is a SHAPE check — three non-empty base64url segments. It
    // verifies no signature, so on its own it grants full operator authority
    // (including `flows:write`) to a value an attacker can simply type, e.g.
    // `?token=aaa.bbb.ccc`. That made the entire operator plane — audit log,
    // flow authoring, approvals — writable by anyone who could reach it.
    //
    // The path is kept only for the deployment that has ALREADY consciously
    // declared it accepts unverified tokens (`JWT_ALLOW_UNVERIFIED=true`, which
    // the production gate rejects under APP_ENV=production). Reusing that
    // existing opt-in rather than inventing a second flag keeps the trust model
    // in one place: "I accept unverified tokens" is exactly the precondition
    // under which a format-only operator token could ever be acceptable.
    //
    // Everyone else fails closed and must configure OPERATOR_TOKENS or a JWT
    // verifier — the two paths that actually establish an identity.
    if (
      this.opts.allowUnverifiedJwt === true &&
      token !== null &&
      isJwtFormat(token)
    ) {
      return {
        ok: true,
        actor: { name: "operator", role: "admin", via: "token" },
      };
    }
    return { ok: false };
  }
}

export function createOperatorAuthorizer(
  opts: OperatorAuthorizerOptions,
): OperatorAuthorizer {
  return new OperatorAuthorizerImpl(opts);
}

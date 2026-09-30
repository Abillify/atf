// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { PostgresClient, PostgresResponse } from "./postgres-client.js";
import type { CollectionAcl } from "./collection-access.js";
import {
  getAmbientPrincipal,
  getPrincipal,
  hasIdentity,
  type RequestPrincipal,
} from "./request-principal.js";
import type { Request } from "express";

/** Central, fail-closed authorization context used by HTTP and MCP paths. */
export interface AccessScope {
  principal: RequestPrincipal;
  userId: string | undefined;
  userGroups: string[];
  tenantId: string | undefined;
  scopes: string[];
  /** Only an authenticated service credential may exercise service authority. */
  service: boolean;
  /** AUTHZ_ENABLED=false bypasses operation permissions and all ACL checks. */
  authorizationBypass?: boolean;
}

export class AccessDeniedError extends Error {
  constructor(
    message = "Access denied",
    public readonly code: "AUTH_SCOPE_DENIED" | "TENANT_REQUIRED" | "TENANT_MISMATCH" = "AUTH_SCOPE_DENIED",
  ) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function accessScopeForRequest(req: Request): AccessScope {
  return accessScopeFromPrincipal(getPrincipal(req));
}

export function accessScopeForMcp(): AccessScope {
  const principal = getAmbientPrincipal();
  if (!principal) throw new AccessDeniedError("No MCP principal in scope");
  return accessScopeFromPrincipal(principal);
}

export function serviceAccessScope(): AccessScope {
  return accessScopeFromPrincipal({
    userId: undefined,
    userGroups: undefined,
    source: "service",
  });
}

export function principalFingerprint(principal: RequestPrincipal): string {
  const groups = [...(principal.userGroups ?? [])].sort();
  const scopes = [...(principal.scopes ?? [])].sort();
  return JSON.stringify([
    principal.source,
    principal.userId ?? null,
    principal.tenantId ?? null,
    principal.issuer ?? null,
    principal.clientId ?? null,
    principal.credentialId ?? null,
    groups,
    scopes,
  ]);
}

export function accessScopeFromPrincipal(principal: RequestPrincipal): AccessScope {
  // Anonymous requests are never service/admin requests. In particular, omitting
  // X-User must not turn an unauthenticated caller into an unrestricted reader.
  const service = principal.source === "service";
  const authorizationBypass = principal.authorizationBypass === true;
  if (!authorizationBypass && !service && !hasIdentity(principal)) {
    throw new AccessDeniedError("An authenticated principal is required");
  }
  return {
    principal,
    userId: principal.userId,
    userGroups: principal.userGroups ?? [],
    tenantId: principal.tenantId,
    scopes: [...new Set((principal.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))],
    service,
    authorizationBypass,
  };
}

export function scopeAllowsAcl(scope: AccessScope, acl: CollectionAcl): boolean {
  if (scope.authorizationBypass || scope.service) return true;
  if (acl.allowedUsers.length === 0 && acl.allowedGroups.length === 0) return true;
  return (
    (scope.userId !== undefined && acl.allowedUsers.includes(scope.userId)) ||
    scope.userGroups.some((group) => acl.allowedGroups.includes(group))
  );
}

/** Load and enforce collection ACL. Unknown/error states fail closed. */
export async function requireCollectionAccess(
  postgres: Pick<PostgresClient, "getCollectionAcl">,
  collection: string,
  scope: AccessScope,
): Promise<CollectionAcl> {
  if (
    !scope.authorizationBypass &&
    !scope.service &&
    scope.scopes.includes("knowledge") &&
    !scope.scopes.includes(`kb:${collection}`)
  ) {
    throw new AccessDeniedError(`Access denied to collection "${collection}"`);
  }
  const result = await postgres.getCollectionAcl(collection);
  if (!result.ok) {
    if (scope.authorizationBypass && result.error.code === "COLLECTION_NOT_FOUND") {
      return { allowedUsers: [], allowedGroups: [] };
    }
    throw new AccessDeniedError(`Access denied to collection "${collection}"`);
  }
  if (!scopeAllowsAcl(scope, result.result)) {
    throw new AccessDeniedError(`Access denied to collection "${collection}"`);
  }
  return result.result;
}

/**
 * Verifies an explicit acting user against the authenticated principal.
 *
 * Security-sensitive integrations use this in addition to metadata filters:
 * an asserted document owner is accepted only when it is the verified end-user
 * identity. Service credentials cannot impersonate a user through a tool argument.
 *
 * `AUTHZ_ENABLED=false` (authorizationBypass) skips the match like every other
 * check in this module: with authorization disabled there is no principal
 * identity to match against, and a tool-supplied `requesting_user` must not
 * turn a disabled-authz deployment into a guaranteed 403.
 */
export function requireActingUser(scope: AccessScope, requestedUser: string): string {
  const normalized = requestedUser.trim();
  if (normalized === "") {
    throw new AccessDeniedError("The requested user does not match the authenticated principal");
  }
  if (scope.authorizationBypass) return normalized;
  if (scope.service || scope.userId !== normalized) {
    throw new AccessDeniedError("The requested user does not match the authenticated principal");
  }
  return normalized;
}

/** ACL policy for a mutation; bypass writes preserve existing row ACLs on conflict. */
export interface MutationAcl extends CollectionAcl {
  preserveExistingOnConflict?: true;
}

/** ACL written for newly ingested rows; never emits an accidental public ACL. */
export function aclForMutation(
  scope: AccessScope,
  collectionAcl: CollectionAcl,
  requestedUser?: string,
): MutationAcl {
  if (scope.authorizationBypass) {
    return {
      allowedUsers: [...collectionAcl.allowedUsers],
      allowedGroups: [...collectionAcl.allowedGroups],
      preserveExistingOnConflict: true,
    };
  }
  if (requestedUser !== undefined) {
    // An explicitly user-owned document is private to that user. Groups are
    // deliberately omitted: assistants act with their owner's identity, while
    // unrelated members of the owner's groups must not see private sessions.
    return { allowedUsers: [requireActingUser(scope, requestedUser)], allowedGroups: [] };
  }
  if (scope.service) {
    if (collectionAcl.allowedUsers.length === 0 && collectionAcl.allowedGroups.length === 0) {
      throw new AccessDeniedError("Service ingest requires an explicit collection ACL or end-user principal");
    }
    return collectionAcl;
  }
  return {
    allowedUsers: scope.userId ? [scope.userId] : [],
    allowedGroups: [...scope.userGroups],
  };
}

/** A document's row ACL, sorted and de-duplicated so two ACLs compare by value. */
export interface RowAcl {
  allowedUsers: string[];
  allowedGroups: string[];
}

function normalizeAclList(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v !== ""))].sort();
}

/**
 * The row ACL of a document written through the v2 revision API (and the ACL
 * its source registration is compared under).
 *
 *   - a service (Extract with its service token) or a bypass principal passes
 *     the ACL it resolved for its own caller (`X-Allowed-Users/-Groups`); when
 *     it passes none, the collection ACL applies, and without one the row is
 *     readable by every reader of the collection — the v2 behaviour so far;
 *   - an end-user principal writes a document readable by its own identity,
 *     narrowed to the requested users/groups it belongs to.
 *
 * A row ACL only ever narrows: a reader still needs access to the collection.
 */
export function rowAclForRevision(
  scope: AccessScope,
  collectionAcl: CollectionAcl | undefined,
  requested: { users: readonly string[]; groups: readonly string[] },
): RowAcl {
  const users = normalizeAclList(requested.users);
  const groups = normalizeAclList(requested.groups);
  if (scope.authorizationBypass || scope.service) {
    if (users.length > 0 || groups.length > 0) return { allowedUsers: users, allowedGroups: groups };
    return {
      allowedUsers: normalizeAclList(collectionAcl?.allowedUsers ?? []),
      allowedGroups: normalizeAclList(collectionAcl?.allowedGroups ?? []),
    };
  }
  const ownUsers = scope.userId ? [scope.userId] : [];
  const ownGroups = normalizeAclList(scope.userGroups);
  return {
    allowedUsers: users.length === 0 ? ownUsers : users.filter((u) => ownUsers.includes(u)),
    allowedGroups: groups.length === 0 ? ownGroups : groups.filter((g) => ownGroups.includes(g)),
  };
}

/** True when a row with this ACL is readable by the scope (the buildAccessSql rule). */
export function rowAclAllows(scope: AccessScope, acl: RowAcl): boolean {
  if (scope.authorizationBypass || scope.service) return true;
  if (acl.allowedUsers.length === 0 && acl.allowedGroups.length === 0) return true;
  if (scope.userId && acl.allowedUsers.includes(scope.userId)) return true;
  return scope.userGroups.some((g) => acl.allowedGroups.includes(g));
}

export function deniedResponse(error: unknown): PostgresResponse<never> {
  return {
    ok: false,
    error: {
      code: "POSTGRES_INVALID_RESPONSE",
      message: error instanceof Error ? error.message : "Access denied",
    },
  };
}


/** Declarative operation matrix shared by REST routes and MCP tool dispatch. */
export type AuthorizationOperation =
  | "read"
  | "write"
  | "delete"
  | "admin"
  | "acl.manage"
  | "metrics"
  | "global.admin";

const OPERATION_SCOPES: Readonly<Record<AuthorizationOperation, readonly string[]>> = {
  read: ["vectorsearch.read", "knowledge"],
  write: ["vectorsearch.write"],
  delete: ["vectorsearch.delete"],
  admin: ["vectorsearch.admin"],
  "acl.manage": ["vectorsearch.acl.manage"],
  metrics: ["vectorsearch.metrics"],
  "global.admin": ["vectorsearch.global.admin"],
};

export type AuthzEnforcement = "off" | "optional" | "required";

/**
 * Central scope decision. `tool:<toolName>` is an exact, non-wildcard grant.
 * Tenant is always mandatory for protected data operations once authorization
 * is enabled; no client supplied request value participates in this decision.
 */
export function requireAuthorization(
  scope: AccessScope,
  operation: AuthorizationOperation,
  enforcement: AuthzEnforcement,
  toolName?: string,
): void {
  if (scope.authorizationBypass || enforcement !== "required") return;
  if (!scope.tenantId) {
    throw new AccessDeniedError("A verified tenant claim is required", "TENANT_REQUIRED");
  }
  const required = OPERATION_SCOPES[operation];
  const allowed = required.some((permission) => scope.scopes.includes(permission)) ||
    (toolName !== undefined && scope.scopes.includes(`tool:${toolName}`));
  if (!allowed && enforcement === "required") {
    throw new AccessDeniedError("The credential lacks the required scope", "AUTH_SCOPE_DENIED");
  }
}

/** Express boundary for the central route-operation policy. */
export function createAuthorizationMiddleware(
  operation: AuthorizationOperation,
  enforcement: AuthzEnforcement,
): import("express").RequestHandler {
  return (req, res, next) => {
    try {
      requireAuthorization(accessScopeForRequest(req), operation, enforcement);
      next();
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  };
}

/** Maps an MCP tool to the same operation used by its REST equivalent. */
export function authorizationOperationForTool(tool: string): AuthorizationOperation {
  if (tool === "ingest") return "write";
  if (tool === "delete_document") return "delete";
  if (tool === "set_collection_permissions" || tool === "list_collections" || /^(delete_collection|rename_collection)$/.test(tool)) return "global.admin";
  if (/^backfill_/.test(tool)) return "admin";
  return "read";
}

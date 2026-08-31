// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * collection-access.ts
 *
 * Collection-level access control, the collection-scoped counterpart to the
 * per-row `allowed_users` / `allowed_groups` ACLs enforced in query-builder.ts.
 *
 * Trust model (identical to the row-level model): the calling service holds the
 * API token and asserts the end-user identity via the `X-User` / `X-Groups`
 * request headers. This module never authenticates the end user itself.
 *
 * Semantics:
 *   - Empty ACL (no users AND no groups) → PUBLIC: everyone may access.
 *   - A caller that asserts NO identity (no X-User and no X-Groups) is treated
 *     as an admin/service context and is granted access — mirroring the
 *     row-level behaviour where an identity-less caller is returned every row.
 *   - Otherwise access requires the asserted user to be in `allowedUsers` OR one
 *     of the asserted groups to be in `allowedGroups`.
 */

export interface CollectionAcl {
  allowedUsers: string[];
  allowedGroups: string[];
}

/**
 * Decide whether a caller (identified by an optional userId and optional list
 * of groups) may access a collection with the given ACL.
 */
export function collectionAccessAllowed(
  acl: CollectionAcl | null | undefined,
  userId: string | undefined,
  userGroups: string[] | undefined,
): boolean {
  const allowedUsers = acl?.allowedUsers ?? [];
  const allowedGroups = acl?.allowedGroups ?? [];

  // Public collection (or unknown/not-yet-created) → unrestricted.
  if (allowedUsers.length === 0 && allowedGroups.length === 0) return true;

  const hasIdentity = Boolean(userId) || (userGroups?.length ?? 0) > 0;
  // Only an explicitly authenticated service principal has administrative
  // authority. Anonymous/no-identity callers never receive unrestricted access.
  if (!hasIdentity) return false;

  if (userId && allowedUsers.includes(userId)) return true;
  if (userGroups && userGroups.some((g) => allowedGroups.includes(g)))
    return true;

  return false;
}

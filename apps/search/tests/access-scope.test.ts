// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "vitest";
import {
  AccessDeniedError,
  accessScopeFromPrincipal,
  aclForMutation,
  principalFingerprint,
  requireActingUser,
  requireCollectionAccess,
  scopeAllowsAcl,
  requireAuthorization,
} from "../src/access-scope.js";
import type { PostgresClient } from "../src/postgres-client.js";

const restricted = { allowedUsers: ["alice"], allowedGroups: ["legal"] };

describe("central access scope", () => {
  it("denies anonymous identity-less callers instead of promoting them to admin", () => {
    expect(() =>
      accessScopeFromPrincipal({ userId: undefined, userGroups: undefined, source: "anonymous" }),
    ).toThrow(AccessDeniedError);
  });

  it("allows a matching user or group and rejects cross-user access", () => {
    const alice = accessScopeFromPrincipal({ userId: "alice", userGroups: [], source: "jwt" });
    const groupMember = accessScopeFromPrincipal({ userId: "bob", userGroups: ["legal"], source: "jwt" });
    const outsider = accessScopeFromPrincipal({ userId: "mallory", userGroups: ["other"], source: "jwt" });
    expect(scopeAllowsAcl(alice, restricted)).toBe(true);
    expect(scopeAllowsAcl(groupMember, restricted)).toBe(true);
    expect(scopeAllowsAcl(outsider, restricted)).toBe(false);
  });

  it("treats empty ACLs as public for identified users, preserving product semantics", () => {
    const user = accessScopeFromPrincipal({ userId: "alice", userGroups: [], source: "jwt" });
    expect(scopeAllowsAcl(user, { allowedUsers: [], allowedGroups: [] })).toBe(true);
  });

  it("fails closed when ACL loading fails", async () => {
    const client = {
      getCollectionAcl: async () => ({
        ok: false as const,
        error: { code: "COLLECTION_NOT_FOUND" as const, message: "missing" },
      }),
    } as unknown as PostgresClient;
    const user = accessScopeFromPrincipal({ userId: "alice", userGroups: [], source: "jwt" });
    await expect(requireCollectionAccess(client, "missing", user)).rejects.toThrow(AccessDeniedError);
  });

  it("preserves existing row ACLs and uses collection ACLs for new rows during bypass", () => {
    const bypass = accessScopeFromPrincipal({
      userId: undefined,
      userGroups: undefined,
      tenantId: "tenant-a",
      source: "anonymous",
      authorizationBypass: true,
    });
    expect(aclForMutation(bypass, restricted)).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["legal"],
      preserveExistingOnConflict: true,
    });
  });

  it("derives mutation ACLs from the principal rather than writing public rows", () => {
    const user = accessScopeFromPrincipal({ userId: "alice", userGroups: ["legal"], source: "jwt" });
    expect(aclForMutation(user, { allowedUsers: [], allowedGroups: [] })).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["legal"],
    });
  });

  it("binds an explicit private owner to the verified user and removes group access", () => {
    const user = accessScopeFromPrincipal({ userId: "alice", userGroups: ["legal"], source: "jwt" });
    expect(requireActingUser(user, "alice")).toBe("alice");
    expect(aclForMutation(user, restricted, "alice")).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: [],
    });
    expect(() => requireActingUser(user, "mallory")).toThrow(AccessDeniedError);
  });

  it("never lets a service credential assert an end-user owner", () => {
    const service = accessScopeFromPrincipal({ userId: undefined, userGroups: undefined, source: "service" });
    expect(() => requireActingUser(service, "alice")).toThrow(AccessDeniedError);
    expect(() => aclForMutation(service, restricted, "alice")).toThrow(AccessDeniedError);
  });

  it("accepts any requesting_user under authorization bypass (AUTHZ_ENABLED=false)", () => {
    const bypass = accessScopeFromPrincipal({
      userId: undefined,
      userGroups: undefined,
      tenantId: "poc",
      source: "anonymous",
      authorizationBypass: true,
    });
    expect(requireActingUser(bypass, "alice")).toBe("alice");
    expect(() => requireActingUser(bypass, "  ")).toThrow(AccessDeniedError);
  });

  it("creates stable, identity-sensitive MCP session fingerprints", () => {
    const alice = { userId: "alice", userGroups: ["legal", "staff"], source: "jwt" as const };
    const reordered = { ...alice, userGroups: ["staff", "legal"] };
    const bob = { ...alice, userId: "bob" };
    expect(principalFingerprint(alice)).toBe(principalFingerprint(reordered));
    expect(principalFingerprint(alice)).not.toBe(principalFingerprint(bob));
  });

  it("requires an explicit collection ACL for identity-less service ingest", () => {
    const service = accessScopeFromPrincipal({ userId: undefined, userGroups: undefined, source: "service" });
    expect(() => aclForMutation(service, { allowedUsers: [], allowedGroups: [] })).toThrow(AccessDeniedError);
    expect(aclForMutation(service, restricted)).toEqual(restricted);
  });

  it("rejects a service write when the collection does not exist yet", () => {
    const service = accessScopeFromPrincipal({ userId: undefined, userGroups: undefined, source: "service" });
    expect(() => aclForMutation(service, undefined)).toThrow(AccessDeniedError);
  });

  it("uses an empty ACL for a first bypass write on an unknown collection", () => {
    const bypass = accessScopeFromPrincipal({
      userId: undefined,
      userGroups: undefined,
      tenantId: "tenant-a",
      source: "anonymous",
      authorizationBypass: true,
    });
    expect(aclForMutation(bypass, undefined)).toEqual({
      allowedUsers: [],
      allowedGroups: [],
      preserveExistingOnConflict: true,
    });
  });
});

describe("delegated ingest ACLs", () => {
  const delegated = { users: ["viewer-1", "viewer-2"], groups: ["client:acme"] };

  it("honors delegated viewer lists for a principal holding vectorsearch.acl.manage", () => {
    const writer = accessScopeFromPrincipal({
      userId: "worker",
      userGroups: [],
      source: "jwt",
      scopes: ["vectorsearch.write", "vectorsearch.acl.manage"],
    });
    expect(aclForMutation(writer, undefined, undefined, delegated)).toEqual({
      allowedUsers: ["viewer-1", "viewer-2"],
      allowedGroups: ["client:acme"],
    });
  });

  it("normalizes delegated lists (trim, drop blanks, dedupe)", () => {
    const writer = accessScopeFromPrincipal({
      userId: "worker",
      userGroups: [],
      source: "jwt",
      scopes: ["vectorsearch.acl.manage"],
    });
    expect(
      aclForMutation(writer, undefined, undefined, {
        users: [" bob ", "", "alice", "bob"],
        groups: [" legal ", "legal"],
      }),
    ).toEqual({ allowedUsers: ["alice", "bob"], allowedGroups: ["legal"] });
  });

  it("ignores delegated lists for a principal without the manage scope", () => {
    const user = accessScopeFromPrincipal({
      userId: "alice",
      userGroups: ["legal"],
      source: "jwt",
      scopes: ["vectorsearch.write"],
    });
    expect(aclForMutation(user, undefined, undefined, delegated)).toEqual({
      allowedUsers: ["alice"],
      allowedGroups: ["legal"],
    });
  });

  it("honors delegated lists for a service credential on a new collection", () => {
    const service = accessScopeFromPrincipal({ userId: undefined, userGroups: undefined, source: "service" });
    expect(aclForMutation(service, undefined, undefined, delegated)).toEqual({
      allowedUsers: ["viewer-1", "viewer-2"],
      allowedGroups: ["client:acme"],
    });
  });

  it("ignores empty delegated lists and keeps the principal-derived ACL", () => {
    const writer = accessScopeFromPrincipal({
      userId: "worker",
      userGroups: [],
      source: "jwt",
      scopes: ["vectorsearch.acl.manage"],
    });
    expect(aclForMutation(writer, undefined, undefined, { users: ["  "], groups: [] })).toEqual({
      allowedUsers: ["worker"],
      allowedGroups: [],
    });
  });

  it("lets an explicit private owner win over delegated lists", () => {
    const writer = accessScopeFromPrincipal({
      userId: "worker",
      userGroups: [],
      source: "jwt",
      scopes: ["vectorsearch.acl.manage"],
    });
    expect(aclForMutation(writer, undefined, "worker", delegated)).toEqual({
      allowedUsers: ["worker"],
      allowedGroups: [],
    });
  });
});

describe("requireCollectionAccess unknown-collection typing", () => {
  const missingClient = () =>
    ({
      getCollectionAcl: async () => ({
        ok: false as const,
        error: { code: "COLLECTION_NOT_FOUND" as const, message: "missing" },
      }),
    }) as unknown as PostgresClient;

  it("surfaces COLLECTION_NOT_FOUND as a typed denial for readers", async () => {
    const user = accessScopeFromPrincipal({ userId: "alice", userGroups: [], source: "jwt" });
    const error = await requireCollectionAccess(missingClient(), "missing", user).catch((e) => e);
    expect(error).toBeInstanceOf(AccessDeniedError);
    expect((error as AccessDeniedError).code).toBe("COLLECTION_NOT_FOUND");
  });

  it("returns an empty ACL for a bypass caller so first ingest can create the collection", async () => {
    const bypass = accessScopeFromPrincipal({
      userId: undefined,
      userGroups: undefined,
      tenantId: "tenant-a",
      source: "anonymous",
      authorizationBypass: true,
    });
    await expect(requireCollectionAccess(missingClient(), "missing", bypass)).resolves.toEqual({
      allowedUsers: [],
      allowedGroups: [],
    });
  });

  it("keeps generic ACL failures as untyped denials (fail closed)", async () => {
    const client = {
      getCollectionAcl: async () => ({
        ok: false as const,
        error: { code: "DB_ERROR" as const, message: "boom" },
      }),
    } as unknown as PostgresClient;
    const user = accessScopeFromPrincipal({ userId: "alice", userGroups: [], source: "jwt" });
    const error = await requireCollectionAccess(client, "docs", user).catch((e) => e);
    expect(error).toBeInstanceOf(AccessDeniedError);
    expect((error as AccessDeniedError).code).not.toBe("COLLECTION_NOT_FOUND");
  });
});


describe("scope authorization policy", () => {
  it("requires a verified tenant and exact operation scope in required mode", () => {
    const principal = { userId: "alice", userGroups: [], tenantId: "tenant-a", scopes: ["vectorsearch.read"], source: "jwt" as const };
    const scope = accessScopeFromPrincipal(principal);
    expect(() => requireAuthorization(scope, "read", "required")).not.toThrow();
    expect(() => requireAuthorization(scope, "write", "required")).toThrow(/required scope/);
    expect(() => requireAuthorization({ ...scope, tenantId: undefined }, "read", "required")).toThrow(/tenant claim/);
  });

  it("uses a dedicated metrics scope rather than an implicit admin grant", () => {
    const metrics = accessScopeFromPrincipal({ userId: "alice", userGroups: [], tenantId: "tenant-a", scopes: ["vectorsearch.metrics"], source: "jwt" });
    const admin = accessScopeFromPrincipal({ userId: "alice", userGroups: [], tenantId: "tenant-a", scopes: ["vectorsearch.admin"], source: "jwt" });
    expect(() => requireAuthorization(metrics, "metrics", "required")).not.toThrow();
    expect(() => requireAuthorization(admin, "metrics", "required")).toThrow(AccessDeniedError);
  });

  it("permits a tool-specific grant only for its exact MCP tool", () => {
    const scope = accessScopeFromPrincipal({ userId: "alice", userGroups: [], tenantId: "tenant-a", scopes: ["tool:retrieve_evidence"], source: "jwt" });
    expect(() => requireAuthorization(scope, "read", "required", "retrieve_evidence")).not.toThrow();
    expect(() => requireAuthorization(scope, "read", "required", "search")).toThrow(AccessDeniedError);
  });

  it("accepts knowledge as a read grant and restricts it to exact kb collections", async () => {
    const client = {
      getCollectionAcl: async () => ({
        ok: true as const,
        result: { allowedUsers: [], allowedGroups: [] },
      }),
    } as unknown as PostgresClient;
    const scope = accessScopeFromPrincipal({
      userId: "alice",
      userGroups: [],
      tenantId: "tenant-a",
      scopes: ["knowledge", "kb:handbook"],
      source: "jwt",
    });

    expect(() => requireAuthorization(scope, "read", "required")).not.toThrow();
    await expect(requireCollectionAccess(client, "handbook", scope)).resolves.toEqual({
      allowedUsers: [],
      allowedGroups: [],
    });
    await expect(requireCollectionAccess(client, "finance", scope)).rejects.toThrow(
      /Access denied to collection/,
    );
  });

  it("keeps vectorsearch.read compatible without requiring a kb grant", async () => {
    const client = {
      getCollectionAcl: async () => ({
        ok: true as const,
        result: { allowedUsers: [], allowedGroups: [] },
      }),
    } as unknown as PostgresClient;
    const scope = accessScopeFromPrincipal({
      userId: "alice",
      userGroups: [],
      tenantId: "tenant-a",
      scopes: ["vectorsearch.read"],
      source: "jwt",
    });

    await expect(requireCollectionAccess(client, "finance", scope)).resolves.toBeDefined();
  });
});

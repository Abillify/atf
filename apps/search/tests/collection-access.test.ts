// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Collection-level ACLs — the pure decision function and the middleware.
 *
 * Both were at 0% coverage. The middleware is where the identity fix actually
 * has to land: it now reads the principal established by the auth middleware
 * instead of re-reading X-User/X-Groups, so a verified JWT identity is honoured
 * rather than being seen as "no identity" (which this module treats as an
 * admin/service context).
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { collectionAccessAllowed } from "../src/collection-access.js";
import {
  collectionFromHeader,
  collectionFromParam,
  collectionFromQuery,
  createCollectionAccessMiddleware,
  extractPrincipal,
} from "../src/handlers/collection-access.js";
import { setPrincipal } from "../src/request-principal.js";
import type { PostgresClient } from "../src/postgres-client.js";

// ---------------------------------------------------------------------------
// Pure decision function
// ---------------------------------------------------------------------------

describe("collectionAccessAllowed", () => {
  it("treats an empty ACL as public", () => {
    expect(collectionAccessAllowed({ allowedUsers: [], allowedGroups: [] }, "alice", [])).toBe(
      true,
    );
  });

  it("treats a missing/unknown ACL as public", () => {
    expect(collectionAccessAllowed(null, "alice", [])).toBe(true);
    expect(collectionAccessAllowed(undefined, "alice", [])).toBe(true);
  });

  it("allows a listed user", () => {
    expect(
      collectionAccessAllowed(
        { allowedUsers: ["alice"], allowedGroups: [] },
        "alice",
        undefined,
      ),
    ).toBe(true);
  });

  it("denies an unlisted user", () => {
    expect(
      collectionAccessAllowed(
        { allowedUsers: ["alice"], allowedGroups: [] },
        "bob",
        undefined,
      ),
    ).toBe(false);
  });

  it("allows via group membership alone", () => {
    expect(
      collectionAccessAllowed(
        { allowedUsers: [], allowedGroups: ["legal"] },
        "bob",
        ["legal"],
      ),
    ).toBe(true);
  });

  it("ORs user and group checks rather than requiring both", () => {
    const acl = { allowedUsers: ["alice"], allowedGroups: ["legal"] };
    expect(collectionAccessAllowed(acl, "alice", ["other"])).toBe(true);
    expect(collectionAccessAllowed(acl, "bob", ["legal"])).toBe(true);
    expect(collectionAccessAllowed(acl, "bob", ["other"])).toBe(false);
  });

  /**
   * Documented, deliberate behaviour: an identity-less caller is a service
   * context. It is only safe because a verified caller ALWAYS has an identity
   * now — before the principal fix, a real end user also arrived here with no
   * identity and therefore landed on this branch.
   */
  it("denies an identity-less caller", () => {
    expect(
      collectionAccessAllowed(
        { allowedUsers: ["alice"], allowedGroups: [] },
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      collectionAccessAllowed({ allowedUsers: ["alice"], allowedGroups: [] }, "", []),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Collection resolvers
// ---------------------------------------------------------------------------

describe("collection resolvers", () => {
  it("reads the X-Collection header", () => {
    expect(
      collectionFromHeader({ headers: { "x-collection": "akten" } } as unknown as Request),
    ).toBe("akten");
  });

  it("reads the ?collection= query param", () => {
    expect(
      collectionFromQuery({ query: { collection: "akten" } } as unknown as Request),
    ).toBe("akten");
  });

  it("reads the :name route param", () => {
    expect(
      collectionFromParam({ params: { name: "akten" } } as unknown as Request),
    ).toBe("akten");
  });

  it("returns undefined for a blank value so the default applies", () => {
    expect(
      collectionFromHeader({ headers: { "x-collection": "" } } as unknown as Request),
    ).toBeUndefined();
    expect(collectionFromQuery({ query: {} } as unknown as Request)).toBeUndefined();
    expect(collectionFromParam({ params: {} } as unknown as Request)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractPrincipal delegation
// ---------------------------------------------------------------------------

describe("extractPrincipal", () => {
  it("returns the principal attached by the auth middleware", () => {
    const req = { headers: { "x-user": "header-claim" } } as unknown as Request;
    setPrincipal(req, { userId: "verified", userGroups: ["legal"], source: "jwt" });
    // The header value must NOT win — that was the escalation path.
    expect(extractPrincipal(req)).toEqual({
      userId: "verified",
      userGroups: ["legal"],
      source: "jwt",
    });
  });
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

describe("createCollectionAccessMiddleware", () => {
  function mkRes() {
    const res = {
      locals: {} as Record<string, unknown>,
      _status: undefined as number | undefined,
      _body: undefined as unknown,
      status(code: number) {
        res._status = code;
        return res;
      },
      json(body: unknown) {
        res._body = body;
        return res;
      },
    };
    return res as unknown as Response & { _status?: number; _body?: unknown };
  }

  function mkClient(
    acl: { allowedUsers: string[]; allowedGroups: string[] } | null,
    ok = true,
  ): { client: PostgresClient; calls: number } {
    const state = { calls: 0 };
    const client = {
      getCollectionAcl: async () => {
        state.calls++;
        return ok
          ? { ok: true as const, result: acl }
          : { ok: false as const, error: new Error("unknown collection") };
      },
    } as unknown as PostgresClient;
    return {
      client,
      get calls() {
        return state.calls;
      },
    } as { client: PostgresClient; calls: number };
  }

  async function run(
    principal: Parameters<typeof setPrincipal>[1] | undefined,
    aclHolder: { client: PostgresClient },
    headers: Record<string, string> = { "x-collection": "akten" },
  ) {
    const req = { headers } as unknown as Request;
    if (principal) setPrincipal(req, principal);
    const res = mkRes();
    const next = vi.fn();
    await createCollectionAccessMiddleware(
      aclHolder.client,
      collectionFromHeader,
    )(req, res, next);
    return { res, next };
  }

  it("allows an authenticated service context after checking the ACL source", async () => {
    const holder = mkClient({ allowedUsers: ["alice"], allowedGroups: [] });
    const { next } = await run(
      { userId: undefined, userGroups: undefined, source: "service" },
      holder,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(holder.calls).toBe(1);
  });

  it("answers 400 for a collection name that breaks the naming rule, before any ACL lookup", async () => {
    const holder = mkClient({ allowedUsers: [], allowedGroups: [] });
    const { next, res } = await run(
      { userId: "alice", userGroups: undefined, source: "jwt" },
      holder,
      { "x-collection": "atf-ui-smoketest" },
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(holder.calls).toBe(0);
  });

  it("allows a permitted user", async () => {
    const holder = mkClient({ allowedUsers: ["alice"], allowedGroups: [] });
    const { next, res } = await run(
      { userId: "alice", userGroups: undefined, source: "jwt" },
      holder,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeUndefined();
  });

  /**
   * The behaviour that was previously unreachable from aiperator: a verified
   * end-user identity is now present, so the ACL actually denies.
   */
  it("denies a user who is not on the ACL", async () => {
    const holder = mkClient({ allowedUsers: ["alice"], allowedGroups: [] });
    const { next, res } = await run(
      { userId: "bob", userGroups: undefined, source: "jwt" },
      holder,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(String((res._body as { error: string }).error)).toContain("akten");
  });

  it("allows via group membership", async () => {
    const holder = mkClient({ allowedUsers: [], allowedGroups: ["legal"] });
    const { next } = await run(
      { userId: "bob", userGroups: ["legal"], source: "jwt" },
      holder,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("fails closed for an unknown collection", async () => {
    // Nothing to protect yet — the handler returns the appropriate 400/404.
    const holder = mkClient(null, false);
    const { next, res } = await run(
      { userId: "bob", userGroups: undefined, source: "jwt" },
      holder,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it("answers 404 (not 403) for a collection that does not exist", async () => {
    // A missing index holds nothing; that is an empty page, not a permission
    // failure. The typed COLLECTION_NOT_FOUND must surface as 404.
    const client = {
      getCollectionAcl: async () => ({
        ok: false as const,
        error: { code: "COLLECTION_NOT_FOUND" as const, message: "missing" },
      }),
    } as unknown as PostgresClient;
    const req = { headers: { "x-collection": "akten" } } as unknown as Request;
    setPrincipal(req, { userId: "bob", userGroups: undefined, source: "jwt" });
    const res = mkRes();
    const next = vi.fn();
    await createCollectionAccessMiddleware(client, collectionFromHeader)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(404);
    expect((res._body as { code?: string }).code).toBe("COLLECTION_NOT_FOUND");
  });

  it("lets a first ingest proceed when allowUnknownCollection is set", async () => {
    const client = {
      getCollectionAcl: async () => ({
        ok: false as const,
        error: { code: "COLLECTION_NOT_FOUND" as const, message: "missing" },
      }),
    } as unknown as PostgresClient;
    const req = { headers: { "x-collection": "akten" } } as unknown as Request;
    setPrincipal(req, { userId: "bob", userGroups: undefined, source: "jwt" });
    const res = mkRes();
    const next = vi.fn();
    await createCollectionAccessMiddleware(client, collectionFromHeader, {
      allowUnknownCollection: true,
    })(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBeUndefined();
    expect((res as unknown as { locals: Record<string, unknown> }).locals["collectionAcl"]).toBeUndefined();
    expect((res as unknown as { locals: Record<string, unknown> }).locals["resolvedCollection"]).toBe("akten");
  });

  it("still denies a real ACL violation when allowUnknownCollection is set", async () => {
    const holder = mkClient({ allowedUsers: ["alice"], allowedGroups: [] });
    const req = { headers: { "x-collection": "akten" } } as unknown as Request;
    setPrincipal(req, { userId: "bob", userGroups: undefined, source: "jwt" });
    const res = mkRes();
    const next = vi.fn();
    await createCollectionAccessMiddleware(holder.client, collectionFromHeader, {
      allowUnknownCollection: true,
    })(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it("falls back to the default collection when none is specified", async () => {
    const holder = mkClient({ allowedUsers: ["alice"], allowedGroups: [] });
    const { res } = await run(
      { userId: "bob", userGroups: undefined, source: "jwt" },
      holder,
      {},
    );
    expect(res._status).toBe(403);
    expect(String((res._body as { error: string }).error)).toContain("documents");
  });

  it("forwards an unexpected error to the error handler instead of failing open", async () => {
    const client = {
      getCollectionAcl: async () => {
        throw new Error("connection reset");
      },
    } as unknown as PostgresClient;
    const req = { headers: { "x-collection": "akten" } } as unknown as Request;
    setPrincipal(req, { userId: "bob", userGroups: undefined, source: "jwt" });
    const next = vi.fn();
    await createCollectionAccessMiddleware(client, collectionFromHeader)(
      req,
      mkRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

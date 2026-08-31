// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Identity resolution — the module that decides who a request acts as.
 *
 * The rule under test, stated once: a VERIFIED identity is authoritative and
 * cannot be overridden by a header; header assertion stays available to service
 * callers holding the static API token. That distinction is the whole fix — the
 * previous design read X-User/X-Groups unconditionally, so (a) a verified
 * end-user JWT arrived as "no identity" and was promoted to admin, and (b) the
 * ACL could be bypassed by simply omitting a header.
 */

import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  SERVICE_PRINCIPAL,
  createRequireIdentityMiddleware,
  getAmbientPrincipal,
  getPrincipal,
  hasIdentity,
  parseGroupsHeader,
  readAssertedIdentity,
  runWithPrincipal,
  setPrincipal,
} from "../src/request-principal.js";
import { createAuthMiddleware } from "../src/auth.js";
import type { JwtVerifier } from "../src/jwt-verifier.js";

/** Minimal Express request stub. */
function mkReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

/** Response stub that records status/json calls. */
function mkRes(): Response & { _status?: number; _body?: unknown } {
  const res = {
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

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

describe("parseGroupsHeader", () => {
  it("splits on commas and trims", () => {
    expect(parseGroupsHeader("staff, legal ,finance")).toEqual([
      "staff",
      "legal",
      "finance",
    ]);
  });

  it("drops empty segments", () => {
    expect(parseGroupsHeader("staff,,legal,")).toEqual(["staff", "legal"]);
  });

  it("returns an empty list for undefined or blank input", () => {
    expect(parseGroupsHeader(undefined)).toEqual([]);
    expect(parseGroupsHeader("")).toEqual([]);
    expect(parseGroupsHeader("  ,  ")).toEqual([]);
  });
});

describe("readAssertedIdentity", () => {
  it("reads X-User and X-Groups", () => {
    expect(
      readAssertedIdentity(mkReq({ "x-user": "alice", "x-groups": "staff" })),
    ).toEqual({ userId: "alice", userGroups: ["staff"] });
  });

  it("leaves groups undefined rather than an empty array", () => {
    // Downstream distinguishes "no groups asserted" from "asserted zero groups";
    // an empty array would read as an identity.
    expect(readAssertedIdentity(mkReq({ "x-user": "alice" }))).toEqual({
      userId: "alice",
      userGroups: undefined,
    });
  });

  it("returns nothing when no headers are present", () => {
    expect(readAssertedIdentity(mkReq())).toEqual({
      userId: undefined,
      userGroups: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Principal attachment
// ---------------------------------------------------------------------------

describe("setPrincipal / getPrincipal", () => {
  it("returns the attached principal", () => {
    const req = mkReq({ "x-user": "ignored-when-attached" });
    setPrincipal(req, { userId: "alice", userGroups: ["staff"], source: "jwt" });
    expect(getPrincipal(req)).toEqual({
      userId: "alice",
      userGroups: ["staff"],
      source: "jwt",
    });
  });

  it("falls back to asserted headers when nothing was attached", () => {
    // Only reachable when auth is disabled entirely — there was no credential
    // to escalate from in that case.
    const principal = getPrincipal(mkReq({ "x-user": "bob" }));
    expect(principal.userId).toBe("bob");
    expect(principal.source).toBe("anonymous");
  });
});

describe("hasIdentity", () => {
  it("is false for the service principal", () => {
    expect(hasIdentity(SERVICE_PRINCIPAL)).toBe(false);
  });

  it("is true with a user or with groups alone", () => {
    expect(
      hasIdentity({ userId: "alice", userGroups: undefined, source: "jwt" }),
    ).toBe(true);
    expect(
      hasIdentity({ userId: undefined, userGroups: ["staff"], source: "jwt" }),
    ).toBe(true);
  });

  it("is false for an empty group array", () => {
    expect(
      hasIdentity({ userId: undefined, userGroups: [], source: "jwt" }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requireIdentity middleware
// ---------------------------------------------------------------------------

describe("createRequireIdentityMiddleware", () => {
  it("passes everything through when disabled", () => {
    const next = vi.fn();
    createRequireIdentityMiddleware(false)(mkReq(), mkRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("refuses a request with no identity when enabled", () => {
    const next = vi.fn();
    const res = mkRes();
    createRequireIdentityMiddleware(true)(mkReq(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect(String((res._body as { error: string }).error)).toContain(
      "No end-user identity",
    );
  });

  it("admits a request carrying an identity when enabled", () => {
    const next = vi.fn();
    const req = mkReq();
    setPrincipal(req, { userId: "alice", userGroups: undefined, source: "jwt" });
    createRequireIdentityMiddleware(true)(req, mkRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Ambient principal (MCP transport bridge)
// ---------------------------------------------------------------------------

describe("ambient principal", () => {
  it("is undefined outside a scope, rather than defaulting to full access", () => {
    expect(getAmbientPrincipal()).toBeUndefined();
  });

  it("is visible inside runWithPrincipal", () => {
    const principal = {
      userId: "alice",
      userGroups: ["staff"],
      source: "jwt" as const,
    };
    const seen = runWithPrincipal(principal, () => getAmbientPrincipal());
    expect(seen).toEqual(principal);
  });

  it("survives an await boundary, which is what the MCP tool path needs", async () => {
    const principal = {
      userId: "alice",
      userGroups: undefined,
      source: "jwt" as const,
    };
    const seen = await runWithPrincipal(principal, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getAmbientPrincipal();
    });
    expect(seen).toEqual(principal);
  });

  it("does not leak out of the scope", () => {
    runWithPrincipal(
      { userId: "alice", userGroups: undefined, source: "jwt" },
      () => undefined,
    );
    expect(getAmbientPrincipal()).toBeUndefined();
  });

  it("keeps concurrent requests isolated", async () => {
    const run = (id: string, delay: number) =>
      runWithPrincipal(
        { userId: id, userGroups: undefined, source: "jwt" },
        async () => {
          await new Promise((r) => setTimeout(r, delay));
          return getAmbientPrincipal()?.userId;
        },
      );
    const [a, b] = await Promise.all([run("alice", 10), run("bob", 1)]);
    expect(a).toBe("alice");
    expect(b).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the auth middleware — the actual fix
// ---------------------------------------------------------------------------

describe("auth middleware · principal resolution", () => {
  const TOKEN = "static-service-token-that-is-long-enough";

  /** A verifier that accepts one token and returns a fixed principal. */
  const verifier: JwtVerifier = {
    verify: async (raw) =>
      raw === "good-jwt"
        ? {
            iss: "https://id.example.com/",
            sub: "sub-123",
            userId: "alice@example.com",
            groups: ["legal", "staff"],
            tenantId: "tenant-a",
            scopes: [],
            audience: undefined,
            clientId: undefined,
            jti: undefined,
          }
        : null,
  };

  function run(
    headers: Record<string, string>,
    opts: {
      apiToken?: string | null;
      jwtVerifier?: JwtVerifier | null;
      tenantIsolationEnabled?: boolean;
    } = {},
  ): Promise<{ req: Request; res: ReturnType<typeof mkRes>; called: boolean }> {
    const req = mkReq(headers);
    const res = mkRes();
    const mw = createAuthMiddleware(
      opts.apiToken === undefined ? TOKEN : opts.apiToken,
      undefined,
      null,
      opts.jwtVerifier ?? null,
      undefined,
      { tenantIsolationEnabled: opts.tenantIsolationEnabled },
    );
    return new Promise((resolve) => {
      let settled = false;
      const done = (called: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ req, res, called });
      };
      mw(req, res, () => done(true));
      // The JWT path is async; give it a tick before concluding it rejected.
      setTimeout(() => done(false), 25);
    });
  }

  it("attaches the VERIFIED identity from a JWT", async () => {
    const { req, called } = await run(
      { authorization: "Bearer good-jwt" },
      { jwtVerifier: verifier },
    );
    expect(called).toBe(true);
    expect(getPrincipal(req)).toEqual({
      userId: "alice@example.com",
      userGroups: ["legal", "staff"],
      tenantId: "tenant-a",
      issuer: "https://id.example.com/",
      source: "jwt",
    });
  });

  /**
   * The escalation this closes: with a verified user token, adding X-User must
   * not let the caller act as somebody else, and removing it must not turn the
   * caller into a service context with unrestricted read access.
   */
  it("ignores X-User/X-Groups on the verified-JWT path", async () => {
    const { req } = await run(
      {
        authorization: "Bearer good-jwt",
        "x-user": "attacker",
        "x-groups": "admins",
      },
      { jwtVerifier: verifier },
    );
    const principal = getPrincipal(req);
    expect(principal.userId).toBe("alice@example.com");
    expect(principal.userGroups).toEqual(["legal", "staff"]);
    expect(principal.source).toBe("jwt");
  });

  it("treats a static token with no asserted identity as a service context", async () => {
    const { req, called } = await run({ authorization: `Bearer ${TOKEN}` });
    expect(called).toBe(true);
    const principal = getPrincipal(req);
    expect(principal.source).toBe("service");
    expect(hasIdentity(principal)).toBe(false);
  });

  it("does not synthesize a tenant for a static token when isolation is enabled", async () => {
    const { req, called } = await run(
      { authorization: `Bearer ${TOKEN}` },
      { tenantIsolationEnabled: true },
    );
    expect(called).toBe(true);
    expect(getPrincipal(req).tenantId).toBeUndefined();
  });

  it("honours asserted headers for a static-token caller in single-tenant mode", async () => {
    const { req } = await run(
      {
        authorization: `Bearer ${TOKEN}`,
        "x-user": "alice",
        "x-groups": "staff,legal",
      },
      { tenantIsolationEnabled: false },
    );
    expect(getPrincipal(req)).toEqual({
      userId: "alice",
      userGroups: ["staff", "legal"],
      tenantId: "default",
      source: "asserted",
    });
  });

  it("rejects an unknown bearer instead of falling through to a principal", async () => {
    const { res, called } = await run(
      { authorization: "Bearer wrong" },
      { jwtVerifier: verifier },
    );
    expect(called).toBe(false);
    expect(res._status).toBe(401);
  });

  it("uses no tenant for direct disabled-mode middleware under isolation", async () => {
    const { req, called } = await run(
      {},
      { apiToken: null, jwtVerifier: null, tenantIsolationEnabled: true },
    );
    expect(called).toBe(true);
    expect(getPrincipal(req)).toMatchObject({ source: "anonymous" });
    expect(getPrincipal(req).tenantId).toBeUndefined();
  });

  it("uses the default tenant for disabled mode only when isolation is off", async () => {
    const { req, called } = await run(
      { "x-user": "dev" },
      {
        apiToken: null,
        jwtVerifier: null,
        tenantIsolationEnabled: false,
      },
    );
    expect(called).toBe(true);
    const principal = getPrincipal(req);
    expect(principal.source).toBe("anonymous");
    expect(principal.userId).toBeUndefined();
    expect(principal.tenantId).toBe("default");
  });
});

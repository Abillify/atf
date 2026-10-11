// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { ConditionRuleSchema } from "../../src/config/schema.ts";
import {
  evaluateConditions,
  privilegedConditionNames,
} from "../../src/db/conditions.ts";
import type { AuthContext } from "../../src/auth/context.ts";

function ctx(username: string, email: string): AuthContext {
  return {
    method: "static",
    subject: username,
    username,
    scopes: ["query:read"],
    claims: { email, tenant: "acme" },
    headers: {},
    rawToken: "x",
  };
}

describe("evaluateConditions", () => {
  const conditions = {
    privileged: {
      any: [
        { context: "username", in: ["alice-example", "bob-example"] },
        { context: "claims.email", in: ["alice@example.com"] },
      ],
    },
  };

  it("matches via username", () => {
    expect(evaluateConditions(conditions, ctx("alice-example", "other@example.com")).privileged).toBe(true);
  });

  it("matches via email", () => {
    expect(evaluateConditions(conditions, ctx("standard-user", "alice@example.com")).privileged).toBe(
      true,
    );
  });

  it("does not match for a normal user", () => {
    expect(evaluateConditions(conditions, ctx("bob", "bob@y.de")).privileged).toBe(false);
  });

  it("supports equals and exists operators", () => {
    const conds = {
      isAcme: { all: [{ context: "claims.tenant", equals: "acme" }] },
      hasEmail: { all: [{ context: "claims.email", exists: true }] },
    };
    const r = evaluateConditions(conds, ctx("bob", "bob@y.de"));
    expect(r.isAcme).toBe(true);
    expect(r.hasEmail).toBe(true);
  });

  it("matches final scopes with containsAny and containsAll", () => {
    const conds = {
      bookingsPrivileged: {
        all: [{ context: "scopes", containsAny: ["bookings:manage", "bookings:admin"] }],
      },
      timesheetsPrivileged: {
        all: [{ context: "scopes", containsAll: ["timesheets:read-sensitive", "timesheets:manage"] }],
      },
    };
    const privileged = {
      ...ctx("bob", "bob@y.de"),
      scopes: ["tools:read", "bookings:manage", "timesheets:read-sensitive", "timesheets:manage"],
    };
    const partial = { ...privileged, scopes: ["bookings:viewer", "timesheets:manage"] };

    expect(evaluateConditions(conds, privileged)).toEqual({
      bookingsPrivileged: true,
      timesheetsPrivileged: true,
    });
    expect(evaluateConditions(conds, partial)).toEqual({
      bookingsPrivileged: false,
      timesheetsPrivileged: false,
    });
  });

  it("fails closed for missing, non-array, and non-string-array values", () => {
    const conds = {
      privileged: { all: [{ context: "claims.scope", containsAny: ["bookings:manage"] }] },
    };
    const missing = { ...ctx("bob", "bob@y.de"), claims: {} };
    const scalar = { ...ctx("bob", "bob@y.de"), claims: { scope: "bookings:manage" } };
    const malformed = { ...ctx("bob", "bob@y.de"), claims: { scope: ["bookings:manage", 1] } };

    expect(evaluateConditions(conds, missing).privileged).toBe(false);
    expect(evaluateConditions(conds, scalar).privileged).toBe(false);
    expect(evaluateConditions(conds, malformed).privileged).toBe(false);
  });

  it("rejects empty scope operands", () => {
    expect(ConditionRuleSchema.safeParse({ context: "scopes", containsAny: [] }).success).toBe(false);
    expect(ConditionRuleSchema.safeParse({ context: "scopes", containsAll: [] }).success).toBe(false);
  });
  it("ANDs the rules in 'all'", () => {
    const conds = {
      both: {
        all: [
          { context: "claims.tenant", equals: "acme" },
          { context: "username", equals: "nope" },
        ],
      },
    };
    expect(evaluateConditions(conds, ctx("bob", "b@y.de")).both).toBe(false);
  });
});

describe("privilegedConditionNames (Req 6.7 / ADR-0002)", () => {
  it("detects conditions whose rules read the scopes context", () => {
    const names = privilegedConditionNames({
      privileged: {
        all: [{ context: "scopes", containsAny: ["timesheets:admin"] }],
      },
      needsAllScopes: {
        any: [{ context: "scopes", containsAll: ["a:read", "a:write"] }],
      },
    });
    expect([...names].sort()).toEqual(["needsAllScopes", "privileged"]);
  });

  it("detects nested scope paths like scopes.length", () => {
    const names = privilegedConditionNames({
      scoped: { all: [{ context: "scopes.length", exists: true }] },
    });
    expect(names.has("scoped")).toBe(true);
  });

  it("treats claim-based conditions as non-privileged", () => {
    const names = privilegedConditionNames({
      notAdmin: { all: [{ context: "claims.role", equals: "support" }] },
      named: { any: [{ context: "username", in: ["alice"] }] },
      mixed: {
        any: [{ context: "claims.tenant", equals: "acme" }],
        all: [{ context: "tenantId", exists: true }],
      },
    });
    expect(names.size).toBe(0);
  });

  it("flags a condition as privileged if any rule in any/all reads scopes", () => {
    const names = privilegedConditionNames({
      mixed: {
        any: [{ context: "claims.role", equals: "support" }],
        all: [{ context: "scopes", containsAny: ["admin"] }],
      },
    });
    expect(names.has("mixed")).toBe(true);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { ConditionRuleSchema } from "../../src/config/schema.ts";
import { evaluateConditions } from "../../src/db/conditions.ts";
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
      parkingPrivileged: {
        all: [{ context: "scopes", containsAny: ["parking:manage", "parking:admin"] }],
      },
      worktimePrivileged: {
        all: [{ context: "scopes", containsAll: ["worktime:read-sensitive", "worktime:manage"] }],
      },
    };
    const privileged = {
      ...ctx("bob", "bob@y.de"),
      scopes: ["tools:read", "parking:manage", "worktime:read-sensitive", "worktime:manage"],
    };
    const partial = { ...privileged, scopes: ["parking:viewer", "worktime:manage"] };

    expect(evaluateConditions(conds, privileged)).toEqual({
      parkingPrivileged: true,
      worktimePrivileged: true,
    });
    expect(evaluateConditions(conds, partial)).toEqual({
      parkingPrivileged: false,
      worktimePrivileged: false,
    });
  });

  it("fails closed for missing, non-array, and non-string-array values", () => {
    const conds = {
      privileged: { all: [{ context: "claims.scope", containsAny: ["parking:manage"] }] },
    };
    const missing = { ...ctx("bob", "bob@y.de"), claims: {} };
    const scalar = { ...ctx("bob", "bob@y.de"), claims: { scope: "parking:manage" } };
    const malformed = { ...ctx("bob", "bob@y.de"), claims: { scope: ["parking:manage", 1] } };

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

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { compileQuery } from "../../src/db/bindings.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "s1",
  username: "alice",
  scopes: [],
  claims: { tenant: "acme", email: "a@x.io", profile: { city: "Berlin" } },
  tenantId: "acme",
  headers: { "x-tenant-id": "t-9" },
  rawToken: "secret",
};

describe("compileQuery", () => {
  it("binds ctx and param tokens as positional parameters", () => {
    const { sql, bindings } = compileQuery(
      "WHERE u = :ctx.username AND t = :ctx.claims.tenant AND s = :param.status",
      { status: "open" },
      ctx,
    );
    expect(sql).toBe("WHERE u = ? AND t = ? AND s = ?");
    expect(bindings).toEqual(["alice", "acme", "open"]);
  });

  it("exposes canonical tenantId and rejects tenant authority from headers", () => {
    const { bindings } = compileQuery("a=:ctx.claims.profile.city b=:ctx.tenantId", {}, ctx);
    expect(bindings).toEqual(["Berlin", "acme"]);
    expect(() => compileQuery("t=:ctx.headers.x-tenant-id", {}, ctx)).toThrow(
      "must use :ctx.tenantId",
    );
    expect(() =>
      compileQuery("t=:ctx.headers.x-account-id", {}, {
        ...ctx,
        tenantClaimNames: ["account_id"],
      }),
    ).toThrow("must use :ctx.tenantId");
  });

  it("preserves Postgres :: casts (no false token match)", () => {
    const { sql, bindings } = compileQuery("SELECT :param.id::int, now()::date", { id: 5 }, ctx);
    expect(sql).toBe("SELECT ?::int, now()::date");
    expect(bindings).toEqual([5]);
  });

  it("maps missing values to null instead of leaving raw tokens", () => {
    const { sql, bindings } = compileQuery("x=:param.nope y=:ctx.claims.nope", {}, ctx);
    expect(sql).toBe("x=? y=?");
    expect(bindings).toEqual([null, null]);
  });

  it("does not bind tokens inside line comments", () => {
    const { sql, bindings } = compileQuery(
      "-- uses :param.from and :ctx.username\nSELECT :param.from",
      { from: "2026-01-01" },
      ctx,
    );
    expect(bindings).toEqual(["2026-01-01"]);
    expect(sql).toContain("-- uses :param.from and :ctx.username");
  });

  it("does not bind tokens inside block comments or string literals", () => {
    const { bindings } = compileQuery(
      "/* :param.x */ SELECT ':ctx.username', :param.real",
      { x: "no", real: "yes" },
      ctx,
    );
    expect(bindings).toEqual(["yes"]);
  });

  it("serializes object values to JSON", () => {
    const { bindings } = compileQuery("v=:param.obj", { obj: { a: 1 } }, ctx);
    expect(bindings).toEqual(['{"a":1}']);
  });
});

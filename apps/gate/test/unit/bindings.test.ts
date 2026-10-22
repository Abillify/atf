// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { compileQuery } from "../../src/db/bindings.ts";
import { interpolateBody, interpolateRaw, interpolateUrl } from "../../src/db/http-bindings.ts";
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

describe("bearer token bindings", () => {
  it("refuses :ctx.rawToken and :ctx.headers.authorization at compile time", () => {
    expect(() => compileQuery("SELECT :ctx.rawToken", {}, ctx)).toThrow(
      "Binding :ctx.rawToken is not allowed",
    );
    expect(() =>
      compileQuery("SELECT :ctx.headers.authorization", {}, { ...ctx, headers: { authorization: "Bearer x" } }),
    ).toThrow("Binding :ctx.headers.authorization is not allowed");
    expect(() => compileQuery("SELECT :ctx.headers.Authorization", {}, ctx)).toThrow(
      "Binding :ctx.headers.authorization is not allowed",
    );
  });

  it("refuses the whole header object and credential headers in SQL, URLs, raw text and bodies", () => {
    const withHeaders = {
      ...ctx,
      headers: { authorization: "Bearer secret-x", cookie: "sid=1", "proxy-authorization": "Basic y" },
    };
    expect(() => compileQuery("SELECT :ctx.headers", {}, withHeaders)).toThrow("Binding :ctx.headers is not allowed");
    expect(() => compileQuery("SELECT :ctx.headers.cookie", {}, withHeaders)).toThrow(
      "Binding :ctx.headers.cookie is not allowed",
    );
    expect(() => compileQuery("SELECT :ctx.headers.proxy-authorization", {}, withHeaders)).toThrow(
      "Binding :ctx.headers.proxy-authorization is not allowed",
    );
    expect(() => interpolateBody({ h: ":ctx.headers" }, {}, withHeaders)).toThrow(
      "Binding :ctx.headers is not allowed",
    );
    expect(() => interpolateUrl("https://api.example.test/x?h=:ctx.headers", {}, withHeaders)).toThrow(
      "is not allowed",
    );
    expect(() => interpolateRaw("h=:ctx.headers", {}, withHeaders)).toThrow("is not allowed");
  });

  it("still resolves other headers and claims", () => {
    const { bindings } = compileQuery("SELECT :ctx.headers.x-request-id", {}, {
      ...ctx,
      headers: { "x-request-id": "r-1" },
    });
    expect(bindings).toEqual(["r-1"]);
  });
});

describe("bearer token bindings in the configuration", () => {
  const parse = async (query: string) => {
    const { AppConfigSchema } = await import("../../src/config/schema.ts");
    return AppConfigSchema.safeParse({
      server: { port: 3000 },
      auth: { mode: "static", static: { tokens: [{ token: "t", username: "u" }] } },
      databases: { main: { client: "pg", connection: "postgres://app:pw@db/app" } },
      tools: [{ name: "t1", type: "database", database: "main", query }],
    });
  };

  it("rejects a tool that binds the raw token when the configuration loads", async () => {
    const result = await parse("SELECT :ctx.rawToken");
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("Binding :ctx.rawToken is not allowed");
  });

  it("rejects the whole header object and credential headers when the configuration loads", async () => {
    for (const [query, path] of [
      ["SELECT :ctx.headers", "headers"],
      ["SELECT :ctx.headers.cookie", "headers.cookie"],
      ["SELECT :ctx.headers.Proxy-Authorization", "headers.Proxy-Authorization"],
    ] as const) {
      const result = await parse(query);
      expect(result.success, query).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain(`Binding :ctx.${path} is not allowed`);
    }
  });

  it("accepts single non-credential header bindings", async () => {
    expect((await parse("SELECT :ctx.headers.x-request-id")).success).toBe(true);
  });

  it("accepts a tool with ordinary bindings", async () => {
    expect((await parse("SELECT :ctx.username")).success).toBe(true);
  });
});

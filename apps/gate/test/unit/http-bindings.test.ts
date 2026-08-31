// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { interpolateUrl, interpolateRaw, interpolateBody } from "../../src/db/http-bindings.ts";
import type { AuthContext } from "../../src/auth/context.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "s1",
  username: "alice",
  scopes: [],
  claims: { tenant: "acme", email: "a@x.io" },
  tenantId: "acme",
  headers: { "x-tenant-id": "t-9" },
  rawToken: "secret",
};

describe("interpolateUrl", () => {
  it("URL-encodes resolved values", () => {
    const url = interpolateUrl(
      "https://api/x/:param.id?u=:ctx.username",
      { id: "a b/c" },
      ctx,
    );
    expect(url).toBe("https://api/x/a%20b%2Fc?u=alice");
  });

  it("replaces a missing token with an empty string", () => {
    expect(interpolateUrl("https://api/:param.nope", {}, ctx)).toBe("https://api/");
  });

  it("resolves verified claims and canonical tenantId but rejects tenant headers", () => {
    expect(interpolateUrl("https://api/:ctx.claims.tenant/:ctx.tenantId", {}, ctx)).toBe(
      "https://api/acme/acme",
    );
    expect(() =>
      interpolateUrl("https://api/:ctx.headers.x-tenant-id", {}, ctx),
    ).toThrow("must use :ctx.tenantId");
  });
});

describe("interpolateRaw", () => {
  it("substitutes without encoding (for headers)", () => {
    expect(interpolateRaw("Bearer :param.tok", { tok: "a/b c" }, ctx)).toBe("Bearer a/b c");
  });

  it("resolves identity tokens", () => {
    expect(interpolateRaw(":ctx.username", {}, ctx)).toBe("alice");
  });
});

describe("interpolateBody", () => {
  it("preserves the original type for a whole-string token", () => {
    const out = interpolateBody({ id: ":param.id", active: ":param.flag" }, { id: 42, flag: true }, ctx);
    expect(out).toEqual({ id: 42, active: true });
  });

  it("string-interpolates tokens embedded in a larger string", () => {
    const out = interpolateBody({ msg: "user :ctx.username did it" }, {}, ctx);
    expect(out).toEqual({ msg: "user alice did it" });
  });

  it("recurses into arrays and nested objects", () => {
    const out = interpolateBody(
      { items: [{ who: ":ctx.username" }, ":param.x"], n: 5 },
      { x: "lit" },
      ctx,
    );
    expect(out).toEqual({ items: [{ who: "alice" }, "lit"], n: 5 });
  });

  it("maps a missing whole-string token to null", () => {
    expect(interpolateBody(":param.nope", {}, ctx)).toBeNull();
  });

  it("passes through non-string primitives unchanged", () => {
    expect(interpolateBody(123, {}, ctx)).toBe(123);
    expect(interpolateBody(false, {}, ctx)).toBe(false);
  });
});

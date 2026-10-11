// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, test, expect } from "vitest";

import { decodeJwtClaims } from "./jwt-claims";

function makeJwt(payload: object): string {
  const enc = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(payload)}.sig`;
}

describe("decodeJwtClaims", () => {
  test("extracts a known role and numeric exp", () => {
    const jwt = makeJwt({ role: "admin", exp: 1_800_000_000 });
    expect(decodeJwtClaims(jwt)).toEqual({ role: "admin", exp: 1_800_000_000 });
  });

  test("nulls unknown roles and non-numeric exp", () => {
    const jwt = makeJwt({ role: "root", exp: "1800000000" });
    expect(decodeJwtClaims(jwt)).toEqual({ role: null, exp: null });
  });

  test("missing claims yield nulls", () => {
    expect(decodeJwtClaims(makeJwt({ sub: "u" }))).toEqual({
      role: null,
      exp: null,
    });
  });

  test("malformed tokens yield nulls instead of throwing", () => {
    for (const bad of ["", "not-a-jwt", "a.b", "a.b.c.d", "a.!!!.c"]) {
      expect(decodeJwtClaims(bad)).toEqual({ role: null, exp: null });
    }
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { expect, test } from "bun:test";
import { IdentityPrincipalSchema } from "../src/index.ts";
test("parses an identity principal", () => expect(IdentityPrincipalSchema.parse({ version: "1.0.0", id: "principal-1", subject: "subject-1", issuer: "issuer", authenticatedAt: "2025-01-01T00:00:00.000Z" }).roles).toEqual([]));

import {
  GatePrincipalInputSchema,
  actorFromClaim,
  IDENTITY_PRINCIPAL_CONTRACT_VERSION,
} from "../src/index.ts";

test("still parses a 1.0.0 principal (backward compatible)", () =>
  expect(
    IdentityPrincipalSchema.parse({
      version: "1.0.0",
      id: "p",
      subject: "s",
      issuer: "i",
      authenticatedAt: "2025-01-01T00:00:00.000Z",
    }).actor,
  ).toBeUndefined());

test("parses a delegated principal with an actor", () => {
  const parsed = IdentityPrincipalSchema.parse({
    version: IDENTITY_PRINCIPAL_CONTRACT_VERSION,
    id: "p",
    subject: "alice",
    issuer: "i",
    authenticatedAt: "2025-01-01T00:00:00.000Z",
    actor: { subject: "atf-runtime" },
  });
  expect(parsed.actor?.subject).toBe("atf-runtime");
});

test("actorFromClaim extracts a nested act chain", () => {
  const actor = actorFromClaim({ sub: "atf-runtime", iss: "idp", act: { sub: "gateway" } });
  expect(actor?.subject).toBe("atf-runtime");
  expect(actor?.issuer).toBe("idp");
  expect(actor?.parent?.subject).toBe("gateway");
});

test("actorFromClaim returns undefined for a non-object or missing sub", () => {
  expect(actorFromClaim(undefined)).toBeUndefined();
  expect(actorFromClaim({ notSub: "x" })).toBeUndefined();
});

test("GatePrincipalInput accepts an optional actor", () => {
  const parsed = GatePrincipalInputSchema.parse({
    method: "oauth",
    subject: "alice",
    username: "alice",
    scopes: [],
    claims: {},
    tenantId: "t",
    actor: { subject: "atf-runtime" },
  });
  expect(parsed.actor?.subject).toBe("atf-runtime");
});

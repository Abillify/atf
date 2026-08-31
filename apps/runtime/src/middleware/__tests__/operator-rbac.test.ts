// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for operator RBAC (`src/middleware/operator-rbac.ts`).
 *
 * `authorize` is async because the JWT role-claim path cryptographically
 * verifies the token signature before trusting the role.
 */

import { describe, it, expect } from "bun:test";
import {
  createOperatorAuthorizer,
  roleHasPermission,
} from "../operator-rbac.js";
import type { JwtVerifier } from "../jwt-verifier.js";

const bearer = (t: string) => `Bearer ${t}`;
const JWT = "aaa.bbb.ccc"; // valid format, 3 segments

describe("roleHasPermission", () => {
  it("grants read to viewer, write only to admin", () => {
    expect(roleHasPermission("viewer", "flows:read")).toBe(true);
    expect(roleHasPermission("viewer", "flows:write")).toBe(false);
    expect(roleHasPermission("operator", "approvals:write")).toBe(true);
    expect(roleHasPermission("operator", "flows:write")).toBe(false);
    expect(roleHasPermission("admin", "flows:write")).toBe(true);
    expect(roleHasPermission("admin", "audit:read")).toBe(true);
  });
});

describe("backward compatibility (no RBAC configured)", () => {
  it("is open when auth is not required", async () => {
    const a = createOperatorAuthorizer({ authRequired: false });
    expect(a.rbacEnabled).toBe(false);
    const r = await a.authorize(undefined, undefined, "flows:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("admin");
    expect(r.actor?.via).toBe("open");
  });

  // The legacy "any well-formed 3-segment token = admin" path is a full
  // operator-plane bypass: isJwtFormat() checks SHAPE only, so `aaa.bbb.ccc`
  // would grant flows:write. It now requires the deployment to have already
  // declared it accepts unverified tokens (JWT_ALLOW_UNVERIFIED=true).
  it("fails closed on a format-only token when unverified JWTs are not allowed", async () => {
    const a = createOperatorAuthorizer({ authRequired: true });
    expect(
      (await a.authorize(undefined, undefined, "monitoring:read")).ok,
    ).toBe(false);
    expect(
      (await a.authorize(bearer("not-a-jwt"), undefined, "monitoring:read")).ok,
    ).toBe(false);
    // A well-formed but UNVERIFIED token no longer grants anything.
    expect((await a.authorize(bearer(JWT), undefined, "flows:write")).ok).toBe(
      false,
    );
    expect(
      (await a.authorize(bearer(JWT), undefined, "monitoring:read")).ok,
    ).toBe(false);
  });

  it("a hand-typed 3-segment string cannot reach the operator plane", async () => {
    const a = createOperatorAuthorizer({ authRequired: true });
    const forged = "aaa.bbb.ccc";
    expect(
      (await a.authorize(bearer(forged), undefined, "monitoring:read")).ok,
    ).toBe(false);
    expect((await a.authorize(undefined, forged, "flows:write")).ok).toBe(
      false,
    );
  });

  it("grants admin on a format-only token ONLY with allowUnverifiedJwt", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      allowUnverifiedJwt: true,
    });
    expect(
      (await a.authorize(undefined, undefined, "monitoring:read")).ok,
    ).toBe(false);
    expect(
      (await a.authorize(bearer("not-a-jwt"), undefined, "monitoring:read")).ok,
    ).toBe(false);
    const r = await a.authorize(bearer(JWT), undefined, "flows:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("admin");
  });

  it("accepts the token via the ?token= query param (opt-in only)", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      allowUnverifiedJwt: true,
    });
    expect((await a.authorize(undefined, JWT, "monitoring:read")).ok).toBe(
      true,
    );
  });
});

describe("static token map RBAC", () => {
  const a = createOperatorAuthorizer({
    authRequired: true,
    tokens: [
      { token: "viewer-tok", role: "viewer", name: "vicky" },
      { token: "op-tok", role: "operator" },
      { token: "admin-tok", role: "admin", name: "alice" },
    ],
  });

  it("is enabled and maps tokens to roles", async () => {
    expect(a.rbacEnabled).toBe(true);
    const r = await a.authorize(bearer("admin-tok"), undefined, "flows:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.name).toBe("alice");
    expect(r.actor?.via).toBe("token");
  });

  it("enforces per-role permissions", async () => {
    // viewer can read but not write or approve.
    expect(
      (await a.authorize(bearer("viewer-tok"), undefined, "monitoring:read"))
        .ok,
    ).toBe(true);
    expect(
      (await a.authorize(bearer("viewer-tok"), undefined, "flows:write")).ok,
    ).toBe(false);
    expect(
      (await a.authorize(bearer("viewer-tok"), undefined, "approvals:write"))
        .ok,
    ).toBe(false);
    // operator can approve + replay but not write flows.
    expect(
      (await a.authorize(bearer("op-tok"), undefined, "approvals:write")).ok,
    ).toBe(true);
    expect(
      (await a.authorize(bearer("op-tok"), undefined, "replay:write")).ok,
    ).toBe(true);
    expect(
      (await a.authorize(bearer("op-tok"), undefined, "flows:write")).ok,
    ).toBe(false);
  });

  it("denies unknown tokens", async () => {
    const r = await a.authorize(bearer("nope"), undefined, "monitoring:read");
    expect(r.ok).toBe(false);
    expect(r.actor).toBeUndefined();
  });

  it("returns the actor even when permission is denied (for audit)", async () => {
    const r = await a.authorize(bearer("viewer-tok"), undefined, "flows:write");
    expect(r.ok).toBe(false);
    expect(r.actor?.role).toBe("viewer");
  });
});

describe("JWT role-claim RBAC", () => {
  const verifier = {
    enabled: true,
    decodePayload: (t: string) =>
      t === JWT
        ? { role: "operator", email: "bob@example.com" }
        : { role: "nope" },
    verify: async (t: string) => t === JWT,
  } as unknown as JwtVerifier;

  it("maps a verified role claim to an operator role", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      jwtVerifier: verifier,
    });
    expect(a.rbacEnabled).toBe(true);
    const r = await a.authorize(bearer(JWT), undefined, "approvals:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("operator");
    expect(r.actor?.name).toBe("bob@example.com");
    expect(r.actor?.via).toBe("jwt");
  });

  it("denies when the claim is not a known role", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      jwtVerifier: verifier,
    });
    expect(
      (await a.authorize(bearer("other.jwt.tok"), undefined, "monitoring:read"))
        .ok,
    ).toBe(false);
  });

  it("denies a forged token whose SIGNATURE fails verification (escalation guard)", async () => {
    // A token that decodes to role=admin but fails signature verification must
    // NOT be trusted — this is the security regression guard.
    const forgeVerifier = {
      enabled: true,
      decodePayload: () => ({ role: "admin" }),
      verify: async () => false, // signature invalid
    } as unknown as JwtVerifier;
    const a = createOperatorAuthorizer({
      authRequired: true,
      jwtVerifier: forgeVerifier,
    });
    const r = await a.authorize(
      bearer("forged.jwt.tok"),
      undefined,
      "flows:write",
    );
    expect(r.ok).toBe(false);
    expect(r.actor).toBeUndefined();
  });

  it("does not trust role claims when verification is disabled", async () => {
    const noopVerifier = {
      enabled: false,
      decodePayload: () => ({ role: "admin" }),
      verify: async () => true,
    } as unknown as JwtVerifier;
    const a = createOperatorAuthorizer({
      authRequired: true,
      jwtVerifier: noopVerifier,
    });
    // rbac not enabled (no tokens, verifier disabled) → falls back to format-only admin.
    expect(a.rbacEnabled).toBe(false);
  });
});

describe("OIDC / SSO group→role mapping", () => {
  // IdP that emits group memberships as a string[] (Okta/Entra style) plus a
  // Keycloak-style nested realm_access.roles claim.
  const oidcVerifier = (claims: Record<string, unknown>) =>
    ({
      enabled: true,
      decodePayload: () => claims,
      verify: async () => true,
    }) as unknown as JwtVerifier;

  it("maps an IdP group (string[] claim) to an operator role", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      groupsClaim: "groups",
      roleMap: { "aiperator-admins": "admin", support: "viewer" },
      jwtVerifier: oidcVerifier({
        groups: ["support", "aiperator-admins"],
        email: "carol@corp.example",
      }),
    });
    expect(a.rbacEnabled).toBe(true);
    const r = await a.authorize(bearer(JWT), undefined, "flows:write");
    expect(r.ok).toBe(true);
    // Highest-privilege match wins (admin over viewer).
    expect(r.actor?.role).toBe("admin");
    expect(r.actor?.name).toBe("carol@corp.example");
    expect(r.actor?.via).toBe("jwt");
  });

  it("reads a nested (dot-path) claim like Keycloak realm_access.roles", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      groupsClaim: "realm_access.roles",
      roleMap: { "platform-ops": "operator" },
      jwtVerifier: oidcVerifier({
        realm_access: { roles: ["offline_access", "platform-ops"] },
        sub: "user-123",
      }),
    });
    const r = await a.authorize(bearer(JWT), undefined, "approvals:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("operator");
    expect(r.actor?.name).toBe("user-123");
    // operator cannot write flows.
    expect((await a.authorize(bearer(JWT), undefined, "flows:write")).ok).toBe(
      false,
    );
  });

  it("denies when no group maps to a role", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      groupsClaim: "groups",
      roleMap: { "aiperator-admins": "admin" },
      jwtVerifier: oidcVerifier({ groups: ["unrelated-group"] }),
    });
    const r = await a.authorize(bearer(JWT), undefined, "monitoring:read");
    expect(r.ok).toBe(false);
  });

  it("still honours a literal role value in the groups claim without a map entry", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      groupsClaim: "groups",
      jwtVerifier: oidcVerifier({ groups: ["viewer"] }),
    });
    const r = await a.authorize(bearer(JWT), undefined, "monitoring:read");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("viewer");
  });

  it("never trusts an unverified-signature OIDC group claim", async () => {
    const forge = {
      enabled: true,
      decodePayload: () => ({ groups: ["aiperator-admins"] }),
      verify: async () => false,
    } as unknown as JwtVerifier;
    const a = createOperatorAuthorizer({
      authRequired: true,
      groupsClaim: "groups",
      roleMap: { "aiperator-admins": "admin" },
      jwtVerifier: forge,
    });
    const r = await a.authorize(
      bearer("forged.jwt.tok"),
      undefined,
      "flows:write",
    );
    expect(r.ok).toBe(false);
    expect(r.actor).toBeUndefined();
  });
});

describe("OPERATOR_DEFAULT_ROLE — any verified identity gets a role", () => {
  const oidcVerifier = (claims: Record<string, unknown>, ok = true) =>
    ({
      enabled: true,
      decodePayload: () => claims,
      verify: async () => ok,
    }) as unknown as JwtVerifier;

  it("grants the default role to a verified token with no mappable role", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      defaultRole: "admin",
      jwtVerifier: oidcVerifier({ email: "dave@corp.example" }),
    });
    expect(a.rbacEnabled).toBe(true);
    const r = await a.authorize(bearer(JWT), undefined, "flows:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("admin");
    expect(r.actor?.name).toBe("dave@corp.example");
    expect(r.actor?.via).toBe("jwt");
  });

  it("still prefers a mapped role over the default", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      defaultRole: "viewer",
      groupsClaim: "groups",
      roleMap: { "aiperator-admins": "admin" },
      jwtVerifier: oidcVerifier({ groups: ["aiperator-admins"] }),
    });
    const r = await a.authorize(bearer(JWT), undefined, "flows:write");
    expect(r.ok).toBe(true);
    expect(r.actor?.role).toBe("admin");
  });

  it("does NOT apply the default to a token that fails verification", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      defaultRole: "admin",
      jwtVerifier: oidcVerifier({ email: "eve@corp.example" }, false),
    });
    const r = await a.authorize(
      bearer("forged.jwt.tok"),
      undefined,
      "flows:write",
    );
    expect(r.ok).toBe(false);
    expect(r.actor).toBeUndefined();
  });

  it("respects the privilege level of the default role", async () => {
    const a = createOperatorAuthorizer({
      authRequired: true,
      defaultRole: "viewer",
      jwtVerifier: oidcVerifier({ sub: "frank" }),
    });
    expect(
      (await a.authorize(bearer(JWT), undefined, "monitoring:read")).ok,
    ).toBe(true);
    expect((await a.authorize(bearer(JWT), undefined, "flows:write")).ok).toBe(
      false,
    );
  });
});

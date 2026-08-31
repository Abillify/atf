// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Identity trust boundary — claim precedence over client-asserted attributes.
 *
 * Guards the fix for the escalation path where `X-OpenWebUI-User-Role` and
 * `metadata.clientId` outranked a cryptographically verified JWT claim. Those
 * three fields (`role`, `clientId`, `plan`) feed authorization decisions
 * (flows/access.yaml allowRoles/allowTenants/allowPlans, tool-authz match.role)
 * plus BYOK key resolution and cost attribution, so a client-chosen value there
 * is a privilege/tenant boundary crossing — not a routing hint.
 *
 * Two invariants are asserted:
 *   1. A verified claim ALWAYS wins, regardless of TRUSTED_IDENTITY_HEADERS.
 *   2. Without a claim, a client-asserted value is used ONLY when the flag is on.
 */

import { describe, test, expect } from "bun:test";
import {
  buildRequestContext,
  logIdentityTrustWarning,
  resolveTrustedIdentityField,
  type IdentityTrustWarning,
} from "../chat/handler.js";

// ---------------------------------------------------------------------------
// resolveTrustedIdentityField — the precedence rule in isolation
// ---------------------------------------------------------------------------

describe("resolveTrustedIdentityField", () => {
  const base = {
    field: "role" as const,
    clientSource: "OWUI header X-OpenWebUI-User-Role",
  };

  test("verified claim wins over a conflicting client value, even when trusted", () => {
    for (const trustClientIdentity of [false, true]) {
      const result = resolveTrustedIdentityField({
        ...base,
        claimCandidates: [{ value: "user", source: 'JWT claim "role"' }],
        clientValue: "admin",
        trustClientIdentity,
      });
      expect(result.value).toBe("user");
      expect(result.warning?.action).toBe("overridden");
      expect(result.warning?.clientValue).toBe("admin");
      expect(result.warning?.claimValue).toBe("user");
    }
  });

  test("an identical client value produces no warning (normal proxy case)", () => {
    const result = resolveTrustedIdentityField({
      ...base,
      claimCandidates: [{ value: "admin", source: 'JWT claim "role"' }],
      clientValue: "admin",
      trustClientIdentity: true,
    });
    expect(result.value).toBe("admin");
    expect(result.warning).toBeUndefined();
  });

  test("without a claim the client value is REJECTED when untrusted", () => {
    const result = resolveTrustedIdentityField({
      ...base,
      claimCandidates: [],
      clientValue: "admin",
      trustClientIdentity: false,
    });
    // The field stays unset rather than becoming client-controlled.
    expect(result.value).toBeUndefined();
    expect(result.warning?.action).toBe("rejected");
    expect(result.warning?.clientValue).toBe("admin");
    expect(result.warning?.claimValue).toBeUndefined();
  });

  test("without a claim the client value is accepted when trusted", () => {
    const result = resolveTrustedIdentityField({
      ...base,
      claimCandidates: [],
      clientValue: "admin",
      trustClientIdentity: true,
    });
    expect(result.value).toBe("admin");
    expect(result.warning).toBeUndefined();
  });

  test("claim candidates are tried in order and empty strings are skipped", () => {
    const result = resolveTrustedIdentityField({
      ...base,
      claimCandidates: [
        { value: "", source: 'JWT claim "role"' },
        { value: undefined, source: "absent" },
        { value: "operator", source: 'JWT claim "roles[0]"' },
      ],
      clientValue: "admin",
      trustClientIdentity: true,
    });
    expect(result.value).toBe("operator");
  });

  test("neither source present yields no value and no warning", () => {
    const result = resolveTrustedIdentityField({
      ...base,
      claimCandidates: [{ value: undefined, source: "absent" }],
      clientValue: undefined,
      trustClientIdentity: false,
    });
    expect(result.value).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  test("non-string client values are ignored (no type confusion)", () => {
    for (const clientValue of [42, true, {}, [], null]) {
      const result = resolveTrustedIdentityField({
        ...base,
        claimCandidates: [],
        clientValue,
        trustClientIdentity: true,
      });
      expect(result.value).toBeUndefined();
      expect(result.warning).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// buildRequestContext — the three gated fields end-to-end
// ---------------------------------------------------------------------------

describe("buildRequestContext identity trust", () => {
  const build = (
    opts: Partial<Parameters<typeof buildRequestContext>[0]> & {
      warnings?: IdentityTrustWarning[];
    } = {},
  ) => {
    const warnings: IdentityTrustWarning[] = opts.warnings ?? [];
    const ctx = buildRequestContext({
      ssoToken: "tok",
      claims: opts.claims ?? null,
      metadata: opts.metadata ?? {},
      ...(opts.owui !== undefined ? { owui: opts.owui } : {}),
      ...(opts.trustClientIdentity !== undefined
        ? { trustClientIdentity: opts.trustClientIdentity }
        : {}),
      ...(opts.strictIdentityHeaders !== undefined
        ? { strictIdentityHeaders: opts.strictIdentityHeaders }
        : {}),
      ...(opts.identityClaimsVerified !== undefined
        ? { identityClaimsVerified: opts.identityClaimsVerified }
        : {}),
      onIdentityWarning: (w) => warnings.push(w),
    });
    return { ctx, warnings };
  };

  test("the header escalation is closed: role stays unset by default", () => {
    const { ctx, warnings } = build({
      claims: { sub: "alice" },
      owui: { role: "admin" },
    });
    expect(ctx.role).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.field).toBe("role");
    expect(warnings[0]?.action).toBe("rejected");
  });

  test("a verified role claim beats the header", () => {
    const { ctx, warnings } = build({
      claims: { role: "viewer" },
      owui: { role: "admin" },
      trustClientIdentity: true,
    });
    expect(ctx.role).toBe("viewer");
    expect(warnings[0]?.action).toBe("overridden");
  });

  test("the cross-tenant escalation is closed: metadata.clientId is ignored", () => {
    const { ctx, warnings } = build({
      claims: { sub: "alice" },
      metadata: { clientId: "other-tenant" },
    });
    expect(ctx.clientId).toBeUndefined();
    expect(warnings.some((w) => w.field === "clientId")).toBe(true);
  });

  test("a verified tenant claim beats metadata.clientId", () => {
    const { ctx } = build({
      claims: { client_id: "acme" },
      metadata: { clientId: "other-tenant" },
      trustClientIdentity: true,
    });
    expect(ctx.clientId).toBe("acme");
  });

  test("the `tid` claim is honoured as a tenant fallback", () => {
    const { ctx } = build({ claims: { tid: "acme" } });
    expect(ctx.clientId).toBe("acme");
  });

  test("metadata.plan cannot satisfy allowPlans by default", () => {
    const { ctx, warnings } = build({ metadata: { plan: "enterprise" } });
    expect(ctx.plan).toBeUndefined();
    expect(warnings.some((w) => w.field === "plan")).toBe(true);
  });

  test("all three conflicts are reported, not just the first", () => {
    const { warnings } = build({
      claims: { sub: "alice" },
      owui: { role: "admin" },
      metadata: { clientId: "other", plan: "enterprise" },
    });
    expect(warnings.map((w) => w.field).sort()).toEqual([
      "clientId",
      "plan",
      "role",
    ]);
  });

  test("trusted mode restores the Open WebUI deployment", () => {
    const { ctx, warnings } = build({
      claims: { sub: "alice" },
      owui: { role: "admin" },
      metadata: { clientId: "acme", plan: "pro" },
      trustClientIdentity: true,
    });
    expect(ctx.role).toBe("admin");
    expect(ctx.clientId).toBe("acme");
    expect(ctx.plan).toBe("pro");
    expect(warnings).toHaveLength(0);
  });

  test("a throwing warning sink never breaks the request", () => {
    expect(() =>
      buildRequestContext({
        ssoToken: "tok",
        claims: null,
        metadata: { clientId: "other" },
        onIdentityWarning: () => {
          throw new Error("sink exploded");
        },
      }),
    ).not.toThrow();
  });

  test("ungated fields keep their existing precedence", () => {
    // email/userId/userName already preferred claims — assert no regression.
    const { ctx } = build({
      claims: { email: "a@example.com", sub: "alice", name: "Alice" },
      owui: { email: "b@example.com", id: "bob", name: "Bob" },
      metadata: {},
    });
    expect(ctx.userEmail).toBe("a@example.com");
    expect(ctx.userId).toBe("alice");
    expect(ctx.userName).toBe("Alice");
  });

  test("legacy mode preserves OWUI and metadata profile fallbacks exactly", () => {
    const { ctx, warnings } = build({
      claims: {},
      metadata: { email: "metadata@example.com" },
      owui: { id: "owui-id", name: "OWUI%20User", email: "owui@example.com" },
      strictIdentityHeaders: false,
    });
    expect(ctx.userEmail).toBe("owui@example.com");
    expect(ctx.userId).toBe("owui-id");
    expect(ctx.userName).toBe("OWUI User");
    expect(warnings).toHaveLength(0);
  });

  test("legacy email metadata fallback still feeds userName", () => {
    const { ctx } = build({
      claims: {},
      metadata: { email: "metadata@example.com" },
    });
    expect(ctx.userEmail).toBe("metadata@example.com");
    expect(ctx.userName).toBe("metadata@example.com");
  });

  test("strict mode keeps verified profile claims and overrides client assertions", () => {
    const { ctx, warnings } = build({
      claims: { email: "jwt@example.com", sub: "jwt-id", name: "JWT User" },
      identityClaimsVerified: true,
      strictIdentityHeaders: true,
      metadata: { email: "metadata@example.com" },
      owui: { email: "owui@example.com", id: "owui-id", name: "OWUI User" },
    });
    expect(ctx.userEmail).toBe("jwt@example.com");
    expect(ctx.userId).toBe("jwt-id");
    expect(ctx.userName).toBe("JWT User");
    expect(warnings.map((warning) => warning.field).sort()).toEqual([
      "email",
      "email",
      "userId",
      "userName",
    ]);
    expect(warnings.every((warning) => warning.action === "overridden")).toBe(true);
  });

  test("strict mode falls back from verified name claims to verified email then userId", () => {
    const email = build({
      claims: { email: "jwt@example.com", sub: "jwt-id" },
      identityClaimsVerified: true,
      strictIdentityHeaders: true,
      metadata: { email: "metadata@example.com" },
      owui: { id: "owui-id", name: "OWUI User", email: "owui@example.com" },
    });
    expect(email.ctx.userName).toBe("jwt@example.com");

    const id = build({
      claims: { sub: "jwt-id" },
      identityClaimsVerified: true,
      strictIdentityHeaders: true,
      metadata: { email: "metadata@example.com" },
      owui: { id: "owui-id", name: "OWUI User", email: "owui@example.com" },
    });
    expect(id.ctx.userName).toBe("jwt-id");
  });

  test("strict mode rejects OWUI/metadata fallbacks and unverified claims", () => {
    const { ctx, warnings } = build({
      claims: { email: "unverified@example.com", sub: "unverified-id", name: "Unverified" },
      identityClaimsVerified: false,
      strictIdentityHeaders: true,
      metadata: { email: "metadata@example.com" },
      owui: { email: "owui@example.com", id: "owui-id", name: "OWUI User" },
    });
    expect(ctx.userEmail).toBeUndefined();
    expect(ctx.userId).toBeUndefined();
    expect(ctx.userName).toBeUndefined();
    expect(warnings.every((warning) => warning.action === "rejected")).toBe(true);
  });

  test("strict profile warnings are structured without asserted values", () => {
    const lines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      logIdentityTrustWarning({
        field: "email",
        source: "metadata.email",
        clientValue: "private@example.com",
        claimValue: "verified@example.com",
        action: "overridden",
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    const entry = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "warn",
      event: "identity_trust_conflict",
      field: "email",
      source: "metadata.email",
      action: "overridden",
    });
    expect(entry.client_value).toBeUndefined();
    expect(entry.claim_value).toBeUndefined();
    expect(lines.join("")).not.toContain("private@example.com");
    expect(lines.join("")).not.toContain("verified@example.com");
  });

  test("strict profile mode does not change TRUSTED_IDENTITY_HEADERS fields", () => {
    const { ctx } = build({
      claims: {},
      strictIdentityHeaders: true,
      trustClientIdentity: true,
      owui: { role: "admin" },
      metadata: { clientId: "acme", plan: "pro" },
    });
    expect(ctx.role).toBe("admin");
    expect(ctx.clientId).toBe("acme");
    expect(ctx.plan).toBe("pro");
  });

  test("groups come only from claims and are unaffected", () => {
    const { ctx } = build({ claims: { groups: ["Dev", "OPS"] } });
    expect(ctx.groups).toEqual(["Dev", "OPS"]);
  });
});

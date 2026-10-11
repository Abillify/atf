// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { AuthContext } from "../../src/auth/context.ts";
import {
  APPROVAL_TOKEN_META_KEY,
  GovernancePolicy,
  approvalArgsFingerprint,
  approvalArgsFingerprintLegacy,
  compilePolicy,
  mintApprovalToken,
} from "../../src/mcp/governance.ts";
import { MemoryTaskStore } from "../../src/mcp/tasks.ts";

const ctx: AuthContext = {
  method: "static",
  subject: "alice",
  username: "alice",
  scopes: ["orders:write"],
  claims: { groups: ["ops"] },
  headers: {},
  rawToken: "x",
};

describe("governance policies", () => {
  it("uses first matching ordered rule and matches arguments/groups/scopes", () => {
    const policy = new GovernancePolicy({
      defaultEffect: "allow",
      approval: { ttlMs: 1000, secret: "0123456789abcdef" },
      rules: [
        {
          effect: "deny",
          match: {
            tool: "orders_*",
            access: "write",
            groups: ["ops"],
            requiredScopes: ["orders:write"],
            argumentEquals: { "order.owner": "other" },
          },
        },
        { effect: "approval", match: { tool: "orders_*" } },
      ],
    });
    expect(policy.decide(ctx, "orders_update", "write", { order: { owner: "other" } })).toBe(
      "deny",
    );
    expect(policy.decide(ctx, "orders_update", "write", { order: { owner: "alice" } })).toBe(
      "approval",
    );
  });
  it("mints externally approved, single-use tokens bound to subject, tool and arguments", async () => {
    const policy = new GovernancePolicy({
      defaultEffect: "approval",
      rules: [],
      approval: { ttlMs: 1000, secret: "0123456789abcdef" },
    });
    const request = policy.approvalRequest(ctx, "write", { id: 1 });
    const token = mintApprovalToken({
      ...request,
      approver: "security@example.test",
      secret: "0123456789abcdef",
      ttlMs: 1000,
    });
    expect(APPROVAL_TOKEN_META_KEY).toContain("approvalToken");
    expect(await policy.verifyApproval(token, ctx, "write", { id: 1 })).toBe(
      true,
    );
    expect(await policy.verifyApproval(token, ctx, "write", { id: 1 })).toBe(
      false,
    );
    expect(await policy.verifyApproval(token, ctx, "write", { id: 2 })).toBe(
      false,
    );
  });
});

describe("memory task store", () => {
  it("executes and exposes a completed result", async () => {
    const store = new MemoryTaskStore(1000, 2);
    const task = store.start(ctx.subject, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    await Bun.sleep(0);
    expect(store.get(task.id, ctx.subject)).toMatchObject({
      state: "completed",
      result: { content: [{ text: "ok" }] },
    });
  });
});

describe("memory task security and retention", () => {
  it("denies cross-principal reads and rejects full active capacity", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MemoryTaskStore(100, 1);
    const task = store.start("alice", async () => {
      await pending;
      return { content: [] };
    });
    expect(store.get(task.id, "bob")).toBeUndefined();
    expect(() => store.start("alice", async () => ({ content: [] }))).toThrow("capacity");
    release();
    await Bun.sleep(0);
  });

  it("starts terminal TTL at completion and never expires working tasks", async () => {
    let now = 1_000;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MemoryTaskStore(10, 2, () => now);
    const task = store.start("alice", async () => {
      await pending;
      return { content: [] };
    });
    now += 100;
    expect(store.get(task.id, "alice")?.state).toBe("working");
    release();
    await Bun.sleep(0);
    expect(store.get(task.id, "alice")?.state).toBe("completed");
    now += 10;
    expect(store.get(task.id, "alice")).toBeUndefined();
  });
});


describe("Evidence-Bound Approval", () => {
  it("rejects an approval token when the action contract digest changes", async () => {
    const policy = new GovernancePolicy({
      defaultEffect: "approval",
      rules: [],
      approval: { ttlMs: 1000, secret: "0123456789abcdef" },
    });
    const evidenceContractHash = "a".repeat(64);
    const token = mintApprovalToken({
      ...policy.approvalRequest(ctx, "write", { id: 1 }),
      evidenceContractHash,
      approver: "security@example.test",
      secret: "0123456789abcdef",
      ttlMs: 1000,
    });

    expect(
      await policy.verifyApproval(
        token,
        ctx,
        "write",
        { id: 1 },
        "b".repeat(64),
      ),
    ).toBe(false);
    expect(
      await policy.verifyApproval(
        token,
        ctx,
        "write",
        { id: 1 },
        evidenceContractHash,
      ),
    ).toBe(true);
  });
});

describe("compiled policy (Req 6.2/6.3)", () => {
  const baseConfig = {
    defaultEffect: "allow" as const,
    approval: { ttlMs: 1000, secret: "0123456789abcdef", maxPending: 10 },
    rules: [
      {
        effect: "deny" as const,
        match: { tool: "orders_*", access: "write" as const, groups: ["ops"] },
      },
    ],
  };

  it("precompiles globs, subjects and groups once at compile time", () => {
    const compiled = compilePolicy(baseConfig);
    expect(compiled.groupClaim).toBe("groups");
    expect(compiled.rules).toHaveLength(1);
    const [rule] = compiled.rules;
    expect(rule?.toolPattern).toBeInstanceOf(RegExp);
    expect(rule?.toolPattern?.test("orders_update")).toBe(true);
    expect(rule?.toolPattern?.test("users_update")).toBe(false);
    expect(rule?.groups?.has("ops")).toBe(true);
  });

  it("reads groups from the configured oauth.groupClaim (Req 6.2)", () => {
    const cognitoCtx: AuthContext = {
      ...ctx,
      claims: { "cognito:groups": ["ops"] },
    };
    const policy = new GovernancePolicy(
      compilePolicy(baseConfig, { groupClaim: "cognito:groups" }),
    );
    expect(policy.decide(cognitoCtx, "orders_update", "write", {})).toBe(
      "deny",
    );
    // The default claim no longer matches when a custom claim is configured.
    expect(policy.decide(ctx, "orders_update", "write", {})).toBe("allow");
  });

  it("resolves effect, rule and evidence requirement in one evaluate() pass", () => {
    const policy = new GovernancePolicy({
      defaultEffect: "allow",
      approval: { ttlMs: 1000, secret: "0123456789abcdef" },
      rules: [
        {
          effect: "approval",
          match: { tool: "secret_*" },
          requireEvidenceContract: true,
        },
      ],
    });
    const decision = policy.evaluate(ctx, "secret_delete", "write", {});
    expect(decision.effect).toBe("approval");
    expect(decision.requiresEvidenceContract).toBe(true);
    expect(decision.rule?.match.tool).toBe("secret_*");
    const fallback = policy.evaluate(ctx, "other_tool", "write", {});
    expect(fallback.effect).toBe("allow");
    expect(fallback.rule).toBeUndefined();
    expect(fallback.requiresEvidenceContract).toBe(false);
  });

  it("matches a string group claim (space/comma separated)", () => {
    const policy = new GovernancePolicy(baseConfig);
    const stringCtx: AuthContext = { ...ctx, claims: { groups: "admin, ops" } };
    expect(policy.decide(stringCtx, "orders_update", "write", {})).toBe("deny");
  });
});

describe("fingerprint canonicalisation (Req 6.4)", () => {
  it("sorts keys by code unit, not locale order", () => {
    // localeCompare orders "a" < "B"; code-unit order is "B" (0x42) < "a" (0x61).
    const one = approvalArgsFingerprint({ B: 1, a: 2 });
    const two = approvalArgsFingerprint({ a: 2, B: 1 });
    expect(one).toBe(two);
    const canonical = approvalArgsFingerprint({ B: 1, a: 2 });
    expect(canonical).not.toBe(approvalArgsFingerprintLegacy({ B: 1, a: 2 }));
  });

  it("accepts legacy tokens (no fp marker, localeCompare digest) until expiry", async () => {
    const secret = "0123456789abcdef";
    const policy = new GovernancePolicy({
      defaultEffect: "approval",
      rules: [],
      approval: { ttlMs: 60_000, secret },
    });
    const args = { B: 1, a: 2 };
    const now = Date.now();
    const payload = Buffer.from(
      JSON.stringify({
        jti: "legacy-jti",
        approver: "security@example.test",
        sub: (policy.approvalRequest(ctx, "write", args) as { subject: string })
          .subject,
        tool: "write",
        args: approvalArgsFingerprintLegacy(args),
        requestState: "legacy-state",
        iat: now,
        exp: now + 60_000,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    const legacyToken = `${payload}.${signature}`;
    expect(
      await policy.verifyApproval(
        legacyToken,
        ctx,
        "write",
        args,
        undefined,
        false,
      ),
    ).toBe(true);
    // A new-style token carries the fp marker and uses the code-unit digest.
    const request = policy.approvalRequest(ctx, "write", args);
    const newToken = mintApprovalToken({
      ...request,
      approver: "security@example.test",
      secret,
      ttlMs: 60_000,
    });
    const [payloadPart] = newToken.split(".");
    const decoded = JSON.parse(
      Buffer.from(payloadPart ?? "", "base64url").toString(),
    ) as { fp?: number };
    expect(decoded.fp).toBe(2);
    expect(
      await policy.verifyApproval(
        newToken,
        ctx,
        "write",
        args,
        undefined,
        false,
      ),
    ).toBe(true);
  });
});
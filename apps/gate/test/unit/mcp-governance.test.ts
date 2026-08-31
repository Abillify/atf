// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import type { AuthContext } from "../../src/auth/context.ts";
import {
  APPROVAL_TOKEN_META_KEY,
  GovernancePolicy,
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
  it("mints externally approved, single-use tokens bound to subject, tool and arguments", () => {
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
    expect(policy.verifyApproval(token, ctx, "write", { id: 1 })).toBe(true);
    expect(policy.verifyApproval(token, ctx, "write", { id: 1 })).toBe(false);
    expect(policy.verifyApproval(token, ctx, "write", { id: 2 })).toBe(false);
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
  it("rejects an approval token when the action contract digest changes", () => {
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

    expect(policy.verifyApproval(token, ctx, "write", { id: 1 }, "b".repeat(64))).toBe(false);
    expect(policy.verifyApproval(token, ctx, "write", { id: 1 }, evidenceContractHash)).toBe(true);
  });
});
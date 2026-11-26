// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the caller-scoped approvals API (`/v1/approvals/mine`).
 *
 * The routes rely on TOKEN_KEY (set by auth middleware upstream). Tests mount
 * the router behind a tiny stub middleware that copies an `x-test-token`
 * header into TOKEN_KEY, mirroring how the real middleware stores the bearer.
 */
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { Hono } from "hono";
import { createApprovalsMineRouter } from "../approvals-mine.js";
import { createApprovalGate } from "../../graph/approval-gate.js";
import { TOKEN_KEY, type AuthContext } from "../../middleware/auth.js";
import type { ApprovalRequest } from "../../graph/approval-gate.js";

function mount(tokenHeader = "x-test-token") {
  const gate = createApprovalGate({ enabled: true, timeoutMs: 60_000 });
  if (gate === undefined) throw new Error("gate disabled");
  const app = new Hono<AuthContext>();
  app.use("*", async (ctx, next) => {
    const t = ctx.req.header(tokenHeader);
    if (t !== undefined) ctx.set(TOKEN_KEY, t);
    await next();
  });
  app.route("/", createApprovalsMineRouter({ approvalGate: gate }));
  return { app, gate };
}

function ownerKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function req(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    executionId: "exec-1",
    nodeId: "n1",
    tool: "abiliware/update_record",
    args: { id: 1 },
    ...over,
  };
}

describe("/v1/approvals/mine", () => {
  test("requires a caller token", async () => {
    const { app } = mount();
    const res = await app.request("/v1/approvals/mine");
    expect(res.status).toBe(401);
  });

  test("lists only the caller's own pending approvals", async () => {
    const { app, gate } = mount();
    void gate.request(req({ tool: "a/x", ownerKey: ownerKey("token-a") }));
    void gate.request(req({ tool: "b/y", ownerKey: ownerKey("token-a") }));
    void gate.request(req({ tool: "c/z", ownerKey: ownerKey("token-b") }));

    const res = await app.request("/v1/approvals/mine", {
      headers: { "x-test-token": "token-a" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pending: Array<{ tool: string }>;
      timeoutMs: number;
    };
    expect(body.pending.length).toBe(2);
    expect(body.pending.map((p) => p.tool).sort()).toEqual(["a/x", "b/y"]);
    expect(body.timeoutMs).toBe(60_000);
  });

  test("decide approves the caller's own approval and unblocks the gate", async () => {
    const { app, gate } = mount();
    const decided = gate.request(
      req({ tool: "abiliware/update_record", ownerKey: ownerKey("token-a") }),
    );
    const list = (await (
      await app.request("/v1/approvals/mine", {
        headers: { "x-test-token": "token-a" },
      })
    ).json()) as { pending: Array<{ id: string }> };
    const id = list.pending[0]?.id;
    if (id === undefined) throw new Error("no pending approval");

    const res = await app.request(`/v1/approvals/mine/${id}/decide`, {
      method: "POST",
      headers: { "x-test-token": "token-a", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(200);
    const decision = await decided;
    expect(decision.approved).toBe(true);
  });

  test("decide denies (fail-closed) on decision=denied", async () => {
    const { app, gate } = mount();
    const decided = gate.request(req({ ownerKey: ownerKey("token-a") }));
    const list = (await (
      await app.request("/v1/approvals/mine", {
        headers: { "x-test-token": "token-a" },
      })
    ).json()) as { pending: Array<{ id: string }> };
    const id = list.pending[0]?.id;
    if (id === undefined) throw new Error("no pending approval");

    const res = await app.request(`/v1/approvals/mine/${id}/decide`, {
      method: "POST",
      headers: { "x-test-token": "token-a", "content-type": "application/json" },
      body: JSON.stringify({ decision: "denied" }),
    });
    expect(res.status).toBe(200);
    expect((await decided).approved).toBe(false);
  });

  test("a different caller cannot decide someone else's approval (404)", async () => {
    const { app, gate } = mount();
    void gate.request(req({ ownerKey: ownerKey("token-a") }));
    const list = (await (
      await app.request("/v1/approvals/mine", {
        headers: { "x-test-token": "token-a" },
      })
    ).json()) as { pending: Array<{ id: string }> };
    const id = list.pending[0]?.id;
    if (id === undefined) throw new Error("no pending approval");

    const res = await app.request(`/v1/approvals/mine/${id}/decide`, {
      method: "POST",
      headers: { "x-test-token": "token-B", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(404);
  });

  test("rejects an invalid decision value", async () => {
    const { app, gate } = mount();
    void gate.request(req({ ownerKey: ownerKey("token-a") }));
    const list = (await (
      await app.request("/v1/approvals/mine", {
        headers: { "x-test-token": "token-a" },
      })
    ).json()) as { pending: Array<{ id: string }> };
    const id = list.pending[0]?.id;
    if (id === undefined) throw new Error("no pending approval");

    const res = await app.request(`/v1/approvals/mine/${id}/decide`, {
      method: "POST",
      headers: { "x-test-token": "token-a", "content-type": "application/json" },
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(res.status).toBe(400);
  });

  test("approvals without an ownerKey are invisible on this plane", async () => {
    const { app, gate } = mount();
    // An approval opened without a bearer (no ownerKey) — e.g. a background
    // job — must not surface for any caller.
    void gate.request({ ...req(), ownerKey: undefined });
    const res = await app.request("/v1/approvals/mine", {
      headers: { "x-test-token": "token-a" },
    });
    const body = (await res.json()) as { pending: unknown[] };
    expect(body.pending.length).toBe(0);
  });
});

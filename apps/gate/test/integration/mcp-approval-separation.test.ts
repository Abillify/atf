// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `approvals/resolve`.
 *
 *  - WHO resolved an approval is the verified identity. A client-supplied
 *    `approver` string is only a display label next to it; it can no longer
 *    stand in for the identity in the audit event or in the approval token.
 *  - `policies.approval.requireDifferentApprover` (off by default) is the
 *    separation of duties: the requester can not resolve its own request, and
 *    a different principal of the same tenant needs `approverScope`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import type { AuthContext } from "../../src/auth/context.ts";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import {
  GovernancePolicy,
  approvalArgsFingerprint,
  approvalOwner,
  mintApprovalToken,
} from "../../src/mcp/governance.ts";
import { FakeDb } from "../helpers/fake-db.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const REQUESTER = "sep-requester";
const APPROVER = "sep-approver";
const NO_SCOPE = "sep-approver-without-scope";
const OTHER_TENANT = "sep-approver-other-tenant";

const TOOL = {
  name: "approved_orders",
  type: "database",
  database: "main",
  query: "SELECT id FROM orders WHERE owner = :ctx.username",
  access: "write",
  inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: [] },
};

function config(requireDifferentApprover: boolean) {
  return AppConfigSchema.parse({
    server: { port: 3000 },
    tenantIsolation: { enabled: true, defaultTenantId: "default", claimNames: ["tenant"] },
    auth: {
      mode: "static",
      static: {
        tokens: [
          {
            token: REQUESTER,
            subject: "requester",
            username: "requester",
            scopes: ["tools:read", "tools:write"],
            claims: { tenant: "acme" },
          },
          {
            token: APPROVER,
            subject: "approver",
            username: "approver",
            scopes: ["tools:read", "approvals:resolve"],
            claims: { tenant: "acme" },
          },
          { token: NO_SCOPE, subject: "other", username: "other", scopes: ["tools:read"], claims: { tenant: "acme" } },
          {
            token: OTHER_TENANT,
            subject: "approver",
            username: "approver",
            scopes: ["tools:read", "approvals:resolve"],
            claims: { tenant: "other" },
          },
        ],
      },
    },
    monitoring: { enabled: true, token: "m" },
    tools: [TOOL],
    policies: {
      defaultEffect: "allow",
      approval: { secret: "separation-approval-secret", ttlMs: 300_000, maxPending: 10, requireDifferentApprover },
      rules: [{ effect: "approval", match: { tool: "approved_orders" } }],
    },
  });
}

describe.each([
  { requireDifferentApprover: false },
  { requireDifferentApprover: true },
])("approvals/resolve · requireDifferentApprover=$requireDifferentApprover", ({ requireDifferentApprover }) => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  const rpc = (token: string, method: string, params: Record<string, unknown> = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(method === "tools/call" && typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
        ...(method === "io.modelcontextprotocol/approvals/resolve" && typeof params.requestState === "string"
          ? { "Mcp-Request-State": params.requestState }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    });

  /** The requester asks for the approval and gets the request state back. */
  async function requestApproval(): Promise<string> {
    const response = await rpc(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } });
    const body = (await response.json()) as { result: { inputRequests: Array<{ requestState: string }> } };
    return String(body.result.inputRequests[0]?.requestState);
  }

  beforeAll(async () => {
    handle = await buildApp(config(requireDifferentApprover), { db: new FakeDb({ main: [{ id: 7 }] }) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("records the verified identity as the approver; a declared approver is only a label", async () => {
    const requestState = await requestApproval();
    const resolver = requireDifferentApprover ? APPROVER : REQUESTER;
    const before = handle.bus.recent().length;
    const resolved = await rpc(resolver, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "approved",
      approver: "ceo@example.test",
    });
    expect(resolved.status).toBe(200);
    const event = handle.bus.recent().slice(before).find((e) => e.type === "approval_resolved");
    const verified = requireDifferentApprover ? "approver" : "requester";
    expect(event?.meta).toMatchObject({
      approver: verified,
      declaredApprover: "ceo@example.test",
      selfResolved: !requireDifferentApprover,
    });
  });

  it("a declared approver that matches the identity adds no label", async () => {
    const requestState = await requestApproval();
    const resolver = requireDifferentApprover ? APPROVER : REQUESTER;
    const verified = requireDifferentApprover ? "approver" : "requester";
    const before = handle.bus.recent().length;
    await rpc(resolver, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "denied",
      approver: verified,
    });
    const event = handle.bus.recent().slice(before).find((e) => e.type === "approval_resolved");
    expect(event?.meta).not.toHaveProperty("declaredApprover");
  });
});

describe("approvals/resolve · separation of duties (requireDifferentApprover=true)", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  const rpc = (token: string, method: string, params: Record<string, unknown> = {}) =>
    fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(method === "tools/call" && typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
        ...(method === "io.modelcontextprotocol/approvals/resolve" && typeof params.requestState === "string"
          ? { "Mcp-Request-State": params.requestState }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    });
  const resolve = (token: string, requestState: string) =>
    rpc(token, "io.modelcontextprotocol/approvals/resolve", { requestState, decision: "approved" });
  async function requestApproval(): Promise<string> {
    const response = await rpc(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } });
    const body = (await response.json()) as { result: { inputRequests: Array<{ requestState: string }> } };
    return String(body.result.inputRequests[0]?.requestState);
  }

  beforeAll(async () => {
    handle = await buildApp(config(true), { db: new FakeDb({ main: [{ id: 7 }] }) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("the requester can not resolve its own request, and the request survives the attempt", async () => {
    const requestState = await requestApproval();
    const own = await resolve(REQUESTER, requestState);
    expect(own.status).toBe(403);
    expect(JSON.stringify(await own.json())).toContain("different principal");
    // Not consumed: the right approver can still resolve it.
    expect((await resolve(APPROVER, requestState)).status).toBe(200);
  });

  it("a different principal without the approver scope is refused and does not consume the request", async () => {
    const requestState = await requestApproval();
    const refused = await resolve(NO_SCOPE, requestState);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(await refused.json())).toContain("approvals:resolve");
    expect((await resolve(APPROVER, requestState)).status).toBe(200);
  });

  it("an approver of another tenant does not even see the request", async () => {
    const requestState = await requestApproval();
    expect((await resolve(OTHER_TENANT, requestState)).status).toBe(404);
    expect((await resolve(APPROVER, requestState)).status).toBe(200);
  });

  it("the approval token the approver mints lets the REQUESTER run the tool exactly once", async () => {
    const requestState = await requestApproval();
    const resolved = await resolve(APPROVER, requestState);
    const { result } = (await resolved.json()) as { result: { approvalToken: string } };
    const run = () =>
      rpc(REQUESTER, "tools/call", {
        name: "approved_orders",
        arguments: { id: 7 },
        _meta: { "io.modelcontextprotocol/approvalToken": result.approvalToken },
      });
    const first = (await (await run()).json()) as { result: { isError?: boolean; resultType: string } };
    expect(first.result.isError).not.toBe(true);
    expect(first.result.resultType).toBe("complete");
    const replay = (await (await run()).json()) as { result: { resultType: string } };
    expect(replay.result.resultType).toBe("input_required");
  });

  it("the approver can not use the token for its own call: it is bound to the requester", async () => {
    const requestState = await requestApproval();
    const { result } = (await (await resolve(APPROVER, requestState)).json()) as { result: { approvalToken: string } };
    const asApprover = (await (
      await rpc(APPROVER, "tools/call", {
        name: "approved_orders",
        arguments: { id: 7 },
        _meta: { "io.modelcontextprotocol/approvalToken": result.approvalToken },
      })
    ).json()) as { result: { resultType: string } };
    expect(asApprover.result.resultType).toBe("input_required");
  });
});

describe("verifyApproval · approver separation at verify time", () => {
  const viewer: AuthContext = {
    method: "static",
    subject: "requester",
    username: "requester",
    scopes: ["tools:read", "tools:write"],
    claims: { tenant: "acme" },
    headers: {},
    rawToken: "x",
  };
  const SECRET = "separation-approval-secret";

  function policy(requireDifferentApprover: boolean): GovernancePolicy {
    return new GovernancePolicy({
      defaultEffect: "approval",
      rules: [],
      approval: {
        ttlMs: 300_000,
        maxPending: 10,
        secret: SECRET,
        requireDifferentApprover,
        approverScope: "approvals:resolve",
      },
    });
  }

  // A token minted before the flag was enabled can carry the owner hash as
  // approver (self-resolve); `sub` is the approvalOwner hash of the caller.
  function selfToken(): string {
    return mintApprovalToken({
      subject: approvalOwner(viewer),
      tool: "approved_orders",
      argsFingerprint: approvalArgsFingerprint({ id: 7 }),
      requestState: "state-self",
      approver: approvalOwner(viewer),
      secret: SECRET,
      ttlMs: 300_000,
    });
  }

  it("rejects a token whose approver equals the owner when the flag is on", async () => {
    const policyOn = policy(true);
    expect(
      await policyOn.verifyApproval(
        selfToken(),
        viewer,
        "approved_orders",
        { id: 7 },
        undefined,
        false,
      ),
    ).toBe(false);
  });

  it("accepts a token from a different approver when the flag is on", async () => {
    const token = mintApprovalToken({
      subject: approvalOwner(viewer),
      tool: "approved_orders",
      argsFingerprint: approvalArgsFingerprint({ id: 7 }),
      requestState: "state-other",
      approver: "approver",
      secret: SECRET,
      ttlMs: 300_000,
    });
    expect(
      await policy(true).verifyApproval(
        token,
        viewer,
        "approved_orders",
        { id: 7 },
        undefined,
        false,
      ),
    ).toBe(true);
  });

  it("still accepts a self token when the flag is off (unchanged default)", async () => {
    expect(
      await policy(false).verifyApproval(
        selfToken(),
        viewer,
        "approved_orders",
        { id: 7 },
        undefined,
        false,
      ),
    ).toBe(true);
  });
});

describe("verifyApproval · self-resolved token through the real resolve path", () => {
  async function start(requireDifferentApprover: boolean) {
    const handle = await buildApp(config(requireDifferentApprover), { db: new FakeDb({ main: [{ id: 7 }] }) });
    const { server, port } = await listen(handle.app);
    const rpc = (token: string, method: string, params: Record<string, unknown> = {}) =>
      fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(method === "tools/call" && typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
          ...(method === "io.modelcontextprotocol/approvals/resolve" && typeof params.requestState === "string"
            ? { "Mcp-Request-State": params.requestState }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params,
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        }),
      });
    return {
      rpc,
      stop: async () => {
        server.close();
        await handle.shutdown();
      },
    };
  }

  it("rejects a token the requester resolved itself before the flag was enabled", async () => {
    // Flag off: the requester asks for and resolves its own approval.
    const before = await start(false);
    let approvalToken: string;
    try {
      const requested = (await (
        await before.rpc(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } })
      ).json()) as { result: { inputRequests: Array<{ requestState: string }> } };
      const requestState = String(requested.result.inputRequests[0]?.requestState);
      const resolved = await before.rpc(REQUESTER, "io.modelcontextprotocol/approvals/resolve", {
        requestState,
        decision: "approved",
      });
      expect(resolved.status).toBe(200);
      ({ approvalToken } = ((await resolved.json()) as { result: { approvalToken: string } }).result);
    } finally {
      await before.stop();
    }

    // Flag on (same secret, same identities): the self-resolved token is refused.
    const after = await start(true);
    try {
      const call = (await (
        await after.rpc(REQUESTER, "tools/call", {
          name: "approved_orders",
          arguments: { id: 7 },
          _meta: { "io.modelcontextprotocol/approvalToken": approvalToken },
        })
      ).json()) as { result: { resultType: string; isError?: boolean } };
      expect(call.result.resultType).toBe("input_required");
    } finally {
      await after.stop();
    }
  });

  it("still accepts a token a different principal resolved", async () => {
    const app = await start(true);
    try {
      const requested = (await (
        await app.rpc(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } })
      ).json()) as { result: { inputRequests: Array<{ requestState: string }> } };
      const requestState = String(requested.result.inputRequests[0]?.requestState);
      const resolved = (await (
        await app.rpc(APPROVER, "io.modelcontextprotocol/approvals/resolve", { requestState, decision: "approved" })
      ).json()) as { result: { approvalToken: string } };
      const call = (await (
        await app.rpc(REQUESTER, "tools/call", {
          name: "approved_orders",
          arguments: { id: 7 },
          _meta: { "io.modelcontextprotocol/approvalToken": resolved.result.approvalToken },
        })
      ).json()) as { result: { resultType: string } };
      expect(call.result.resultType).toBe("complete");
    } finally {
      await app.stop();
    }
  });

  it("resolves a request exactly once when two resolutions race", async () => {
    const app = await start(true);
    try {
      const requested = (await (
        await app.rpc(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } })
      ).json()) as { result: { inputRequests: Array<{ requestState: string }> } };
      const requestState = String(requested.result.inputRequests[0]?.requestState);
      const [a, b] = await Promise.all([
        app.rpc(APPROVER, "io.modelcontextprotocol/approvals/resolve", { requestState, decision: "approved" }),
        app.rpc(APPROVER, "io.modelcontextprotocol/approvals/resolve", { requestState, decision: "denied" }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 404]);
    } finally {
      await app.stop();
    }
  });

  it("rejects a legacy token (no resolver hash) whose approver is the owner's subject", async () => {
    const viewer: AuthContext = {
      method: "static",
      subject: "requester",
      username: "requester",
      scopes: ["tools:read", "tools:write"],
      claims: { tenant: "acme" },
      headers: {},
      rawToken: "x",
    };
    const token = mintApprovalToken({
      subject: approvalOwner(viewer),
      tool: "approved_orders",
      argsFingerprint: approvalArgsFingerprint({ id: 7 }),
      requestState: "state-legacy-self",
      approver: "requester",
      secret: "separation-approval-secret",
      ttlMs: 300_000,
    });
    const policy = new GovernancePolicy({
      defaultEffect: "approval",
      rules: [],
      approval: {
        ttlMs: 300_000,
        maxPending: 10,
        secret: "separation-approval-secret",
        requireDifferentApprover: true,
        approverScope: "approvals:resolve",
      },
    });
    expect(await policy.verifyApproval(token, viewer, "approved_orders", { id: 7 }, undefined, false)).toBe(false);
  });
});

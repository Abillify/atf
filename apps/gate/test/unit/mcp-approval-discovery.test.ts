// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * `approvals/list` and `approvals/get` on the 2026 endpoint.
 *
 *  - `approvals/list` shows the caller's open approvals: their own requests,
 *    and — with `requireDifferentApprover` on — every request of the tenant for
 *    holders of `approverScope`. Tool arguments are never exposed.
 *  - `approvals/get` is for the owner only and reports the status; once
 *    approved it hands the requester the one-shot approval token.
 *  - Anything the caller may not see answers `-32003 approval not found`, so
 *    the endpoint never discloses that a request exists.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { FakeDb } from "../helpers/fake-db.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

const REQUESTER = "disc-requester";
const APPROVER = "disc-approver";
const NO_SCOPE = "disc-other";
const OTHER_TENANT = "disc-other-tenant";

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
      approval: { secret: "discovery-approval-secret", ttlMs: 300_000, maxPending: 10, requireDifferentApprover },
      rules: [{ effect: "approval", match: { tool: "approved_orders" } }],
    },
  });
}

type RpcBody = {
  error?: { code: number; message: string };
  result?: Record<string, unknown> & { approvals?: Array<Record<string, unknown>> };
};

describe("approvals/list and approvals/get (requireDifferentApprover=true)", () => {
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
  const rpcJson = async (token: string, method: string, params: Record<string, unknown> = {}) => {
    const response = await rpc(token, method, params);
    return { status: response.status, body: (await response.json()) as RpcBody };
  };

  /** The requester asks for the approval and gets the request state back. */
  async function requestApproval(): Promise<string> {
    const { body } = await rpcJson(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } });
    const inputRequests = (body.result?.inputRequests ?? []) as Array<{ requestState: string }>;
    return String(inputRequests[0]?.requestState);
  }

  beforeAll(async () => {
    handle = await buildApp(config(true), { db: new FakeDb({ main: [{ id: 7 }] }) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("the owner sees their own request in the list, without tool arguments", async () => {
    const requestState = await requestApproval();
    const { status, body } = await rpcJson(REQUESTER, "io.modelcontextprotocol/approvals/list");
    expect(status).toBe(200);
    const entry = body.result?.approvals?.find((a) => a.requestState === requestState);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ tool: "approved_orders" });
    expect(typeof entry?.owner).toBe("string");
    expect(typeof entry?.createdAt).toBe("string");
    expect(typeof entry?.expiresAt).toBe("string");
    expect(entry).not.toHaveProperty("args");
    expect(entry).not.toHaveProperty("arguments");
  });

  it("another principal of the tenant without the approver scope does not see it", async () => {
    const requestState = await requestApproval();
    const { body } = await rpcJson(NO_SCOPE, "io.modelcontextprotocol/approvals/list");
    expect(body.result?.approvals ?? []).toEqual([]);
    const denied = await rpcJson(NO_SCOPE, "io.modelcontextprotocol/approvals/get", { requestState });
    expect(denied.status).toBe(404);
    expect(denied.body.error).toMatchObject({ code: -32003, message: "approval not found" });
  });

  it("an approver with the approver scope sees the tenant's open requests", async () => {
    const requestState = await requestApproval();
    const { status, body } = await rpcJson(APPROVER, "io.modelcontextprotocol/approvals/list");
    expect(status).toBe(200);
    const entry = body.result?.approvals?.find((a) => a.requestState === requestState);
    expect(entry).toMatchObject({ tool: "approved_orders" });
    // Listing is not resolving: the approver may not read the arguments.
    expect(entry).not.toHaveProperty("args");
  });

  it("a principal of another tenant sees neither the list entry nor the request", async () => {
    const requestState = await requestApproval();
    const list = await rpcJson(OTHER_TENANT, "io.modelcontextprotocol/approvals/list");
    expect(list.body.result?.approvals ?? []).toEqual([]);
    const get = await rpcJson(OTHER_TENANT, "io.modelcontextprotocol/approvals/get", { requestState });
    expect(get.status).toBe(404);
    expect(get.body.error).toMatchObject({ code: -32003, message: "approval not found" });
  });

  it("get by the owner yields approved and the token, which then runs the tool exactly once", async () => {
    const requestState = await requestApproval();
    const pending = await rpcJson(REQUESTER, "io.modelcontextprotocol/approvals/get", { requestState });
    expect(pending.status).toBe(200);
    expect(pending.body.result).toMatchObject({ status: "pending" });
    expect(pending.body.result).not.toHaveProperty("approvalToken");

    const resolved = await rpcJson(APPROVER, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "approved",
    });
    expect(resolved.status).toBe(200);

    const fetched = await rpcJson(REQUESTER, "io.modelcontextprotocol/approvals/get", { requestState });
    expect(fetched.body.result).toMatchObject({ status: "approved" });
    const approvalToken = String(fetched.body.result?.approvalToken);
    expect(approvalToken).toBeString();

    const first = await rpcJson(REQUESTER, "tools/call", {
      name: "approved_orders",
      arguments: { id: 7 },
      _meta: { "io.modelcontextprotocol/approvalToken": approvalToken },
    });
    expect(first.body.result?.resultType).toBe("complete");
    const replay = await rpcJson(REQUESTER, "tools/call", {
      name: "approved_orders",
      arguments: { id: 7 },
      _meta: { "io.modelcontextprotocol/approvalToken": approvalToken },
    });
    expect(replay.body.result?.resultType).toBe("input_required");

    // A resolved request leaves the open list.
    const list = await rpcJson(REQUESTER, "io.modelcontextprotocol/approvals/list");
    expect(list.body.result?.approvals?.find((a) => a.requestState === requestState)).toBeUndefined();
  });

  it("a denied request is reported as denied to its owner and carries no token", async () => {
    const requestState = await requestApproval();
    const resolved = await rpcJson(APPROVER, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "denied",
    });
    expect(resolved.status).toBe(200);
    const fetched = await rpcJson(REQUESTER, "io.modelcontextprotocol/approvals/get", { requestState });
    expect(fetched.body.result).toMatchObject({ status: "denied" });
    expect(fetched.body.result).not.toHaveProperty("approvalToken");
  });

  it("an unknown request state answers approval not found", async () => {
    const { status, body } = await rpcJson(REQUESTER, "io.modelcontextprotocol/approvals/get", {
      requestState: "00000000-0000-4000-8000-000000000000",
    });
    expect(status).toBe(404);
    expect(body.error).toMatchObject({ code: -32003, message: "approval not found" });
  });

  it("a second resolve of the same request fails, so the token can not be minted twice", async () => {
    const requestState = await requestApproval();
    const first = await rpcJson(APPROVER, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "approved",
    });
    expect(first.status).toBe(200);
    const second = await rpcJson(APPROVER, "io.modelcontextprotocol/approvals/resolve", {
      requestState,
      decision: "approved",
    });
    expect(second.status).toBe(404);
  });

  it("without the separation flag the requester still resolves its own request and can read it", async () => {
    const flagless = await buildApp(config(false), { db: new FakeDb({ main: [{ id: 7 }] }) });
    const { server: ownServer, port: ownPort } = await listen(flagless.app);
    try {
      const call = (token: string, method: string, params: Record<string, unknown> = {}) =>
        fetch(`http://127.0.0.1:${ownPort}/mcp/v2026`, {
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
        }).then((r) => r.json() as Promise<RpcBody>);
      const created = await call(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } });
      const requestState = String(
        ((created.result?.inputRequests ?? []) as Array<{ requestState: string }>)[0]?.requestState,
      );
      const resolved = await call(REQUESTER, "io.modelcontextprotocol/approvals/resolve", {
        requestState,
        decision: "approved",
      });
      expect(resolved.result?.approvalToken).toBeString();
      const fetched = await call(REQUESTER, "io.modelcontextprotocol/approvals/get", { requestState });
      expect(fetched.result).toMatchObject({ status: "approved" });
      expect(fetched.result?.approvalToken).toBeString();
      // The approver scope is not a reason to see other people's requests
      // while the separation flag is off.
      const approverList = await call(APPROVER, "io.modelcontextprotocol/approvals/list");
      expect(approverList.result?.approvals ?? []).toEqual([]);
    } finally {
      ownServer.close();
      await flagless.shutdown();
    }
  });
});

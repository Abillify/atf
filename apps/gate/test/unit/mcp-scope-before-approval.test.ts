// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Scopes are checked before the approval decision: a caller without the
 * scopes of an approval-gated tool gets the scope error, creates no pending
 * request and never reaches the approval-token check.
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

const REQUESTER = "scope-requester";
const APPROVER = "scope-approver";
const NO_SCOPE = "scope-reader";

const TOOL = {
  name: "approved_orders",
  type: "database",
  database: "main",
  query: "SELECT id FROM orders WHERE owner = :ctx.username",
  access: "write",
  requiredScopes: ["orders:write"],
  inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: [] },
};

function config() {
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
            scopes: ["tools:read", "tools:write", "orders:write"],
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
        ],
      },
    },
    monitoring: { enabled: true, token: "m" },
    tools: [TOOL],
    policies: {
      defaultEffect: "allow",
      approval: { secret: "scope-order-approval-secret", ttlMs: 300_000, maxPending: 10, requireDifferentApprover: true },
      rules: [{ effect: "approval", match: { tool: "approved_orders" } }],
    },
  });
}

type RpcBody = {
  error?: { code: number; message: string };
  result?: Record<string, unknown> & {
    approvals?: Array<Record<string, unknown>>;
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
};

describe("scope check precedes the approval check", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;

  const rpcJson = async (token: string, method: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": method,
        ...(method === "tools/call" && typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    });
    return { status: response.status, body: (await response.json()) as RpcBody };
  };

  beforeAll(async () => {
    handle = await buildApp(config(), { db: new FakeDb({ main: [{ id: 7 }] }) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("a caller without the tool scopes gets the scope error and no approval request", async () => {
    const denied = await rpcJson(NO_SCOPE, "tools/call", { name: "approved_orders", arguments: { id: 7 } });
    expect(denied.body.result).not.toHaveProperty("inputRequests");
    expect(denied.body.result?.isError).toBe(true);
    expect(denied.body.result?.content?.[0]?.text).toContain("Missing required scope(s)");

    const list = await rpcJson(APPROVER, "io.modelcontextprotocol/approvals/list");
    expect(list.body.result?.approvals ?? []).toEqual([]);
  });

  it("a caller with the scopes still receives the approval request", async () => {
    const asked = await rpcJson(REQUESTER, "tools/call", { name: "approved_orders", arguments: { id: 7 } });
    expect(asked.body.result).toHaveProperty("inputRequests");
  });
});

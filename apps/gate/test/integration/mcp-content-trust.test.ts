// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Everything a tool returns is data from a downstream system. The Gate says so
 * on every executed tool result (`_meta["io.atf/content-trust"]`), additively:
 * `content` and `structuredContent` are untouched, and a result the Gate
 * produced itself (policy denial) carries no such label (P1-Q1).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import type { Express } from "express";
import { AppConfigSchema } from "../../src/config/schema.ts";
import { buildApp, type AppHandle } from "../../src/app.ts";
import { CONTENT_TRUST_META_KEY, contentTrustLabel } from "../../src/tools/types.ts";
import { FakeDb } from "../helpers/fake-db.ts";

function listen(app: Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

describe("contentTrustLabel", () => {
  it("is an additive _meta entry naming the backend", () => {
    expect(CONTENT_TRUST_META_KEY).toBe("io.atf/content-trust");
    expect(contentTrustLabel("database")).toEqual({
      "io.atf/content-trust": { content_trust: "untrusted", source: "database" },
    });
  });
});

describe("MCP tools/call · content-trust label", () => {
  let handle: AppHandle;
  let server: Server;
  let port: number;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/v2026`, {
      method: "POST",
      headers: {
        authorization: "Bearer trust-token",
        "content-type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      }),
    });
    return (await response.json()) as { result: Record<string, unknown> & { _meta?: Record<string, unknown> } };
  };

  beforeAll(async () => {
    const config = AppConfigSchema.parse({
      server: { port: 3000 },
      auth: {
        mode: "static",
        static: { tokens: [{ token: "trust-token", username: "u", scopes: ["tools:read"], claims: {} }] },
      },
      monitoring: { enabled: true, token: "m" },
      tools: [
        {
          name: "my_orders",
          type: "database",
          database: "main",
          query: "SELECT id FROM orders WHERE owner = :ctx.username",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: "secret_orders",
          type: "database",
          database: "main",
          query: "SELECT id FROM orders",
          requiredScopes: ["orders:admin"],
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    });
    handle = await buildApp(config, { db: new FakeDb({ main: [{ id: 1 }] }) });
    ({ server, port } = await listen(handle.app));
  });
  afterAll(async () => {
    server.close();
    await handle.shutdown();
  });

  it("labels an executed tool result as untrusted data and leaves the payload alone", async () => {
    const { result } = await call("my_orders");
    expect(result.isError).not.toBe(true);
    expect(result._meta?.[CONTENT_TRUST_META_KEY]).toEqual({ content_trust: "untrusted", source: "database" });
    // The protocol envelope is still there next to it.
    expect(result._meta).toHaveProperty("serverInfo");
    expect(result.content).toBeDefined();
    expect(result.structuredContent).toMatchObject({ rowCount: 1 });
  });

  it("a result the Gate refused itself carries no data label", async () => {
    const { result } = await call("secret_orders");
    expect(result.isError).toBe(true);
    expect(result._meta?.[CONTENT_TRUST_META_KEY]).toBeUndefined();
  });
});

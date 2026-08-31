// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createFlowMcpRouter } from "../flow-mcp.js";
import { TOKEN_KEY, type AuthContext } from "../../middleware/auth.js";
import type { FlowMcpServer } from "../../mcp/flow-mcp-server.js";

describe("flow MCP route authentication boundary", () => {
  test("rejects a request that was not authenticated by the composition root", async () => {
    const server: FlowMcpServer = {
      handleRequest: async () => new Response("unexpected"),
      syncTools: () => {},
      createServer: () => {
        throw new Error("not used");
      },
    };
    const app = new Hono<AuthContext>();
    app.route("/", createFlowMcpRouter({ flowMcpServer: server }));

    const response = await app.request("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
  });

  test("forwards only the verified context token to the MCP server", async () => {
    let receivedToken: string | undefined;
    const server: FlowMcpServer = {
      handleRequest: async (_request, token) => {
        receivedToken = token;
        return new Response("ok");
      },
      syncTools: () => {},
      createServer: () => {
        throw new Error("not used");
      },
    };
    const app = new Hono<AuthContext>();
    app.use("*", async (ctx, next) => {
      ctx.set(TOKEN_KEY, "verified.jwt.token");
      await next();
    });
    app.route("/", createFlowMcpRouter({ flowMcpServer: server }));

    const response = await app.request("/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer untrusted.header.token" },
    });
    expect(response.status).toBe(200);
    expect(receivedToken).toBe("verified.jwt.token");
  });
});

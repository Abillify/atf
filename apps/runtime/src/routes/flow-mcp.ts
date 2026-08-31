// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow-as-MCP-Server route (`src/routes/flow-mcp.ts`)
 *
 * Mounts a Streamable HTTP MCP endpoint at `/mcp` that exposes every published
 * aiperator flow as an MCP tool. The endpoint is:
 *
 *   POST /mcp     — MCP JSON-RPC message (initialize / tools/list / tools/call …)
 *   GET  /mcp     — SSE stream for server-sent notifications (optional)
 *   DELETE /mcp   — Close a session (stateless mode: always 200 OK)
 *
 * Authentication:
 *   Mounted behind the composition root's bearer-token middleware. The verified
 *   credential is passed explicitly to flow execution, so downstream tools see
 *   the caller identity without trusting transport-provided auth metadata.
 *
 * Hot reload:
 *   The router accepts an optional `onRegistryChange` hook. Wire it to the
 *   flow-parser's change callback so tools are re-synced without a restart.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { AuthContext } from "../middleware/auth.js";
import { AUTH_PRINCIPAL_KEY, TOKEN_KEY } from "../middleware/auth.js";
import type { FlowMcpServer } from "../mcp/flow-mcp-server.js";

export interface FlowMcpRouterDeps {
  flowMcpServer: FlowMcpServer;
}

export function createFlowMcpRouter(deps: FlowMcpRouterDeps): Hono<AuthContext> {
  const app = new Hono<AuthContext>();
  const { flowMcpServer } = deps;

  /**
   * All MCP protocol messages use the same `/mcp` path regardless of method.
   * The `WebStandardStreamableHTTPServerTransport` handles GET (SSE), POST
   * (JSON-RPC), and DELETE (session close) internally based on the method.
   */
  app.all("/mcp", async (ctx) => {
    // Authentication is applied by the composition root before this router is
    // mounted. Passing the verified credential explicitly prevents the MCP SDK
    // transport from treating a client-controlled header as trusted authInfo.
    const callerToken = ctx.get(TOKEN_KEY);
    const principal = ctx.get(AUTH_PRINCIPAL_KEY);
    if ((callerToken === undefined || callerToken === "") && principal === undefined) {
      return ctx.json(
        { error: { message: "Authentication required.", type: "authentication_error" } },
        401,
      );
    }
    const response = await flowMcpServer.handleRequest(
      ctx.req.raw,
      callerToken,
      principal,
    );
    return response;
  });

  return app;
}

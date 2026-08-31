// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP management routes (`src/routes/mcp.ts`)
 *
 * Operator endpoints for managing MCP server connections. Gated by the same
 * MONITORING_AUTH token as the rest of the operator plane.
 *
 *   POST /mcp/:server/reconnect — tear down the named server's client and
 *                                  establish a fresh connection, then refresh
 *                                  the in-memory knownToolIds set.
 *
 * Useful when an MCP server process has been restarted outside of aiperator
 * and the reactive auto-reconnect has not yet triggered (i.e. no in-flight
 * tool call produced an error that kicked off the recovery path).
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import type { McpServerConfig } from "../config/index.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";
import type { AuditLog } from "../observability/audit-log.js";

export interface McpRouterDeps {
  mcpWrapper: McpWrapperService;
  /**
   * The live knownToolIds set from startup. The router mutates it in-place
   * after a successful reconnect so that flow validation stays consistent with
   * the server's current tool list.
   */
  knownToolIds: Set<string>;
  /** Names of all configured MCP servers (used to validate the :server param). */
  serverNames: ReadonlySet<string>;
  /** Configured MCP servers, for GET /mcp/servers (name/url/transport display). */
  serverConfigs?: readonly McpServerConfig[];
  /** Require a valid token (header or ?token=) — mirrors MONITORING_AUTH. */
  authRequired?: boolean;
  /** Operator RBAC authorizer (defaults to a back-compat one from authRequired). */
  operatorAuth?: OperatorAuthorizer;
  /** Optional audit log. */
  auditLog?: AuditLog;
}

export function createMcpRouter(deps: McpRouterDeps): Hono {
  const { mcpWrapper, knownToolIds, serverNames, auditLog } = deps;
  const serverConfigs = deps.serverConfigs ?? [];
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  const router = new Hono();

  const guard = async (
    ctx: {
      req: {
        header: (k: string) => string | undefined;
        query: (k: string) => string | undefined;
      };
    },
    perm: Parameters<OperatorAuthorizer["authorize"]>[2],
  ) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      perm,
    );
    return r.ok
      ? (r.actor ?? { name: "operator", role: "admin", via: "open" as const })
      : null;
  };

  const unauthorized = (ctx: import("hono").Context) =>
    ctx.json(
      {
        error: {
          message: "Unauthorized operator access.",
          type: "authentication_error",
        },
      },
      401,
    );

  // ---------------------------------------------------------------------------
  // GET /mcp/servers — configured MCP servers + their currently known tools.
  // ---------------------------------------------------------------------------
  router.get("/mcp/servers", async (ctx) => {
    if (!(await guard(ctx, "monitoring:read"))) return unauthorized(ctx);

    const servers = await Promise.all(
      serverConfigs.map(async (cfg) => {
        try {
          const tools = await mcpWrapper.listTools(cfg.name);
          return {
            id: cfg.name,
            name: cfg.name,
            url: cfg.url,
            transport: cfg.transport,
            status: "connected" as const,
            tools: tools.map((name) => ({ name, description: "", authorized: true })),
          };
        } catch (err) {
          return {
            id: cfg.name,
            name: cfg.name,
            url: cfg.url,
            transport: cfg.transport,
            status: "error" as const,
            error: err instanceof Error ? err.message : String(err),
            tools: [],
          };
        }
      }),
    );
    return ctx.json({ servers });
  });

  // ---------------------------------------------------------------------------
  // POST /mcp/:server/reconnect
  // ---------------------------------------------------------------------------

  /**
   * Reconnects the named MCP server and refreshes the in-process knownToolIds.
   *
   * Flow:
   *  1. Validate that :server names a known MCP server config.
   *  2. Call mcpWrapper.reconnect() — closes the dead transport, opens a fresh
   *     connection, and invalidates the schema cache for that server.
   *  3. Fetch the server's current tool list via mcpWrapper.listTools().
   *  4. Remove the server's old entries from knownToolIds (prefixed and bare).
   *  5. Insert the freshly discovered tool names (prefixed and bare).
   *  6. Return { ok, server, tools }.
   */
  router.post("/mcp/:server/reconnect", async (ctx) => {
    const actor = await guard(ctx, "flows:write");
    if (!actor) return unauthorized(ctx);

    const serverName = ctx.req.param("server");

    if (!serverNames.has(serverName)) {
      return ctx.json(
        {
          error: {
            message:
              `Unknown MCP server: "${serverName}". ` +
              `Known servers: [${[...serverNames].join(", ")}]`,
            type: "invalid_request_error",
          },
        },
        404,
      );
    }

    try {
      // 1. Reconnect — replaces the dead client with a fresh one.
      await mcpWrapper.reconnect(serverName);

      // 2. Fetch the current tool list from the freshly connected server.
      const toolNames = await mcpWrapper.listTools(serverName);

      // 3. Remove this server's old entries from knownToolIds.
      //    Find old prefixed entries, then delete both the prefixed and bare
      //    forms. (If two servers share a bare tool name, the bare form gets
      //    re-added in the next step — any transient gap is acceptable.)
      const oldBareNames = [...knownToolIds]
        .filter((id) => id.startsWith(`${serverName}/`))
        .map((id) => id.slice(serverName.length + 1));

      for (const name of oldBareNames) {
        knownToolIds.delete(`${serverName}/${name}`);
        knownToolIds.delete(name);
      }

      // 4. Insert the freshly discovered tool names.
      for (const name of toolNames) {
        knownToolIds.add(`${serverName}/${name}`);
        knownToolIds.add(name);
      }

      auditLog?.record({
        actor: actor.name,
        role: actor.role,
        action: "mcp.reconnect",
        target: serverName,
      });

      return ctx.json({ ok: true, server: serverName, tools: toolNames });
    } catch (err) {
      return ctx.json(
        {
          error: {
            message: `Failed to reconnect MCP server "${serverName}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            type: "server_error",
          },
        },
        502,
      );
    }
  });

  return router;
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Services overview route (`src/routes/services.ts`)
 *
 * GET /monitoring/services — the operator-plane inventory behind the Control
 * services page: the configured `SERVICE_LINKS` (name/kind/url, display data
 * only) plus the live status of every configured MCP server.
 *
 * Deliberately secret-free: MCP headers, token-exchange wiring and any other
 * credential material are never part of the response — only name, URL,
 * transport, connection status and tool names, the same display fields
 * `GET /mcp/servers` exposes.
 *
 * Operator-plane, gated by `monitoring:read`, same monitoring authentication
 * as the other `/monitoring/*` routes.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { AppConfig, McpServerConfig } from "../config/schema.js";
import type { McpWrapperService } from "../mcp/mcp-wrapper.js";
import {
  createOperatorAuthorizer,
  type OperatorAuthorizer,
} from "../middleware/operator-rbac.js";

export interface ServicesRouterDeps {
  config: AppConfig;
  /** Live MCP wrapper for the connection status; absent = status never probed. */
  mcpWrapper?: McpWrapperService;
  authRequired?: boolean;
  operatorAuth?: OperatorAuthorizer;
}

interface McpServerStatus {
  name: string;
  url: string;
  transport: McpServerConfig["transport"];
  status: "connected" | "error";
  /** Present only when the connection failed; the wrapper's error message. */
  error?: string;
}

export function createServicesRouter(deps: ServicesRouterDeps): Hono {
  const app = new Hono();
  const authRequired = deps.authRequired ?? false;
  const operatorAuth =
    deps.operatorAuth ?? createOperatorAuthorizer({ authRequired });

  app.get("/monitoring/services", async (ctx: Context) => {
    const r = await operatorAuth.authorize(
      ctx.req.header("Authorization"),
      ctx.req.query("token"),
      "monitoring:read",
    );
    if (!r.ok) {
      return ctx.json(
        { error: { message: "Unauthorized services access." } },
        401,
      );
    }

    const mcp: McpServerStatus[] = await Promise.all(
      deps.config.mcpServers.map(async (cfg): Promise<McpServerStatus> => {
        const base = {
          name: cfg.name,
          url: cfg.url,
          transport: cfg.transport,
        };
        if (deps.mcpWrapper === undefined) {
          return { ...base, status: "error" as const, error: "not probed" };
        }
        try {
          await deps.mcpWrapper.listTools(cfg.name);
          return { ...base, status: "connected" as const };
        } catch (err) {
          return {
            ...base,
            status: "error" as const,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return ctx.json({
      services: (deps.config.serviceLinks ?? []).map((link) => ({
        name: link.name,
        kind: link.kind,
        url: link.url,
      })),
      mcp,
    });
  });

  return app;
}

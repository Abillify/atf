"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /mcp — MCP server + tools + tool-authz management (Req. 13.5).
 *
 * Lists registered MCP servers and their tool authorizations via GET /mcp/servers.
 */

import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { Badge } from "../../../lib/ui";
import type { BadgeVariant } from "../../../lib/ui";

interface McpTool {
  name: string;
  description: string;
  authorized: boolean;
}

interface McpServer {
  id: string;
  name: string;
  url: string;
  status: "connected" | "disconnected" | "error";
  error?: string;
  tools: McpTool[];
}

function fetchMcpServers(token: string | undefined): Promise<McpServer[]> {
  return authFetch(backendUrl("/mcp/servers"), token).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<{ servers: McpServer[] }>;
  }).then((d) => d.servers);
}

const STATUS_VARIANT: Record<McpServer["status"], BadgeVariant> = {
  connected: "success",
  disconnected: "secondary",
  error: "destructive",
};

export default function McpPage() {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled (no
  // token; the backend serves the operator plane anonymously). authFetch omits
  // the Authorization header for an undefined token.
  const { token, ready, isAuthenticated } = useAuth();

  const {
    data: servers = [],
    isLoading,
    error,
  } = useQuery<McpServer[], Error>({
    queryKey: ["mcp", "servers"],
    queryFn: () => fetchMcpServers(token),
    enabled: ready && isAuthenticated,
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        MCP Servers &amp; Tool Authorization
      </h1>

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Loading MCP servers…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md bg-danger-soft p-4 text-sm text-danger"
        >
          Failed to load MCP servers: {error.message}
        </div>
      )}

      {!isLoading && !error && servers.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          No MCP servers registered.
        </div>
      )}

      <div className="space-y-4">
        {servers.map((server) => (
          <div
            key={server.id}
            className="rounded-lg border border-border bg-card shadow-sm"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <span className="font-medium text-foreground">
                  {server.name}
                </span>
                <code className="ml-2 text-xs text-muted-foreground">
                  {server.url}
                </code>
              </div>
              <Badge variant={STATUS_VARIANT[server.status]}>
                {server.status}
              </Badge>
            </div>
            <div className="p-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Tools
              </p>
              {server.tools.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No tools registered.
                </p>
              )}
              <div className="space-y-1">
                {server.tools.map((tool) => (
                  <div
                    key={tool.name}
                    className="flex items-center justify-between rounded px-2 py-1 hover:bg-muted"
                  >
                    <div>
                      <span className="text-sm font-medium text-foreground">
                        {tool.name}
                      </span>
                      {tool.description && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {tool.description}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-xs font-medium ${tool.authorized ? "text-success" : "text-danger"}`}
                    >
                      {tool.authorized ? "✓ authorized" : "✗ blocked"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for GET /monitoring/services (`src/routes/services.ts`).
 *
 * Pins the monitoring auth contract (401 without credentials when
 * MONITORING_AUTH is active), that the configured SERVICE_LINKS and the live
 * MCP server status reach the response, and that no credential material
 * (headers, token-exchange wiring) ever leaks into it.
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createServicesRouter } from "../services.js";
import { createOperatorAuthorizer } from "../../middleware/operator-rbac.js";
import type {
  AppConfig,
  McpServerConfig,
  ServiceLinkConfig,
} from "../../config/schema.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";

function serviceLink(over: Partial<ServiceLinkConfig> = {}): ServiceLinkConfig {
  return {
    name: "Search",
    kind: "search",
    url: "https://search.example.com",
    ...over,
  };
}

function mcpServer(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "erp",
    url: "http://erp.internal:4000/mcp",
    transport: "http",
    headers: { Authorization: "Bearer super-secret-header-value" },
    ...over,
  } as McpServerConfig;
}

function config(
  serviceLinks: ServiceLinkConfig[],
  mcpServers: McpServerConfig[],
): AppConfig {
  return {
    port: 3000,
    flowsDir: "./flows",
    monitoringTransport: "sse",
    mcpServers,
    serviceLinks,
    corsOrigins: [],
    monitoringAuthRequired: false,
    maxConcurrentExecutions: 1,
    logLevel: "error",
    maxToolSteps: 1,
  } as AppConfig;
}

function wrapper(
  failing: ReadonlySet<string>,
): McpWrapperService {
  return {
    listTools: async (serverName: string) => {
      if (failing.has(serverName)) throw new Error("connection refused");
      return ["tool_a", "tool_b"];
    },
  } as unknown as McpWrapperService;
}

function buildApp(opts: {
  authRequired?: boolean;
  serviceLinks?: ServiceLinkConfig[];
  mcpServers?: McpServerConfig[];
  failingMcp?: ReadonlySet<string>;
  withWrapper?: boolean;
}): Hono {
  const app = new Hono();
  app.route(
    "/",
    createServicesRouter({
      config: config(opts.serviceLinks ?? [], opts.mcpServers ?? []),
      authRequired: opts.authRequired ?? false,
      ...(opts.authRequired === true
        ? {
            operatorAuth: createOperatorAuthorizer({
              authRequired: true,
              tokens: [{ token: "viewer-tok", role: "viewer" }],
            }),
          }
        : {}),
      ...(opts.withWrapper === false
        ? {}
        : { mcpWrapper: wrapper(opts.failingMcp ?? new Set()) }),
    }),
  );
  return app;
}

describe("GET /monitoring/services", () => {
  it("returns 401 without credentials when monitoring auth is required", async () => {
    const app = buildApp({ authRequired: true });
    const res = await app.request("/monitoring/services");
    expect(res.status).toBe(401);
  });

  it("returns the configured service links when authenticated", async () => {
    const app = buildApp({
      authRequired: true,
      serviceLinks: [
        serviceLink(),
        serviceLink({ name: "Gate", kind: "gate", url: "https://gate.example.com" }),
      ],
    });
    const res = await app.request("/monitoring/services", {
      headers: { Authorization: "Bearer viewer-tok" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: { name: string; kind: string; url: string }[];
      mcp: unknown[];
    };
    expect(body.services).toHaveLength(2);
    expect(body.services[0]).toEqual({
      name: "Search",
      kind: "search",
      url: "https://search.example.com",
    });
    expect(body.services[1]?.kind).toBe("gate");
  });

  it("reports connected and error status per MCP server", async () => {
    const app = buildApp({
      mcpServers: [mcpServer(), mcpServer({ name: "broken" })],
      failingMcp: new Set(["broken"]),
    });
    const res = await app.request("/monitoring/services");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      services: unknown[];
      mcp: {
        name: string;
        url: string;
        transport: string;
        status: string;
        error?: string;
      }[];
    };
    expect(body.mcp).toHaveLength(2);
    expect(body.mcp[0]).toEqual({
      name: "erp",
      url: "http://erp.internal:4000/mcp",
      transport: "http",
      status: "connected",
    });
    expect(body.mcp[1]?.status).toBe("error");
    expect(body.mcp[1]?.error).toBe("connection refused");
  });

  it("never leaks MCP headers or token-exchange material", async () => {
    const app = buildApp({
      mcpServers: [
        mcpServer({
          tokenExchange: {
            tokenEndpoint: "https://idp.example.com/token",
            clientId: "client-id",
            clientSecretEnv: "ERP_SECRET",
            audience: "erp",
          },
        }),
      ],
    });
    const res = await app.request("/monitoring/services");
    const raw = await res.text();
    expect(raw).not.toContain("super-secret-header-value");
    expect(raw).not.toContain("ERP_SECRET");
    expect(raw).not.toContain("client-id");
    expect(raw).not.toContain("tokenExchange");
  });

  it("marks servers as not probed when no wrapper is wired", async () => {
    const app = buildApp({
      mcpServers: [mcpServer()],
      withWrapper: false,
    });
    const res = await app.request("/monitoring/services");
    const body = (await res.json()) as {
      mcp: { status: string; error?: string }[];
    };
    expect(body.mcp[0]?.status).toBe("error");
    expect(body.mcp[0]?.error).toBe("not probed");
  });
});

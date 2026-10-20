// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * openapi.ts
 *
 * Returns the OpenAPI 3.1 specification for the ATF Gate (MCP security
 * gateway) as a plain JS object, served unauthenticated at
 * GET /openapi.json (requirement 14.5).
 *
 * The Gate is an Express app whose HTTP surface is assembled in app.ts from
 * a fixed set of routers (health, RFC 9728 metadata, erasure, metrics,
 * webhook receivers, the three MCP transports and the operator monitor).
 * The inventory below mirrors that assembly; conditional routers are marked
 * with an `x-enabled-when` extension. Inbound webhook paths are declared per
 * tool configuration and therefore dynamic — they are described in the
 * document body rather than enumerated.
 *
 * The committed baseline under docs/openapi/gate.json is regenerated with
 * `bun run openapi:update` and guarded for breaking changes by
 * `bun run openapi:check` (requirement 11.7).
 */

import { version } from "../package.json";
import type { Request } from "express";

/**
 * Resolve the `servers[0].url` for the document from the incoming request:
 * PUBLIC_URL wins, then X-Forwarded-Proto/Host (trusted-proxy deployments),
 * then the request origin itself.
 */
export function resolveOpenApiServerUrl(req: Request): string {
  const envUrl = process.env["PUBLIC_URL"];
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto =
    typeof fwdProto === "string"
      ? (fwdProto.split(",")[0] ?? "").trim() || req.protocol
      : req.protocol;
  const fwdHost = req.headers["x-forwarded-host"];
  const host =
    (typeof fwdHost === "string" ? fwdHost : undefined) ?? req.headers.host;
  if (host) return `${proto}://${host}`;
  const port = (req.socket as { localPort?: number }).localPort;
  return `http://localhost${port ? `:${port}` : ""}`;
}

interface Op {
  tag: string;
  summary: string;
  auth: "none" | "bearer" | "service" | "signature" | "session";
  /** Config condition under which the route exists, surfaced as x-enabled-when. */
  enabledWhen?: string;
  /** Media type the operation produces (defaults to application/json). */
  produces?: string;
  requestBody?: boolean;
}

const SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "OAuth2/OIDC access token validated by the configured authenticator (auth.mode oauth|both).",
  },
  serviceAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "service-token",
    description:
      "Internal service credential used by the orchestrator for the shared erasure contract.",
  },
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: "mcpgate_monitor_session",
    description: "Operator browser session established via /monitor/login (OIDC BFF).",
  },
  webhookSignature: {
    type: "apiKey",
    in: "header",
    name: "X-Hub-Signature-256",
    description: "HMAC request signature verified against the webhook tool's secret.",
  },
} as const;

function securityFor(auth: Op["auth"]): Array<Record<string, string[]>> | undefined {
  switch (auth) {
    case "bearer":
      return [{ bearerAuth: [] }];
    case "service":
      return [{ serviceAuth: [] }];
    case "session":
      return [{ sessionCookie: [] }];
    case "signature":
      return [{ webhookSignature: [] }];
    default:
      return undefined;
  }
}

/**
 * The Gate's HTTP surface, mirroring the router assembly in app.ts.
 * Keyed by OpenAPI path template; MCP transport paths are the configuration
 * defaults (server.ssePath / server.messagePath / server.mcpPath /
 * server.mcp2026.path).
 */
const SURFACE: Record<string, Record<string, Op>> = {
  "/healthz": {
    get: { tag: "Health", summary: "Liveness probe (never rate-limited)", auth: "none" },
  },
  "/readyz": {
    get: {
      tag: "Health",
      summary: "Readiness probe: database, ledger and optional stores",
      auth: "none",
    },
  },
  "/.well-known/oauth-protected-resource": {
    get: {
      tag: "Security",
      summary: "OAuth protected-resource metadata (RFC 9728) for MCP clients",
      auth: "none",
    },
  },
  "/v1/erasure": {
    post: {
      tag: "Security",
      summary: "Subject erasure (DSAR) for the persistent audit sink",
      auth: "service",
      requestBody: true,
    },
  },
  "/metrics": {
    get: {
      tag: "Monitoring",
      summary: "Prometheus metrics (path configurable via server.metrics.path)",
      auth: "bearer",
      enabledWhen: "server.metrics.enabled",
      produces: "text/plain; version=0.0.4",
    },
  },
  "/sse": {
    get: {
      tag: "MCP",
      summary: "MCP SSE transport: opens the server-sent-events stream",
      auth: "bearer",
      enabledWhen: "always (path = server.ssePath)",
    },
  },
  "/messages": {
    post: {
      tag: "MCP",
      summary: "MCP SSE transport: JSON-RPC message channel for a session",
      auth: "bearer",
      enabledWhen: "always (path = server.messagePath)",
      requestBody: true,
    },
  },
  "/mcp": {
    post: {
      tag: "MCP",
      summary: "MCP streamable HTTP transport: JSON-RPC requests",
      auth: "bearer",
      enabledWhen: "always (path = server.mcpPath)",
      requestBody: true,
    },
    get: {
      tag: "MCP",
      summary: "MCP streamable HTTP transport: server-to-client SSE stream",
      auth: "bearer",
      enabledWhen: "always (path = server.mcpPath)",
    },
    delete: {
      tag: "MCP",
      summary: "MCP streamable HTTP transport: terminate a session",
      auth: "bearer",
      enabledWhen: "always (path = server.mcpPath)",
    },
  },
  "/mcp/v2026": {
    post: {
      tag: "MCP",
      summary: "Native stateless MCP 2026-07-28 endpoint (GET/DELETE answer 405)",
      auth: "bearer",
      enabledWhen: "server.mcp2026.enabled (path = server.mcp2026.path)",
      requestBody: true,
    },
  },
  "/": {
    get: {
      tag: "Monitor",
      summary: "Operator monitor dashboard (HTML)",
      auth: "session",
      enabledWhen: "monitoring.enabled",
      produces: "text/html",
    },
  },
  "/monitor/session": {
    post: {
      tag: "Monitor",
      summary:
        "Exchange the static monitoring token (Authorization: Bearer) for an HttpOnly, SameSite=Strict session cookie (204)",
      auth: "bearer",
      enabledWhen: "monitoring.enabled",
    },
  },
  "/monitor/login": {
    get: {
      tag: "Monitor",
      summary: "Start the operator OIDC login flow",
      auth: "none",
      enabledWhen: "monitoring.enabled",
    },
  },
  "/monitor/callback": {
    get: {
      tag: "Monitor",
      summary: "OIDC redirect callback establishing the monitor session",
      auth: "none",
      enabledWhen: "monitoring.enabled",
    },
  },
  "/monitor/logout": {
    post: {
      tag: "Monitor",
      summary: "End the monitor session (POST only: a GET answers 405, so a third-party page cannot log the user out)",
      auth: "session",
      enabledWhen: "monitoring.enabled",
    },
  },
  "/monitor/stream": {
    get: {
      tag: "Monitor",
      summary: "Live event stream (SSE) for the monitor dashboard",
      auth: "session",
      enabledWhen: "monitoring.enabled",
      produces: "text/event-stream",
    },
  },
  "/monitor/instructions": {
    get: {
      tag: "Monitor",
      summary: "Current server instructions shown to MCP clients",
      auth: "session",
      enabledWhen: "monitoring.enabled",
    },
  },
  "/monitor/tools": {
    get: {
      tag: "Monitor",
      summary: "Registered tool catalog with governance metadata",
      auth: "session",
      enabledWhen: "monitoring.enabled",
    },
  },
  "/monitor/tools/{name}/run": {
    post: {
      tag: "Monitor",
      summary: "Tool playground: run or dry-run a registered tool through the governance pipeline (policy, scopes, approval, rate limit, audit); 403 when disabled, 503 without governance wiring",
      auth: "session",
      enabledWhen: "monitoring.enabled",
      requestBody: true,
    },
  },
};

const JSON_ERROR_RESPONSE = {
  description: "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

function operation(template: string, method: string, op: Op): Record<string, unknown> {
  const parameters: Array<Record<string, unknown>> = [];
  for (const m of template.matchAll(/\{([^}]+)\}/g)) {
    parameters.push({ name: m[1], in: "path", required: true, schema: { type: "string" } });
  }
  const produces = op.produces ?? "application/json";
  return {
    tags: [op.tag],
    summary: op.summary,
    operationId: `${method}_${template}`.replace(/[^A-Za-z0-9_]+/g, "_"),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(op.requestBody
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Success",
        content: { [produces]: { schema: { type: "object" } } },
      },
      default: JSON_ERROR_RESPONSE,
    },
    ...(securityFor(op.auth) ? { security: securityFor(op.auth) } : {}),
    ...(op.enabledWhen ? { "x-enabled-when": op.enabledWhen } : {}),
  };
}

export function buildOpenApiSpec(serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const tagsSeen = new Set<string>();
  for (const [template, methods] of Object.entries(SURFACE)) {
    const item: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(methods)) {
      tagsSeen.add(op.tag);
      item[method] = operation(template, method, op);
    }
    paths[template] = item;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Aiperator Trust Fabric Gate",
      version,
      description:
        "The ATF Gate is the MCP security gateway: it exposes governed tools over " +
        "the SSE, streamable-HTTP and stateless (2026-07-28) MCP transports with " +
        "OIDC authentication, policy authorization, rate limiting and a tamper-evident " +
        "audit trail. Health probes, RFC 9728 protected-resource metadata and the " +
        "service-auth erasure endpoint are mounted before rate limiting. Inbound " +
        "webhook receivers are declared per tool configuration, so their paths are " +
        "dynamic and not enumerated here; each verifies its request signature. " +
        "Conditional routers carry an `x-enabled-when` extension.",
    },
    servers: [{ url: serverUrl }],
    tags: [...tagsSeen].sort().map((t) => ({ name: t })),
    paths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
            code: { type: "string" },
          },
          required: ["error"],
        },
      },
    },
  };
}

/** Minimal YAML serialization for the spec (same shape as the search service). */
function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((v) => `\n${pad}- ${toYaml(v, indent + 1).replace(/^\n/, "")}`).join("");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return entries
    .map(([k, v]) => {
      const rendered = toYaml(v, indent + 1);
      const key = /^[A-Za-z0-9_./-]+$/.test(k) ? k : JSON.stringify(k);
      return rendered.startsWith("\n") ? `\n${pad}${key}:${rendered}` : `${pad}${key}: ${rendered}`;
    })
    .join("\n");
}

export function buildOpenApiYaml(serverUrl: string): string {
  return `${toYaml(buildOpenApiSpec(serverUrl))}\n`;
}

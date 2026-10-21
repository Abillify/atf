// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * openapi.ts
 *
 * Returns the OpenAPI 3.1 specification for the ATF Runtime as a plain JS
 * object, served unauthenticated at GET /openapi.json (requirement 14.5).
 *
 * The path inventory is parsed from the real router tree at request time
 * (see route-catalog.ts), so the published document cannot drift from the
 * mounted routes. Operation summaries, tags and auth schemes are keyed by
 * path prefix below; a route that matches no rule still appears — with a
 * generic summary — rather than silently disappearing from the document.
 *
 * The committed baseline under docs/openapi/runtime.json is regenerated with
 * `bun run openapi:update` and guarded for breaking changes by
 * `bun run openapi:check` (requirement 11.7).
 */

import { version } from "../package.json";
import { buildRuntimeRouteCatalog } from "./route-catalog.js";

interface OperationMeta {
  summary: string;
  tag: string;
}

/**
 * Prefix-matched operation metadata. Longer prefixes win; the first matching
 * rule for a path is used. `auth` describes the credential the endpoint
 * expects (see `components.securitySchemes`).
 */
const META_RULES: Array<
  { prefix: string } & OperationMeta & { auth?: string }
> = [
  {
    prefix: "/health",
    tag: "Health",
    summary: "Liveness, readiness and composite health probe",
  },
  {
    prefix: "/.well-known/atf-transaction-jwks.json",
    tag: "Security",
    summary: "Public transaction-token verification JWKS",
    auth: "none",
  },
  {
    prefix: "/.well-known/atf-receipt-jwks.json",
    tag: "Security",
    summary: "Public Decision_Receipt verification JWKS",
    auth: "none",
  },
  {
    prefix: "/.well-known/atf-evidence-jwks.json",
    tag: "Security",
    summary: "Public evidence-chain verification JWKS",
    auth: "none",
  },
  {
    prefix: "/.well-known/atf-jwks.json",
    tag: "Security",
    summary:
      "All public signing keys with their purpose (atf_purpose: evidence, erasure-receipt, decision-receipt, transaction)",
    auth: "none",
  },
  {
    prefix: "/monitoring/auth/",
    tag: "Security",
    summary: "Operator OIDC login (BFF) and auth configuration",
    auth: "session",
  },
  {
    prefix: "/monitoring/slo",
    tag: "Monitoring",
    summary: "Service-level objective status",
    auth: "bearer",
  },
  {
    prefix: "/monitoring/explain/",
    tag: "Monitoring",
    summary: "Execution explainability bundle",
    auth: "bearer",
  },
  {
    prefix: "/monitoring/approvals",
    tag: "Monitoring",
    summary: "Human-in-the-loop approval queue",
    auth: "bearer",
  },
  {
    prefix: "/monitoring/metrics",
    tag: "Monitoring",
    summary: "Prometheus metrics",
    auth: "bearer",
  },
  {
    prefix: "/metrics",
    tag: "Monitoring",
    summary: "Prometheus metrics",
    auth: "bearer",
  },
  {
    prefix: "/security/red-team",
    tag: "Security",
    summary: "Red-team evaluation runs and posture",
    auth: "bearer",
  },
  {
    prefix: "/security/tool-authz",
    tag: "Security",
    summary: "Tool authorization matrix",
    auth: "bearer",
  },
  {
    prefix: "/security/mcp",
    tag: "Security",
    summary: "MCP server security posture",
    auth: "bearer",
  },
  {
    prefix: "/admin/tenants",
    tag: "Admin",
    summary: "Tenant management",
    auth: "bearer",
  },
  {
    prefix: "/admin/assistants",
    tag: "Admin",
    summary: "Assistant administration",
    auth: "bearer",
  },
  {
    prefix: "/admin/identity-broker",
    tag: "Admin",
    summary: "Identity-broker delegations",
    auth: "bearer",
  },
  {
    prefix: "/admin/pii-vault",
    tag: "Admin",
    summary: "PII vault status",
    auth: "bearer",
  },
  {
    prefix: "/admin/compliance",
    tag: "Admin",
    summary: "Data-retention compliance",
    auth: "bearer",
  },
  {
    prefix: "/admin/policy-replay",
    tag: "Admin",
    summary: "Policy replay simulation (dry-run)",
    auth: "bearer",
  },
  {
    prefix: "/admin/finops",
    tag: "Admin",
    summary: "FinOps forecasts and CO₂ accounting",
    auth: "bearer",
  },
  {
    prefix: "/admin/memory",
    tag: "Admin",
    summary: "Memory session administration",
    auth: "bearer",
  },
  {
    prefix: "/admin/",
    tag: "Admin",
    summary: "Administrative endpoint",
    auth: "bearer",
  },
  {
    prefix: "/webhooks/git",
    tag: "Integrations",
    summary: "GitOps webhook receiver",
    auth: "signature",
  },
  {
    prefix: "/integrations/rocketchat",
    tag: "Integrations",
    summary: "Rocket.Chat inbound events",
    auth: "signature",
  },
  {
    prefix: "/connect/rocketchat",
    tag: "Integrations",
    summary: "Rocket.Chat connect-link flow",
    auth: "none",
  },
  {
    prefix: "/optimizer",
    tag: "Optimizer",
    summary: "Flow optimizer: routing advice and trace analysis",
    auth: "bearer",
  },
  {
    prefix: "/mcp/servers",
    tag: "MCP",
    summary: "Configured MCP servers",
    auth: "bearer",
  },
  {
    prefix: "/mcp",
    tag: "MCP",
    summary: "MCP tool-call transport",
    auth: "bearer",
  },
  {
    prefix: "/autopilot",
    tag: "Autopilot",
    summary: "Autopilot governance runs",
    auth: "bearer",
  },
  {
    prefix: "/v1/chat/completions",
    tag: "Inference",
    summary:
      "OpenAI-compatible chat completions (AI_DISCLOSURE=header|field marks successful completions as AI-generated: X-AI-Generated: true, or metadata.ai_generated = true (string) in the JSON body; flows served as MCP tools carry _meta io.atf/ai-generated)",
    auth: "bearer",
  },
  {
    prefix: "/v1/responses",
    tag: "Inference",
    summary:
      "OpenAI-compatible responses API (AI_DISCLOSURE=header|field marks successful responses as AI-generated: X-AI-Generated: true, or metadata.ai_generated = true (string))",
    auth: "bearer",
  },
  {
    prefix: "/v1/models",
    tag: "Inference",
    summary: "Model catalog",
    auth: "bearer",
  },
  {
    prefix: "/v1/media",
    tag: "Inference",
    summary: "Media fetch for chat attachments",
    auth: "bearer",
  },
  {
    prefix: "/v1/jobs",
    tag: "Inference",
    summary: "Async inference job status",
    auth: "bearer",
  },
  {
    prefix: "/v1/analysis-artifacts",
    tag: "Inference",
    summary: "Analysis artifacts with revision history",
    auth: "bearer",
  },
  {
    prefix: "/v1/receipts",
    tag: "Security",
    summary: "Decision receipts: signed receipt and Merkle inclusion proof",
    auth: "bearer",
  },
  {
    prefix: "/v1/assistants",
    tag: "Assistants",
    summary: "Assistants API: threads, runs, schedules, skills",
    auth: "bearer",
  },
  {
    prefix: "/v1/org-skills",
    tag: "Assistants",
    summary: "Organization-wide skill registry",
    auth: "bearer",
  },
  {
    prefix: "/v1/rag",
    tag: "RAG",
    summary: "Retrieval-augmented generation collections",
    auth: "bearer",
  },
  {
    prefix: "/v1/memory",
    tag: "Memory",
    summary: "Long-term memory store",
    auth: "bearer",
  },
  {
    prefix: "/v1/",
    tag: "Inference",
    summary: "Inference-plane endpoint",
    auth: "bearer",
  },
  {
    prefix: "/monitoring/",
    tag: "Monitoring",
    summary: "Monitoring, audit and observability endpoint",
    auth: "bearer",
  },
  {
    prefix: "/flows",
    tag: "Management",
    summary: "Flow definitions: list, read, draft, publish, test-run, inspect (Studio and operators)",
    auth: "bearer",
  },
  {
    prefix: "/triggers",
    tag: "Management",
    summary: "Flow trigger schedules",
    auth: "bearer",
  },
  {
    prefix: "/eval",
    tag: "Management",
    summary: "Evaluation case registry",
    auth: "bearer",
  },
];

function metaFor(path: string): OperationMeta & { auth: string } {
  // META_RULES is ordered most-specific first; the catch-alls above sit last.
  const rule = META_RULES.find((r) => path === r.prefix || path.startsWith(r.prefix));
  return {
    tag: rule?.tag ?? "Other",
    summary: rule?.summary ?? "Runtime endpoint",
    auth: rule?.auth ?? "bearer",
  };
}

/** Convert an Express/Hono path (`/v1/jobs/:id`) to an OpenAPI path template. */
function toTemplate(routePath: string): string {
  return routePath
    .replace(/:([A-Za-z_$][\w$]*)/g, "{$1}")
    // Regex-constrained params like `:requestId{[0-9a-fA-F-]+}` collapse to the name.
    .replace(/\{([A-Za-z_$][\w$]*)\}\{[^}]*\}/g, "{$1}");
}

function pathItemParams(template: string): unknown[] {
  const out: Array<Record<string, unknown>> = [];
  for (const m of template.matchAll(/\{([^}]+)\}/g)) {
    out.push({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return out;
}

const JSON_ERROR_RESPONSE = {
  description: "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

// Health probe schemas — mirror the response bodies in routes/health.ts.
const DEPENDENCY_CHECK_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["ok", "degraded", "unavailable", "unconfigured"],
    },
    reason: { type: "string" },
    latencyMs: { type: "number" },
  },
  required: ["status"],
};

/**
 * Response overrides for probe endpoints, keyed by OpenAPI path template.
 * The generic route-catalog response is `{type: "object"}`; these carry the
 * real shapes, including the optional `auth: "disabled"` marker that the
 * probes add while `AUTHN_MODE=disabled` is in effect.
 */
const HEALTH_RESPONSE_OVERRIDES: Record<
  string,
  Record<string, Record<string, unknown>>
> = {
  "/health": {
    "200": {
      description: "Composite probe (always 200, backward compatible)",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              auth: { type: "string", enum: ["disabled"] },
              flows_loaded: { type: "number" },
            },
            required: ["status"],
          },
        },
      },
    },
  },
  "/health/live": {
    "200": {
      description: "Process alive",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
              uptime_seconds: { type: "number" },
            },
            required: ["status", "uptime_seconds"],
          },
        },
      },
    },
  },
  "/health/ready": {
    "200": {
      description: "Ready to serve",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ReadinessResponse" },
        },
      },
    },
    "503": {
      description: "A configured dependency is unavailable",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ReadinessResponse" },
        },
      },
    },
  },
};

const SECURITY_SCHEMES = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "Platform JWT (or an `aip-…` managed API key in the Authorization header) when authentication is enabled.",
  },
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: "atf_session",
    description: "Operator browser session established via /monitoring/auth/login (OIDC BFF).",
  },
  webhookSignature: {
    type: "apiKey",
    in: "header",
    name: "X-Hub-Signature-256",
    description: "HMAC request signature verified against the configured webhook secret.",
  },
} as const;

function securityFor(auth: string): Array<Record<string, string[]>> | undefined {
  switch (auth) {
    case "bearer":
      return [{ bearerAuth: [] }];
    case "session":
      return [{ sessionCookie: [] }];
    case "signature":
      return [{ webhookSignature: [] }];
    default:
      return undefined;
  }
}

/**
 * Resolve the `servers[0].url` for the document from the incoming request:
 * PUBLIC_URL wins, then X-Forwarded-Proto/Host (trusted-proxy deployments),
 * then the request origin itself.
 */
export function resolveOpenApiServerUrl(requestUrl: string): string {
  const envUrl = process.env["PUBLIC_URL"];
  if (envUrl) return envUrl.replace(/\/+$/, "");
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "http://localhost:3000";
  }
}

export function buildOpenApiSpec(serverUrl: string): Record<string, unknown> {
  const srcRoot = new URL(".", import.meta.url).pathname;
  const { groups } = buildRuntimeRouteCatalog(srcRoot);

  const paths: Record<string, Record<string, unknown>> = {};
  const tagsSeen = new Set<string>();

  for (const group of groups) {
    for (const route of group.routes) {
      const template = toTemplate(route.path);
      const meta = metaFor(route.path);
      tagsSeen.add(meta.tag);
      let item = paths[template];
      if (!item) {
        item = {};
        paths[template] = item;
      }
      const methods = route.method === "ALL" ? ["get", "post", "put", "delete", "patch"] : [route.method.toLowerCase()];
      for (const method of methods) {
        if (item[method]) continue; // first registration wins, like Hono
        item[method] = {
          tags: [meta.tag],
          summary: meta.summary,
          operationId: `${method}_${template}`.replace(/[^A-Za-z0-9_]+/g, "_"),
          ...(pathItemParams(template).length > 0
            ? { parameters: pathItemParams(template) }
            : {}),
          ...(method === "get" || method === "delete" || method === "head"
            ? {}
            : {
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: { type: "object" } } },
                },
              }),
          responses: {
            "200": HEALTH_RESPONSE_OVERRIDES[template]?.["200"] ?? {
              description: "Success",
              content: { "application/json": { schema: { type: "object" } } },
            },
            ...(HEALTH_RESPONSE_OVERRIDES[template]?.["503"] ?? {}),
            default: JSON_ERROR_RESPONSE,
          },
          ...(securityFor(meta.auth) ? { security: securityFor(meta.auth) } : {}),
          ...(group.condition
            ? { "x-enabled-when": group.condition }
            : {}),
        };
      }
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Aiperator Trust Fabric Runtime",
      version,
      description:
        "The ATF Runtime is the OpenAI-compatible inference and orchestration plane: " +
        "chat/responses, assistants, flows, jobs, RAG, memory, optimizer, monitoring, " +
        "admin and security APIs. The path inventory in this document is generated from " +
        "the real router tree at request time; conditional groups carry an " +
        "`x-enabled-when` extension. Endpoints are only mounted when their configuration " +
        "condition holds.",
    },
    servers: [{ url: serverUrl }],
    tags: [...tagsSeen].sort().map((t) => ({ name: t })),
    paths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas: {
        DependencyCheck: DEPENDENCY_CHECK_SCHEMA,
        ReadinessResponse: {
          type: "object",
          description:
            "Readiness probe body (routes/health.ts). A check is present only when the dependency is configured.",
          properties: {
            status: { type: "string", enum: ["ready", "not_ready"] },
            checks: {
              type: "object",
              properties: {
                database: { $ref: "#/components/schemas/DependencyCheck" },
                redis: { $ref: "#/components/schemas/DependencyCheck" },
                flows: { $ref: "#/components/schemas/DependencyCheck" },
                audit: { $ref: "#/components/schemas/DependencyCheck" },
                flow_load: {
                  allOf: [
                    { $ref: "#/components/schemas/DependencyCheck" },
                    {
                      type: "object",
                      description:
                        "Only the number of flow files that fail to load; file names and reasons are not part of the unauthenticated probe.",
                      properties: { flow_load_failures: { type: "integer", minimum: 0 } },
                    },
                  ],
                },
                policy_stale: { $ref: "#/components/schemas/DependencyCheck" },
              },
            },
            auth: { type: "string", enum: ["disabled"] },
          },
          required: ["status", "checks"],
        },
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                message: { type: "string" },
                type: { type: "string" },
                code: { type: "string" },
              },
              required: ["message"],
            },
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

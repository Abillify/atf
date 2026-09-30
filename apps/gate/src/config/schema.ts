// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { z } from "zod";

/**
 * Configuration schemas for mcpgate.
 *
 * Everything the server does is driven by these structures, loaded from
 * YAML/JSON files in a configuration directory (see ./loader.ts).
 */

/**
 * Boolean that also accepts the string forms produced by ${ENV} interpolation
 * (e.g. "false", "0", "off"). Unlike z.coerce.boolean(), "false" -> false.
 */
const boolish = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off", ""].includes(s)) return false;
  }
  return v;
}, z.boolean());

/**
 * Optional URL that also tolerates an empty string as "unset". Needed because
 * `${VAR:-}` interpolation (see config/loader.ts) leaves an unset env var as
 * `""`, not `undefined` — an empty string would otherwise fail `z.string().url()`
 * even though the field is meant to be optional.
 */
const optionalUrl = z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export const ServerConfigSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(3000),
  name: z.string().default("mcpgate"),
  version: z.string().default("0.12.0"),
  ssePath: z.string().default("/sse"),
  messagePath: z.string().default("/messages"),
  mcpPath: z.string().default("/mcp"),
  /** Native stateless MCP 2026-07-28 HTTP endpoint (kept separate from mcpPath). */
  mcp2026: z
    .object({
      enabled: boolish.default(true),
      path: z.string().default("/mcp/v2026"),
    })
    .default({ enabled: true, path: "/mcp/v2026" }),
  /**
   * Externally-visible base URL of this server (scheme + host, no trailing
   * slash), e.g. "https://mcpgate.example.com". Required to advertise MCP
   * Authorization ("RFC 9728") protected-resource metadata at
   * `/.well-known/oauth-protected-resource` and the `resource_metadata` link
   * in `WWW-Authenticate` on 401s, since `host`/`port` alone (e.g. "0.0.0.0")
   * are not a usable public identifier. Only meaningful when `auth.mode` is
   * `oauth` or `both`; ignored otherwise.
   */
  publicUrl: optionalUrl,
  /**
   * DNS-rebinding protection: list of hostnames (without port) that are allowed
   * in the incoming Host header. Requests with a different hostname are rejected
   * with 403. Typical values: ["localhost", "myserver.internal"].
   * Leave empty (default) to skip the check.
   */
  allowedHosts: z.array(z.string()).default([]),
  /** CORS configuration for the MCP and monitoring endpoints. */
  cors: z
    .object({
      enabled: boolish.default(false),
      /** Origins allowed in CORS pre-flight. "*" allows any origin. */
      origins: z.array(z.string()).default([]),
    })
    .default({ enabled: false, origins: [] }),
  /**
   * Rate-limiting on all MCP and authentication endpoints.
   * Uses a sliding-window counter keyed on the client IP.
   */
  rateLimit: z
    .object({
      enabled: boolish.default(true),
      /** Duration of the window in milliseconds (default: 60 s). */
      windowMs: z.coerce.number().int().positive().default(60_000),
      /** Maximum requests per IP per window (default: 200). */
      max: z.coerce.number().int().positive().default(200),
      /**
       * Backing store for the counter. `memory` (default) is per-instance and
       * fine for a single process; `redis` shares the counter across instances
       * for correct limiting behind a load balancer (requires the optional
       * `redis` + `rate-limit-redis` packages to be installed).
       */
      store: z
        .object({
          type: z.enum(["memory", "redis"]).default("memory"),
          /** Redis connection URL, e.g. redis://localhost:6379. */
          redisUrl: z.string().optional(),
          /** Key prefix for rate-limit entries in the shared store. */
          prefix: z.string().default("mcpgate:rl:"),
        })
        .default({ type: "memory", prefix: "mcpgate:rl:" }),
      /**
       * Additional rate limit keyed on the caller's identity (auth subject)
       * rather than IP, applied to MCP tool calls after authentication. Useful
       * for multi-tenant deployments where many callers share one egress IP
       * (or one caller uses many IPs). Independent of the IP-based limit above
       * - both apply when enabled. Backed by an in-process TTL counter by
       * default; set `store.type: redis` to share it across instances
       * (reuses the same optional `redis` + `rate-limit-redis` packages).
       */
      perIdentity: z
        .object({
          enabled: boolish.default(false),
          windowMs: z.coerce.number().int().positive().default(60_000),
          max: z.coerce.number().int().positive().default(120),
          store: z
            .object({
              type: z.enum(["memory", "redis"]).default("memory"),
              redisUrl: z.string().optional(),
              prefix: z.string().default("mcpgate:rl:identity:"),
            })
            .default({ type: "memory", prefix: "mcpgate:rl:identity:" }),
        })
        .default({
          enabled: false,
          windowMs: 60_000,
          max: 120,
          store: { type: "memory", prefix: "mcpgate:rl:identity:" },
        }),
    })
    .default({
      enabled: true,
      windowMs: 60_000,
      max: 200,
      store: { type: "memory", prefix: "mcpgate:rl:" },
      perIdentity: {
        enabled: false,
        windowMs: 60_000,
        max: 120,
        store: { type: "memory", prefix: "mcpgate:rl:identity:" },
      },
    }),
  /**
   * Restrict the hosts that `http` and `mcp` tools may call outbound. When
   * non-empty, any tool request whose target hostname is not listed is refused
   * before a connection is opened (SSRF guard). Empty (default) allows any host.
   */
  outbound: z
    .object({
      allowedHosts: z.array(z.string()).default([]),
    })
    .default({ allowedHosts: [] }),
  /**
   * Prometheus metrics endpoint (text exposition aggregated from monitor events).
   *
   * The exposition is not neutral data: it carries tool names, per-tool call
   * and error counts and latency buckets, i.e. a usage profile of the
   * deployment. It is therefore gated behind a bearer token by default rather
   * than served openly.
   *
   * `token` accepts the scrape credential. When it is unset the endpoint is
   * only reachable from a loopback address (typical sidecar/`localhost` scrape)
   * — a remote scrape without a token gets 401. Setting
   * `allowUnauthenticated: true` restores the old wide-open behaviour and is
   * rejected by the production readiness gate.
   */
  metrics: z
    .object({
      enabled: boolish.default(true),
      path: z.string().default("/metrics"),
      /** Bearer token required to scrape. Unset → loopback-only access. */
      token: z.string().optional(),
      /** Escape hatch: serve metrics to anyone. Fatal in production. */
      allowUnauthenticated: boolish.default(false),
    })
    .default({ enabled: true, path: "/metrics", allowUnauthenticated: false }),
  /**
   * Bounds on concurrently held MCP sessions (Streamable HTTP and SSE).
   *
   * Sessions live in the process that served `initialize`, so they are
   * inherently instance-local: horizontal scaling requires sticky routing on
   * `Mcp-Session-Id`. Without the bounds below an abandoned client (one that
   * never sends `DELETE` and whose socket never errors) would leave its session
   * — and its Server instance and captured AuthContext — resident forever, so a
   * loop of `initialize` calls is an unauthenticated-shaped memory exhaustion.
   */
  sessions: z
    .object({
      /**
       * Evict a session after this long without any request on it.
       * 0 disables the idle sweep. Default: 30 min.
       */
      idleTimeoutMs: z.coerce.number().int().nonnegative().default(1_800_000),
      /**
       * Hard cap on concurrent sessions per transport per instance. When the
       * cap is reached a new `initialize` is refused with 503 rather than
       * silently evicting somebody else's live session. 0 disables the cap.
       */
      max: z.coerce.number().int().nonnegative().default(2_000),
      /** How often the idle sweep runs. Default: 60 s. */
      sweepIntervalMs: z.coerce.number().int().positive().default(60_000),
    })
    .default({ idleTimeoutMs: 1_800_000, max: 2_000, sweepIntervalMs: 60_000 }),
  /**
   * Hot-reload of tool definitions. When enabled, the config directory is
   * watched and the in-memory tool set is rebuilt on change without dropping
   * sessions. Only tools (and their queries/conditions) reload live; server,
   * auth, databases, router and MQTT changes still require a restart.
   */
  reload: z
    .object({
      enabled: boolish.default(false),
      debounceMs: z.coerce.number().int().nonnegative().default(300),
    })
    .default({ enabled: false, debounceMs: 300 }),
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export const StaticTokenSchema = z.object({
  token: z.string().min(1),
  subject: z.string().optional(),
  username: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  claims: z.record(z.unknown()).default({}),
});

export const StaticAuthSchema = z.object({
  tokens: z.array(StaticTokenSchema).default([]),
});

/**
 * An additional trusted OAuth/OIDC issuer. Each entry verifies against its own
 * JWKS with its own `iss`/`aud` expectations, so tokens minted by a *different*
 * IdP application (e.g. a second Authentik provider whose bearer is forwarded
 * by an upstream gateway) can be accepted alongside the primary issuer. The
 * claim-mapping settings (`usernameClaim`, `scopeClaim`, `groupClaim`, `groupScopes`,
 * `requiredScopes`) are shared from the parent `oauth` block and applied to whichever issuer
 * verifies.
 */
const OAuthVerificationTargetSchema = z
  .object({
    /** Explicit JWKS endpoint. Optional when OIDC discovery is configured. */
    jwksUri: optionalUrl,
    /** Optional OIDC discovery document; its issuer must exactly match `issuer`. */
    discoveryUrl: optionalUrl,
    issuer: z.string().optional(),
    audience: z.union([z.string(), z.array(z.string())]).optional(),
    algorithms: z.array(z.string()).default(["RS256"]),
    clockToleranceSec: z.coerce.number().int().nonnegative().default(5),
    allowAnyIssuer: boolish.default(false),
    allowAnyAudience: boolish.default(false),
  })
  .superRefine((target, ctx) => {
    if (!target.jwksUri && !target.discoveryUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either jwksUri or discoveryUrl is required",
        path: ["jwksUri"],
      });
    }
    if (target.discoveryUrl && !target.issuer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "issuer is required when discoveryUrl is configured",
        path: ["issuer"],
      });
    }
  });

export const AdditionalIssuerSchema = OAuthVerificationTargetSchema;

/**
 * Optional policy on the RFC 8693 `act` (actor) claim carried by a delegated
 * (on-behalf-of) token. The subject stays the end user; `act.sub` names the
 * service that acted for them (e.g. the aiperator runtime). Absent → the actor
 * is recorded for audit but never gates a request, so existing deployments are
 * unaffected.
 */
export const ActorPolicySchema = z.object({
  /** Claim carrying the actor. RFC 8693 uses `act`. */
  actorClaim: z.string().default("act"),
  /** Reject tokens that carry NO actor (i.e. only allow delegated calls). */
  requireActor: boolish.default(false),
  /**
   * When non-empty, the actor's subject must be one of these values; any other
   * actor is rejected. Empty → any actor subject is accepted (still audited).
   */
  allowedActorSubjects: z.array(z.string()).default([]),
});
export type ActorPolicy = z.infer<typeof ActorPolicySchema>;

export const OAuthAuthSchema = OAuthVerificationTargetSchema.and(
  z.object({
    usernameClaim: z.string().default("preferred_username"),
    scopeClaim: z.string().default("scope"),
    groupClaim: z.string().default("groups"),
    groupScopes: z.record(z.array(z.string())).default({}),
    requiredScopes: z.array(z.string()).default([]),
    additionalIssuers: z.array(AdditionalIssuerSchema).default([]),
    resource: z.string().url().optional(),
    /** Optional actor (RFC 8693 `act`) policy. Absent → actor audited, never gated. */
    actorPolicy: ActorPolicySchema.optional(),
  }),
);

export const AuthConfigSchema = z
  .object({
    mode: z.enum(["disabled", "static", "oauth", "both"]).default("static"),
    static: StaticAuthSchema.optional(),
    oauth: OAuthAuthSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    if ((cfg.mode === "static" || cfg.mode === "both") && !cfg.static) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `auth.mode '${cfg.mode}' requires an auth.static section`,
        path: ["static"],
      });
    }
    if ((cfg.mode === "oauth" || cfg.mode === "both") && !cfg.oauth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `auth.mode '${cfg.mode}' requires an auth.oauth section`,
        path: ["oauth"],
      });
    }

    if (cfg.oauth) {
      const targets = [
        { label: "auth.oauth", path: ["oauth"] as (string | number)[], target: cfg.oauth },
        ...cfg.oauth.additionalIssuers.map((target, i) => ({
          label: `auth.oauth.additionalIssuers[${i}]`,
          path: ["oauth", "additionalIssuers", i] as (string | number)[],
          target,
        })),
      ];
      for (const { label, path, target } of targets) {
        if (!target.issuer) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label}.issuer is required so the expected token issuer is pinned`,
            path: [...path, "issuer"],
          });
        }
        const audiences = Array.isArray(target.audience)
          ? target.audience
          : target.audience
            ? [target.audience]
            : [];
        if (!audiences.some(Boolean)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label}.audience is required to prevent audience confusion`,
            path: [...path, "audience"],
          });
        }
      }
    }
  });

export const AuthorizationConfigSchema = z
  .object({ enabled: boolish.default(true) })
  .default({ enabled: true });

export const TenantIsolationConfigSchema = z
  .object({
    enabled: boolish.default(false),
    defaultTenantId: z.string().trim().min(1).default("default"),
    /** Ordered verified JWT/static claim names accepted as tenant authority. */
    claimNames: z.array(z.string().trim().min(1)).min(1).default(["tenant_id", "tenant", "tid", "client_id"]),
    /** Databases whose connection is physically dedicated to one tenant. */
    isolatedDatabases: z.array(z.string().trim().min(1)).default([]),
    /** Semantic SQL tenant-binding diagnostics: report findings or fail readiness. */
    sqlValidationMode: z.enum(["report", "strict"]).default("report"),
  })
  .default({
    enabled: false,
    defaultTenantId: "default",
    claimNames: ["tenant_id", "tenant", "tid", "client_id"],
    isolatedDatabases: [],
  });

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

export const DatabaseConfigSchema = z.object({
  client: z.string().min(1),
  connection: z.union([z.string(), z.record(z.unknown())]),
  pool: z
    .object({
      min: z.coerce.number().int().nonnegative().default(0),
      max: z.coerce.number().int().positive().default(10),
    })
    .optional(),
  searchPath: z.union([z.string(), z.array(z.string())]).optional(),
  /**
   * Server-side statement timeout in milliseconds, applied per pooled
   * connection when it is acquired.
   *
   * Without this a single pathological query (a missing index, a cartesian
   * join in a hand-written tool query, a lock wait) holds a pool slot until the
   * client goes away — and because tool calls arrive over long-lived MCP
   * sessions, "the client goes away" can be never. The cap turns that from an
   * availability incident into one failed tool call.
   *
   * Enforcement is dialect-specific and applied for `pg`/`mysql`/`mysql2`/
   * `mssql`. Dialects without an equivalent knob (e.g. sqlite3) ignore it.
   * 0 disables the timeout. Default: 30 s.
   */
  statementTimeoutMs: z.coerce.number().int().nonnegative().default(30_000),
});

// ---------------------------------------------------------------------------
// Tools — common
// ---------------------------------------------------------------------------

export const InputSchemaSchema = z
  .object({
    type: z.literal("object").default("object"),
    properties: z.record(z.unknown()).default({}),
    required: z.array(z.string()).default([]),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

/**
 * MCP tool annotation hints advertised to clients (see the MCP spec's
 * `ToolAnnotations`). Every field is an advisory hint, never an authorization
 * boundary. When omitted, mcpgate derives sensible defaults from the tool's
 * `access` field (see registry.ts): `access: read` -> readOnlyHint: true,
 * `access: write` -> readOnlyHint: false, destructiveHint: true.
 */
export const AnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

/**
 * JSON Schema describing the shape of a tool's `structuredContent`. Reuses the
 * same permissive shape as `inputSchema` (any object-typed JSON Schema).
 */
export const OutputSchemaSchema = z
  .object({
    type: z.literal("object").default("object"),
    properties: z.record(z.unknown()).default({}),
    required: z.array(z.string()).default([]),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

export const ConditionRuleSchema = z.object({
  context: z.string().min(1),
  in: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  exists: z.boolean().optional(),
  /** Match at least one requested string in an array-valued context path. */
  containsAny: z.array(z.string()).min(1).optional(),
  /** Match every requested string in an array-valued context path. */
  containsAll: z.array(z.string()).min(1).optional(),
});

export const ConditionSchema = z
  .object({
    any: z.array(ConditionRuleSchema).optional(),
    all: z.array(ConditionRuleSchema).optional(),
  })
  .refine((c) => c.any !== undefined || c.all !== undefined, {
    message: "condition needs at least one of 'any' or 'all'",
  });

/**
 * Per-tool result cache. Caches successful tool results so repeated identical
 * calls skip the database/HTTP/downstream round-trip. Only meaningful for
 * read-ish tools; the cache key includes the caller identity unless `scope` is
 * `global`, so identity-aware results are never served across users.
 */
export const CacheConfigSchema = z.object({
  enabled: boolish.default(false),
  ttlSeconds: z.coerce.number().positive().default(30),
  scope: z.enum(["identity", "global"]).default("identity"),
  maxEntries: z.coerce.number().int().positive().default(1000),
});

// ---------------------------------------------------------------------------
// Tool: database
// ---------------------------------------------------------------------------

/**
 * A single field-level redaction rule applied to database tool results after
 * the query runs. Rules are evaluated in order; the first matching rule for a
 * given column wins. Redaction never touches the SQL/bindings - it is a
 * pure post-processing step over the JSON rows already fetched.
 */
export const RedactRuleSchema = z.object({
  /** Row field (JSON key) this rule applies to. */
  column: z.string().min(1),
  /**
   * Name of a condition (see `conditions`) that must be true for this rule to
   * apply. Omit to apply the rule unconditionally to every caller.
   */
  when: z.string().optional(),
  /**
   * mask   — replace with a fixed placeholder (default "***")
   * hash   — replace with a short SHA-256 hex digest of the original value
   * omit   — remove the key from the row entirely
   */
  strategy: z.enum(["mask", "hash", "omit"]).default("mask"),
  /** Placeholder used by the `mask` strategy (default: "***"). */
  placeholder: z.string().default("***"),
});

export const DatabaseToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("database"),
  database: z.string().min(1),
  query: z.string().min(1).optional(),
  queryFile: z.string().min(1).optional(),
  conditions: z.record(ConditionSchema).default({}),
  rowLimit: z.coerce.number().int().positive().default(1000),
  /**
   * Field-level redaction applied to each returned row after the query runs.
   * Rules are matched by `column`; a rule with no `when` applies to every
   * caller, otherwise only when the named condition evaluates to true for the
   * current AuthContext. Runs identically whether autoLimit/pagination is used.
   */
  redact: z.array(RedactRuleSchema).default([]),
  /**
   * Opt-in cursor-based pagination. When enabled, the tool advertises a
   * `cursor` input parameter (an opaque offset token) and returns
   * `meta.nextCursor` when more rows remain, instead of only truncating at
   * `rowLimit`. Disabled by default to keep existing tool behaviour unchanged.
   */
  pagination: z
    .object({
      enabled: boolish.default(false),
      /** Default page size when the caller does not supply `pageSize`. */
      pageSize: z.coerce.number().int().positive().default(100),
      /** Upper bound for a caller-supplied `pageSize`. */
      maxPageSize: z.coerce.number().int().positive().default(1000),
    })
    .refine((pagination) => pagination.pageSize <= pagination.maxPageSize, {
      message: "pagination.pageSize must not exceed pagination.maxPageSize",
      path: ["pageSize"],
    })
    .default({ enabled: false, pageSize: 100, maxPageSize: 1000 }),
  /**
   * When true (default), the query is wrapped in a subquery with LIMIT
   * rowLimit+1 so the database returns at most rowLimit+1 rows instead of
   * fetching the entire result set into memory.  Disable only if your SQL
   * already contains its own LIMIT or if the wrapping causes issues with a
   * specific dialect / CTE.
   */
  autoLimit: boolish.default(true),
  cache: CacheConfigSchema.optional(),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tool: http
// ---------------------------------------------------------------------------

export const HttpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("http"),
  request: z
    .object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      /** URL with optional :param.* / :ctx.* tokens (URL-encoded on substitution). */
      url: z.string().min(1),
      /**
       * Headers map. Values may contain :param.* / :ctx.* tokens (raw string
       * substitution — no encoding). Environment variables (${VAR}) are
       * interpolated at config load time; identity tokens at request time.
       */
      headers: z.record(z.string()).default({}),
      /**
       * Optional request body. May be any JSON-serialisable value; nested
       * string values containing :param.* / :ctx.* tokens are substituted.
       * A whole-value token (e.g. ":param.id") preserves the original type.
       * Content-Type defaults to application/json when a body is present.
       */
      body: z.unknown().optional(),
      timeoutMs: z.coerce.number().int().positive().default(30_000),
    })
    .passthrough(),
  /**
   * Optional post-processing pipeline applied to the parsed response body
   * before returning it to the MCP client.  Supported step types:
   *   { type: "jsonPath", expression: "$.data" }   — extract by JSONPath
   *   { type: "field",    path: "result.items" }    — dot-notation field pick
   */
  pipeline: z.array(z.record(z.unknown())).default([]),
  cache: CacheConfigSchema.optional(),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
  /**
   * Maximum size (bytes) of the response body read from the backend before
   * the request is aborted with an error. Guards against unbounded memory
   * use from a large or misbehaving downstream response. Default: 10 MiB.
   */
  maxResponseBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
});

// ---------------------------------------------------------------------------
// Tool: taigaApi — user-bound OIDC-to-Taiga exchange plus constrained writes
// ---------------------------------------------------------------------------

export const TaigaApiToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.literal("write").default("write"),
  type: z.literal("taigaApi"),
  operation: z.enum(["task_create", "task_update", "story_points_update"]),
  apiBaseUrl: z.string().url(),
  timeoutMs: z.coerce.number().int().positive().default(30_000),
  tokenCacheTtlMs: z.coerce.number().int().positive().max(900_000).default(300_000),
  /** Permit only this tool's exact configured API hostname to resolve privately (split DNS). */
  allowPrivateAddress: boolish.default(false),
  maxResponseBytes: z.coerce.number().int().positive().default(1024 * 1024),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tool: inline (built-in server-side handlers)
// ---------------------------------------------------------------------------

export const InlineToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("inline"),
  handler: z.string().min(1),
  options: z.record(z.unknown()).default({}),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tool: webhook — receives incoming HTTP POST calls; returns the last payload
// ---------------------------------------------------------------------------

export const WebhookAuthSchema = z.object({
  /**
   * none   — accept any POST to the webhook path.
   * bearer — require Authorization: Bearer <token> matching `token`.
   * hmac   — verify a signature header (HMAC-SHA256 by default) against `secret`.
   */
  type: z.enum(["none", "bearer", "hmac"]).default("none"),
  /** Required for type: bearer. */
  token: z.string().optional(),
  /** Required for type: hmac — the shared secret used to sign payloads. */
  secret: z.string().optional(),
  /** Header carrying the HMAC signature (default: x-webhook-signature). */
  header: z.string().default("x-webhook-signature"),
  /** HMAC algorithm (default: sha256). */
  algorithm: z.string().default("sha256"),
});

export const WebhookReplayProtectionSchema = z
  .object({
    /** Unix-seconds timestamp header; mandatory for HMAC webhooks. */
    timestampHeader: z.string().min(1).default("x-webhook-timestamp"),
    /** Unique per-delivery nonce header; mandatory for HMAC webhooks. */
    nonceHeader: z.string().min(1).default("x-webhook-nonce"),
    /** Maximum accepted delivery age, excluding clock skew. */
    maxAgeSeconds: z.coerce.number().int().positive().default(300),
    /** Allowed future/past clock skew. */
    clockSkewSeconds: z.coerce.number().int().nonnegative().default(30),
    /** TTL for consumed nonces in the atomic replay store. */
    cacheTtlSeconds: z.coerce.number().int().positive().default(330),
  })
  .superRefine((value, ctx) => {
    if (value.cacheTtlSeconds < value.maxAgeSeconds + value.clockSkewSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cacheTtlSeconds"],
        message: "cacheTtlSeconds must cover maxAgeSeconds plus clockSkewSeconds",
      });
    }
  });

export const WebhookToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("webhook"),
  /** Express path where the webhook receiver is registered. */
  path: z.string().min(1),
  /** Trusted, operator-configured tenant for both inbound storage and reads. */
  tenantId: z.string().min(1),
  authentication: WebhookAuthSchema.default({ type: "none", header: "x-webhook-signature", algorithm: "sha256" }),
  /** Mandatory timestamp/nonce protocol settings for every HMAC webhook. */
  replayProtection: WebhookReplayProtectionSchema.default({
    timestampHeader: "x-webhook-timestamp", nonceHeader: "x-webhook-nonce", maxAgeSeconds: 300,
    clockSkewSeconds: 30, cacheTtlSeconds: 330,
  }),
  /** Payload freshness bound. Required by the production gate. */
  ttlSeconds: z.coerce.number().positive().optional(),
  defaultValue: z.unknown().optional(),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tool: mcp — proxy calls to a downstream MCP server
// ---------------------------------------------------------------------------

export const McpServerConnectionSchema = z.object({
  /** Full URL of the downstream MCP server (Streamable HTTP endpoint). */
  url: z.string().url(),
  /** Bearer token sent to the downstream server. */
  token: z.string().optional(),
  /**
   * When true, the caller's own bearer token is forwarded to the downstream
   * server instead of the configured `token`.
   */
  forwardBearerToken: boolish.default(false),
  timeoutMs: z.coerce.number().int().positive().default(30_000),
});

export const McpProxyToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("mcp"),
  server: McpServerConnectionSchema,
  /** Name of the tool to call on the downstream server. */
  targetTool: z.string().min(1),
  /**
   * Parameter values fixed by the gateway operator. Merged into every call to
   * the downstream tool (overriding any caller-supplied value of the same
   * name) and not part of the advertised `inputSchema` — callers cannot see
   * or change them.
   */
  fixedParams: z.record(z.unknown()).default({}),
  cache: CacheConfigSchema.optional(),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
  /**
   * Maximum size (bytes) of the downstream tool's text content before the
   * call is treated as failed. Guards against unbounded memory use. Default: 10 MiB.
   */
  maxResponseBytes: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /**
   * Hard cap for the complete JSON-serialized downstream result, including
   * structured and non-text content. 0 keeps this additive guard disabled.
   */
  hardPayloadLimitBytes: z.coerce.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------------------------
// MQTT — shared broker config + topic mapping
// ---------------------------------------------------------------------------

export const MqttBrokerSchema = z.object({
  /**
   * Broker connection URL.  Supported schemes:
   *   mqtt://    plain MQTT over TCP
   *   mqtts://   MQTT over TLS
   *   ws://      MQTT over WebSocket
   *   wss://     MQTT over secure WebSocket
   */
  url: z.string().min(1),
  /** MQTT client identifier (default: "mcpgate-<hostname>"). */
  clientId: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  clean: boolish.default(true),
  keepalive: z.coerce.number().int().positive().default(60),
  reconnectPeriod: z.coerce.number().int().nonnegative().default(5_000),
  connectTimeout: z.coerce.number().int().positive().default(30_000),
  /** MQTT protocol version: 4 = 3.1.1 (default), 5 = 5.0 */
  protocolVersion: z.coerce.number().int().optional(),
  /**
   * Upper bound on the number of distinct topics cached per broker connection.
   * Protects memory when subscribing to high-cardinality wildcards (e.g. `#`):
   * once exceeded, the least-recently-updated topic is evicted (LRU).
   */
  maxCachedTopics: z.coerce.number().int().positive().default(10_000),
  /**
   * Optional cache-level TTL (seconds). Cached messages older than this are
   * dropped during periodic sweeps to bound memory for rarely-updated topics.
   * This is independent of a tool's own `ttlSeconds` freshness check.
   */
  cacheTtlSeconds: z.coerce.number().positive().optional(),
});

/**
 * A single MQTT topic → output key mapping for multi-topic tools.
 */
export const MqttTopicMappingSchema = z.object({
  /** Key in the returned JSON object. */
  path: z.string().min(1),
  /** MQTT topic to subscribe to (wildcards + / # supported). */
  topic: z.string().min(1),
  /**
   * How the raw payload bytes are converted before returning:
   *   auto   — try JSON parse; fall back to utf-8 string (default)
   *   json   — always JSON.parse; error if invalid
   *   string — always return as utf-8 string
   *   number — parseFloat
   *   boolean — "true"/"1"/"yes"/"on" → true, everything else → false
   */
  transform: z.enum(["auto", "json", "string", "number", "boolean"]).default("auto"),
  /** Value returned when no message has been received on this topic yet. */
  defaultValue: z.unknown().optional(),
});

export const MqttToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("mqtt"),
  /**
   * Per-tool broker override.  When omitted the global `mqtt` broker
   * from the top-level config is used.
   */
  broker: MqttBrokerSchema.optional(),
  /**
   * Multi-topic mode — returns a JSON object with one key per mapping.
   * Use when you need several values in a single tool call.
   */
  topics: z.array(MqttTopicMappingSchema).optional(),
  /**
   * Single-topic mode — returns the raw (transformed) value directly.
   * Mutually exclusive with `topics`.  Exactly one of `topic` / `topics`
   * must be set; this is enforced at config load time (see loader.ts).
   */
  topic: z.string().optional(),
  /** Transform applied in single-topic mode. */
  transform: z.enum(["auto", "json", "string", "number", "boolean"]).default("auto"),
  /**
   * How long (seconds) a cached value is considered fresh.
   * Omit for no expiry.
   */
  ttlSeconds: z.coerce.number().positive().optional(),
  /** Default value when no message has been received yet (or TTL expired). */
  defaultValue: z.unknown().optional(),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tool: composite — chain existing tools into a workflow
// ---------------------------------------------------------------------------

export const CompositeStepSchema = z.object({
  /** Identifier used to reference this step's output as `:steps.<id>.*`. */
  id: z.string().min(1),
  /** Name of the tool to run (may be `expose: false`). */
  tool: z.string().min(1),
  /**
   * Argument template for the step. String values may contain tokens:
   *   :param.<path>      the composite tool's own call arguments
   *   :ctx.<path>        the caller's auth context
   *   :steps.<id>.<path> a previous step's (JSON-parsed) output
   * A whole-string token preserves the resolved value's type.
   */
  arguments: z.record(z.unknown()).default({}),
  /**
   * Optional gate: a token (`:param.*` / `:ctx.*` / `:steps.<id>.*`) that must
   * resolve to a truthy value for the step to run. When falsy, the step is
   * skipped (its `:steps.<id>.*` output is `null`) and execution continues
   * with the next step.
   */
  condition: z.string().optional(),
  /**
   * Steps sharing the same non-empty `parallelGroup` value run concurrently
   * (via `Promise.all`) once every step that precedes the group (in
   * declaration order) has completed. Steps without a group run strictly
   * sequentially, in declaration order, exactly as before.
   */
  parallelGroup: z.string().optional(),
  /** Per-step timeout in milliseconds. Omit to run with no explicit timeout. */
  timeoutMs: z.coerce.number().int().positive().optional(),
  /** Number of additional attempts after a failing call (0 = no retry). */
  retries: z.coerce.number().int().nonnegative().default(0),
  /** Delay between retry attempts, in milliseconds. */
  retryDelayMs: z.coerce.number().int().nonnegative().default(200),
});

export const CompositeToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  enabled: boolish.default(true),
  expose: boolish.default(true),
  access: z.enum(["read", "write"]).default("read"),
  type: z.literal("composite"),
  steps: z.array(CompositeStepSchema).min(1),
  /**
   * What the composite returns. A token (e.g. `:steps.final` or
   * `:steps.final.rows`) resolved against the step outputs. Omit to return the
   * last step's raw result.
   */
  output: z.string().optional(),
  cache: CacheConfigSchema.optional(),
  inputSchema: InputSchemaSchema.default({ type: "object", properties: {}, required: [] }),
  outputSchema: OutputSchemaSchema.optional(),
  annotations: AnnotationsSchema.optional(),
  requiredScopes: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tool union
// ---------------------------------------------------------------------------

export const ToolConfigSchema = z.discriminatedUnion("type", [
  DatabaseToolSchema,
  HttpToolSchema,
  TaigaApiToolSchema,
  InlineToolSchema,
  WebhookToolSchema,
  McpProxyToolSchema,
  MqttToolSchema,
  CompositeToolSchema,
]);

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

/**
 * Redaction applied to every monitor event before it reaches ANY consumer
 * (dashboard ring buffer, SSE subscribers, audit file, Redis cluster bridge).
 *
 * `extraKeys` is the important knob for a real deployment: the defaults cover
 * credential-shaped and generic finance/identifier-shaped key names, but only
 * the operator knows that their `schuldner_name` column is personal data.
 */
export const MonitorRedactSchema = z.object({
  enabled: boolish.default(true),
  /**
   * Additional lower-cased key fragments to redact, merged with the built-in
   * denylist. Matching is "key contains fragment".
   */
  extraKeys: z.array(z.string()).default([]),
  /** Replace the built-in denylist entirely instead of extending it. */
  keys: z.array(z.string()).optional(),
  maxStringLength: z.coerce.number().int().nonnegative().default(2048),
  maxArrayLength: z.coerce.number().int().nonnegative().default(100),
  maxDepth: z.coerce.number().int().positive().default(8),
  /** Token claims kept verbatim; all others are dropped and counted. */
  claimAllowlist: z.array(z.string()).optional(),
});

export type MonitorRedactConfig = z.infer<typeof MonitorRedactSchema>;

export const MonitoringConfigSchema = z.object({
  enabled: boolish.default(true),
  token: z.string().optional(),
  /** See {@link MonitorRedactSchema}. */
  redact: MonitorRedactSchema.default({
    enabled: true,
    extraKeys: [],
    maxStringLength: 2048,
    maxArrayLength: 100,
    maxDepth: 8,
  }),
  /**
   * Alternative/additional login for human operators: OAuth2/OIDC against an
   * external provider (e.g. Authentik). When set, `GET /monitor/login` starts
   * the authorization-code flow and a signed session cookie is accepted
   * everywhere `monitoring.token` would be. Both can be configured together —
   * either one is sufficient to authorize a request.
   *
   * `config.yaml` substitutes unset `${VAR:-}` env vars with `""`, not
   * `undefined` — so the preprocess below treats an object whose required
   * fields are all blank as "not configured" rather than failing validation.
   */
  oidc: z.preprocess(
    (val) => {
      if (!val || typeof val !== "object") return val;
      const v = val as Record<string, unknown>;
      const required = ["issuer", "clientId", "clientSecret", "redirectUri", "sessionSecret"];
      if (required.every((k) => !v[k])) return undefined;
      return val;
    },
    z
      .object({
        issuer: z.string().url(),
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        /** Must exactly match the redirect URI registered with the provider. */
        redirectUri: z.string().url(),
        scopes: z.array(z.string()).default(["openid", "profile", "email"]),
        /** Secret used to HMAC-sign the session/state cookies. */
        sessionSecret: z.string().min(1),
        /** Session lifetime in seconds. */
        sessionMaxAge: z.coerce.number().int().positive().default(28_800),
      })
      .optional(),
  ),
  bufferSize: z.coerce.number().int().nonnegative().default(200),
  /**
   * Tool Playground (execute tools from the dashboard). Disabled by default
   * because it runs tools out-of-band from a normal MCP session. When enabled
   * it requires `monitoring.token` to be set, and write-access tools stay
   * blocked unless `allowWrite` is also enabled.
   */
  playground: z
    .object({
      enabled: boolish.default(false),
      allowWrite: boolish.default(false),
    })
    .default({ enabled: false, allowWrite: false }),
  /**
   * Persistent, append-only audit log. When enabled, every monitor event (or
   * the subset listed in `events`) is written as one JSON object per line to
   * `file`, giving a durable record beyond the in-memory ring buffer.
   */
  audit: z
    .object({
      enabled: boolish.default(false),
      /** Path to the JSONL audit file (required when enabled). */
      file: z.string().optional(),
      /** Optional whitelist of event types to record; omit to record all. */
      events: z.array(z.string()).optional(),
    })
    .default({ enabled: false }),
  /**
   * Optional multi-instance monitor bridge (see monitor/cluster-bridge.ts).
   * MCP sessions themselves still require sticky routing across instances -
   * this only makes the dashboard/SSE feed/audit log cluster-wide by sharing
   * MonitorBus events over Redis pub/sub. Entirely optional; a no-op unless
   * `redisUrl` is set (and the optional `redis` package is installed).
   */
  cluster: z
    .object({
      redisUrl: z.string().optional(),
      channel: z.string().default("mcpgate:monitor"),
    })
    .default({ channel: "mcpgate:monitor" }),
});

// ---------------------------------------------------------------------------
// Router (abstract LLM-driven tool)
// ---------------------------------------------------------------------------

export const LlmProviderSchema = z.enum(["openai", "bedrock"]);

export const LlmConfigSchema = z
  .object({
    provider: LlmProviderSchema.default("openai"),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().default(""),
    forwardBearerToken: boolish.default(false),
    region: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
    model: z.string().default("qwen/qwen3-4b-2507"),
    temperature: z.coerce.number().min(0).default(0),
    maxTokens: z.coerce.number().int().positive().optional(),
    timeoutMs: z.coerce.number().int().positive().default(60_000),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === "openai" && !cfg.baseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "llm.baseUrl is required when provider is 'openai'",
        path: ["baseUrl"],
      });
    }
    if (cfg.provider === "bedrock" && !cfg.region) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "llm.region is required when provider is 'bedrock'",
        path: ["region"],
      });
    }
  });

export const PromptSourceSchema = z
  .object({
    name: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    column: z.string().optional(),
    scopes: z.array(z.string().min(1)).default([]),
    intro: z.string().default(""),
    maxRows: z.coerce.number().int().positive().default(500),
  })
  .superRefine((s, ctx) => {
    if (s.tool) {
      if (s.query || s.database) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "prompt source with 'tool' must not also set 'query'/'database'",
          path: ["tool"],
        });
      }
    } else if (!s.query || !s.database) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt source needs either 'tool' or both 'query' and 'database'",
        path: ["query"],
      });
    }
    if (!s.name && !s.tool) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt source needs a 'name' (or a 'tool' to derive it from)",
        path: ["name"],
      });
    }
  });

export const SystemPromptConfigSchema = z.object({
  text: z.string().default(""),
  dynamic: z
    .object({
      enabled: boolish.default(false),
      refreshMinutes: z.coerce.number().positive().default(15),
      sources: z.array(PromptSourceSchema).default([]),
    })
    .default({ enabled: false, refreshMinutes: 15, sources: [] }),
});

export const RouterWriteConfigSchema = z.object({
  name: z.string().default("act"),
  description: z
    .string()
    .default(
      "Natural-language entry point for operations that change data (create, update, cancel, delete): describe what you want to do and the right underlying tool is selected and called automatically.",
    ),
  systemPrompt: SystemPromptConfigSchema.default({
    text: "",
    dynamic: { enabled: false, refreshMinutes: 15, sources: [] },
  }),
});

export const RouterConfigSchema = z
  .object({
    enabled: boolish.default(false),
    mode: z.enum(["augment", "replace"]).default("augment"),
    name: z.string().default("ask"),
    description: z
      .string()
      .default(
        "Natural-language entry point for read-only requests: describe what you want to look up and the right underlying tool is selected and called automatically.",
      ),
    llm: LlmConfigSchema.optional(),
    systemPrompt: SystemPromptConfigSchema.default({
      text: "",
      dynamic: { enabled: false, refreshMinutes: 15, sources: [] },
    }),
    write: RouterWriteConfigSchema.default({}),
    interpretResults: boolish.default(false),
    /**
     * Cache routing decisions (prompt → chosen tool + arguments) so repeated
     * identical prompts skip the LLM call. Keyed on the prompt and — unless
     * scope is `global` — the caller identity.
     */
    cache: CacheConfigSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.enabled && !r.llm) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Required", path: ["llm"] });
    }
  });

// ---------------------------------------------------------------------------
// OpenAPI import — generate `http` tools from an OpenAPI 3.x spec at load time
// ---------------------------------------------------------------------------

export const OpenApiImportSchema = z.object({
  /** Path to an OpenAPI 3.x document, relative to the config dir, OR an http(s) URL. */
  spec: z.string().min(1),
  /** Base URL for generated requests; overrides the spec's `servers[0].url`. */
  baseUrl: z.string().optional(),
  /** Prefix prepended to every generated tool name (e.g. "petstore_"). */
  prefix: z.string().default(""),
  /** When set, only operations with these operationIds are imported. */
  include: z.array(z.string()).optional(),
  /** Operations with these operationIds are skipped. */
  exclude: z.array(z.string()).optional(),
  /** Extra headers added to every generated tool (may use ${ENV} / :ctx.* tokens). */
  headers: z.record(z.string()).default({}),
  /** Headers used only when fetching a remote spec URL (e.g. auth for the spec). */
  specHeaders: z.record(z.string()).default({}),
  /** Force the access class of generated tools; default infers from HTTP method. */
  access: z.enum(["read", "write"]).optional(),
  /** Whether generated tools are advertised to MCP clients. */
  expose: boolish.optional(),
  /** Request timeout for generated tools. */
  timeoutMs: z.coerce.number().int().positive().default(30_000),
});

// ---------------------------------------------------------------------------
// MCP server import — generate `mcp` proxy tools from a downstream MCP
// server's tools/list at load time
// ---------------------------------------------------------------------------

/**
 * Per-tool override applied to a single imported tool, matched by its name on
 * the downstream server (before `prefix` is applied).
 */
export const McpToolOverrideSchema = z.object({
  /** Name of the tool as advertised by the downstream server. */
  name: z.string().min(1),
  /** Replace the downstream description; omit to keep it as-is. */
  description: z.string().optional(),
  /** Set to false to skip importing this tool (shorthand for `exclude`). */
  enabled: boolish.optional(),
  /** Override visibility for this tool only. */
  expose: boolish.optional(),
  /** Override the access class for this tool only. */
  access: z.enum(["read", "write"]).optional(),
  /** Remove these parameters from the advertised inputSchema. */
  removeOptions: z.array(z.string()).default([]),
  /**
   * Fix these parameters to a constant value. They are removed from the
   * advertised inputSchema (callers can no longer set them) and merged into
   * every call to the downstream tool.
   */
  replaceParams: z.record(z.unknown()).default({}),
});

export const McpServerImportSchema = z.object({
  /** Connection details for the downstream MCP server. */
  server: McpServerConnectionSchema,
  /** Prefix prepended to every imported tool name (e.g. "github_"). */
  prefix: z.string().default(""),
  /** When set, only downstream tools with these names are imported. */
  include: z.array(z.string()).optional(),
  /** Downstream tool names that are skipped. */
  exclude: z.array(z.string()).optional(),
  /** Default access class for imported tools (default: "read"). */
  access: z.enum(["read", "write"]).optional(),
  /** Default visibility for imported tools; per-tool `overrides[].expose` wins. */
  expose: boolish.optional(),
  /** Result cache applied to every imported tool. */
  cache: CacheConfigSchema.optional(),
  /** Per-tool filtering / description / parameter overrides, keyed by downstream tool name. */
  overrides: z.array(McpToolOverrideSchema).default([]),
});

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Optional OpenTelemetry tracing. Entirely opt-in: when `enabled` is false (or
 * the `@opentelemetry/*` packages are not installed), tracing is a complete
 * no-op with zero overhead. Spans are emitted for MCP tool calls, database
 * queries and outbound HTTP/MCP-proxy calls.
 */
export const TracingConfigSchema = z.object({
  enabled: boolish.default(false),
  serviceName: z.string().default("mcpgate"),
  /** OTLP/HTTP exporter endpoint, e.g. http://localhost:4318. */
  otlpEndpoint: optionalUrl,
});

const RequiredScopesSchema = z.array(z.string()).default([]);
const ApprovalFieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  value: z.string(),
});
const ApprovalPresentationSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  fields: z.array(ApprovalFieldSchema).optional(),
  lookup: z
    .object({
      tool: z.string().min(1),
      arguments: z.record(z.unknown()).default({}),
    })
    .optional(),
});
export const PolicyRuleSchema = z
  .object({
    effect: z.enum(["allow", "deny", "approval"]),
    match: z
      .object({
        tool: z.string().optional(),
        access: z.enum(["read", "write"]).optional(),
        requiredScopes: z.array(z.string()).optional(),
        subjects: z.array(z.string()).optional(),
        groups: z.array(z.string()).optional(),
        argumentEquals: z.record(z.unknown()).optional(),
      })
      .default({}),
    /**
     * Fail closed when this matching rule receives a call without a valid
     * Evidence-Bound Action Contract. This is enforced by mcpgate for every
     * client; it is not an Aiperator-side approval or UI policy.
     */
    requireEvidenceContract: boolish.default(false),
    approval: ApprovalPresentationSchema.optional(),
  })
  .superRefine((rule, ctx) => {
  if (rule.approval && rule.effect !== "approval")
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "approval presentation requires effect: approval", path: ["approval"] });
});
export const GovernanceConfigSchema = z
  .object({
    defaultEffect: z.enum(["allow", "deny", "approval"]).default("allow"),
    rules: z.array(PolicyRuleSchema).default([]),
    approval: z
      .object({
        secret: z.string().min(16).optional(),
        ttlMs: z.coerce.number().int().positive().default(300_000),
        maxPending: z.coerce.number().int().positive().default(1000),
      })
      .default({ ttlMs: 300_000, maxPending: 1000 }),
  })
  .default({ defaultEffect: "allow", rules: [], approval: { ttlMs: 300_000, maxPending: 1000 } });
const ResourceSchema = z.object({
  uri: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  mimeType: z.string().default("text/plain"),
  text: z.string(),
  requiredScopes: RequiredScopesSchema,
});
const PromptSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  arguments: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        required: boolish.default(false),
      }),
    )
    .default([]),
  message: z.string(),
  requiredScopes: RequiredScopesSchema,
});
const SkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  instructions: z.string(),
  requiredScopes: RequiredScopesSchema,
});
const AppMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  resourceUri: z.string().min(1),
  requiredScopes: RequiredScopesSchema,
});
const TasksConfigSchema = z
  .object({
    asyncTools: z.array(z.string()).default([]),
    ttlMs: z.coerce.number().int().positive().default(300_000),
    maxEntries: z.coerce.number().int().positive().default(1000),
  })
  .default({ asyncTools: [], ttlMs: 300_000, maxEntries: 1000 });

export const SchemaCompatibilityConfigSchema = z
  .object({
    mode: z.enum(["report", "strict"]).default("report"),
  })
  .default({ mode: "report" });

export const AppConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  schemaCompatibility: SchemaCompatibilityConfigSchema,
  authorization: AuthorizationConfigSchema,
  tenantIsolation: TenantIsolationConfigSchema,
  policies: GovernanceConfigSchema,
  resources: z.array(ResourceSchema).default([]),
  prompts: z.array(PromptSchema).default([]),
  skills: z.array(SkillSchema).default([]),
  apps: z.array(AppMetadataSchema).default([]),
  tasks: TasksConfigSchema,
  auth: AuthConfigSchema,
  databases: z.record(DatabaseConfigSchema).default({}),
  monitoring: MonitoringConfigSchema.default({}),
  router: RouterConfigSchema.optional(),
  instructions: SystemPromptConfigSchema.optional(),
  tracing: TracingConfigSchema.default({ enabled: false, serviceName: "mcpgate" }),
  /**
   * Global MQTT broker configuration.  Individual mqtt-type tools may
   * override this with a per-tool `broker` section, or reference it
   * implicitly by omitting their own broker config.
   */
  mqtt: MqttBrokerSchema.optional(),
  /**
   * OpenAPI specs to import. Each is expanded into `http` tools at load time
   * and appended to `tools` (see config/openapi.ts).
   */
  openapi: z.array(OpenApiImportSchema).optional(),
  /**
   * Remote MCP servers to import as a backend. Each is expanded into `mcp`
   * proxy tools at load time — one per tool discovered via the downstream
   * server's `tools/list` — and appended to `tools` (see config/mcp-import.ts).
   */
  mcpServers: z.array(McpServerImportSchema).optional(),
  tools: z.array(ToolConfigSchema).default([]),
});

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type StaticToken = z.infer<typeof StaticTokenSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type AuthorizationConfig = z.infer<typeof AuthorizationConfigSchema>;
export type TenantIsolationConfig = z.infer<typeof TenantIsolationConfigSchema>;
export type OAuthAuth = z.infer<typeof OAuthAuthSchema>;
export type AdditionalIssuer = z.infer<typeof AdditionalIssuerSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type ConditionRule = z.infer<typeof ConditionRuleSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type CacheConfig = z.infer<typeof CacheConfigSchema>;
export type Annotations = z.infer<typeof AnnotationsSchema>;
export type OutputSchema = z.infer<typeof OutputSchemaSchema>;
export type RedactRule = z.infer<typeof RedactRuleSchema>;
export type TracingConfig = z.infer<typeof TracingConfigSchema>;
export type DatabaseTool = z.infer<typeof DatabaseToolSchema>;
export type HttpTool = z.infer<typeof HttpToolSchema>;
export type TaigaApiTool = z.infer<typeof TaigaApiToolSchema>;
export type InlineTool = z.infer<typeof InlineToolSchema>;
export type WebhookAuth = z.infer<typeof WebhookAuthSchema>;
export type WebhookTool = z.infer<typeof WebhookToolSchema>;
export type McpServerConnection = z.infer<typeof McpServerConnectionSchema>;
export type McpProxyTool = z.infer<typeof McpProxyToolSchema>;
export type MqttBroker = z.infer<typeof MqttBrokerSchema>;
export type MqttTopicMapping = z.infer<typeof MqttTopicMappingSchema>;
export type MqttTool = z.infer<typeof MqttToolSchema>;
export type CompositeStep = z.infer<typeof CompositeStepSchema>;
export type CompositeTool = z.infer<typeof CompositeToolSchema>;
export type OpenApiImport = z.infer<typeof OpenApiImportSchema>;
export type McpToolOverride = z.infer<typeof McpToolOverrideSchema>;
export type McpServerImport = z.infer<typeof McpServerImportSchema>;
export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type MonitoringConfig = z.infer<typeof MonitoringConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type PromptSource = z.infer<typeof PromptSourceSchema>;
export type SystemPromptConfig = z.infer<typeof SystemPromptConfigSchema>;
export type RouterWriteConfig = z.infer<typeof RouterWriteConfigSchema>;
export type RouterConfig = z.infer<typeof RouterConfigSchema>;
export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AppConfigSchema,
  OpenApiImportSchema,
  McpServerImportSchema,
  type AppConfig,
  type OpenApiImport,
  type ToolConfig,
} from "./schema.ts";
import { expandOpenApiImports } from "./openapi.ts";
import { expandMcpServerImports } from "./mcp-import.ts";
import {
  hasTopLevelSqlKeywords,
  TOP_LEVEL_ROW_LIMIT_KEYWORDS,
} from "../db/sql-tokens.ts";

/**
 * Resolve the configuration directory.
 * Order: explicit arg -> MCPGATE_CONFIG_DIR env -> ./config
 */
export function resolveConfigDir(explicit?: string): string {
  return explicit ?? process.env.MCPGATE_CONFIG_DIR ?? join(process.cwd(), "config");
}

/** Recursively replace ${VAR} and ${VAR:-default} in every string value. */
function interpolateEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => {
      const env = process.env[name];
      if (env !== undefined && env !== "") return env;
      if (def !== undefined) return def;
      return "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnv(v);
    }
    return out as T;
  }
  return value;
}

function parseFile(path: string): unknown {
  const raw = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  if (ext === ".json") return JSON.parse(raw);
  if (ext === ".yaml" || ext === ".yml") return parseYaml(raw);
  throw new Error(`Unsupported config file type: ${path}`);
}

const CONFIG_EXTS = [".yaml", ".yml", ".json"];

function isConfigFile(name: string): boolean {
  return CONFIG_EXTS.includes(extname(name).toLowerCase());
}

/** Deep-merge plain objects (arrays and scalars are replaced, not merged). */
function deepMerge<T>(base: T, override: Partial<T>): T {
  if (
    base &&
    override &&
    typeof base === "object" &&
    typeof override === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(override)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v as never);
    }
    return out as T;
  }
  return (override ?? base) as T;
}

function findBaseConfig(dir: string): string | undefined {
  for (const ext of CONFIG_EXTS) {
    const p = join(dir, `config${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/**
 * Resolve a tool's external assets (`queryFile`, `conditions.$ref`) relative to baseDir.
 *
 * conditions.$ref
 *   Instead of inlining a large conditions block in every tool.yaml, a tool may
 *   delegate to a shared file:
 *
 *     conditions:
 *       $ref: ../../conditions.yaml
 *
 *   The referenced file must be a YAML/JSON object whose keys are condition names
 *   (e.g. `privileged:`) — i.e. the full conditions map, not a single condition.
 *   It is resolved relative to the tool's own directory (baseDir) and inlined at
 *   load time, before Zod validation.
 */
function resolveToolAssets(tool: unknown, baseDir: string): unknown {
  if (!tool || typeof tool !== "object") return tool;
  const t = tool as Record<string, unknown>;

  if (typeof t.queryFile === "string" && !t.query) {
    const queryPath = join(baseDir, t.queryFile);
    if (!existsSync(queryPath)) {
      throw new Error(`queryFile not found for tool '${String(t.name)}': ${queryPath}`);
    }
    t.query = readFileSync(queryPath, "utf8");
  }

  const conds = t.conditions as Record<string, unknown> | undefined;
  if (conds && typeof conds === "object" && !Array.isArray(conds) && typeof conds.$ref === "string") {
    const refPath = join(baseDir, conds.$ref);
    if (!existsSync(refPath)) {
      throw new Error(`conditions.$ref not found for tool '${String(t.name)}': ${refPath}`);
    }
    t.conditions = parseFile(refPath);
  }

  return t;
}

/** Pull tool definitions out of one parsed file (array | { tools: [] } | single). */
function toolsFromParsed(parsed: unknown, source: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.tools)) return obj.tools;
    // A single tool object (per-tool directory layout).
    if (typeof obj.type === "string" && typeof obj.name === "string") return [obj];
  }
  throw new Error(
    `Tool config ${source} must be a single tool object, an array of tools, or { tools: [...] }`,
  );
}

/** Find the tool definition file inside a per-tool directory. */
function findToolFileInDir(dir: string): string | undefined {
  for (const base of ["tool", "index"]) {
    for (const ext of CONFIG_EXTS) {
      const p = join(dir, `${base}${ext}`);
      if (existsSync(p)) return p;
    }
  }
  // Fall back to a single config file in the directory.
  const candidates = readdirSync(dir).filter(isConfigFile).sort();
  if (candidates.length === 1) return join(dir, candidates[0]!);
  return undefined;
}

/**
 * Collect tool definitions from the `tools/` subdirectory. Two layouts are
 * supported and may be mixed:
 *   - per-tool directory: tools/<name>/tool.yaml (+ optional query.sql, ...)
 *   - grouped/flat file:   tools/<group>.yaml (array or { tools: [...] })
 */
function loadToolFiles(dir: string): ToolConfig[] {
  const toolsDir = join(dir, "tools");
  if (!existsSync(toolsDir) || !statSync(toolsDir).isDirectory()) return [];

  const tools: unknown[] = [];
  for (const entry of readdirSync(toolsDir).sort()) {
    const full = join(toolsDir, entry);
    const stat = statSync(full);

    if (stat.isDirectory()) {
      const toolFile = findToolFileInDir(full);
      if (!toolFile) {
        throw new Error(
          `Tool directory '${entry}' has no tool.{yaml,yml,json} (or single config file)`,
        );
      }
      for (const t of toolsFromParsed(interpolateEnv(parseFile(toolFile)), toolFile)) {
        tools.push(resolveToolAssets(t, full));
      }
    } else if (isConfigFile(entry)) {
      for (const t of toolsFromParsed(interpolateEnv(parseFile(full)), entry)) {
        tools.push(resolveToolAssets(t, toolsDir));
      }
    }
  }
  return tools as ToolConfig[];
}

function parseSecurityBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

/** Apply the shared AUTHN_MODE/security env contract after YAML interpolation. */
function applySecurityModelFromEnv(merged: Record<string, unknown>): void {
  const auth =
    merged.auth && typeof merged.auth === "object" && !Array.isArray(merged.auth)
      ? (merged.auth as Record<string, unknown>)
      : {};
  if (merged.auth !== auth) merged.auth = auth;
  const authnMode = process.env.AUTHN_MODE;
  if (authnMode) {
    const mapped = ({
      disabled: "disabled",
      token: "static",
      oidc: "oauth",
      token_or_oidc: "both",
    } as const)[authnMode.trim().toLowerCase() as "disabled" | "token" | "oidc" | "token_or_oidc"];
    if (!mapped) {
      throw new Error("AUTHN_MODE must be disabled, token, oidc, or token_or_oidc");
    }
    auth.mode = mapped;
  }

  const canonicalAuthzEnabled = parseSecurityBoolean(
    "AUTHZ_ENABLED",
    process.env.AUTHZ_ENABLED,
  );
  const legacyAuthorizationEnabled = parseSecurityBoolean(
    "AUTHORIZATION_ENABLED",
    process.env.AUTHORIZATION_ENABLED,
  );
  if (
    canonicalAuthzEnabled !== undefined &&
    legacyAuthorizationEnabled !== undefined &&
    canonicalAuthzEnabled !== legacyAuthorizationEnabled
  ) {
    throw new Error("AUTHZ_ENABLED and AUTHORIZATION_ENABLED conflict");
  }
  const authorizationEnabled =
    canonicalAuthzEnabled ?? legacyAuthorizationEnabled;
  if (authorizationEnabled !== undefined) {
    merged.authorization = { enabled: authorizationEnabled };
  }

  const tenantEnabled = parseSecurityBoolean(
    "TENANT_ISOLATION_ENABLED",
    process.env.TENANT_ISOLATION_ENABLED,
  );
  const canonicalDefaultTenantId = process.env.DEFAULT_TENANT_ID?.trim();
  const legacyDefaultTenantId =
    process.env.TENANT_ISOLATION_DEFAULT_TENANT_ID?.trim();
  if (
    canonicalDefaultTenantId &&
    legacyDefaultTenantId &&
    canonicalDefaultTenantId !== legacyDefaultTenantId
  ) {
    throw new Error(
      "DEFAULT_TENANT_ID and TENANT_ISOLATION_DEFAULT_TENANT_ID conflict",
    );
  }
  const defaultTenantId = canonicalDefaultTenantId || legacyDefaultTenantId;
  const claimNames = process.env.TENANT_ISOLATION_CLAIM_NAMES;
  const isolatedDatabases = process.env.TENANT_ISOLATION_ISOLATED_DATABASES;
  const sqlValidationMode = process.env.TENANT_ISOLATION_SQL_VALIDATION_MODE?.trim();
  if (
    sqlValidationMode !== undefined &&
    sqlValidationMode !== "report" &&
    sqlValidationMode !== "strict"
  ) {
    throw new Error("TENANT_ISOLATION_SQL_VALIDATION_MODE must be report or strict");
  }
  if (tenantEnabled !== undefined || defaultTenantId || claimNames || isolatedDatabases || sqlValidationMode) {
    const existing =
      merged.tenantIsolation && typeof merged.tenantIsolation === "object"
        ? (merged.tenantIsolation as Record<string, unknown>)
        : {};
    merged.tenantIsolation = {
      ...existing,
      ...(tenantEnabled !== undefined ? { enabled: tenantEnabled } : {}),
      ...(defaultTenantId ? { defaultTenantId } : {}),
      ...(claimNames
        ? { claimNames: claimNames.split(",").map((name) => name.trim()).filter(Boolean) }
        : {}),
      ...(isolatedDatabases
        ? {
            isolatedDatabases: isolatedDatabases
              .split(",")
              .map((name) => name.trim())
              .filter(Boolean),
          }
        : {}),
      ...(sqlValidationMode ? { sqlValidationMode } : {}),
    };
  }
}

/**
 * TRUST_PROXY env override (Req 6.12): same contract as the search app, plus
 * a non-negative integer for trusted proxy-hop chains ("2"). Empty/unset
 * leaves the YAML value (default: 1 hop) untouched.
 */
function applyTrustProxyFromEnv(merged: Record<string, unknown>): void {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw === undefined || raw === "") return;
  const normalized = raw.toLowerCase();
  let value: boolean | number;
  if (["true", "yes", "on"].includes(normalized)) value = true;
  else if (["false", "no", "off"].includes(normalized)) value = false;
  else if (/^\d+$/.test(normalized)) value = Number(normalized);
  else throw new Error("TRUST_PROXY must be true, false, or a hop count");
  const server =
    merged.server && typeof merged.server === "object" && !Array.isArray(merged.server)
      ? (merged.server as Record<string, unknown>)
      : {};
  if (merged.server !== server) merged.server = server;
  server.trustProxy = value;
}

function applySchemaCompatibilityFromEnv(merged: Record<string, unknown>): void {
  const mode = process.env.MCP_SCHEMA_COMPATIBILITY_MODE?.trim();
  if (mode === undefined) return;
  if (mode !== "report" && mode !== "strict") {
    throw new Error("MCP_SCHEMA_COMPATIBILITY_MODE must be report or strict");
  }
  const existing =
    merged.schemaCompatibility &&
    typeof merged.schemaCompatibility === "object" &&
    !Array.isArray(merged.schemaCompatibility)
      ? (merged.schemaCompatibility as Record<string, unknown>)
      : {};
  merged.schemaCompatibility = { ...existing, mode };
}

function applyAdditionalOidcIssuerFromEnv(merged: Record<string, unknown>): void {
  const jwksUri = process.env.MCPGATE_AUTH_ADDITIONAL_OIDC_JWKS_URI;
  const issuer = process.env.MCPGATE_AUTH_ADDITIONAL_OIDC_ISSUER;
  const audience = process.env.MCPGATE_AUTH_ADDITIONAL_OIDC_AUDIENCE;
  const configured = [jwksUri, issuer, audience].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (configured.length === 0) return;
  if (configured.length !== 3) {
    throw new Error(
      "MCPGATE_AUTH_ADDITIONAL_OIDC_JWKS_URI, MCPGATE_AUTH_ADDITIONAL_OIDC_ISSUER, and " +
        "MCPGATE_AUTH_ADDITIONAL_OIDC_AUDIENCE must be set together",
    );
  }

  const auth = merged.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("Additional OIDC issuer configured, but auth is missing");
  }
  const oauth = (auth as Record<string, unknown>).oauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) {
    throw new Error("Additional OIDC issuer configured, but auth.oauth is missing");
  }

  const oauthConfig = oauth as Record<string, unknown>;
  if (oauthConfig.issuer === issuer) {
    if (oauthConfig.jwksUri !== jwksUri || oauthConfig.audience !== audience) {
      throw new Error(`Additional OIDC issuer '${issuer}' conflicts with auth.oauth`);
    }
    return;
  }
  const additional = Array.isArray(oauthConfig.additionalIssuers)
    ? [...oauthConfig.additionalIssuers]
    : [];
  const sameIssuer = additional.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).issuer === issuer,
  ) as Record<string, unknown> | undefined;
  if (sameIssuer) {
    if (sameIssuer.jwksUri !== jwksUri || sameIssuer.audience !== audience) {
      throw new Error(
        `Additional OIDC issuer '${issuer}' conflicts with auth.oauth.additionalIssuers`,
      );
    }
    return;
  }

  additional.push({ jwksUri, issuer, audience, algorithms: ["RS256"] });
  oauthConfig.additionalIssuers = additional;
}

/**
 * Read and deep-merge the config files into a single object, with all tool
 * files appended — but WITHOUT OpenAPI expansion or final validation. Shared by
 * the sync and async load paths.
 */
function buildMerged(dir: string): Record<string, unknown> {
  if (!existsSync(dir)) {
    throw new Error(`Config directory not found: ${dir}`);
  }
  const basePath = findBaseConfig(dir);
  if (!basePath) {
    throw new Error(`No config.{yaml,yml,json} found in ${dir}`);
  }

  let merged = interpolateEnv(parseFile(basePath)) as Record<string, unknown>;

  // Optional local override (e.g. config.local.yaml) for secrets / dev tweaks.
  for (const ext of CONFIG_EXTS) {
    const localPath = join(dir, `config.local${ext}`);
    if (existsSync(localPath)) {
      merged = deepMerge(
        merged,
        interpolateEnv(parseFile(localPath)) as Record<string, unknown>,
      );
      break;
    }
  }

  applySecurityModelFromEnv(merged);
  applySchemaCompatibilityFromEnv(merged);
  applyAdditionalOidcIssuerFromEnv(merged);
  applyTrustProxyFromEnv(merged);

  // Tools may be inlined in config or split across tools/*.yaml files.
  const fileTools = loadToolFiles(dir);
  if (fileTools.length > 0) {
    const inline = Array.isArray(merged.tools)
      ? (merged.tools as unknown[])
      : [];
    merged.tools = [...inline, ...fileTools];
  }

  return merged;
}

/** Append generated tools onto the merged config (mutates and returns it). */
function appendGeneratedTools(merged: Record<string, unknown>, generated: unknown[]): void {
  if (generated.length === 0) return;
  const existing = Array.isArray(merged.tools) ? (merged.tools as unknown[]) : [];
  merged.tools = [...existing, ...generated];
}

/** Validate the merged config and run the cross-field tool checks. */
function finalize(merged: Record<string, unknown>, dir: string): { config: AppConfig; dir: string } {
  const result = AppConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration in ${dir}:\n${issues}`);
  }

  // Reject duplicate tool names early - they would shadow each other silently.
  const seen = new Set<string>();
  const contextHeaderBinding = /:ctx\.headers\.([A-Za-z0-9_.-]+)/gi;
  const tenantAliases = [
    "tenant",
    "org",
    "organization",
    "security",
    ...result.data.tenantIsolation.claimNames,
  ].map((name) => name.replace(/[^a-z0-9]/gi, "").toLowerCase());
  const unsafeHeaderBinding = (text: string): string | undefined => {
    for (const match of text.matchAll(contextHeaderBinding)) {
      const normalized = match[1]!.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (tenantAliases.some((alias) => alias.length > 0 && normalized.includes(alias))) {
        return match[0];
      }
    }
    return undefined;
  };
  const findUnsafeBinding = (value: unknown): string | undefined => {
    if (typeof value === "string") return unsafeHeaderBinding(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = findUnsafeBinding(entry);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const found = findUnsafeBinding(entry);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const tool of result.data.tools) {
    const unsafeBinding = findUnsafeBinding(tool);
    if (unsafeBinding) {
      throw new Error(
        `Tool '${tool.name}' uses unsafe tenant/security header binding '${unsafeBinding}'. ` +
          "Use :ctx.tenantId, which is derived only from verified claims.",
      );
    }
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name in configuration: ${tool.name}`);
    }
    seen.add(tool.name);
    // Database tools need an actual query (inline or resolved from queryFile).
    if (tool.type === "database" && !tool.query) {
      throw new Error(
        `Database tool '${tool.name}' must define 'query' or 'queryFile'`,
      );
    }
    // Req 6.5: a paginated tool must not page itself — a top-level
    // LIMIT/TOP/OFFSET/FETCH in its SQL would conflict with the gate's own
    // cursor windowing, so the configuration is rejected at load time.
    if (tool.type === "database" && tool.pagination?.enabled && tool.query) {
      if (hasTopLevelSqlKeywords(tool.query, TOP_LEVEL_ROW_LIMIT_KEYWORDS)) {
        throw new Error(
          `Database tool '${tool.name}' enables pagination but its SQL already contains a ` +
            "top-level LIMIT, TOP, OFFSET or FETCH clause. Remove it from the query — the " +
            "gate applies pagination itself (Req 6.5).",
        );
      }
    }
    if (
      result.data.tenantIsolation.enabled &&
      tool.type === "database" &&
      !tool.query?.includes(":ctx.tenantId") &&
      !result.data.tenantIsolation.isolatedDatabases.includes(tool.database)
    ) {
      throw new Error(
        `Database tool '${tool.name}' cannot guarantee tenant isolation. ` +
          "Bind :ctx.tenantId in its query or declare its database in " +
          "tenantIsolation.isolatedDatabases when the connection is physically tenant-dedicated.",
      );
    }
    // MQTT tools need exactly one of 'topic' (single) or 'topics' (multi).
    if (tool.type === "mqtt") {
      const hasSingle = tool.topic !== undefined;
      const hasMulti = tool.topics !== undefined && tool.topics.length > 0;
      if (!hasSingle && !hasMulti) {
        throw new Error(
          `MQTT tool '${tool.name}' must define either 'topic' or a non-empty 'topics' array`,
        );
      }
      if (hasSingle && hasMulti) {
        throw new Error(
          `MQTT tool '${tool.name}' must define only one of 'topic' or 'topics', not both`,
        );
      }
    }
    // Req 6.13: token exchange and bearer passthrough are mutually exclusive —
    // a server configured for both would make it ambiguous which credential
    // reaches the downstream, and passthrough defeats the exchange entirely.
    if (
      tool.type === "mcp" &&
      tool.server.tokenExchange &&
      tool.server.forwardBearerToken
    ) {
      throw new Error(
        `MCP tool '${tool.name}' sets both server.tokenExchange and server.forwardBearerToken. ` +
          "Choose one: tokenExchange sends an audience-bound exchanged token, " +
          "forwardBearerToken (deprecated) forwards the caller's login token verbatim.",
      );
    }
  }

  resolveTokenExchangeSecrets(result.data.tools);

  return { config: result.data, dir };
}

/**
 * Resolve every MCP tool's `server.tokenExchange.clientSecretEnv` (and any
 * actor `clientSecretEnv`) to the concrete secret, mutating the parsed config
 * in place so the executor reads a ready-to-use `clientSecret`. Fail-closed: a
 * referenced variable that is unset or empty aborts startup — an exchange
 * configured with a missing secret would fail every downstream call at
 * runtime, which reads like an IdP outage instead of a deployment bug.
 */
function resolveTokenExchangeSecrets(tools: AppConfig["tools"]): void {
  for (const tool of tools) {
    if (tool.type !== "mcp") continue;
    const exchange = tool.server.tokenExchange;
    if (exchange === undefined) continue;
    const secret = process.env[exchange.clientSecretEnv];
    if (secret === undefined || secret === "") {
      throw new Error(
        `MCP tool '${tool.name}' server.tokenExchange.clientSecretEnv references ` +
          `${exchange.clientSecretEnv}, which is unset or empty.`,
      );
    }
    exchange.clientSecret = secret;
    if (exchange.actor !== undefined) {
      const actorSecret = process.env[exchange.actor.clientSecretEnv];
      if (actorSecret === undefined || actorSecret === "") {
        throw new Error(
          `MCP tool '${tool.name}' server.tokenExchange.actor.clientSecretEnv references ` +
            `${exchange.actor.clientSecretEnv}, which is unset or empty.`,
        );
      }
      exchange.actor.clientSecret = actorSecret;
    }
  }
}

function isUrl(spec: string): boolean {
  return /^https?:\/\//i.test(spec.trim());
}

/** Synchronous spec reader: local files only. URLs require loadConfigAsync. */
function readSpecFileSync(spec: string, dir: string): string {
  if (isUrl(spec)) {
    throw new Error(
      `openapi.spec '${spec}' is a URL — remote specs require the async loader ` +
        `(server startup uses it automatically). Use a local file path for the sync loader.`,
    );
  }
  const specPath = join(dir, spec);
  if (!existsSync(specPath)) {
    throw new Error(`openapi.spec not found: ${specPath}`);
  }
  return readFileSync(specPath, "utf8");
}

/** Fetch a remote spec over HTTP(S), or read a local file. */
async function fetchSpecText(imp: OpenApiImport, dir: string): Promise<string> {
  if (!isUrl(imp.spec)) {
    const specPath = join(dir, imp.spec);
    if (!existsSync(specPath)) {
      throw new Error(`openapi.spec not found: ${specPath}`);
    }
    return readFileSync(specPath, "utf8");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(imp.spec, {
      headers: { Accept: "application/json, application/yaml, text/yaml, text/plain", ...imp.specHeaders },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`fetching openapi spec '${imp.spec}' failed: HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`fetching openapi spec '${imp.spec}' timed out after 30000ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load and validate the full application configuration from a directory.
 *
 * Synchronous: OpenAPI imports must reference LOCAL files, and `mcpServers`
 * imports are not supported at all (discovering a downstream server's tools
 * always requires a network round-trip). Use loadConfigAsync for either.
 *
 * Layout:
 *   config/
 *     config.yaml          (base; .yml/.json also accepted)
 *     config.local.yaml    (optional, git-ignored, deep-merged over base)
 *     tools/<name>/tool.yaml   (per-tool directory; may reference query.sql)
 *     tools/*.yaml             (optional grouped files: array or { tools: [...] })
 */
export function loadConfig(explicitDir?: string): { config: AppConfig; dir: string } {
  const dir = resolveConfigDir(explicitDir);
  const merged = buildMerged(dir);

  if (Array.isArray(merged.openapi) && merged.openapi.length > 0) {
    const imports = merged.openapi.map((entry) => OpenApiImportSchema.parse(entry));
    appendGeneratedTools(
      merged,
      expandOpenApiImports(imports, (imp) => readSpecFileSync(imp.spec, dir)),
    );
  }

  if (Array.isArray(merged.mcpServers) && merged.mcpServers.length > 0) {
    throw new Error(
      "config has 'mcpServers' entries — importing tools from a remote MCP server requires " +
        "the async loader (server startup uses it automatically). Use loadConfigAsync.",
    );
  }

  return finalize(merged, dir);
}

/**
 * Async variant of loadConfig that also supports remote OpenAPI specs and
 * `mcpServers` imports: any `openapi[].spec` that is an http(s) URL is
 * fetched over the network, and every `mcpServers` entry is connected to
 * discover its tools via `tools/list`. Local OpenAPI file specs work exactly
 * as in loadConfig. Server startup and hot-reload use this path.
 */
export async function loadConfigAsync(explicitDir?: string): Promise<{ config: AppConfig; dir: string }> {
  const dir = resolveConfigDir(explicitDir);
  const merged = buildMerged(dir);

  if (Array.isArray(merged.openapi) && merged.openapi.length > 0) {
    const imports = merged.openapi.map((entry) => OpenApiImportSchema.parse(entry));
    // Pre-fetch every spec's text (URLs in parallel), then expand synchronously.
    const texts = await Promise.all(imports.map((imp) => fetchSpecText(imp, dir)));
    const byIndex = new Map(imports.map((imp, i) => [imp, texts[i]!]));
    appendGeneratedTools(
      merged,
      expandOpenApiImports(imports, (imp) => byIndex.get(imp)!),
    );
  }

  if (Array.isArray(merged.mcpServers) && merged.mcpServers.length > 0) {
    const imports = merged.mcpServers.map((entry) => McpServerImportSchema.parse(entry));
    const server = merged.server as Record<string, unknown> | undefined;
    const outbound = server?.outbound as Record<string, unknown> | undefined;
    const allowedHosts = Array.isArray(outbound?.allowedHosts)
      ? outbound.allowedHosts.filter((value): value is string => typeof value === "string")
      : [];
    appendGeneratedTools(merged, await expandMcpServerImports(imports, allowedHosts));
  }

  return finalize(merged, dir);
}

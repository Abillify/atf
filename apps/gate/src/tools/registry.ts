// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import { diffToolSchemas, type ToolSchemas } from "@atf/schema-compatibility";
import type { Annotations, CompositeTool, OutputSchema, ToolConfig } from "../config/schema.ts";
import { DatabaseToolExecutor, databaseToolDefinition } from "./database-tool.ts";
import { HttpToolExecutor } from "./http-tool.ts";
import { TaigaApiToolExecutor } from "./taiga-api-tool.ts";
import { InlineToolExecutor } from "./inline-tool.ts";
import { WebhookToolExecutor } from "./webhook-tool.ts";
import { McpProxyToolExecutor } from "./mcp-proxy-tool.ts";
import { MqttToolExecutor } from "./mqtt-tool.ts";
import { CompositeToolExecutor } from "./composite-tool.ts";
import { CachingToolExecutor } from "./caching-tool.ts";
import { logger } from "../logger.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

/**
 * Default MCP tool annotation hints derived from a tool's `access` field when
 * the tool author does not supply explicit `annotations`. A read-only tool is
 * hinted as safe/idempotent/read-only; a write tool is hinted as potentially
 * destructive (the conservative default — authors can override with explicit
 * `annotations` when a write tool is actually safe, e.g. an idempotent upsert).
 */
function defaultAnnotations(access: "read" | "write"): Annotations {
  return access === "read"
    ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
}

/** Automatic access scope and additive explicit scopes unless scope checking is disabled. */
function effectiveRequiredScopes(requiredScopes: readonly string[] = []): string[] {
  return [...new Set(requiredScopes)];
}

type SchemaCompatibilityMode = "report" | "strict";

function candidateDefinition(cfg: ToolConfig): ToolDefinition {
  if (cfg.type === "database") return databaseToolDefinition(cfg);
  return {
    name: cfg.name,
    description: cfg.description,
    inputSchema: cfg.inputSchema as Record<string, unknown>,
    ...("outputSchema" in cfg && cfg.outputSchema !== undefined
      ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
      : {}),
  };
}

function schemaSnapshot(tools: readonly ToolConfig[]): Map<string, ToolSchemas> {
  return new Map(
    tools
      .filter((tool) => tool.enabled)
      .map((tool) => {
        const definition = candidateDefinition(tool);
        return [
          tool.name,
          {
            inputSchema: definition.inputSchema,
            ...(definition.outputSchema !== undefined
              ? { outputSchema: definition.outputSchema }
              : {}),
          },
        ];
      }),
  );
}

/**
 * Wraps an executor so its advertised `definition` carries `outputSchema` and
 * `annotations` (explicit config, or sensible defaults derived from `access`),
 * without every individual *ToolExecutor having to duplicate this logic.
 */
export class ScopeEnforcingToolExecutor implements ToolExecutor {
  updateScopes(requiredScopes: readonly string[]): void {
    this.requiredScopes = requiredScopes;
  }

  constructor(
    private readonly inner: ToolExecutor,
    private requiredScopes: readonly string[],
  ) {}

  get definition(): ToolDefinition {
    return this.inner.definition;
  }

  private missingScopes(ctx: AuthContext): string[] {
    return this.requiredScopes.filter((scope) => !ctx.scopes.includes(scope));
  }

  private deniedResult(missing: readonly string[]): ToolResult {
    return {
      content: [{ type: "text", text: `Missing required scope(s): ${missing.join(", ")}` }],
      isError: true,
    };
  }

  execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const missing = this.missingScopes(ctx);
    if (missing.length > 0) return Promise.resolve(this.deniedResult(missing));
    return this.inner.execute(args, ctx, signal);
  }

  explain(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> | undefined {
    const missing = this.missingScopes(ctx);
    if (missing.length > 0) return Promise.resolve(this.deniedResult(missing));
    return this.inner.explain?.(args, ctx);
  }
}

export class DecoratedToolExecutor implements ToolExecutor {
  definition: ToolDefinition;

  constructor(
    private readonly inner: ToolExecutor,
    outputSchema: OutputSchema | undefined,
    annotations: Annotations | undefined,
    access: "read" | "write",
  ) {
    this.definition = this.decorate(inner.definition, outputSchema, annotations, access);
  }

  updateDefinition(
    definition: ToolDefinition,
    outputSchema: OutputSchema | undefined,
    annotations: Annotations | undefined,
    access: "read" | "write",
  ): void {
    this.definition = this.decorate(definition, outputSchema, annotations, access);
  }

  private decorate(
    definition: ToolDefinition,
    outputSchema: OutputSchema | undefined,
    annotations: Annotations | undefined,
    access: "read" | "write",
  ): ToolDefinition {
    return {
      ...definition,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      annotations: { ...defaultAnnotations(access), ...annotations },
    };
  }

  execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    return this.inner.execute(args, ctx, signal);
  }

  explain(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> | undefined {
    return this.inner.explain?.(args, ctx);
  }
}

/**
 * Builds and holds the set of tool executors from configuration. Disabled tools
 * are skipped. The registry is shared across all connections; per-request
 * identity is supplied at execution time via the AuthContext.
 *
 * An optional set of abstract "router" tools can be attached on top:
 *   - augment: MCP clients see the individual tools AND the router(s)
 *   - replace: MCP clients see ONLY the router(s) (individual tools remain
 *              dispatchable internally by the routers)
 * Tools are split by `access`: the read router handles `read` tools, the write
 * router handles `write` tools.
 *
 * The tool set can be rebuilt at runtime via `reload()` (hot-reload) without
 * recreating the registry, so live closures in MCP session handlers keep seeing
 * the current tools.
 */
export class ToolRegistry {
  private executors = new Map<string, ToolExecutor>();
  /** Webhook executors, kept separately so their receivers can be mounted. */
  private webhooks: WebhookToolExecutor[] = [];
  /** Names of tools advertised to MCP clients (cfg.expose !== false). */
  private exposed = new Set<string>();
  /** Read/write classification per tool, used to scope each router. */
  private access = new Map<string, "read" | "write">();
  /** Tool type (database / http / inline / webhook / mcp / mqtt / composite) per tool. */
  private types = new Map<string, string>();
  /** Scopes the caller's token must carry to invoke this tool (empty = no extra restriction). */
  private requiredScopes = new Map<string, string[]>();
  /**
   * Decoration cache keyed by the *inner* executor instance, so a preserved
   * webhook executor (same inner instance reused across reload, see `build()`)
   * is wrapped in the very same DecoratedToolExecutor, keeping `getReal()`
   * identity-stable for callers that rely on it (mounted receivers, etc.).
   */
  private readonly decoratedCache = new WeakMap<ToolExecutor, ToolExecutor>();
  private readonly authorizedCache = new WeakMap<ToolExecutor, ScopeEnforcingToolExecutor>();
  private readonly routers: ToolExecutor[] = [];
  private readonly routerAccess = new Map<string, "read" | "write">();
  private readonly routerRequiredScopes = new Map<string, string[]>();
  private routerMode: "augment" | "replace" = "augment";
  private schemas = new Map<string, ToolSchemas>();

  constructor(
    tools: ToolConfig[],
    private readonly runtime: ToolRuntime,
    private schemaCompatibilityMode: SchemaCompatibilityMode = "report",
  ) {
    this.build(tools);
    this.schemas = schemaSnapshot(tools);
  }

  /**
   * (Re)build the executor maps from a tool list. Synchronous and atomic with
   * respect to request handling (no awaits), so a concurrent `list()`/`get()`
   * never observes a half-built registry. On reload, existing webhook executors
   * are reused by name so their already-mounted inbound receiver and cached
   * payload survive.
   */
  private build(tools: ToolConfig[], preserveWebhooks?: Map<string, WebhookToolExecutor>): void {
    const executors = new Map<string, ToolExecutor>();
    const webhooks: WebhookToolExecutor[] = [];
    const exposed = new Set<string>();
    const access = new Map<string, "read" | "write">();
    const types = new Map<string, string>();
    const requiredScopes = new Map<string, string[]>();
    const composites: CompositeTool[] = [];
    const pendingScopeUpdates: Array<{
      executor: ScopeEnforcingToolExecutor;
      scopes: readonly string[];
    }> = [];
    const pendingDefinitionUpdates: Array<{
      executor: DecoratedToolExecutor;
      definition: ToolDefinition;
      outputSchema: OutputSchema | undefined;
      annotations: Annotations | undefined;
      access: "read" | "write";
    }> = [];

    for (const cfg of tools) {
      if (!cfg.enabled) continue;
      switch (cfg.type) {
        case "database":
          executors.set(cfg.name, new DatabaseToolExecutor(cfg, this.runtime));
          break;
        case "http":
          executors.set(cfg.name, new HttpToolExecutor(cfg, this.runtime));
          break;
        case "taigaApi":
          executors.set(cfg.name, new TaigaApiToolExecutor(cfg, this.runtime));
          break;
        case "inline":
          executors.set(cfg.name, new InlineToolExecutor(cfg, this.runtime));
          break;
        case "webhook": {
          const preserved = preserveWebhooks?.get(cfg.name);
          if (preserved) {
            executors.set(cfg.name, preserved);
            webhooks.push(preserved);
          } else {
            const wh = new WebhookToolExecutor(cfg, this.runtime);
            executors.set(cfg.name, wh);
            webhooks.push(wh);
            if (preserveWebhooks) {
              logger.warn(
                `webhook tool '${cfg.name}' added via reload — its inbound receiver ` +
                  `is mounted at startup, so a restart is required before it can receive payloads`,
              );
            }
          }
          break;
        }
        case "mcp":
          executors.set(cfg.name, new McpProxyToolExecutor(cfg, this.runtime));
          break;
        case "mqtt": {
          if (!this.runtime.mqtt) {
            throw new Error(
              `Tool '${cfg.name}' is type 'mqtt' but no MQTT broker is configured. ` +
                `Add a top-level 'mqtt' block or a per-tool 'broker'.`,
            );
          }
          executors.set(cfg.name, new MqttToolExecutor(cfg, this.runtime.mqtt));
          break;
        }
        case "composite":
          composites.push(cfg);
          break;
      }
      // Non-exposed tools stay registered (router + prompt sources can use
      // them) but are withheld from MCP clients.
      if (cfg.expose) exposed.add(cfg.name);
      access.set(cfg.name, cfg.access);
      types.set(cfg.name, cfg.type);
      requiredScopes.set(cfg.name, effectiveRequiredScopes(cfg.requiredScopes));
    }

    // Composite tools resolve their step tools lazily, so they may reference any
    // other tool regardless of declaration order (including other composites).
    for (const cfg of composites) {
      executors.set(cfg.name, new CompositeToolExecutor(cfg, (n) => executors.get(n)));
    }

    // Wrap read tools that opted into caching. Done last so the cached executor
    // also covers composite tools and is what composites resolve at call time.
    for (const cfg of tools) {
      if (!cfg.enabled) continue;
      if ("cache" in cfg && cfg.cache?.enabled) {
        if (cfg.access === "write") {
          logger.warn(`tool '${cfg.name}' has cache enabled but access: write — caching skipped`);
          continue;
        }
        const inner = executors.get(cfg.name);
        if (inner) executors.set(cfg.name, new CachingToolExecutor(inner, cfg.cache));
      }
    }

    // Authorization is applied as the outermost real-executor wrapper. This
    // ensures direct, router and composite calls (including retries) all pass
    // the same gate immediately before cache/executor execution.
    for (const [name, inner] of executors) {
      const scopes = this.runtime.authorizationEnabled === false
        ? []
        : (requiredScopes.get(name) ?? []);
      const preserved = this.authorizedCache.get(inner);
      if (preserved) {
        pendingScopeUpdates.push({ executor: preserved, scopes });
        executors.set(name, preserved);
      } else {
        const authorized = new ScopeEnforcingToolExecutor(inner, scopes);
        this.authorizedCache.set(inner, authorized);
        executors.set(name, authorized);
      }
    }

    // Decorate every executor's advertised definition with outputSchema +
    // annotations (explicit config, or defaults derived from access). Done
    // last so the decoration wraps whatever executor ended up registered
    // (including cached/composite ones) without altering execute() behaviour.
    for (const cfg of tools) {
      if (!cfg.enabled) continue;
      const inner = executors.get(cfg.name);
      if (!inner) continue;
      const outputSchema = "outputSchema" in cfg ? cfg.outputSchema : undefined;
      const annotations = "annotations" in cfg ? cfg.annotations : undefined;
      // Reuse the decoration wrapper for a preserved inner instance (e.g. a
      // webhook executor kept across reload) so getReal() stays identity-
      // stable for callers that depend on it.
      const cached = this.decoratedCache.get(inner);
      if (cached) {
        pendingDefinitionUpdates.push({
          executor: cached as DecoratedToolExecutor,
          definition: candidateDefinition(cfg),
          outputSchema,
          annotations,
          access: cfg.access,
        });
        executors.set(cfg.name, cached);
        continue;
      }
      const decorated = new DecoratedToolExecutor(inner, outputSchema, annotations, cfg.access);
      this.decoratedCache.set(inner, decorated);
      executors.set(cfg.name, decorated);
    }

    // Mutate preserved wrappers only after the complete candidate was built.
    // Strict compatibility failures return before build(), so rejected reloads
    // cannot change scopes or advertised webhook definitions.
    for (const { executor, scopes } of pendingScopeUpdates) executor.updateScopes(scopes);
    for (const update of pendingDefinitionUpdates) {
      update.executor.updateDefinition(
        update.definition,
        update.outputSchema,
        update.annotations,
        update.access,
      );
    }

    // Swap in the freshly built maps (synchronous; no interleaving with requests).
    this.executors = executors;
    this.webhooks = webhooks;
    this.exposed = exposed;
    this.access = access;
    this.types = types;
    this.requiredScopes = requiredScopes;
  }

  /**
   * Rebuild the tool set from a new configuration without recreating the
   * registry. Routers and the MCP session handlers keep their references and
   * automatically see the new tools (they read `list()`/`get()` per request).
   */
  reload(
    tools: ToolConfig[],
    mode: SchemaCompatibilityMode = this.schemaCompatibilityMode,
  ): void {
    const candidateSchemas = schemaSnapshot(tools);
    const breaking: Array<{
      tool: string;
      finding: ReturnType<typeof diffToolSchemas>["breaking"][number];
    }> = [];
    const unknown: Array<{
      tool: string;
      finding: ReturnType<typeof diffToolSchemas>["unknown"][number];
    }> = [];

    for (const [name, previous] of this.schemas) {
      const next = candidateSchemas.get(name);
      if (!next) {
        breaking.push({
          tool: name,
          finding: {
            direction: "input",
            path: "$",
            code: "tool-removed",
            message: `Tool '${name}' was removed`,
          },
        });
        continue;
      }
      const diff = diffToolSchemas(previous, next);
      breaking.push(...diff.breaking.map((finding) => ({ tool: name, finding })));
      unknown.push(...diff.unknown.map((finding) => ({ tool: name, finding })));
    }

    for (const [classification, findings] of [
      ["breaking", breaking],
      ["unknown", unknown],
    ] as const) {
      for (const { tool, finding } of findings) {
        logger.warn("tool schema compatibility finding", {
          tool,
          classification,
          direction: finding.direction,
          path: finding.path,
          code: finding.code,
          message: finding.message,
        });
      }
    }

    if (mode === "strict" && breaking.length > 0) {
      const summary = breaking
        .map(({ tool, finding }) => `${tool}:${finding.direction}:${finding.path}:${finding.code}`)
        .join(", ");
      throw new Error(`Schema compatibility check rejected reload: ${summary}`);
    }

    const preserve = new Map(this.webhooks.map((w) => [w.definition.name, w]));
    this.build(tools, preserve);
    this.schemas = candidateSchemas;
    this.schemaCompatibilityMode = mode;
  }

  /** All webhook executors, so their inbound receivers can be mounted. */
  webhookExecutors(): WebhookToolExecutor[] {
    return [...this.webhooks];
  }

  /**
   * Attach the abstract router tool(s) and set the exposure mode. Typically one
   * read router (`ask`) and, when write tools exist, one write router (`act`).
   */
  configureRouters(
    routers: Array<{ executor: ToolExecutor; access: "read" | "write" }>,
    mode: "augment" | "replace",
  ): void {
    this.routers.splice(0, this.routers.length);
    this.routerAccess.clear();
    this.routerRequiredScopes.clear();
    for (const { executor, access } of routers) {
      const scopes = effectiveRequiredScopes();
      const authorized = new ScopeEnforcingToolExecutor(executor, scopes);
      const decorated = new DecoratedToolExecutor(authorized, undefined, undefined, access);
      this.routers.push(decorated);
      this.routerAccess.set(executor.definition.name, access);
      this.routerRequiredScopes.set(executor.definition.name, scopes);
    }
    this.routerMode = mode;
  }

  // --- The set exposed to MCP clients (honours router mode) ----------------

  /** MCP tool definitions for tools/list. */
  list(): ToolDefinition[] {
    const routerDefs = this.routers.map((r) => r.definition);
    if (routerDefs.length > 0 && this.routerMode === "replace") return routerDefs;
    return [...this.exposedDefinitions(), ...routerDefs];
  }

  get(name: string): ToolExecutor | undefined {
    const router = this.routers.find((r) => r.definition.name === name);
    if (router) return router;
    if (this.routers.length > 0 && this.routerMode === "replace") return undefined;
    // Non-exposed tools are not directly callable by MCP clients.
    if (!this.exposed.has(name)) return undefined;
    return this.executors.get(name);
  }

  /** Definitions of the exposed (non-router) tools shown to MCP clients. */
  private exposedDefinitions(): ToolDefinition[] {
    return [...this.executors.entries()]
      .filter(([name]) => this.exposed.has(name))
      .map(([, e]) => e.definition);
  }

  // --- The full set of real tools (used internally by the router) ----------

  /**
   * Definitions of all configured (non-router) tools, including non-exposed
   * ones. The abstract router routes over this full set regardless of `expose`.
   * When `access` is given, only tools of that class are returned, so each
   * router routes only over its own (read or write) tools.
   */
  realDefinitions(access?: "read" | "write"): ToolDefinition[] {
    return [...this.executors.entries()]
      .filter(([name]) => access === undefined || this.access.get(name) === access)
      .map(([, e]) => e.definition);
  }

  /** Look up any configured (non-router) executor by name, ignoring `expose`. */
  getReal(name: string): ToolExecutor | undefined {
    return this.executors.get(name);
  }

  /** Read/write classification of a configured tool, if known. */
  accessOf(name: string): "read" | "write" | undefined {
    return this.routerAccess.get(name) ?? this.access.get(name);
  }

  /** Type of a configured tool (database / http / inline), if known. */
  typeOf(name: string): string | undefined {
    return this.types.get(name);
  }

  /** Effective tool scopes; empty when that tool explicitly disables scope checking. */
  requiredScopesOf(name: string): string[] {
    if (this.runtime.authorizationEnabled === false) return [];
    return [...(this.routerRequiredScopes.get(name) ?? this.requiredScopes.get(name) ?? [])];
  }

  /** Whether the tool is advertised to MCP clients (expose: true). */
  isExposed(name: string): boolean {
    return this.exposed.has(name);
  }

  /** Number of configured (non-router) tools. */
  get size(): number {
    return this.executors.size;
  }
}

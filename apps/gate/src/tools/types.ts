// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { AuthContext } from "../auth/context.ts";
import type { DbProvider } from "../db/manager.ts";
import type { MqttBroker } from "../config/schema.ts";
import type { MqttProvider } from "../mqtt/manager.ts";
import type { MonitorBus } from "../monitor/events.ts";
import type { WebhookReplayStore } from "./webhook-replay-store.ts";

/**
 * MCP tool annotation hints (see the MCP spec's `ToolAnnotations`). All fields
 * are advisory hints for clients (e.g. to decide whether to prompt for
 * confirmation before a destructive call) - mcpgate never uses them to make
 * authorization decisions itself.
 */
export interface ToolAnnotations {
  title?: string;
  /** True if the tool does not modify its environment (read-only). */
  readOnlyHint?: boolean;
  /** True if the tool may perform destructive updates (only meaningful when readOnlyHint is false). */
  destructiveHint?: boolean;
  /** True if calling the tool repeatedly with the same arguments has no additional effect. */
  idempotentHint?: boolean;
  /** True if the tool interacts with an "open world" of external entities. */
  openWorldHint?: boolean;
}

/** MCP tool definition advertised to clients (tools/list). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Optional JSON Schema describing the shape of `ToolResult.structuredContent`. */
  outputSchema?: Record<string, unknown>;
  /** Optional behavioural hints surfaced to MCP clients. */
  annotations?: ToolAnnotations;
}

/** Result content compatible with the MCP CallTool response. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /**
   * Machine-readable result payload (MCP `structuredContent`), returned
   * alongside `content` when the tool's output is naturally an object (e.g.
   * `{ rowCount, truncated, rows }` for a database tool). Clients that
   * understand `outputSchema` can consume this directly instead of parsing
   * `content[0].text`.
   */
  structuredContent?: Record<string, unknown>;
  /** Structured detail forwarded to the monitor (e.g. row count). */
  meta?: Record<string, unknown>;
}

/** Shared services available to every tool executor. */
export interface ToolRuntime {
  db: DbProvider;
  bus: MonitorBus;
  /** MQTT access, present only when MQTT is configured. */
  mqtt?: MqttProvider & { resolveBroker(b?: MqttBroker): MqttBroker };
  /**
   * Allow-list of hostnames that outbound tools (`http`, `mcp`) may call.
   * Empty array means no restriction. Sourced from `server.outbound.allowedHosts`.
   */
  outboundAllowedHosts?: string[];
  /** Test/integration seam; production wiring leaves this unset for the pinned transport. */
  outboundFetch?: typeof fetch;
  /** Whether scope, governance and tool-specific business authorization are enforced. */
  authorizationEnabled?: boolean;
  /** Shared atomic nonce store used by all webhook executors. */
  webhookReplayStore?: WebhookReplayStore;
}

/** Something that can fulfil one configured tool. */
export interface ToolExecutor {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: AuthContext, signal?: AbortSignal): Promise<ToolResult>;
  /**
   * Optional dry-run: describe what the tool WOULD do (compiled SQL + bindings,
   * the HTTP request that would be sent, the workflow plan, ...) without
   * executing it. Used by the monitor playground's dry-run mode.
   */
  explain?(args: Record<string, unknown>, ctx: AuthContext): Promise<ToolResult> | undefined;
}

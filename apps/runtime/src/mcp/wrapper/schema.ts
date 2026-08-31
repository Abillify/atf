// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import crypto from "node:crypto";
import type { ToolSchemas } from "@atf/schema-compatibility";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ---------------------------------------------------------------------------
// Default protected parameters
// ---------------------------------------------------------------------------

export const DEFAULT_PROTECTED_PARAMS: readonly string[] = [
  "user_token",
  "user_email",
  "client_id",
] as const;

// ---------------------------------------------------------------------------
// Paginated tool discovery
// ---------------------------------------------------------------------------

/**
 * Lists every tool advertised by an MCP server, following the protocol's
 * opaque `nextCursor` until the final page.
 */
export async function listAllTools(
  client: Client,
): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools({ cursor });
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

// ---------------------------------------------------------------------------
// Schema cache
// ---------------------------------------------------------------------------

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface RawTool {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: string;
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: Readonly<Record<string, unknown>>;
}

export interface FilteredToolSchema {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Shared scope used for bootstrap and non-forward-auth sessions. */
const SHARED_SCOPE = "shared";

/**
 * Manages raw tool caching (with TTL-based expiry) and schema checksum storage.
 * Cache entries are partitioned by a non-secret session scope: bootstrap and
 * non-forward-auth requests share one scope, while callers of forward-auth
 * servers pass a SHA-256 token digest. Raw bearer tokens never enter this cache.
 */
export class SchemaCache {
  /** Structure: serverName → scope → toolName → { tool, fetchedAt }. */
  private readonly toolCache = new Map<
    string,
    Map<string, Map<string, { tool: RawTool; fetchedAt: number }>>
  >();

  /** Structure: serverName → scope → toolName → checksum. */
  private readonly checksums = new Map<string, Map<string, Map<string, string>>>();

  /** Last accepted full schema contract for compatibility checks. */
  private readonly schemaContracts = new Map<
    string,
    Map<string, Map<string, ToolSchemas>>
  >();

  /** Tool-schema cache TTL in ms. 0 disables expiry (cache forever). */
  private readonly schemaTtlMs: number;

  constructor(schemaTtlMs: number) {
    this.schemaTtlMs = schemaTtlMs;
  }

  async fetchRawTool(
    client: Client,
    toolName: string,
    serverName?: string,
    scope = SHARED_SCOPE,
  ): Promise<RawTool> {
    if (serverName !== undefined) {
      const cached = this.toolCache.get(serverName)?.get(scope)?.get(toolName);
      if (cached !== undefined) {
        const fresh = this.schemaTtlMs === 0 || Date.now() - cached.fetchedAt < this.schemaTtlMs;
        if (fresh) return cached.tool;
      }
    }

    const tools = await listAllTools(client);
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) throw new Error(`Tool not found: ${toolName}`);

    const { type, properties, required, ...rest } = tool.inputSchema;
    const rawTool: RawTool = {
      name: tool.name,
      description: tool.description,
      ...("annotations" in tool && tool.annotations !== undefined
        ? { annotations: tool.annotations as ToolAnnotations }
        : {}),
      inputSchema: {
        type,
        properties: properties as Record<string, object> | undefined,
        required,
        ...rest,
      },
      ...("outputSchema" in tool && tool.outputSchema !== undefined
        ? { outputSchema: tool.outputSchema as Readonly<Record<string, unknown>> }
        : {}),
    };

    if (serverName !== undefined) {
      let serverCache = this.toolCache.get(serverName);
      if (serverCache === undefined) {
        serverCache = new Map();
        this.toolCache.set(serverName, serverCache);
      }
      let scopeCache = serverCache.get(scope);
      if (scopeCache === undefined) {
        scopeCache = new Map();
        serverCache.set(scope, scopeCache);
      }
      scopeCache.set(toolName, { tool: rawTool, fetchedAt: Date.now() });
    }

    return rawTool;
  }

  /**
   * Invalidates only fetched discovery data while preserving the last accepted
   * checksum and schema contract used by compatibility enforcement.
   */
  invalidateDiscovery(serverName: string, scope?: string): void {
    if (scope === undefined) {
      this.toolCache.delete(serverName);
      return;
    }
    const serverCache = this.toolCache.get(serverName);
    serverCache?.delete(scope);
    if (serverCache?.size === 0) this.toolCache.delete(serverName);
  }

  /** Fully forgets discovery and accepted policy state after server removal/reconfiguration. */
  invalidateServer(serverName: string): void {
    this.toolCache.delete(serverName);
    this.checksums.delete(serverName);
    this.schemaContracts.delete(serverName);
  }

  /** Invalidates one tool within the supplied cache partition. */
  invalidateTool(serverName: string, toolName: string, scope = SHARED_SCOPE): void {
    this.toolCache.get(serverName)?.get(scope)?.delete(toolName);
    this.checksums.get(serverName)?.get(scope)?.delete(toolName);
    this.schemaContracts.get(serverName)?.get(scope)?.delete(toolName);
  }

  storeChecksum(
    serverName: string,
    toolName: string,
    checksum: string,
    scope = SHARED_SCOPE,
  ): void {
    let serverChecksums = this.checksums.get(serverName);
    if (serverChecksums === undefined) {
      serverChecksums = new Map();
      this.checksums.set(serverName, serverChecksums);
    }
    let scopeChecksums = serverChecksums.get(scope);
    if (scopeChecksums === undefined) {
      scopeChecksums = new Map();
      serverChecksums.set(scope, scopeChecksums);
    }
    scopeChecksums.set(toolName, checksum);
  }

  getStoredChecksum(
    serverName: string,
    toolName: string,
    scope = SHARED_SCOPE,
  ): string | undefined {
    return this.checksums.get(serverName)?.get(scope)?.get(toolName);
  }

  storeSchemaContract(
    serverName: string,
    toolName: string,
    contract: ToolSchemas,
    scope = SHARED_SCOPE,
  ): void {
    let serverContracts = this.schemaContracts.get(serverName);
    if (serverContracts === undefined) {
      serverContracts = new Map();
      this.schemaContracts.set(serverName, serverContracts);
    }
    let scopeContracts = serverContracts.get(scope);
    if (scopeContracts === undefined) {
      scopeContracts = new Map();
      serverContracts.set(scope, scopeContracts);
    }
    scopeContracts.set(toolName, structuredClone(contract));
  }

  getStoredSchemaContract(
    serverName: string,
    toolName: string,
    scope = SHARED_SCOPE,
  ): ToolSchemas | undefined {
    const contract = this.schemaContracts.get(serverName)?.get(scope)?.get(toolName);
    return contract === undefined ? undefined : structuredClone(contract);
  }
}

// ---------------------------------------------------------------------------
// Exported pure helpers
// ---------------------------------------------------------------------------

export function filterSchema(
  schema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  },
  protectedParams: string[],
): {
  type: string;
  properties: Record<string, unknown>;
  required?: string[];
} {
  const filteredProperties: Record<string, unknown> = {};
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (!protectedParams.includes(key)) filteredProperties[key] = value;
    }
  }

  const filteredRequired = schema.required?.filter(
    (required) => !protectedParams.includes(required),
  );
  return {
    type: schema.type,
    properties: filteredProperties,
    ...(filteredRequired !== undefined && filteredRequired.length > 0
      ? { required: filteredRequired }
      : {}),
  };
}

/** Computes a SHA-256 checksum over JSON-serialised schema content. */
export function computeSchemaChecksum(schema: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

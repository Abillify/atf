// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerImport, McpToolOverride } from "./schema.ts";
import { logger } from "../logger.ts";
import { secureOutboundFetch, validateOutboundUrl } from "../tools/outbound.ts";

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Connect to each configured downstream MCP server, discover its tools via
 * `tools/list`, and expand them into `mcp` proxy tool definitions (raw
 * objects, before Zod validation) — one per (non-filtered) downstream tool.
 *
 * Mirrors `expandOpenApiImports`: this is the MCP-server equivalent of the
 * OpenAPI import, letting a whole downstream MCP server be connected as a
 * backend instead of hand-writing one `mcp` proxy tool per remote tool.
 */
export async function expandMcpServerImports(
  imports: McpServerImport[],
  allowedHosts: string[] = [],
  testFetch?: typeof fetch,
): Promise<unknown[]> {
  const tools: unknown[] = [];
  for (const imp of imports) {
    tools.push(...(await expandOne(imp, allowedHosts, testFetch)));
  }
  return tools;
}

async function expandOne(
  imp: McpServerImport,
  allowedHosts: string[],
  testFetch?: typeof fetch,
): Promise<unknown[]> {
  const remoteTools = await listRemoteTools(imp, allowedHosts, testFetch);
  const remoteNames = new Set(remoteTools.map((t) => t.name));

  const include = imp.include ? new Set(imp.include) : undefined;
  const exclude = imp.exclude ? new Set(imp.exclude) : undefined;
  const overridesByName = new Map(imp.overrides.map((o) => [o.name, o]));

  // An override whose `name` matches no tool the server actually advertised
  // is silently inert — most likely a typo. Since `replaceParams` is often
  // used to lock down a parameter the caller must not control, a silent
  // mismatch here would leave that parameter just as caller-settable as
  // before, so this is worth a warning rather than failing quietly.
  for (const name of overridesByName.keys()) {
    if (!remoteNames.has(name)) {
      logger.warn(`mcpServers import '${imp.server.url}': override '${name}' matches no discovered tool, ignored`);
    }
  }

  const tools: unknown[] = [];
  for (const remote of remoteTools) {
    if (include && !include.has(remote.name)) continue;
    if (exclude?.has(remote.name)) continue;

    const override = overridesByName.get(remote.name);
    if (override?.enabled === false) continue;

    tools.push(buildTool(imp, remote, override));
  }
  return tools;
}

async function listRemoteTools(
  imp: McpServerImport,
  allowedHosts: string[],
  testFetch?: typeof fetch,
): Promise<RemoteTool[]> {
  const { server } = imp;
  if (!testFetch) {
    const blocked = await validateOutboundUrl(server.url, allowedHosts);
    if (blocked) throw new Error(`mcpServers import '${server.url}' refused: ${blocked}`);
  }
  const controller = new AbortController();
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: {
      headers: server.token ? { Authorization: `Bearer ${server.token}` } : {},
    },
    fetch: (input, init) => testFetch
      ? testFetch(input, init)
      : secureOutboundFetch(
          input,
          { ...init, signal: init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal },
          allowedHosts,
        ),
  });
  const client = new Client({ name: "mcpgate-import", version: "0.16.0" }, { capabilities: {} });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`mcpServers import '${server.url}' timed out`));
      reject(new Error(`mcpServers import '${server.url}': timed out after ${server.timeoutMs}ms`));
    }, server.timeoutMs);
  });

  try {
    await Promise.race([client.connect(transport), timeout]);

    // tools/list is paginated — keep following nextCursor until the server
    // stops returning one, otherwise only the first page would be imported.
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const result = (await Promise.race([client.listTools({ cursor }), timeout])) as {
        tools?: RemoteTool[];
        nextCursor?: string;
      };
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor !== undefined);

    return tools;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`mcpServers import '${server.url}' failed: ${message}`);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {
      /* best-effort */
    });
  }
}

function buildTool(imp: McpServerImport, remote: RemoteTool, override: McpToolOverride | undefined): unknown {
  const expose = override?.expose !== undefined ? override.expose : imp.expose;
  return {
    name: imp.prefix + remote.name,
    description: override?.description ?? remote.description ?? "",
    type: "mcp",
    access: override?.access ?? imp.access ?? "read",
    ...(expose !== undefined ? { expose } : {}),
    server: imp.server,
    targetTool: remote.name,
    fixedParams: override?.replaceParams ?? {},
    ...(imp.cache ? { cache: imp.cache } : {}),
    inputSchema: buildInputSchema(remote.inputSchema, override),
  };
}

/**
 * Start from the downstream tool's own inputSchema and strip out anything the
 * override hides from callers: removed options, and parameters that are now
 * fixed to a constant value (see `fixedParams` on the generated tool).
 */
function buildInputSchema(raw: unknown, override: McpToolOverride | undefined): Record<string, unknown> {
  const schema = (raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >;
  const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
  let required = Array.isArray(schema.required) ? [...(schema.required as string[])] : [];

  const hidden = new Set([...(override?.removeOptions ?? []), ...Object.keys(override?.replaceParams ?? {})]);
  for (const name of hidden) {
    delete properties[name];
    required = required.filter((r) => r !== name);
  }

  return { ...schema, type: "object", properties, required };
}

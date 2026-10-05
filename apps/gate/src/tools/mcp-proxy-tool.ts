// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AuthContext } from "../auth/context.ts";
import type { McpProxyTool } from "../config/schema.ts";
import { secureOutboundFetch, validateOutboundUrl } from "./outbound.ts";
import { logger } from "../logger.ts";
import { withSpan } from "../observability/tracing.ts";
import type { ToolDefinition, ToolExecutor, ToolResult, ToolRuntime } from "./types.ts";

interface McpTextContent {
  type: string;
  text?: string;
}
interface McpCallResult {
  content?: McpTextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Measure the complete JSON representation exactly as UTF-8 bytes. */
export function measureMcpPayloadBytes(result: unknown): number {
  return Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
}

/** Build the standard MCP proxy error when the additive hard cap is exceeded. */
export function hardPayloadLimitError(
  result: unknown,
  limit: number,
  meta: { server: string; targetTool: string },
): ToolResult | undefined {
  if (limit === 0) return undefined;
  let bytes: number;
  try {
    bytes = measureMcpPayloadBytes(result);
  } catch {
    return {
      content: [
        {
          type: "text",
          text: "Downstream MCP response could not be safely measured for hardPayloadLimitBytes.",
        },
      ],
      isError: true,
      meta: { source: "mcp", ...meta, payloadMeasurementFailed: true },
    };
  }
  if (bytes <= limit) return undefined;
  return {
    content: [
      {
        type: "text",
        text: `Downstream MCP response exceeded hardPayloadLimitBytes (${limit}).`,
      },
    ],
    isError: true,
    meta: { source: "mcp", ...meta, bytes },
  };
}

/**
 * MCP proxy tool.
 *
 * Forwards a tool call to a downstream MCP server (Streamable HTTP transport)
 * and returns its result. A fresh client connection is opened per call and torn
 * down afterwards, so downstream session state stays isolated per request and
 * the caller's identity boundary is respected.
 *
 * The bearer token sent downstream is either the configured `server.token` or —
 * when `forwardBearerToken` is set — the caller's own token.
 *
 * `fixedParams`, if set, are merged into every downstream call after the
 * caller's own arguments, so a gateway-pinned value always wins over (and is
 * never visible to) the caller.
 */
export class McpProxyToolExecutor implements ToolExecutor {
  readonly definition: ToolDefinition;
  private readonly allowedHosts: string[];

  constructor(
    private readonly cfg: McpProxyTool,
    runtime: ToolRuntime,
  ) {
    this.allowedHosts = runtime.outboundAllowedHosts ?? [];
    this.definition = {
      name: cfg.name,
      description: cfg.description,
      inputSchema: cfg.inputSchema as Record<string, unknown>,
      ...(cfg.outputSchema !== undefined
        ? { outputSchema: cfg.outputSchema as Record<string, unknown> }
        : {}),
    };
  }

  async execute(
    args: Record<string, unknown>,
    ctx: AuthContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const server = this.cfg.server;
    const token = server.forwardBearerToken ? ctx.rawToken : server.token;

    const blocked = await validateOutboundUrl(server.url, this.allowedHosts);
    if (blocked) {
      logger.warn("mcp proxy blocked by outbound allow-list", {
        tool: this.cfg.name,
        reason: blocked,
      });
      return {
        content: [{ type: "text", text: `Downstream MCP call refused: ${blocked}` }],
        isError: true,
        meta: { source: "mcp", server: server.url, blocked: true },
      };
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(new Error(`downstream MCP call timed out after ${server.timeoutMs}ms`)),
      server.timeoutMs,
    );
    timer.unref?.();

    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      fetch: (input, init) => {
        const sdkSignal = init?.signal;
        const effectiveSignal = sdkSignal
          ? AbortSignal.any([controller.signal, sdkSignal])
          : controller.signal;
        return secureOutboundFetch(input, { ...init, signal: effectiveSignal }, this.allowedHosts);
      },
    });
    const client = new Client({ name: "mcpgate-proxy", version: "0.13.2" }, { capabilities: {} });

    try {
      logger.debug("mcp proxy connect", {
        tool: this.cfg.name,
        url: server.url,
        target: this.cfg.targetTool,
      });
      await client.connect(transport);

      const callArgs = { ...(args ?? {}), ...this.cfg.fixedParams };
      const result = (await withSpan(
        `mcp.proxy_call ${this.cfg.name}`,
        {
          "mcpgate.tool": this.cfg.name,
          "mcpgate.target_tool": this.cfg.targetTool,
          "mcpgate.server": server.url,
        },
        () => client.callTool({ name: this.cfg.targetTool, arguments: callArgs }),
      )) as McpCallResult;

      const hardLimitError = hardPayloadLimitError(result, this.cfg.hardPayloadLimitBytes, {
        server: server.url,
        targetTool: this.cfg.targetTool,
      });
      if (hardLimitError) return hardLimitError;

      const content = (result.content ?? [])
        .filter(
          (c): c is McpTextContent & { text: string } =>
            c.type === "text" && typeof c.text === "string",
        )
        .map((c) => ({ type: "text" as const, text: c.text }));

      const totalBytes = content.reduce((n, c) => n + Buffer.byteLength(c.text, "utf8"), 0);
      if (totalBytes > this.cfg.maxResponseBytes) {
        return {
          content: [
            {
              type: "text",
              text: `Downstream MCP response exceeded maxResponseBytes (${this.cfg.maxResponseBytes}).`,
            },
          ],
          isError: true,
          meta: {
            source: "mcp",
            server: server.url,
            targetTool: this.cfg.targetTool,
            bytes: totalBytes,
          },
        };
      }

      const structuredContent =
        result.structuredContent && typeof result.structuredContent === "object"
          ? (result.structuredContent as Record<string, unknown>)
          : undefined;

      return {
        content: content.length > 0 ? content : [{ type: "text", text: JSON.stringify(result) }],
        isError: result.isError === true,
        ...(structuredContent !== undefined ? { structuredContent } : {}),
        meta: { source: "mcp", server: server.url, targetTool: this.cfg.targetTool },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug("mcp proxy error", { tool: this.cfg.name, error: message });
      return {
        content: [{ type: "text", text: `Downstream MCP call failed: ${message}` }],
        isError: true,
        meta: { source: "mcp", server: server.url, targetTool: this.cfg.targetTool },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await client.close().catch(() => {
        /* best-effort */
      });
    }
  }
}

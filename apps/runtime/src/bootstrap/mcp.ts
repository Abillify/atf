// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * MCP builder (`src/bootstrap/mcp.ts`)
 *
 * Connects to all configured MCP servers, collects tool IDs, and wires the
 * periodic-reconnect timer and the tool-group summariser:
 *   - McpWrapper (connection + tool dispatch)
 *   - knownToolIds (pre-populated at startup)
 *   - ToolGroupSummarizer (LLM summaries of each server's instructions)
 *   - Periodic 10-minute reconnect timer
 *
 * Extracted from index.ts so the MCP lifecycle (connect → collect → summarise
 * → reconnect) is self-contained and testable.
 */

import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import {
  createMcpWrapper,
  type McpWrapperService,
} from "../mcp/mcp-wrapper.js";
import {
  createToolGroupSummarizer,
  type ToolGroupSummarizer,
} from "../graph/tool-group-summary.js";
import { createLlmProvider } from "../graph/llm-factory.js";

export interface McpResult {
  mcpWrapper: McpWrapperService;
  knownToolIds: Set<string>;
  toolGroupSummarizer: ToolGroupSummarizer | undefined;
}

export async function buildMcp(
  config: AppConfig,
  logger: Logger,
): Promise<McpResult> {
  const mcpWrapper: McpWrapperService = createMcpWrapper({
    schemaCompatibilityMode: config.mcpSchemaCompatibilityMode ?? "report",
    onSchemaCompatibility: ({ serverName, toolName, mode, diff }) => {
      logger.warn("MCP tool schema compatibility findings", {
        server: serverName,
        tool: toolName,
        mode,
        breaking: diff.breaking,
        unknown: diff.unknown,
      });
    },
  });
  const knownToolIds = new Set<string>();

  // ── Connect + collect tool IDs ─────────────────────────────────────────────
  //
  // A failed connect used to call `process.exit(1)`, so ONE unreachable MCP
  // server prevented the entire platform from starting — in Kubernetes this is
  // a crash-loop, not a degraded-but-running deployment, even though every
  // OTHER configured server (and every flow that does not use the down one)
  // would have worked fine. The periodic reconnect timer below already treats
  // a post-startup connection loss as recoverable (it retries every 10
  // minutes and logs a warning); startup now gets the SAME treatment instead
  // of a stricter one. A flow whose tools depend on the unreachable server
  // fails that specific tool call (or the MCP wrapper's own connect-on-demand
  // retry, depending on transport) rather than taking down flows that do not.
  await Promise.all(
    config.mcpServers.map(async (serverConfig) => {
      try {
        await mcpWrapper.connect(serverConfig);
        const hasBootstrapAuthorization = Object.entries(
          serverConfig.headers ?? {},
        ).some(
          ([name, value]) =>
            name.toLowerCase() === "authorization" && value.trim().length > 0,
        );
        if (
          serverConfig.forwardAuthToken === true &&
          !hasBootstrapAuthorization
        ) {
          logger.info("Registered caller-authenticated MCP server", {
            server: serverConfig.name,
            auth:
              serverConfig.tokenExchange !== undefined
                ? serverConfig.tokenExchange.actor !== undefined
                  ? "token-exchange-delegation"
                  : "token-exchange"
                : "passthrough",
          });
        } else {
          logger.info("Connected to MCP server", { server: serverConfig.name });
        }
      } catch (err) {
        logger.error(
          "Failed to connect to MCP server at startup — continuing without it. " +
            "Tools from this server are unavailable until the periodic reconnect " +
            "(every 10 min) succeeds. Set up alerting on this log line if this " +
            "server is required for the deployment.",
          {
            server: serverConfig.name,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return; // Skip listTools below — there is no connection to list from.
      }
      if (serverConfig.forwardAuthToken === true) {
        // The globally compiled flow can validate only that this server is
        // configured. Its actual tool surface is caller-specific and is
        // discovered fail-closed at request time with the user's bearer.
        knownToolIds.add(`${serverConfig.name}/*`);
        return;
      }
      try {
        const toolNames = await mcpWrapper.listTools(serverConfig.name);
        for (const name of toolNames) {
          knownToolIds.add(`${serverConfig.name}/${name}`);
          knownToolIds.add(name);
        }
      } catch (err) {
        logger.warn("Could not list tools for MCP server", {
          server: serverConfig.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  // ── Tool-group summariser ──────────────────────────────────────────────────
  let toolGroupSummarizer: ToolGroupSummarizer | undefined;
  if (config.mcpServers.length > 0 && config.defaultLlm !== undefined) {
    try {
      const summaryModel = createLlmProvider(config.defaultLlm, config);
      toolGroupSummarizer = createToolGroupSummarizer(summaryModel, logger);
      for (const serverConfig of config.mcpServers) {
        toolGroupSummarizer.update(
          serverConfig.name,
          mcpWrapper.getInstructions(serverConfig.name),
        );
      }
    } catch (err) {
      logger.warn("Failed to build tool-group summariser", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Periodic reconnect (every 10 min) ─────────────────────────────────────
  if (config.mcpServers.length > 0) {
    const MCP_RECONNECT_INTERVAL_MS = 10 * 60_000;
    const reconnectTimer = setInterval(() => {
      void (async () => {
        for (const serverConfig of config.mcpServers) {
          try {
            await mcpWrapper.reconnect(serverConfig.name);
            if (serverConfig.forwardAuthToken === true) {
              // Tool discovery remains caller-scoped; retain the configured
              // server marker used only for compile-time reference validation.
              knownToolIds.add(`${serverConfig.name}/*`);
              toolGroupSummarizer?.update(serverConfig.name, undefined);
              continue;
            }
            const toolNames = await mcpWrapper.listTools(serverConfig.name);
            const oldBareNames = [...knownToolIds]
              .filter((id) => id.startsWith(`${serverConfig.name}/`))
              .map((id) => id.slice(serverConfig.name.length + 1));
            for (const name of oldBareNames) {
              knownToolIds.delete(`${serverConfig.name}/${name}`);
              knownToolIds.delete(name);
            }
            for (const name of toolNames) {
              knownToolIds.add(`${serverConfig.name}/${name}`);
              knownToolIds.add(name);
            }
            toolGroupSummarizer?.update(
              serverConfig.name,
              mcpWrapper.getInstructions(serverConfig.name),
            );
          } catch (err) {
            logger.warn("Periodic MCP reconnect failed", {
              server: serverConfig.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })();
    }, MCP_RECONNECT_INTERVAL_MS);
    reconnectTimer.unref?.();
  }

  return { mcpWrapper, knownToolIds, toolGroupSummarizer };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow-as-MCP-Server (`src/mcp/flow-mcp-server.ts`)
 *
 * Exposes every published aiperator flow as a callable MCP tool. External
 * agents, LLMs, and tools that speak the Model Context Protocol can discover
 * and invoke any flow exactly as if it were a native MCP tool — with the same
 * guardrail, BYOK, protected-param, and access-control guarantees that the
 * /v1/chat/completions endpoint provides.
 *
 * Architecture:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  External MCP client (Claude, GPT, another  │
 *   │  aiperator instance, mcpgate, …)            │
 *   └──────────────────┬──────────────────────────┘
 *                      │  POST /mcp   (MCP Streamable HTTP)
 *                      ▼
 *   ┌─────────────────────────────────────────────┐
 *   │  FlowMcpServer                              │
 *   │  • McpServer (one tool per flow)            │
 *   │  • WebStandardStreamableHTTPServerTransport │
 *   │    (stateless — no sessions to manage)      │
 *   └──────────────────┬──────────────────────────┘
 *                      │  graphEngine.executeFlow()
 *                      ▼
 *   ┌─────────────────────────────────────────────┐
 *   │  GraphEngine — same pipeline as /v1/chat    │
 *   │  (guardrails, BYOK, cost tracking, …)       │
 *   └─────────────────────────────────────────────┘
 *
 * Tool naming:
 *   Each flow is exposed with tool name equal to its `flow.id` (already a
 *   URL-safe identifier chosen by the operator). The description comes from
 *   `flow.description` if present, else `flow.name`. Each tool accepts exactly
 *   one string argument `message` (the user turn) plus an optional
 *   `conversation_id` for stateful multi-turn flows.
 *
 * Authentication & authorisation:
 *   The composition root verifies the bearer token before calling this server
 *   and forwards that verified credential as the RequestContext `ssoToken`.
 *   MCP transport metadata is not trusted as HTTP authentication.
 *
 * Hot reload:
 *   When the flow registry changes (chokidar detects a new/updated YAML),
 *   `syncTools()` is called: tools for deleted flows are removed, new flows
 *   gain a tool, unchanged flows are left as-is.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { RequestContext } from "../types/monitoring.js";
import type { ChatMessage } from "../types/openai.js";
import type { Logger } from "../observability/logger.js";
import type { InputGuardrail } from "../graph/input-guardrails.js";
import {
  decideFlowAccess,
  type FlowAuthorizer,
} from "../graph/flow-authorizer.js";
import type { AuthPrincipal } from "../middleware/auth.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { ExecutionAdmissionService } from "../graph/execution-admission.js";

// ---------------------------------------------------------------------------
// Input schema for every flow-tool
// ---------------------------------------------------------------------------

/**
 * Every flow tool accepts:
 *   - `message`         — the user's input text (required)
 *   - `conversation_id` — optional thread id for multi-turn checkpointing
 *   - `user_email`      — optional; forwarded in the RequestContext
 *   - `client_id`      — optional; forwarded for BYOK / tenant scoping
 */
const FlowToolInputShape = {
  message: z.string().describe("The user message to send to the flow."),
  conversation_id: z
    .string()
    .optional()
    .describe(
      "Optional conversation/thread ID for multi-turn stateful flows. " +
        "If omitted, each call is treated as a new conversation.",
    ),
  user_email: z
    .string()
    .optional()
    .describe("Caller email forwarded to downstream MCP tools."),
  client_id: z
    .string()
    .optional()
    .describe("Tenant / client identifier for BYOK and cost attribution."),
};

const FlowToolInputSchema = z.object(FlowToolInputShape);

/** Parsed request shape for a flow tool call (kept in sync with {@link FlowToolInputShape}). */
type FlowToolArgs = z.infer<typeof FlowToolInputSchema>;

/** The subset of a tool-call result this module ever returns. */
interface FlowToolResult {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
}

/**
 * Zod-version interop shim for `registerTool`.
 *
 * `@modelcontextprotocol/sdk` bundles its OWN copy of `zod` (currently
 * 3.25.76, which re-exports a `zod/v4/core` preview build) to type its
 * `ZodRawShapeCompat`/`AnySchema`/`ToolCallback` generics. This project
 * depends on the published `zod@4.x` package directly. Both are structurally
 * compatible at runtime — the SDK's `isZ4Schema()` duck-types on the `_zod`
 * internal field present on every Zod 4 schema regardless of which copy
 * constructed it — but TypeScript treats the two module resolutions as
 * nominally distinct classes, so a schema built from our `zod` does not
 * structurally satisfy the SDK's own `AnySchema`/`ZodRawShapeCompat` types.
 * This is the documented "two copies of zod" situation described in the
 * SDK's own troubleshooting guide
 * (https://ts.sdk.modelcontextprotocol.io/v2/troubleshooting.html) and is
 * inherent to any install that does not hoist a single zod across the whole
 * tree — deduplicating further is not possible here because
 * `@langchain/core` / `@langchain/langgraph` pin a hard `zod@^3.x` of their
 * own that must not be overridden.
 *
 * `registerFlowTool` gives every call site a locally-declared, precisely
 * typed signature (real `FlowToolArgs`, no `any`) so the tool body is fully
 * type-checked, while the mismatched `inputSchema` generic on the SDK's own
 * `registerTool` overload is bypassed through a single, well-documented cast
 * confined to this one function.
 */
function registerFlowTool(
  mcp: McpServer,
  name: string,
  description: string,
  handler: (
    args: FlowToolArgs,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<FlowToolResult>,
): void {
  const register = mcp.registerTool.bind(mcp) as unknown as (
    name: string,
    config: { description: string; inputSchema: unknown },
    handler: (
      args: FlowToolArgs,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => Promise<FlowToolResult>,
  ) => void;
  register(name, { description, inputSchema: FlowToolInputShape }, handler);
}

// ---------------------------------------------------------------------------
// FlowMcpServer
// ---------------------------------------------------------------------------

export interface FlowMcpServerOptions {
  /** The flow registry to source tool definitions from. */
  flowRegistry: FlowRegistry;
  /** The graph engine that executes flows. */
  graphEngine: GraphEngineService;
  /** Optional input guardrail evaluated before dispatching to the engine. */
  inputGuardrail?: InputGuardrail;
  /** Global business-authorization switch. */
  authorizationEnabled?: boolean;
  /** Optional flow authorizer — gates which flows are callable per identity. */
  flowAuthorizer?: FlowAuthorizer;
  /** Verifier used to decode the already-authenticated caller token into claims. */
  jwtVerifier?: JwtVerifier;
  /** JWT claim names used to resolve declarative FlowDefinition.requiredScopes. */
  flowScopeClaims?: readonly string[];
  /** Shared admission gate executed immediately before every engine call. */
  admission?: ExecutionAdmissionService;
  /** Human-readable server name advertised in the MCP initialize response. */
  serverName?: string;
  /** Server version string. */
  serverVersion?: string;
  logger?: Logger;
}

export interface FlowMcpServer {
  /**
   * Handle a raw Web-standard `Request` and return a `Response`.
   * Mount this on any Hono route that handles `*` methods.
   */
  handleRequest(
    req: Request,
    callerToken?: string,
    principal?: AuthPrincipal,
  ): Promise<Response>;
  /**
   * Re-sync the registered tools to match the current flow registry.
   * Call when the registry changes (hot-reload).
   */
  syncTools(): void;
  /**
   * Builds a fresh `McpServer` with one tool per currently-loaded flow.
   *
   * This is the same construction `handleRequest` performs per request. It is
   * public so a caller can pair the server with a non-HTTP transport (the
   * in-memory transport used by the tests) instead of reaching into internals.
   */
  createServer(callerToken?: string, principal?: AuthPrincipal): McpServer;
}

class FlowMcpServerImpl implements FlowMcpServer {
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly flowRegistry: FlowRegistry;
  private readonly graphEngine: GraphEngineService;
  private readonly inputGuardrail: InputGuardrail | undefined;
  private readonly authorizationEnabled: boolean;
  private readonly flowAuthorizer: FlowAuthorizer | undefined;
  private readonly jwtVerifier: JwtVerifier | undefined;
  private readonly flowScopeClaims: readonly string[] | undefined;
  private readonly admission: ExecutionAdmissionService | undefined;
  private readonly logger: Logger | undefined;
  /** Track which flow ids are currently registered as tools. */
  private readonly registeredFlowIds = new Set<string>();

  constructor(opts: FlowMcpServerOptions) {
    this.flowRegistry = opts.flowRegistry;
    this.graphEngine = opts.graphEngine;
    this.inputGuardrail = opts.inputGuardrail;
    this.authorizationEnabled = opts.authorizationEnabled ?? true;
    this.flowAuthorizer = opts.flowAuthorizer;
    this.jwtVerifier = opts.jwtVerifier;
    this.flowScopeClaims = opts.flowScopeClaims;
    this.admission = opts.admission;
    this.logger = opts.logger;
    this.serverName = opts.serverName ?? "aiperator";
    this.serverVersion = opts.serverVersion ?? "1.0.0";

    // Log the initial tool surface. Tools themselves are registered per
    // request — see `handleRequest`.
    this.syncTools();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Serves one MCP HTTP request on its own `McpServer` + transport pair.
   *
   * A stateless `WebStandardStreamableHTTPServerTransport` (no
   * `sessionIdGenerator`) refuses to handle a second request — reusing one
   * would collide JSON-RPC message ids between unrelated clients, so the SDK
   * throws "Stateless transport cannot be reused across requests". Since an
   * `McpServer` may connect to exactly one transport, both are created per
   * request and closed afterwards. Tools are (re)registered from the live flow
   * registry each time, which also makes hot-reload immediate.
   */
  createServer(callerToken?: string, principal?: AuthPrincipal): McpServer {
    const mcp = new McpServer({
      name: this.serverName,
      version: this.serverVersion,
    });
    this.registerFlowTools(mcp, callerToken, principal);
    return mcp;
  }

  async handleRequest(
    req: Request,
    callerToken?: string,
    principal?: AuthPrincipal,
  ): Promise<Response> {
    const mcp = this.createServer(callerToken, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // Release the per-request pair. The response body has already been
      // produced by the transport, so closing here cannot truncate it.
      void mcp.close().catch(() => {});
    }
  }

  syncTools(): void {
    const current = new Set(this.flowRegistry.list().map((f) => f.id));

    for (const id of this.registeredFlowIds) {
      if (!current.has(id)) {
        this.registeredFlowIds.delete(id);
        this.logger?.info("[FlowMcpServer] flow removed from tool registry", {
          flowId: id,
        });
      }
    }
    for (const id of current) {
      if (this.registeredFlowIds.has(id)) continue;
      this.registeredFlowIds.add(id);
      this.logger?.info("[FlowMcpServer] flow registered as MCP tool", {
        flowId: id,
      });
    }
  }

  /** Registers one tool per flow currently authorized for this caller. */
  private registerFlowTools(
    mcp: McpServer,
    callerToken?: string,
    principal?: AuthPrincipal,
  ): void {
    const discoveryClaims =
      principal?.claims ??
      this.jwtVerifier?.decodePayload(callerToken ?? "") ??
      undefined;
    const discoveryContext: RequestContext = {
      ssoToken: callerToken ?? "",
      executionId: crypto.randomUUID(),
      ...(discoveryClaims !== undefined ? { claims: discoveryClaims } : {}),
      ...(principal?.tenantId !== undefined
        ? { clientId: principal.tenantId }
        : {}),
    };
    for (const flow of this.flowRegistry.list()) {
      if (
        !decideFlowAccess(
          flow,
          discoveryContext,
          this.flowAuthorizer,
          this.flowScopeClaims,
          this.authorizationEnabled,
        ).allowed
      ) {
        continue;
      }
      const description =
        flow.description ?? flow.name ?? `Run the '${flow.id}' aiperator flow.`;

      // Capture for the closure.
      const flowId = flow.id;
      const engine = this.graphEngine;
      const guardrail = this.inputGuardrail;
      const authorizer = this.flowAuthorizer;
      const verifier = this.jwtVerifier;
      const scopeClaims = this.flowScopeClaims;
      const admission = this.admission;
      const log = this.logger;

      registerFlowTool(
        mcp,
        flowId,
        description,
        async (
          args,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
          const { message, conversation_id, user_email, client_id } = args;

          // ── Input guardrail ───────────────────────────────────────────────
          if (guardrail !== undefined) {
            const result = guardrail.scan([{ role: "user", content: message }]);
            if (result.flagged) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: `Input blocked by guardrail: prompt injection detected (score ${result.score.toFixed(2)}).`,
                  },
                ],
              };
            }
          }

          // The route verifies the bearer credential before it reaches this
          // transport and passes it explicitly. `authInfo` is retained only for
          // non-HTTP transports used by embedders and tests.
          const authenticatedToken = callerToken ?? extra.authInfo?.token ?? "";
          const claims =
            principal?.claims ??
            verifier?.decodePayload(authenticatedToken) ??
            undefined;
          const trustedTenantId = principal?.tenantId ?? client_id;
          const ctx: RequestContext = {
            ssoToken: authenticatedToken,
            executionId: crypto.randomUUID(),
            ...(claims !== undefined ? { claims } : {}),
            ...(user_email !== undefined ? { userEmail: user_email } : {}),
            ...(trustedTenantId !== undefined
              ? { clientId: trustedTenantId }
              : {}),
            requestParams: {
              ...(conversation_id !== undefined ? { conversation_id } : {}),
            },
          };

          // ── Access check (uses full RequestContext) ───────────────────────
          const currentFlow = this.flowRegistry.get(flowId);
          const decision =
            currentFlow === undefined
              ? { allowed: false, reason: "Flow is no longer available." }
              : decideFlowAccess(
                  currentFlow,
                  ctx,
                  authorizer,
                  scopeClaims,
                  this.authorizationEnabled,
                );
          if (!decision.allowed) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: `Access denied: ${decision.reason ?? `not authorised to call flow '${flowId}'`}.`,
                  },
                ],
              };
          }

          // ── Shared admission (authz, compliance, capacity, budget, limits, BYOK) ──
          if (admission !== undefined) {
            const admitted = await admission.admit(flowId, ctx);
            if (!admitted.allowed) {
              return {
                isError: true,
                content: [{ type: "text" as const, text: `Execution denied: ${admitted.failure.message}` }],
              };
            }
          }

          // ── Build messages ────────────────────────────────────────────────
          const messages: ChatMessage[] = [{ role: "user", content: message }];

          // ── Execute flow ──────────────────────────────────────────────────
          const textParts: string[] = [];

          try {
            await engine.executeFlow(
              flowId,
              messages,
              ctx,
              async (chunk) => {
                const delta = chunk.choices[0]?.delta?.content;
                if (typeof delta === "string" && delta.length > 0) {
                  textParts.push(delta);
                }
              },
              async () => {}, // onDone (usage) — not surfaced to MCP caller
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log?.error("[FlowMcpServer] flow execution failed", {
              flowId,
              error: msg,
            });
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Flow execution failed: ${msg}`,
                },
              ],
            };
          }

          const responseText = textParts.join("");
          log?.info("[FlowMcpServer] flow executed via MCP", {
            flowId,
            executionId: ctx.executionId,
            responseLength: responseText.length,
          });

          return {
            content: [
              { type: "text" as const, text: responseText || "(no response)" },
            ],
          };
        },
      );

    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFlowMcpServer(opts: FlowMcpServerOptions): FlowMcpServer {
  return new FlowMcpServerImpl(opts);
}

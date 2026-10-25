// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * handlers/mcp.ts
 *
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 *
 * Exposes the vectorsearch capabilities as MCP tools so any MCP-compatible
 * LLM agent (Claude Desktop, Cursor, Continue, …) can use this service
 * directly without custom HTTP wrappers.
 *
 * Transport
 * ─────────
 * Streamable HTTP (POST /mcp + GET /mcp + DELETE /mcp) — the current MCP
 * standard as of spec 2025-03-26.  Sessions are stateful: the server assigns
 * a session ID on initialisation and subsequent requests must echo it back
 * via the `Mcp-Session-Id` header.
 *
 * Auth
 * ────
 * The /mcp routes are protected by the same Bearer-token auth middleware as
 * every other route in the app. The MCP client must pass the token in the
 * Authorization header.
 *
 * Tools exposed
 * ─────────────
 *   search           — semantic / hybrid / FTS search
 *   ingest           — add or update a document
 *   delete_document  — remove a document by reference
 *   list_collections — list available collections
 *   collection_stats — count documents/chunks (optionally folder-scoped)
 *   collection_overview — rich stats: sizes, folders, summary coverage, config
 *   list_documents   — enumerate documents (folder-scoped, paginated)
 *   list_folders     — explore the folder structure
 *   find_folders     — resolve a folder name to its path anywhere in the tree
 *   get_document     — reassemble one document from its chunks
 *   get_thread       — read an e-mail thread's messages chronologically
 *   get_document_asset — fetch one authorized original figure as MCP image content
 *   get_documents    — reassemble every document beneath a folder
 *   get_summary      — stored summary of one document
 *   get_summaries    — stored summaries across a collection/folder
 *
 * All tool calls (including the read-only list/get tools) emit activity events
 * so they appear on the Activity page. Read-only lookups use type "query".
 *
 * Each tool maps 1:1 to the underlying PostgresClient / EmbeddingClient calls
 * so it shares all existing retry, circuit-breaker, and cache logic.
 */

import type { TokenCounter } from "../token-counter.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import {
  jsonRpcErrorBody,
  MCP_2026_PROTOCOL_VERSION,
  paginate,
  statelessEnvelope,
  validateStatelessRequest,
} from "@atf/mcp-2026";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AccessDeniedError,
  accessScopeForMcp,
  accessScopeFromPrincipal,
  authorizationOperationForTool,
  principalFingerprint,
  requireAuthorization,
  requireCollectionAccess,
  type AuthzEnforcement,
} from "../access-scope.js";
import { emitActivity } from "../activity-emitter.js";
import type { DocumentGroup } from "../document-identity.js";
import type { EmbeddingClient } from "../embedding-client.js";
import type { HydeClient } from "../hyde-client.js";
import type { ChunkingOptions } from "../ingest-jobs.js";
import {
  MemoryInvocationLedger,
  invocationFingerprint,
  type InvocationLedger,
} from "../invocation-ledger.js";
import type { PostgresClient } from "../postgres-client.js";
import type { QueryEmbeddingCache } from "../query-cache.js";
import { getAmbientPrincipal, getPrincipal, runWithPrincipal } from "../request-principal.js";
import type { RerankerClient } from "../reranker-client.js";
import type { SparseEmbeddingClient } from "../sparse-embedding-client.js";
import type { SummaryClient } from "../summary-client.js";
import {
  TransactionError,
  enforceToolScope,
  extractTransactionToken,
  getTransactionContext,
  isTransactionError,
  runWithTransaction,
  stableHash,
  transactionCorrelation,
  verifyTransactionToken,
  type TransactionConfig,
} from "../transaction-context.js";
import { getUsageContext } from "../usage-context.js";
import { newActivityId } from "./activity-stream.js";
import { registerNavigationTools } from "./mcp-nav.js";
import type { McpToolContext } from "./mcp-tool-ctx.js";
import { registerRetrieveForAnswerTool } from "./mcp-retrieve-for-answer-tool.js";
import { registerTransactionTools } from "./mcp-transaction.js";
import { registerSearchTool } from "./mcp-search-tool.js";
import { registerTraceTool } from "./mcp-trace-tool.js";
import { registerDocumentDiffTool } from "./mcp-document-diff-tool.js";
import { registerIngestTools } from "./mcp-ingest.js";
import { registerCatalogTools } from "./mcp-catalog.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Behaviour hints every Search tool declares. Clients act on them: the Runtime
 * retries only read-only or idempotent tools and lets only `readOnlyHint` tools
 * run in shadow and replay runs, so an unannotated lookup tool would be blocked
 * there. Every tool must be listed — registering one that is missing fails at
 * startup instead of silently shipping without hints.
 */
export const SEARCH_TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = (() => {
  const lookup: ToolAnnotations = {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  };
  const readOnly = [
    "search",
    "list_collections",
    "collection_stats",
    "collection_overview",
    "list_documents",
    "list_folders",
    "find_folders",
    "get_document",
    "get_thread",
    "get_document_asset",
    "get_documents",
    "get_summary",
    "get_summaries",
    "get_outline",
    "get_section",
    "get_pages",
    "get_context",
    "list_figures",
    "get_table",
    "find_identifier",
    "trace",
    "document_diff",
    "follow_ref",
    "get_asset",
    "transaction_capabilities",
    "retrieve_evidence",
    "retrieve_for_answer",
    "verified_evidence_pack",
  ];
  return {
    ...Object.fromEntries(readOnly.map((name) => [name, lookup])),
    // Re-ingesting the same reference replaces it, so a retry is safe.
    ingest: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    delete_document: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  };
})();

export interface McpHandlerOptions {
  embeddingClient: EmbeddingClient;
  postgresClient: PostgresClient;
  sparseClient: SparseEmbeddingClient | null;
  queryCache: QueryEmbeddingCache | null;
  rerankerClient?: RerankerClient | null;
  /** Tokenizer for token-fitted rerank inputs (shared with `/v2/search`). */
  tokenCounter?: TokenCounter | null;
  /**
   * HyDE client forwarded from server config. When set and a search tool call
   * passes `hyde: true`, the query is expanded into a hypothetical document
   * before embedding (better recall on natural-language questions).
   * null = HyDE disabled for MCP search.
   */
  hydeClient?: HydeClient | null;
  logger: Logger;
  defaultCollection?: string;
  hybridSearchDefault?: boolean;
  candidateMultiplier?: number;
  /**
   * MIN_RERANK_SCORE (Requirement 4.8): server-side relevance threshold for
   * the search tool, used when the call omits its per-request `minScore`.
   * null / undefined = disabled (the tool keeps its per-request-only behavior).
   */
  minRerankScore?: number | null;
  /**
   * SEARCH_MAX_QUERY_CHARS: over-long query texts are cut at the last space
   * before this limit (query-limits.ts); the tools report `query_truncated`.
   */
  maxQueryChars?: number;
  /**
   * SEARCH_GROUP_MAX_CHUNKS_PER_DOCUMENT: best-scoring chunks kept per
   * document by `group_by_document`; a cut document reports `truncated`
   * and `omitted_chunks`.
   */
  groupMaxChunksPerDocument?: number;
  /** SEARCH_MCP_PRETTY_JSON: indent the `search` tool's JSON. Default false. */
  mcpPrettyJson?: boolean;
  /** SEARCH_EVIDENCE_SIGNING_KEY, parsed: signs verified evidence packs. */
  evidenceSigningKey?: import("../evidence-signing.js").EvidenceSigningKey | null;
  /** Chunking options forwarded from server config. null = no chunking. */
  chunkingOptions?: ChunkingOptions | null;
  /**
   * Summary client forwarded from server config.
   * When set and chunkingOptions.useSummarization is true, MCP ingest uses
   * the same LLM-summarization pipeline as the REST /ingest endpoint.
   * null = summarization disabled for MCP ingest.
   */
  summaryClient?: SummaryClient | null;
  /** Transaction Envelope v1 verification and enforcement settings. */
  transactionConfig: TransactionConfig;
  /** Shared durable ledger in production; defaults to an explicit single-process memory ledger. */
  invocationLedger?: InvocationLedger;
  /** AuthZ enforcement shared with the REST route policy. */
  authzEnforcement: AuthzEnforcement;
  /** Service identity advertised by both MCP transports. */
  serviceName?: string;
  serviceVersion?: string;
  /** Embedding provenance persisted on first collection creation. */
  embeddingModel?: string;
  embeddingModelRevision?: string;
  /**
   * The v2 AssetStore, for the navigation `get_asset` tool's
   * variant reads + metadata (fail-closed). Null/omitted disables `get_asset`.
   */
  assetStore?: import("../asset-store.js").AssetStore | null;
  /**
   * The render-cache, for `get_asset`'s optional `region` zoom.
   * Null/omitted (Extract not configured) disables the region zoom path only.
   */
  renderCache?: import("../render-cache.js").RenderCache | null;
}

// ─── Per-session transport store ──────────────────────────────────────────────
// Streamable HTTP is stateful: one McpServer + one transport per session.
// Sessions are cleaned up when the transport closes (client disconnects or
// calls DELETE /mcp), OR when the TTL expires (stale/abandoned sessions).

/** TTL for idle sessions: 30 minutes. */
const SESSION_TTL_MS = 30 * 60 * 1000;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Timestamp of the last request on this session (ms). */
  lastActivity: number;
  principalFingerprint: string;
}

// ─── Activity helper ──────────────────────────────────────────────────────────

/**
 * Emit a "query" activity event for a read-only MCP tool call so it shows up
 * on the Activity page alongside ingest/search/delete. `tool` is the MCP tool
 * name (e.g. "get_summary"), `summary` a human-readable one-liner.
 */
function emitQueryActivity(params: {
  tool: string;
  summary: string;
  status: "ok" | "error";
  startTime: number;
  detail: Record<string, unknown>;
}): void {
  const usage = getUsageContext();
  emitActivity({
    id: newActivityId(),
    tenantId: getAmbientPrincipal()?.tenantId,
    type: "query",
    status: params.status,
    summary: `${params.tool}: ${params.summary}`,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - params.startTime,
    detail: { tool: params.tool, source: "mcp", ...transactionCorrelation(), ...params.detail },
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cost: usage.cost,
          modelCosts: usage.modelCosts,
        }
      : undefined,
  });
}

// ─── Tool builder ─────────────────────────────────────────────────────────────

function buildMcpServer(opts: McpHandlerOptions): McpServer {
  // The tool-option scalars (defaults included) are forwarded verbatim via
  // `toolCtx` below; only the helpers the registration boundary needs are
  // destructured here.
  const { postgresClient, logger, defaultCollection = "documents" } = opts;

  const authorize = async (collection: string) => {
    const scope = accessScopeForMcp();
    const acl = await requireCollectionAccess(
      postgresClient,
      collection,
      scope,
    );
    return { scope, acl };
  };

  /** The e-mail thread / attachment parent a document belongs to, if any. */
  const documentGroupOf = async (
    collection: string,
    baseRef: string,
  ): Promise<DocumentGroup | undefined> => {
    if (postgresClient.resolveDocumentGroups === undefined) return undefined;
    const res = await postgresClient.resolveDocumentGroups(
      collection,
      accessScopeForMcp(),
      [baseRef],
    );
    return res.ok ? res.result.get(baseRef) : undefined;
  };

  const server = new McpServer({
    name: "vectorsearch",
    version: "1.0.0",
  });

  // One registration boundary guarantees identical Fabric scope and idempotency
  // semantics for every tool, including tools added later.
  const rawTool = server.tool.bind(server);
  server.tool = ((...registration: unknown[]) => {
    const tool = String(registration[0]);
    const handlerIndex = registration.length - 1;
    const handler = registration[handlerIndex] as (
      args: unknown,
      extra: unknown,
    ) => Promise<unknown>;
    registration[handlerIndex] = async (args: unknown, extra: unknown) => {
      const scope = accessScopeForMcp();
      // Re-evaluate against the current verified request principal immediately
      // before every invocation; session state is never an authorization grant.
      // Capability negotiation is authenticated and principal-bound at the
      // transport boundary, but must not require domain-specific search scopes:
      // orchestrators need this document before they can mint an envelope.
      if (tool !== "transaction_capabilities") {
        requireAuthorization(
          scope,
          authorizationOperationForTool(tool),
          opts.authzEnforcement,
          tool,
        );
      }
      enforceToolScope(tool);
      const context = getTransactionContext();
      const envelope = context?.envelope;
      if (!envelope || context.legacy) return handler(args, extra);

      const principal = accessScopeForMcp().principal;
      const key = stableHash(
        JSON.stringify([
          principalFingerprint(principal),
          envelope.executionId,
          envelope.invocationId,
        ]),
      );
      const fingerprint = invocationFingerprint(
        tool,
        args,
        envelope.executionId,
      );
      const claim = await opts.invocationLedger!.claim(key, fingerprint);
      if (claim.kind === "replay") return claim.record.result;
      if (claim.kind !== "claimed") {
        const code =
          claim.kind === "mismatch"
            ? "IDEMPOTENCY_KEY_MISMATCH"
            : claim.kind === "in_flight"
              ? "INVOCATION_IN_FLIGHT"
              : "INVOCATION_TERMINAL";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code,
                category: "conflict",
                retryable: false,
                outcome: claim.record.state,
                ...transactionCorrelation(),
              }),
            },
          ],
          isError: true,
        };
      }

      await opts.invocationLedger!.transition(key, fingerprint, "running");
      const mutating = tool === "ingest" || tool === "delete_document";
      try {
        const result = (await handler(args, extra)) as { isError?: boolean };
        await opts.invocationLedger!.transition(
          key,
          fingerprint,
          result?.isError ? "failed" : "committed",
          result,
        );
        return result;
      } catch (cause) {
        await opts.invocationLedger!.transition(
          key,
          fingerprint,
          mutating ? "outcome_unknown" : "failed",
        );
        throw cause;
      }
    };
    const annotations = SEARCH_TOOL_ANNOTATIONS[tool];
    if (annotations === undefined) {
      throw new Error(
        `MCP tool "${tool}" has no entry in SEARCH_TOOL_ANNOTATIONS; declare its readOnlyHint before registering it`,
      );
    }
    const registered = (rawTool as (...args: unknown[]) => {
      update: (updates: { annotations: ToolAnnotations }) => void;
    })(...registration);
    registered.update({ annotations });
    return registered;
  }) as typeof server.tool;

  // The tool implementations live in sibling modules (Requirement 13.6). They
  // register onto this same server, so they inherit the registration boundary
  // above: identical Fabric scope, authorization and idempotency semantics.
  const toolCtx: McpToolContext = {
    ...opts,
    server,
    authorize,
    documentGroupOf,
    emitQueryActivity,
  };
  registerTransactionTools(toolCtx);
  registerSearchTool(toolCtx);
  registerTraceTool(toolCtx);
  registerDocumentDiffTool(toolCtx);
  registerRetrieveForAnswerTool(toolCtx);
  registerIngestTools(toolCtx);
  registerCatalogTools(toolCtx);

  // ── v2 document-navigation tools ────────────────────────────────
  // Registered onto the SAME server so they inherit the one registration
  // boundary above (auth/scope/idempotency). Additive: the tools above are
  // untouched. `get_asset` uses the AssetStore + render-cache when configured.
  registerNavigationTools({
    server,
    postgresClient,
    logger,
    defaultCollection,
    authorize,
    accessScopeForMcp,
    emitQueryActivity,
    assetStore: opts.assetStore ?? null,
    renderCache: opts.renderCache ?? null,
  });

  return server;
}

// ─── Handler factory ──────────────────────────────────────────────────────────

/**
 * Returns a triple of Express RequestHandlers: [postHandler, getHandler, deleteHandler].
 * Mount them on the same path:
 *
 *   app.post("/mcp",    authMiddleware, mcpHandlers.post);
 *   app.get("/mcp",     authMiddleware, mcpHandlers.get);
 *   app.delete("/mcp",  authMiddleware, mcpHandlers.delete);
 *
 * Call mcpHandlers.close() during graceful shutdown to stop the session TTL
 * sweep timer.
 */
/**
 * The acting identity for an MCP tool call.
 *
 * Returns the ambient principal established by the MCP HTTP handlers. When none
 * is present the tool is running outside an authenticated request, which should
 * not happen — the routes are all mounted behind the auth middleware. Rather
 * than degrade to "no identity" (which the row filter reads as *see everything*),
 * this fails closed by returning an identity that cannot match any ACL, and logs
 * loudly so the wiring bug is visible.
 */
function _requireMcpPrincipal(logger: Logger): {
  userId: string | undefined;
  userGroups: string[] | undefined;
} {
  try {
    const scope = accessScopeForMcp();
    return { userId: scope.userId, userGroups: scope.userGroups };
  } catch (error) {
    logger.error(
      { error },
      "[MCP] No request principal in scope — failing closed",
    );
    return { userId: "\u0000no-principal", userGroups: undefined };
  }
}

export function createMcpHandlers(opts: McpHandlerOptions): {
  post: RequestHandler;
  get: RequestHandler;
  delete: RequestHandler;
  close(): void;
} {
  const { logger } = opts;
  opts.invocationLedger ??= new MemoryInvocationLedger();
  if (opts.invocationLedger.durability === "single-process") {
    logger.warn("[MCP] Invocation ledger uses single-process memory fallback; PostgreSQL durability is unavailable");
  }
  const sessions = new Map<string, Session>();

  // ── Session TTL cleanup ─────────────────────────────────────────────────
  // Periodically evict sessions that have been idle longer than SESSION_TTL_MS.
  // This handles clients that crash or disconnect without sending DELETE /mcp,
  // preventing unbounded memory growth in long-running deployments.
  const sessionSweepInterval = setInterval(
    () => {
      const cutoff = Date.now() - SESSION_TTL_MS;
      for (const [id, session] of sessions) {
        if (session.lastActivity < cutoff) {
          sessions.delete(id);
          logger.debug(
            { sessionId: id },
            "[MCP] Session evicted (TTL expired)",
          );
          // Close the transport gracefully so the McpServer can clean up.
          session.transport.close().catch(() => {});
        }
      }
    },
    5 * 60 * 1000,
  ); // sweep every 5 minutes
  sessionSweepInterval.unref();

  async function createSession(req: Request): Promise<Session> {
    const server = buildMcpServer(opts);
    const sessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: () => {
        sessions.set(sessionId, session);
        logger.debug({ sessionId }, "[MCP] Session created");
      },
    });
    const session: Session = {
      server,
      transport,
      lastActivity: Date.now(),
      principalFingerprint: principalFingerprint(getPrincipal(req)),
    };

    transport.onclose = () => {
      if (sessions.delete(sessionId)) {
        logger.debug({ sessionId }, "[MCP] Session closed");
      }
    };

    await server.connect(transport);
    return session;
  }

  /**
   * True only for protected JSON-RPC tool dispatch. Capability discovery is
   * intentionally unauthenticated at the transaction layer: an orchestrator
   * must discover the required v1 contract before it can mint a conforming
   * envelope. The surrounding MCP session still remains principal-bound.
   */
  const isProtectedToolCall = (body: unknown): boolean => {
    if (
      typeof body !== "object" ||
      body === null ||
      (body as Record<string, unknown>)["method"] !== "tools/call"
    ) {
      return false;
    }
    const params = (body as Record<string, unknown>)["params"];
    return !(
      typeof params === "object" &&
      params !== null &&
      (params as Record<string, unknown>)["name"] ===
        "transaction_capabilities"
    );
  };

  /**
   * Bind principal and transaction contexts at the transport boundary.
   *
   * Required transaction enforcement applies to `tools/call`, not to MCP
   * initialize, notifications, SSE GET, or session DELETE. Lifecycle requests
   * are already authenticated and principal-bound to the session, and normally
   * have no JSON-RPC `_meta` field in which a transaction token could live.
   */
  const withRequestContexts = async <T>(
    req: Request,
    fn: () => Promise<T>,
    enforceTransaction = isProtectedToolCall(req.body),
  ): Promise<T> => {
    const principal = getPrincipal(req);
    const rawHeader = req.headers["x-transaction-token"];
    const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const transaction = enforceTransaction
      ? await verifyTransactionToken(
          extractTransactionToken(req.body, headerToken),
          opts.transactionConfig,
          principal,
        )
      : { envelope: null, legacy: true };
    return runWithPrincipal(principal, () => runWithTransaction(transaction, fn));
  };

  const sessionMatches = (session: Session, req: Request): boolean =>
    session.principalFingerprint === principalFingerprint(getPrincipal(req));

  // POST: initialisation (no session ID) or regular tool calls (with session ID)
  const postHandler: RequestHandler = async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId) {
        // Existing session
        const session = sessions.get(sessionId);
        if (!session) {
          res.status(404).json({ error: "MCP session not found or expired" });
          return;
        }
        if (!sessionMatches(session, req)) {
          res.status(404).json({ error: "MCP session not found or expired" });
          return;
        }
        session.lastActivity = Date.now();
        await withRequestContexts(req, () =>
          session.transport.handleRequest(req, res, req.body),
        );
      } else {
        // New session — initialisation request
        const session = await createSession(req);
        await withRequestContexts(req, () =>
          session.transport.handleRequest(req, res, req.body),
        );
      }
    } catch (err) {
      if (isTransactionError(err) && !res.headersSent) {
        if (err.status === 503) res.set("Retry-After", "5");
        res.status(err.status).json(err.body);
        return;
      }
      logger.error({ err }, "[MCP] POST handler error");
      if (!res.headersSent)
        res.status(500).json({ code: "INTERNAL_ERROR", category: "internal", retryable: false, outcome: "failed" });
    }
  };

  // GET: SSE stream for server-to-client notifications
  const getHandler: RequestHandler = async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res
          .status(400)
          .json({ error: "Mcp-Session-Id header required for GET" });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session || !sessionMatches(session, req)) {
        res.status(404).json({ error: "MCP session not found or expired" });
        return;
      }
      session.lastActivity = Date.now();
      await withRequestContexts(req, () => session.transport.handleRequest(req, res));
    } catch (err) {
      logger.error({ err }, "[MCP] GET handler error");
      if (!res.headersSent)
        res.status(500).json({ error: "Internal MCP error" });
    }
  };

  // DELETE: explicit session teardown
  const deleteHandler: RequestHandler = async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (!sessionId) {
        res
          .status(400)
          .json({ error: "Mcp-Session-Id header required for DELETE" });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session || !sessionMatches(session, req)) {
        res.status(404).json({ error: "MCP session not found or expired" });
        return;
      }
      await withRequestContexts(req, () => session.transport.handleRequest(req, res));
      // The transport.onclose callback handles sessions.delete()
    } catch (err) {
      logger.error({ err }, "[MCP] DELETE handler error");
      if (!res.headersSent)
        res.status(500).json({ error: "Internal MCP error" });
    }
  };

  return {
    post: postHandler,
    get: getHandler,
    delete: deleteHandler,
    /** Stop the TTL sweep timer. Call during graceful shutdown. */
    close(): void {
      clearInterval(sessionSweepInterval);
    },
  };
}


// ─── Stateless MCP 2026-07-28 adapter ───────────────────────────────────────

export { MCP_2026_PROTOCOL_VERSION };

interface Mcp2026Body {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

interface SharedRegisteredTool {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
  enabled: boolean;
  handler: (...args: unknown[]) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

function mcp2026Header(req: Request, name: string): string | undefined {
  const value = req.get(name)?.trim();
  return value || undefined;
}

function mcp2026Error(res: Response, status: number, id: unknown, code: number, message: string): void {
  res.status(status).json(jsonRpcErrorBody(id, code, message));
}

/**
 * Compact human-readable summary of Zod issues for tool-call 400s, e.g.
 * `granularity: Invalid option: expected one of "chunk"|"section"|...`.
 * Models act on this message, so it must name the offending parameter and the
 * expected values instead of a bare "Invalid tool arguments".
 */
function describeToolArgumentIssues(issues: z.ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Offset pagination with the transaction-error vocabulary of this service. */
function mcp2026Page<T>(items: T[], params: Record<string, unknown>): { items: T[]; nextCursor?: string } {
  return paginate(items, params, {
    invalidPageSize: () =>
      new TransactionError(
        400,
        {
          code: "INVALID_PAGE_SIZE",
          category: "validation",
          retryable: false,
          outcome: "denied",
        },
        "pageSize must be an integer between 1 and 1000",
      ),
    invalidCursor: () =>
      new TransactionError(
        400,
        {
          code: "INVALID_CURSOR",
          category: "validation",
          retryable: false,
          outcome: "denied",
        },
        "Invalid pagination cursor",
      ),
  });
}

/**
 * Stateless 2026 transport over the exact catalog built for the 2025 server.
 * The SDK registry remains the single registration boundary; this adapter only
 * translates discovery/list/call framing and invokes the already wrapped
 * handlers, preserving validation, ACL, activity, scope and ledger semantics.
 */
export function createMcp2026Handlers(
  opts: McpHandlerOptions,
  path = "/mcp/v2026",
): { path: string; post: RequestHandler; get: RequestHandler; delete: RequestHandler } {
  opts.invocationLedger ??= new MemoryInvocationLedger();
  const catalogServer = buildMcpServer(opts);
  const tools = (catalogServer as unknown as { _registeredTools: Record<string, SharedRegisteredTool> })._registeredTools;
  const serverInfo = {
    name: opts.serviceName ?? "vectorsearch",
    version: opts.serviceVersion ?? "1.0.0",
    protocolVersion: MCP_2026_PROTOCOL_VERSION,
    endpoint: path,
    transport: "stateless-http",
  };
  const envelope = (fields: Record<string, unknown>) =>
    statelessEnvelope(serverInfo, fields);

  const post: RequestHandler = async (req, res) => {
    const body = (req.body ?? {}) as Mcp2026Body;
    try {
      const validation = validateStatelessRequest(
        (name) => mcp2026Header(req, name),
        body,
        { requireJsonrpc20: true, namedMethods: ["tools/call"] },
      );
      if (!validation.ok) {
        mcp2026Error(res, 400, body.id, validation.code, validation.message);
        return;
      }
      const { method } = validation;
      const params = validation.params;

      const principal = getPrincipal(req);
      let result: Record<string, unknown>;
      if (method === "server/discover") {
        result = {
          resultType: "complete",
          serverInfo,
          capabilities: { tools: { list: true, call: true, pagination: true } },
          extensions: {
            "io.modelcontextprotocol/transaction": {
              schemaVersion: "v1",
              tokenLocations: ["params._meta[transaction/token]", "X-Transaction-Token"],
              trace: true,
              deadline: true,
              idempotency: true,
            },
          },
          _meta: { serverInfo },
        };
      } else if (method === "tools/list") {
        const scope = accessScopeFromPrincipal(principal);
        const definitions = Object.entries(tools)
          .filter(([name, tool]) => {
            if (!tool.enabled) return false;
            if (name === "transaction_capabilities") return true;
            try {
              requireAuthorization(scope, authorizationOperationForTool(name), opts.authzEnforcement, name);
              return true;
            } catch {
              return false;
            }
          })
          .map(([name, tool]) => ({
            name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema ? z.toJSONSchema(tool.inputSchema) : { type: "object", properties: {} },
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
            ...(tool._meta ? { _meta: tool._meta } : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const page = mcp2026Page(definitions, params);
        result = envelope({ tools: page.items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
      } else if (method === "tools/call") {
        const name = String(params["name"]);
        const tool = tools[name];
        if (!tool?.enabled) {
          mcp2026Error(res, 404, body.id, -32601, "Tool not found");
          return;
        }
        const args = params["arguments"] ?? {};
        const parsed = tool.inputSchema ? await tool.inputSchema.safeParseAsync(args) : { success: true as const, data: undefined };
        if (!parsed.success) {
          mcp2026Error(res, 400, body.id, -32602, `Invalid tool arguments: ${describeToolArgumentIssues(parsed.error.issues)}`);
          return;
        }

        const rawHeader = req.headers["x-transaction-token"];
        const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
        const paramsMeta = typeof params["_meta"] === "object" && params["_meta"] !== null
          ? params["_meta"] as Record<string, unknown>
          : {};
        const mergedMeta = { ...(body._meta ?? {}), ...paramsMeta };
        const transactionIdHeader = mcp2026Header(req, "Mcp-Transaction-Id");
        const deadlineHeader = mcp2026Header(req, "Mcp-Deadline");
        const traceparentHeader = mcp2026Header(req, "traceparent");
        const transactionId = transactionIdHeader ?? (typeof mergedMeta["io.modelcontextprotocol/transactionId"] === "string" ? mergedMeta["io.modelcontextprotocol/transactionId"] : undefined);
        const deadlineValue =
          deadlineHeader ??
          mergedMeta["transaction/deadlineAt"] ??
          mergedMeta["io.modelcontextprotocol/deadline"];
        const traceparent = traceparentHeader ?? (typeof mergedMeta["traceparent"] === "string" ? mergedMeta["traceparent"] : undefined);
        const transactionBody = { ...body, params: { ...params, _meta: mergedMeta } };
        const transaction = name === "transaction_capabilities"
          ? { envelope: null, legacy: true }
          : await verifyTransactionToken(extractTransactionToken(transactionBody, headerToken), opts.transactionConfig, principal);
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Request aborted"));
        req.once("aborted", abort);
        res.once("close", () => { if (!res.writableEnded) abort(); });
        const envelopeDeadline = transaction.envelope?.trace.deadlineAt;
        const rawDeadline = deadlineValue ?? envelopeDeadline;
        const deadlineAt = (() => {
          if (typeof rawDeadline === "number") {
            return rawDeadline < 10_000_000_000 ? rawDeadline * 1000 : rawDeadline;
          }
          if (typeof rawDeadline !== "string") return undefined;
          const numericDeadline = Number(rawDeadline.trim());
          if (rawDeadline.trim() !== "" && Number.isFinite(numericDeadline)) {
            return numericDeadline < 10_000_000_000 ? numericDeadline * 1000 : numericDeadline;
          }
          return Date.parse(rawDeadline);
        })();
        if (deadlineAt !== undefined && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())) {
          req.off("aborted", abort);
          mcp2026Error(res, 408, body.id, -32008, "TRANSACTION_DEADLINE_EXCEEDED"); return;
        }
        const deadlineTimer = deadlineAt === undefined ? undefined : setTimeout(
          () => controller.abort(new Error("Deadline exceeded")),
          Math.max(1, deadlineAt - Date.now()),
        );
        deadlineTimer?.unref();
        const call = await runWithPrincipal(principal, () => runWithTransaction(transaction, async () =>
          await tool.handler(parsed.data, {
            signal: controller.signal,
            requestId: String(body.id ?? randomUUID()),
            sendNotification: async () => {},
            sendRequest: async () => { throw new Error("Server requests are unavailable on stateless MCP"); },
          }),
        ));
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        req.off("aborted", abort);
        result = {
          resultType: "complete",
          ...call,
          _meta: {
            serverInfo,
            ...transactionCorrelation(),
            ...(transactionId ? { transactionId } : {}),
            ...(traceparent ? { traceparent } : {}),
            ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          },
        };
      } else {
        mcp2026Error(res, 404, body.id, -32601, "Method not found"); return;
      }
      res.json({ jsonrpc: "2.0", id: body.id ?? null, result });
    } catch (err) {
      if (isTransactionError(err)) {
        if (err.status === 503) res.set("Retry-After", "5");
        mcp2026Error(res, err.status, body.id, -32001, err.body.code); return;
      }
      if (err instanceof AccessDeniedError) {
        mcp2026Error(res, 403, body.id, -32003, "Access denied"); return;
      }
      opts.logger.error({ err }, "[MCP 2026] request failed");
      mcp2026Error(res, 500, body.id, -32603, "Internal error");
    }
  };
  const methodNotAllowed: RequestHandler = (_req, res) => mcp2026Error(res, 405, null, -32600, "Method not allowed");
  return { path, post, get: methodNotAllowed, delete: methodNotAllowed };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { authContextFingerprint } from "../cache.ts";
import express, { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type Authenticator, AuthError, extractBearer } from "../auth/authenticator.ts";
import type { AuthContext } from "../auth/context.ts";
import { bearerChallenge } from "../auth/well-known.ts";
import type { GovernanceConfig, ServerConfig } from "../config/schema.ts";
import type { MonitorBus } from "../monitor/events.ts";
import type { IdentityRateLimiter } from "../server/identity-rate-limit.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ApprovalConsumptionStore } from "./approval-store.ts";
import type { GovernancePolicyRef } from "./governance.ts";
import { createMcpServer } from "./server.ts";
import { SessionStore } from "./session-store.ts";
import { logger, isDebugEnabled } from "../logger.ts";
import type { TransactionFabric } from "../transaction/fabric.ts";

export interface StreamableDeps {
  serverConfig: ServerConfig;
  authenticator: Authenticator;
  registry: ToolRegistry;
  bus: MonitorBus;
  instructions?: () => string | undefined;
  identityRateLimiter?: IdentityRateLimiter;
  transactionFabric?: TransactionFabric;
  authorizationEnabled?: boolean;
  policies?: GovernanceConfig;
  /** Shared compiled policy holder, hot-reloaded by `buildApp` (Req 6.3). */
  policyRef?: GovernancePolicyRef;
  /** Shared redeemed-JTI store for approval tokens (Req 6.1). */
  approvalStore?: ApprovalConsumptionStore;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  ctx: AuthContext;
}

/**
 * Wrap transport.send so every outbound write is logged at DEBUG level.
 * At INFO and above the wrapper is a transparent no-op, so there is zero
 * serialisation overhead in production.
 */
function instrumentTransport(transport: StreamableHTTPServerTransport, sessionId: string): void {
  if (!isDebugEnabled()) return;
  const orig = transport.send.bind(transport);
  (transport as unknown as { send: (m: unknown, o?: unknown) => Promise<void> }).send = async (
    message: unknown,
    options?: unknown,
  ) => {
    let bytes = -1;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    } catch {
      /* best-effort */
    }
    const id = (message as { id?: unknown })?.id;
    const t = Date.now();
    logger.debug("transport.send start", { session: sessionId, id: String(id), bytes });
    try {
      await orig(message as Parameters<typeof orig>[0], options as Parameters<typeof orig>[1]);
      logger.debug("transport.send done", {
        session: sessionId,
        id: String(id),
        ms: Date.now() - t,
      });
    } catch (err) {
      logger.debug("transport.send error", {
        session: sessionId,
        id: String(id),
        error: (err as Error).message,
      });
      throw err;
    }
  };
}

/** Headers safe to surface to the monitor (Authorization/Cookie are dropped). */
function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization" || k.toLowerCase() === "cookie") continue;
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** Returns only a bounded request hint; it is not an authenticated tool identity. */
function requestedTool(req: Request): string | undefined {
  const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
  const name = body?.method === "tools/call" ? body.params?.name : undefined;
  return typeof name === "string" && /^[\w.:-]{1,128}$/.test(name) ? name : undefined;
}

/** Non-reversible correlation id for an invalid bearer; never log the raw token. */
function tokenFingerprint(token: string | undefined): string | undefined {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : undefined;
}

/**
 * Express router for the MCP Streamable HTTP transport:
 *   POST   {mcpPath}  — initialize or dispatch JSON-RPC message
 *   GET    {mcpPath}  — open optional server→client SSE notification stream
 *   DELETE {mcpPath}  — terminate a session
 */
export function createStreamableRouter(deps: StreamableDeps): Router {
  const { serverConfig, authenticator, registry, bus } = deps;
  const router = Router();
  const sessions = new SessionStore<Session>(
    serverConfig.sessions,
    (sessionId, session, idleMs) => {
      // Close the transport so the client sees a terminated session rather than
      // a silently dead one, and emit the disconnection for the monitor/audit.
      try {
        void session.transport.close?.();
      } catch {
        /* best-effort */
      }
      bus.publish({
        tenantId: session.ctx.tenantId,
        type: "disconnection",
        sessionId,
        username: session.ctx.username,
        message: `Session evicted after ${Math.round(idleMs / 1000)}s idle`,
      });
    },
  );
  // Expose the sweeper for shutdown; the timer is unref'd so it never blocks.
  (router as unknown as { stopSessions?: () => void }).stopSessions = () => sessions.stop();

  router.use(serverConfig.mcpPath, express.json({ limit: "4mb" }));

  async function authenticate(req: Request, res: Response): Promise<AuthContext | undefined> {
    const token = extractBearer(req.headers.authorization);
    try {
      return await authenticator.authenticate(token, req.headers as Record<string, unknown>);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      const message = err instanceof Error ? err.message : String(err);
      const sessionId = sessionIdOf(req);
      const session = sessionId ? sessions.get(sessionId) : undefined;
      const fingerprint = tokenFingerprint(token);
      bus.publish({
        tenantId: session?.ctx.tenantId,
        type: "auth_failure",
        sessionId,
        username: session?.ctx.username,
        subject: session?.ctx.subject,
        tool: requestedTool(req),
        status: "error",
        message,
        headers: redactHeaders(req.headers as Record<string, unknown>),
        meta: { ...(fingerprint ? { tokenFingerprint: fingerprint } : {}) },
      });
      if (status === 401) {
        const challenge = bearerChallenge(serverConfig, authenticator.authConfig, message);
        res.set("WWW-Authenticate", challenge ?? "Bearer");
      }
      res.status(status).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: null,
      });
      return undefined;
    }
  }

  function sessionIdOf(req: Request): string | undefined {
    const raw = req.headers["mcp-session-id"];
    const id = Array.isArray(raw) ? raw[0] : raw;
    return id ? String(id) : undefined;
  }

  function sameSessionSecurityContext(left: AuthContext, right: AuthContext): boolean {
    const securityContext = (ctx: AuthContext): AuthContext => ({
      ...ctx,
      headers: Object.fromEntries(
        Object.entries(ctx.headers).filter(([name]) =>
          /(^|[-_])(tenant|security|organization|org)([-_]|$)/i.test(name),
        ),
      ),
      rawToken: "",
      sessionId: undefined,
    });
    const a = Buffer.from(authContextFingerprint(securityContext(left)), "hex");
    const b = Buffer.from(authContextFingerprint(securityContext(right)), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function rejectSessionContext(req: Request, res: Response, sessionId: string | undefined): void {
    bus.publish({
      type: "auth_failure",
      sessionId,
      status: "error",
      message: "Token security context does not match session",
      headers: redactHeaders(req.headers as Record<string, unknown>),
    });
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Token security context does not match session" },
      id: null,
    });
  }

  router.post(serverConfig.mcpPath, async (req: Request, res: Response) => {
    const ctx = await authenticate(req, res);
    if (!ctx) return;

    const existingId = sessionIdOf(req);
    let session = existingId ? sessions.get(existingId) : undefined;

    // Bind an existing session to the identity that created it. Because
    // authenticate() re-verifies the bearer on every POST, this also enforces
    // OAuth token expiry over the lifetime of the session.
    if (session && !sameSessionSecurityContext(ctx, session.ctx)) {
      rejectSessionContext(req, res, existingId);
      return;
    }

    if (!session) {
      if (existingId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session ID provided" },
          id: null,
        });
        return;
      }

      // Check the cap before building the transport/Server, so a refused
      // request costs nothing. Refusing is intentional: evicting a stranger's
      // live session to admit this one would hide the capacity problem.
      const reservation = sessions.tryReserve();
      if (!reservation.ok) {
        logger.warn("refused new MCP session: limit reached", {
          held: reservation.held,
          max: reservation.max,
          user: ctx.username,
        });
        bus.publish({
          tenantId: ctx.tenantId,
          type: "error",
          status: "error",
          username: ctx.username,
          message: reservation.reason,
        });
        res.set("Retry-After", "30");
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: reservation.reason },
          id: null,
        });
        return;
      }

      const sessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: () => {
          sessions.set(sessionId, { transport, ctx });
          bus.publish({
            tenantId: ctx.tenantId,
            type: "connection",
            sessionId,
            username: ctx.username,
            subject: ctx.subject,
            authMethod: ctx.method,
            status: "ok",
            headers: redactHeaders(req.headers as Record<string, unknown>),
          });
          bus.publish({
            tenantId: ctx.tenantId,
            type: "auth",
            sessionId,
            username: ctx.username,
            subject: ctx.subject,
            authMethod: ctx.method,
            status: "ok",
            meta: { scopes: ctx.scopes, claims: ctx.claims },
          });
        },
      });

      transport.onclose = () => {
        if (sessions.delete(sessionId)) {
          bus.publish({
            tenantId: ctx.tenantId,
            type: "disconnection",
            sessionId,
            username: ctx.username,
          });
        }
      };

      const server = createMcpServer(ctx, sessionId, {
        serverConfig,
        registry,
        bus,
        instructions: deps.instructions,
        identityRateLimiter: deps.identityRateLimiter,
        transactionFabric: deps.transactionFabric,
        authorizationEnabled: deps.authorizationEnabled,
        policies: deps.policies,
        policyRef: deps.policyRef,
        approvalStore: deps.approvalStore,
      });
      instrumentTransport(transport, sessionId);
      try {
        await server.connect(transport);
      } catch (err) {
        sessions.delete(sessionId);
        bus.publish({
          tenantId: ctx.tenantId,
          type: "error",
          sessionId,
          status: "error",
          message: `Failed to start MCP session: ${(err as Error).message}`,
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Failed to start MCP session" },
            id: null,
          });
        }
        return;
      }
      session = { transport, ctx };
    }

    const body = req.body as { method?: unknown; id?: unknown } | undefined;
    logger.debug("POST mcp", {
      session: existingId ?? "(new)",
      method: String(body?.method),
      id: String(body?.id),
      contentLength: req.headers["content-length"],
    });
    const t = Date.now();
    await session.transport.handleRequest(req, res, req.body);
    logger.debug("POST mcp handled", {
      session: existingId ?? "(new)",
      method: String(body?.method),
      ms: Date.now() - t,
      status: res.statusCode,
    });
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const ctx = await authenticate(req, res);
    if (!ctx) return;
    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unknown or expired session" },
        id: null,
      });
      return;
    }
    if (!sameSessionSecurityContext(ctx, session.ctx)) {
      rejectSessionContext(req, res, sessionId);
      return;
    }
    logger.debug(`${req.method} mcp session`, { session: sessionId });
    const t = Date.now();
    await session.transport.handleRequest(req, res);
    logger.debug(`${req.method} mcp handled`, {
      session: sessionId,
      ms: Date.now() - t,
      status: res.statusCode,
    });
  };

  router.get(serverConfig.mcpPath, handleSessionRequest);
  router.delete(serverConfig.mcpPath, handleSessionRequest);

  return router;
}

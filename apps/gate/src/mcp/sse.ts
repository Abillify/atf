// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { Router, type Request, type Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { type Authenticator, AuthError, extractBearer } from "../auth/authenticator.ts";
import type { AuthContext } from "../auth/context.ts";
import { bearerChallenge } from "../auth/well-known.ts";
import type { GovernanceConfig, ServerConfig } from "../config/schema.ts";
import type { MonitorBus } from "../monitor/events.ts";
import type { IdentityRateLimiter } from "../server/identity-rate-limit.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { createMcpServer } from "./server.ts";
import { SessionStore } from "./session-store.ts";
import { logger, isDebugEnabled } from "../logger.ts";
import { authContextFingerprint } from "../cache.ts";
import { timingSafeEqual } from "node:crypto";
import type { TransactionFabric } from "../transaction/fabric.ts";

export interface SseDeps {
  serverConfig: ServerConfig;
  authenticator: Authenticator;
  registry: ToolRegistry;
  bus: MonitorBus;
  instructions?: () => string | undefined;
  identityRateLimiter?: IdentityRateLimiter;
  transactionFabric?: TransactionFabric;
  authorizationEnabled?: boolean;
  policies?: GovernanceConfig;
}

interface Session {
  transport: SSEServerTransport;
  ctx: AuthContext;
}

/**
 * Wrap transport.send so every outbound SSE write is logged at DEBUG level.
 * At INFO and above the wrapper is a transparent no-op.
 */
function instrumentTransport(transport: SSEServerTransport, sessionId: string): void {
  if (!isDebugEnabled()) return;
  const orig = transport.send.bind(transport);
  (transport as unknown as { send: (m: unknown) => Promise<void> }).send = async (
    message: unknown,
  ) => {
    let bytes = -1;
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    } catch {
      /* best-effort */
    }
    const id = (message as { id?: unknown })?.id;
    const t = Date.now();
    logger.debug("sse send start", { session: sessionId, id: String(id), bytes });
    try {
      await orig(message as Parameters<typeof orig>[0]);
      logger.debug("sse send done", { session: sessionId, id: String(id), ms: Date.now() - t });
    } catch (err) {
      logger.debug("sse send error", {
        session: sessionId,
        id: String(id),
        error: (err as Error).message,
      });
      throw err;
    }
  };
}

function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization" || k.toLowerCase() === "cookie") continue;
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
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

/**
 * Express router for the legacy MCP HTTP+SSE transport:
 *   GET  {ssePath}       open the SSE stream (authenticated; establishes session)
 *   POST {messagePath}   deliver a client→server JSON-RPC message for a session
 */
export function createSseRouter(deps: SseDeps): Router {
  const { serverConfig, authenticator, registry, bus } = deps;
  const router = Router();
  const sessions = new SessionStore<Session>(
    serverConfig.sessions,
    (sessionId, session, idleMs) => {
      try {
        void session.transport.close?.();
      } catch {
        /* best-effort */
      }
      bus.publish({
        type: "disconnection",
        sessionId,
        username: session.ctx.username,
        message: `Session evicted after ${Math.round(idleMs / 1000)}s idle`,
      });
    },
  );
  (router as unknown as { stopSessions?: () => void }).stopSessions = () => sessions.stop();

  router.get(serverConfig.ssePath, async (req: Request, res: Response) => {
    let ctx: AuthContext;
    try {
      const token = extractBearer(req.headers.authorization);
      ctx = await authenticator.authenticate(token, req.headers as Record<string, unknown>);
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      const message = err instanceof Error ? err.message : String(err);
      bus.publish({
        type: "auth_failure",
        status: "error",
        message,
        headers: redactHeaders(req.headers as Record<string, unknown>),
      });
      if (status === 401) {
        const challenge = bearerChallenge(serverConfig, authenticator.authConfig, message);
        res.set("WWW-Authenticate", challenge ?? "Bearer");
      }
      res.status(status).json({ error: message });
      return;
    }

    // Enforce the concurrency cap before opening the stream.
    const reservation = sessions.tryReserve();
    if (!reservation.ok) {
      logger.warn("refused new SSE session: limit reached", {
        held: reservation.held,
        max: reservation.max,
        user: ctx.username,
      });
      bus.publish({
        type: "error",
        status: "error",
        username: ctx.username,
        message: reservation.reason,
      });
      res.set("Retry-After", "30");
      res.status(503).json({ error: reservation.reason });
      return;
    }

    const transport = new SSEServerTransport(serverConfig.messagePath, res);
    const sessionId = transport.sessionId;
    instrumentTransport(transport, sessionId);
    sessions.set(sessionId, { transport, ctx });
    logger.debug("sse stream opened", { session: sessionId, user: ctx.username });

    bus.publish({
      type: "connection",
      sessionId,
      username: ctx.username,
      subject: ctx.subject,
      authMethod: ctx.method,
      status: "ok",
      headers: redactHeaders(req.headers as Record<string, unknown>),
    });
    bus.publish({
      type: "auth",
      sessionId,
      username: ctx.username,
      subject: ctx.subject,
      authMethod: ctx.method,
      status: "ok",
      meta: { scopes: ctx.scopes, claims: ctx.claims },
    });

    res.on("close", () => {
      sessions.delete(sessionId);
      logger.debug("sse stream closed", { session: sessionId });
      bus.publish({ type: "disconnection", sessionId, username: ctx.username });
    });
    res.on("error", (err) => {
      logger.debug("sse stream error", { session: sessionId, error: err.message });
    });

    const server = createMcpServer(ctx, sessionId, {
      serverConfig,
      registry,
      bus,
      instructions: deps.instructions,
      identityRateLimiter: deps.identityRateLimiter,
      transactionFabric: deps.transactionFabric,
      authorizationEnabled: deps.authorizationEnabled,
      policies: deps.policies,
    });
    try {
      await server.connect(transport);
    } catch (err) {
      sessions.delete(sessionId);
      bus.publish({
        type: "error",
        sessionId,
        status: "error",
        message: `Failed to start MCP session: ${(err as Error).message}`,
      });
    }
  });

  router.post(serverConfig.messagePath, async (req: Request, res: Response) => {
    const sessionId = String(req.query.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "Unknown or expired session" });
      return;
    }

    // Re-authenticate the bearer on every client→server message. For OAuth this
    // enforces JWT expiry over the lifetime of a long-lived SSE session; for all
    // methods it binds the session id to the identity that opened it, so a
    // leaked session id cannot be driven with a different (or expired) token.
    try {
      const token = extractBearer(req.headers.authorization);
      const ctx = await authenticator.authenticate(token, req.headers as Record<string, unknown>);
      if (!sameSessionSecurityContext(ctx, session.ctx)) {
        throw new AuthError("Token security context does not match session", 403);
      }
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      const message = err instanceof Error ? err.message : String(err);
      sessions.delete(sessionId);
      try {
        session.transport.close?.();
      } catch {
        /* best-effort */
      }
      bus.publish({
        type: "auth_failure",
        sessionId,
        status: "error",
        message,
        headers: redactHeaders(req.headers as Record<string, unknown>),
      });
      if (status === 401) {
        const challenge = bearerChallenge(serverConfig, authenticator.authConfig, message);
        res.set("WWW-Authenticate", challenge ?? "Bearer");
      }
      res.status(status).json({ error: message });
      return;
    }

    const t = Date.now();
    logger.debug("sse post message", {
      session: sessionId,
      contentLength: req.headers["content-length"],
    });
    await session.transport.handlePostMessage(req, res);
    logger.debug("sse post handled", {
      session: sessionId,
      ms: Date.now() - t,
      status: res.statusCode,
    });
  });

  return router;
}

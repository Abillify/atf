// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * HTTP middleware stack bootstrap (extracted verbatim from index.ts, 18.3).
 *
 * Builds the Hono app and installs the full middleware chain in its original
 * order: CORS → approval-widget embedding → secure headers → CSRF →
 * request logging/tracing → body limit → pre-auth rate limit → legacy rate
 * limit → auth → post-auth rate limit. The API-key resolver is returned so
 * later route groups (e.g. Flow-as-MCP at /mcp) can reuse the exact same
 * resolver instance.
 */

import crypto from "node:crypto";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { AppConfig } from "../config/index.js";
import type { StoreFactory } from "../db/store/index.js";
import type { TenantStore } from "../graph/tenant-manager.js";
import { resolveApiKey } from "../middleware/api-key-auth.js";
import {
  authMiddleware,
  TRACE_CONTEXT_KEY,
  type AuthContext,
} from "../middleware/auth.js";
import { approvalWidgetEmbeddingMiddleware } from "../middleware/approval-widget-embedding.js";
import { csrfProtection } from "../middleware/csrf-protection.js";
import {
  rateLimitMiddleware,
  preAuthRateLimitMiddleware,
  postAuthRateLimitMiddleware,
  createStoreBackedRateLimitStore,
  createRedisRateLimitStore,
} from "../middleware/rate-limit.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import { parseTraceparent } from "../observability/tracing.js";
import type { Tracer } from "../observability/tracing.js";

export interface HttpMiddlewareDeps {
  config: AppConfig;
  logger: Logger;
  tracer: Tracer;
  metrics: Metrics;
  storeFactory: StoreFactory;
  jwtVerifier: JwtVerifier;
  tenantStore: TenantStore;
}

export interface HttpMiddlewareResult {
  app: Hono<AuthContext>;
  apiKeyResolver:
    | ((rawKey: string) => ReturnType<typeof resolveApiKey>)
    | undefined;
}

export function createHttpMiddleware(
  deps: HttpMiddlewareDeps,
): HttpMiddlewareResult {
  const { config, logger, tracer, metrics, storeFactory, jwtVerifier, tenantStore } =
    deps;

  const app = new Hono<AuthContext>();

  const allowAnyOrigin = config.corsOrigins.includes("*");
  app.use(
    "*",
    cors({
      origin: allowAnyOrigin
        ? "*"
        : (origin) => (config.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Type", "X-Accel-Buffering", "Cache-Control"],
    }),
  );

  // Allows the capability-token-protected approval HTML pages to be embedded
  // by the explicitly allowlisted Open WebUI parent after secureHeaders() has
  // applied the rest of the response hardening.
  app.use("*", approvalWidgetEmbeddingMiddleware);

  // Security response headers (CSP omitted deliberately — this is a JSON API
  // plus a separately-deployed dashboard, not an HTML-serving origin here, so
  // a restrictive `default-src 'none'` would need per-route tuning to avoid
  // breaking the OIDC callback / approval-widget HTML responses; those set
  // their own minimal inline styles and are reviewed individually). Every
  // other header Hono's `secureHeaders()` sets by default — HSTS,
  // X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
  // Cross-Origin-*-Policy, X-DNS-Prefetch-Control, X-Download-Options,
  // X-Permitted-Cross-Domain-Policies — applies with no per-route exceptions.
  app.use("*", secureHeaders());

  // CSRF protection for form-submittable POSTs — see csrf-protection.ts.
  app.use("*", csrfProtection());

  // Request logging + tracing
  app.use("*", async (ctx, next) => {
    const requestId = crypto.randomUUID();
    ctx.header("X-Request-Id", requestId);
    const start = Date.now();
    const routeLabelForSpan = ctx.req.routePath ?? ctx.req.path;
    const inbound = parseTraceparent(ctx.req.header("traceparent"));
    const serverSpan = tracer.startSpan(
      `${ctx.req.method} ${routeLabelForSpan}`,
      {
        kind: "server",
        ...(inbound !== undefined ? { parent: inbound } : {}),
        attributes: {
          "http.method": ctx.req.method,
          "http.route": routeLabelForSpan,
          "aiperator.request_id": requestId,
        },
      },
    );
    if (tracer.enabled) ctx.set(TRACE_CONTEXT_KEY, serverSpan.spanContext());
    await next();
    const durationMs = Date.now() - start;
    logger.info("request", {
      requestId,
      method: ctx.req.method,
      path: ctx.req.path,
      status: ctx.res.status,
      durationMs,
    });
    serverSpan
      .setAttribute("http.status_code", ctx.res.status)
      .setStatus(ctx.res.status >= 500 ? "error" : "ok")
      .end();
    const routeLabel = ctx.req.routePath ?? ctx.req.path;
    const isInternalRoute =
      routeLabel === "/metrics" ||
      routeLabel.startsWith("/monitoring/") ||
      routeLabel.startsWith("/health");
    if (!isInternalRoute)
      metrics.recordRequest(routeLabel, ctx.res.status, durationMs);
  });

  // Auth + rate limiting on /v1/*
  const maxBodyBytes = config.maxRequestBodyBytes ?? 26_214_400;
  const exceptMedia =
    (mw: MiddlewareHandler): MiddlewareHandler =>
    (ctx, next) =>
      ctx.req.path.startsWith("/v1/media/") ? next() : mw(ctx, next);

  const rateLimitPerMinute = config.rateLimitPerMinute ?? 0;
  const rateLimitPerUserPerMinute = config.rateLimitPerUserPerMinute ?? 0;
  const rateLimitPreAuthPerMinute = config.rateLimitPreAuthPerMinute ?? 0;
  const rateLimitPostAuthPerMinute = config.rateLimitPostAuthPerMinute ?? 0;
  const anyRateLimitEnabled =
    rateLimitPerMinute > 0 ||
    rateLimitPerUserPerMinute > 0 ||
    rateLimitPreAuthPerMinute > 0 ||
    rateLimitPostAuthPerMinute > 0;
  // Prefer the true sliding-window Redis limiter when Redis is configured — it
  // weights the previous window and avoids the ~2× burst a fixed-window counter
  // allows at the boundary. Fall back to the StoreFactory-backed (fixed-window)
  // counter when Redis is unavailable or not configured.
  const rateLimitStore = anyRateLimitEnabled
    ? ((config.redisUrl !== undefined
        ? createRedisRateLimitStore(config.redisUrl, logger)
        : undefined) ??
      createStoreBackedRateLimitStore(
        storeFactory.counter<string>("rate-limit"),
      ))
    : undefined;
  if (rateLimitStore !== undefined)
    logger.info("Rate limiting enabled", {
      backing: storeFactory.backing(),
      window:
        config.redisUrl !== undefined ? "sliding (redis)" : "fixed (store)",
    });

  app.use(
    "/v1/*",
    exceptMedia(
      bodyLimit({
        maxSize: maxBodyBytes,
        onError: (ctx) =>
          ctx.json(
            {
              error: {
                message: `Request body exceeds the ${maxBodyBytes}-byte limit.`,
                type: "invalid_request_error",
              },
            },
            413,
          ),
      }),
    ),
  );
  // Additive abuse gate: network identity only, deliberately before auth.
  app.use(
    "/v1/*",
    exceptMedia(
      preAuthRateLimitMiddleware(
        rateLimitPreAuthPerMinute,
        rateLimitStore,
        logger,
        config.rateLimitFailMode ?? "open",
        metrics,
      ),
    ),
  );
  // Legacy token/IP + optional user limiter remains in its historical position
  // and keeps its existing headers/status contract.
  app.use(
    "/v1/*",
    exceptMedia(
      rateLimitMiddleware(
        rateLimitPerMinute,
        rateLimitStore,
        logger,
        config.rateLimitFailMode ?? "open",
        rateLimitPerUserPerMinute,
        metrics,
      ),
    ),
  );
  // Managed API keys (`aip-…`) authenticate the inference plane only when tenant
  // management is on — that is what issues the keys in the first place. Without
  // the resolver the middleware rejects such a key with an explicit "not
  // enabled" message instead of the misleading "invalid token format".
  const apiKeyResolver =
    config.authnMode !== "oidc" &&
    config.authnMode !== "disabled" &&
    config.tenantManagementEnabled === true &&
    tenantStore !== undefined
      ? (rawKey: string) => resolveApiKey(rawKey, tenantStore, logger)
      : undefined;
  if (apiKeyResolver !== undefined) {
    logger.info("API key authentication enabled for /v1/* (aip-… keys)");
  }
  app.use(
    "/v1/*",
    exceptMedia(
      authMiddleware(jwtVerifier, apiKeyResolver, {
        mode: config.authnMode,
        tenantIsolationEnabled: config.tenantIsolationEnabled,
        defaultTenantId: config.defaultTenantId ?? "default",
      }),
    ),
  );
  // Additive authenticated gate: only the verified principal/tenant established
  // above contributes to the key; no client identity header is consulted.
  app.use(
    "/v1/*",
    exceptMedia(
      postAuthRateLimitMiddleware(
        rateLimitPostAuthPerMinute,
        rateLimitStore,
        logger,
        config.rateLimitFailMode ?? "open",
        metrics,
      ),
    ),
  );

  return { app, apiKeyResolver };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * index.ts
 *
 * Application wiring and the server lifecycle.
 *
 * `createApp` builds a fully configured Express app without starting a listener,
 * so integration tests drive the real middleware chain with supertest instead of
 * a stubbed one. `main` adds the readiness gate, the listener and graceful
 * shutdown. Same split as `apps/search/src/index.ts`.
 *
 * ## Middleware order is a security property
 *
 * Rate limit → authenticate → authorise → *then* parse the upload. Parsing before
 * authenticating would let an unauthenticated caller make the service buffer 50
 * MiB of their choosing, which is a denial-of-service primitive that costs them
 * one request. Every conversion route follows that order, and the ordering is the
 * reason the upload parser is per-route rather than global.
 *
 * ## Two front doors, one pipeline
 *
 * `/v1/*` accepts machine credentials only (Bearer). `/ui/*` accepts the browser
 * session cookie only, and adds a CSRF guard. Both hand the same handler the same
 * work; what differs is who is allowed to ask and what identity the ingest is
 * attributed to. Letting a cookie authenticate `/v1/*` would make a CSRF into a
 * document upload; letting a Bearer token authenticate the UI would make the UI's
 * credential a full programmatic one.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import pino, { type Logger } from "pino";
import pinoHttp from "pino-http";
import { EXTRACT_CONTRACT_ID } from "@atf/extract-contract";

import { loadConfig, type Config } from "./config.js";
import { checkProductionReadiness } from "./prod-gate.js";
import { toErrorBody } from "./errors.js";
import { sanitizeHeaderValue } from "./header-utils.js";
import { HttpMetrics } from "./http-metrics.js";
import { createRateLimiter } from "./rate-limiter.js";
import { traceContextStorage } from "./trace-context.js";
import { createRequireIdentityMiddleware } from "./request-principal.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import {
  createAuthMiddleware,
  createLoginHandler,
  createWebAuthMiddleware,
} from "./auth.js";
import { createRequireScope } from "./authorize.js";
import { createOidcProvider, type OidcProvider } from "./oidc.js";
import {
  createRequireUiOperatorMiddleware,
  createUiMutationGuard,
  createUiPrincipalMiddleware,
} from "./ui-auth.js";
import { createServerUrlResolver } from "./server-url.js";
import { createWorkQueue, type WorkQueue } from "./queue.js";
import { createVisionClient, type VisionClient } from "./vision/client.js";
import { createExtractor, type Extractor } from "./pipeline/extract.js";
import { createSearchClient, type SearchClient } from "./search-client.js";
import { createUploadMiddleware } from "./upload.js";
import { createConvertHandler } from "./handlers/convert.js";
import { createIngestHandler } from "./handlers/ingest.js";
import { createHealthHandler, type HealthProbe } from "./handlers/health.js";
import { buildOpenApiSpec } from "./openapi.js";
import { getUiPageHtml } from "./ui-page.js";

/** Seams for tests, which must not spawn converters or reach a model. */
export interface AppOverrides {
  logger?: Logger;
  vision?: VisionClient;
  extractor?: Extractor;
  searchClient?: SearchClient | null;
  queue?: WorkQueue;
  metrics?: HttpMetrics;
  /**
   * Replaces the converter-binary probe used by `/health`.
   *
   * Without this seam a health-check test spawns LibreOffice, which takes seconds
   * and fails on any machine that does not have it — making the test a check of
   * the developer's laptop rather than of the handler.
   */
  probeBinary?: HealthProbe;
}

export interface CreatedApp {
  app: Express;
  /** Stop background timers. Call during graceful shutdown. */
  cleanup: () => void;
}

export function createApp(config: Config, overrides: AppOverrides = {}): CreatedApp {
  const app = express();
  const logger =
    overrides.logger ?? pino({ level: config.logLevel, base: { pid: process.pid } });
  const metrics = overrides.metrics ?? new HttpMetrics();

  // ── Request logging ───────────────────────────────────────────────────────
  // autoLogging is off and the req/res serializers are suppressed: one line per
  // request is emitted below instead, so a conversion's own progress lines are
  // not buried under repeated header dumps.
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-callback-url']"],
        remove: true,
      },
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const raw =
          (req as IncomingMessage & { id?: string }).id ??
          req.headers["x-request-id"] ??
          randomUUID();
        const id = sanitizeHeaderValue(String(raw));
        res.setHeader("X-Request-Id", id);
        return id;
      },
      customProps: (req: IncomingMessage) => ({
        req_id: (req as IncomingMessage & { id?: string }).id,
      }),
      serializers: { req: () => undefined, res: () => undefined },
      autoLogging: { ignore: () => true },
    }),
  );

  // Small bodies only. The document upload is parsed per route, after
  // authentication, by createUploadMiddleware.
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));

  // ── Correlation, metrics and trace propagation ────────────────────────────
  const requestIdStorage = new AsyncLocalStorage<string>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = (req as Request & { id?: string }).id ?? randomUUID();
    requestIdStorage.run(reqId, () => {
      const start = Date.now();
      const endMetrics = metrics.begin();
      const finish = (): void => {
        // Only canonical route templates become labels; a raw path would put one
        // metric series per document reference into Prometheus.
        endMetrics(req.method, req.route?.path ? String(req.route.path) : "__unmatched__", res.statusCode);
      };
      res.on("finish", () => {
        finish();
        req.log.info(
          { method: req.method, path: req.path, status: res.statusCode, duration: Date.now() - start },
          "Request finished",
        );
      });
      res.on("close", finish);
      next();
    });
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    const traceparent = req.headers["traceparent"];
    const tracestate = req.headers["tracestate"];
    traceContextStorage.run(
      {
        traceparent: typeof traceparent === "string" ? traceparent : undefined,
        tracestate: typeof tracestate === "string" ? tracestate : undefined,
      },
      next,
    );
  });

  // ── Clients and the pipeline ──────────────────────────────────────────────
  const vision =
    overrides.vision ??
    createVisionClient(
      {
        visionUrl: config.visionUrl,
        visionModel: config.visionModel,
        visionApiKey: config.visionApiKey,
        visionTimeoutMs: config.visionTimeoutMs,
        visionTemperature: config.visionTemperature,
        visionTopP: config.visionTopP,
        visionMaxTokenVariants: config.visionMaxTokenVariants,
        visionMaxRetries: config.visionMaxRetries,
        visionReasoningEffort: config.visionReasoningEffort,
      },
      logger,
    );

  const queue =
    overrides.queue ??
    createWorkQueue({
      concurrency: config.convertConcurrency,
      maxDepth: config.queueMaxDepth,
      onStateChange: (state) => metrics.setQueue(state),
    });

  const extractor =
    overrides.extractor ??
    createExtractor({
      config: {
        renderDpi: config.renderDpi,
        figureDpi: config.figureDpi,
        maxPages: config.maxPages,
        tempDir: config.tempDir,
        pageLabel: config.pageLabel,
        libreofficeBin: config.libreofficeBin,
        popplerBinDir: config.popplerBinDir,
        pageConcurrency: config.pageConcurrency,
        visionModel: config.visionModel,
      },
      logger,
      vision,
      metrics,
    });

  const searchClient =
    overrides.searchClient !== undefined
      ? overrides.searchClient
      : config.search !== null
        ? createSearchClient(config.search, logger)
        : null;

  // ── Authentication and authorisation ──────────────────────────────────────
  const resolveBaseUrl = createServerUrlResolver({
    publicUrl: config.publicUrl,
    port: config.port,
    trustProxy: config.trustProxy,
  });

  const oidcProvider: OidcProvider | null =
    config.oidc !== null
      ? createOidcProvider(config.oidc, {
          logger,
          // Cookies get Secure behind TLS, which TRUST_PROXY is the signal for.
          secureCookie: config.trustProxy,
          resolveBaseUrl,
        })
      : null;

  const jwtVerifier = createJwtVerifier(
    config.apiOidcIssuers,
    config.defaultTenantId,
    config.tenantIsolationEnabled,
  );

  const baseAuth = createAuthMiddleware(
    config.apiToken,
    jwtVerifier,
    { scopes: config.apiServiceScopes, tenantId: config.apiServiceTenantId },
    {
      mode: config.authnMode,
      authzEnabled: config.authzEnabled,
      tenantIsolationEnabled: config.tenantIsolationEnabled,
      defaultTenantId: config.defaultTenantId,
    },
  );
  // Composed into the auth middleware rather than added per route: a route added
  // later cannot forget it.
  const requireIdentity = createRequireIdentityMiddleware(false);
  const authMiddleware: RequestHandler = (req, res, next) => {
    baseAuth(req, res, (err?: unknown) => {
      if (err !== undefined) {
        next(err);
        return;
      }
      requireIdentity(req, res, next);
    });
  };

  const webAuth = createWebAuthMiddleware(config.monitorToken, oidcProvider ?? undefined, {
    mode: config.authnMode,
  });
  const uiPrincipal = createUiPrincipalMiddleware(oidcProvider, {
    ...config.uiBff,
    authnMode: config.authnMode,
    authzEnabled: config.authzEnabled,
  });
  const uiMutationGuard = createUiMutationGuard(resolveBaseUrl);
  const requireUiOperator = createRequireUiOperatorMiddleware(
    config.uiBff.operatorGroup,
    config.authnMode,
  );

  const requireConvert = createRequireScope("extract.convert", {
    authzEnabled: config.authzEnabled,
  });
  const requireIngest = createRequireScope("extract.ingest", {
    authzEnabled: config.authzEnabled,
  });
  const requireMetrics = createRequireScope("extract.metrics", {
    authzEnabled: config.authzEnabled,
  });

  const rateLimiter = createRateLimiter({
    max: config.rateLimit,
    windowMs: 60_000,
    trustProxy: config.trustProxy,
  });

  const upload = createUploadMiddleware({ maxUploadBytes: config.maxUploadBytes });

  // ── Handlers ──────────────────────────────────────────────────────────────
  const convertHandler = createConvertHandler({
    extractor,
    queue,
    config: {
      exposeErrorDetail: config.exposeErrorDetail,
      callbackMaxRetries: config.callbackMaxRetries,
      callbackTimeoutMs: config.callbackTimeoutMs,
      callbackAllowedHosts: config.callbackAllowedHosts,
    },
    logger,
    metrics,
  });

  const ingestHandler =
    searchClient !== null
      ? createIngestHandler({
          extractor,
          searchClient,
          queue,
          logger,
          metrics,
          defaultCollection: config.search?.collection ?? "documents",
        })
      : null;

  const healthHandler = createHealthHandler({
    queue,
    vision,
    searchClient,
    logger,
    ...(overrides.probeBinary !== undefined ? { probeBinary: overrides.probeBinary } : {}),
    config: {
      libreofficeBin: config.libreofficeBin,
      popplerBinDir: config.popplerBinDir,
      tempDir: config.tempDir,
      visionModel: config.visionModel,
      renderDpi: config.renderDpi,
      figureDpi: config.figureDpi,
      maxPages: config.maxPages,
    },
  });

  // ── Routes ────────────────────────────────────────────────────────────────
  // Unauthenticated, so an orchestrator and API tooling need no credential.
  app.get("/health", healthHandler);
  app.get("/openapi.json", (req: Request, res: Response) => {
    res.status(200).json(
      buildOpenApiSpec({ serverUrl: resolveBaseUrl(req), ingestEnabled: ingestHandler !== null }),
    );
  });

  app.get("/metrics", authMiddleware, requireMetrics, (_req: Request, res: Response) => {
    res.status(200).type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render());
  });

  app.get("/", webAuth, (_req: Request, res: Response) => {
    res
      .status(200)
      .type("html")
      .send(
        getUiPageHtml({
          logoutPath: oidcProvider !== null ? "/auth/logout" : null,
          ingestEnabled: ingestHandler !== null,
          defaultCollection: config.search?.collection ?? "documents",
          maxUploadBytes: config.maxUploadBytes,
        }),
      );
  });

  app.post("/login", createLoginHandler(config.monitorToken, config.trustProxy));

  if (oidcProvider !== null) {
    app.get("/auth/login", oidcProvider.loginHandler);
    app.get("/auth/callback", oidcProvider.callbackHandler);
    app.get("/auth/logout", oidcProvider.logoutHandler);
  }

  // ── Machine API ───────────────────────────────────────────────────────────
  app.post(
    "/v1/convert",
    rateLimiter.middleware,
    authMiddleware,
    requireConvert,
    upload,
    convertHandler,
  );
  if (ingestHandler !== null) {
    app.post(
      "/v1/ingest",
      rateLimiter.middleware,
      authMiddleware,
      requireIngest,
      upload,
      ingestHandler,
    );
  }

  // ── Browser backend-for-frontend ──────────────────────────────────────────
  // Accepts only the signed session cookie and translates it into a
  // server-controlled tenant and scope set, then reuses the same handlers.
  const ui = express.Router();
  ui.use(uiPrincipal);
  ui.post(
    "/convert",
    rateLimiter.middleware,
    uiMutationGuard,
    requireConvert,
    upload,
    convertHandler,
  );
  if (ingestHandler !== null) {
    ui.post(
      "/ingest",
      rateLimiter.middleware,
      uiMutationGuard,
      requireUiOperator,
      requireIngest,
      upload,
      ingestHandler,
    );
  }
  app.use("/ui", ui);

  // ── Error handler ─────────────────────────────────────────────────────────
  // Last, after every route. Internal messages stay in the log; the client gets a
  // stable code and an id to quote.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const bodyError = err as { type?: string; status?: number };
    if (bodyError.type === "entity.too.large" || bodyError.status === 413) {
      res.status(413).json({
        error: `The upload exceeds the ${config.maxUploadBytes} byte limit`,
        code: "PAYLOAD_TOO_LARGE",
        retryable: false,
      });
      return;
    }

    const errorId = randomUUID();
    const body = toErrorBody(err, errorId, config.exposeErrorDetail);
    const status =
      err instanceof Error && "status" in err && typeof err.status === "number" ? err.status : 500;

    if (status >= 500) {
      req.log.error({ err, errorId, context: (err as { context?: unknown }).context }, "Request failed");
    } else {
      req.log.warn({ errorId, code: body.code }, "Request rejected");
    }

    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    // 499 is nginx's "client closed request"; there is nobody left to send it to.
    res.status(status === 499 ? 499 : status).json(body);
  });

  function cleanup(): void {
    rateLimiter.close();
  }

  return { app, cleanup };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("Failed to load config:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const logger = pino({ level: config.logLevel, base: { pid: process.pid } });

  // ── Production-readiness gate ────────────────────────────────────────────
  // Refuse to start in production with permissive settings, rather than warning
  // into a log nobody reads. Non-production keeps the convenient defaults and
  // reports what WOULD be fatal, so the same config surfaces the same list
  // before it is promoted.
  const readiness = checkProductionReadiness(config);
  for (const warning of readiness.warnings) {
    logger.warn({ readiness: true }, warning);
  }
  if (readiness.fatal.length > 0) {
    for (const fatal of readiness.fatal) {
      logger.fatal({ readiness: true }, fatal);
    }
    logger.fatal(
      `Refusing to start in '${readiness.environment}': ${readiness.fatal.length} ` +
        "production-readiness check(s) failed. Fix the settings above, or run with " +
        "NODE_ENV=development to accept them explicitly.",
    );
    process.exit(1);
  }
  logger.info(
    { environment: readiness.environment, warnings: readiness.warnings.length },
    "Production-readiness gate passed",
  );

  // Fail here rather than on the first upload if the scratch directory is not
  // writable — a read-only filesystem is a common hardening default.
  try {
    await mkdir(config.tempDir, { recursive: true });
  } catch (err) {
    logger.fatal({ err, tempDir: config.tempDir }, "TEMP_DIR is not writable; refusing to start");
    process.exit(1);
  }

  const { app, cleanup } = createApp(config, { logger });

  const server: Server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        contract: EXTRACT_CONTRACT_ID,
        visionModel: config.visionModel,
        searchIngest: config.search !== null,
        renderDpi: config.renderDpi,
        figureDpi: config.figureDpi,
      },
      `extract listening on port ${config.port}`,
    );
  });

  // A conversion legitimately runs for many minutes, so the default header and
  // request timeouts would kill work in progress. The queue and MAX_PAGES are
  // what bound resource use here, not the socket timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 75_000;

  let shuttingDown = false;
  const shutdown = (signal: string) => (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down gracefully");
    cleanup();
    server.close(() => {
      logger.info("All in-flight requests completed");
      process.exit(0);
    });
    // Long enough for a page in flight to finish and short enough that an
    // orchestrator's SIGKILL does not arrive first.
    setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 30_000).unref();
  };

  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
}

const isMainModule =
  process.argv[1] !== undefined &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

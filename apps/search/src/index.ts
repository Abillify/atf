// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { pino } from "pino";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { pinoHttp } from "pino-http";
import { usageStorage } from "./usage-context.js";
import {
  createAuthMiddleware,
  createWebAuthMiddleware,
  createLoginHandler,
} from "./auth.js";
import { createOidcProvider, type OidcProvider } from "./oidc.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import {
  createRequireUiOperatorMiddleware,
  createUiMutationGuard,
  createUiPrincipalMiddleware,
} from "./ui-auth.js";
import { checkProductionReadiness } from "./prod-gate.js";
import { createRequireIdentityMiddleware } from "./request-principal.js";
import { createAuthorizationMiddleware } from "./access-scope.js";
import { parseMetadataHeader } from "./metadata.js";
import {
  createEmbeddingClient,
  createFallbackEmbeddingClient,
} from "./embedding-client.js";
import {
  createFallbackRerankerClient,
  createRerankerClient,
} from "./reranker-client.js";
import { createSparseEmbeddingClient } from "./sparse-embedding-client.js";
import { createHydeClient } from "./hyde-client.js";
import { createSummaryClient } from "./summary-client.js";
import {
  createPostgresClient,
  type PostgresClient,
  waitForDatabase,
  type CircuitBreakerStatus,
} from "./postgres-client.js";
import { runMigrations } from "./migrations.js";
import { createCircuitBreaker } from "./retry.js";
import { createIngestHandler } from "./handlers/ingest.js";
import { createIngestBatchHandler } from "./handlers/ingest-batch.js";
import { createIngestStreamHandler } from "./handlers/ingest-stream.js";
import { createSearchHandler } from "./handlers/search.js";
import { createDeleteHandler } from "./handlers/delete.js";
import {
  createAdminStatsHandler,
  createHealthHandler,
  createListCollectionsHandler,
  createDeleteCollectionHandler,
} from "./handlers/admin.js";
import { createMetricsHandler } from "./handlers/metrics.js";
import { createRetrievalEvaluationHandler } from "./handlers/evaluation.js";
import { HttpMetrics } from "./http-metrics.js";
import { createMcpHandlers, createMcp2026Handlers } from "./handlers/mcp.js";
import { createQueryHandlers } from "./handlers/query.js";
import {
  createGetDocumentAssetHandler,
  createPutDocumentAssetHandler,
  DOCUMENT_ASSET_MIME_TYPES,
  MAX_DOCUMENT_ASSET_BYTES,
} from "./handlers/document-assets.js";
import { createRenameCollectionHandler } from "./handlers/admin.js";
import { createBackfillSummariesHandler } from "./handlers/admin.js";
import {
  createGetCollectionPermissionsHandler,
  createSetCollectionPermissionsHandler,
} from "./handlers/admin.js";
import {
  createCollectionAccessMiddleware,
  collectionFromHeader,
  collectionFromQuery,
  collectionFromParam,
} from "./handlers/collection-access.js";
import { createActivityStreamHandler } from "./handlers/activity-stream.js";
import { getTestPageHtml } from "./test-page.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createQueryEmbeddingCache } from "./query-cache.js";
import { buildOpenApiSpec, buildOpenApiYaml } from "./openapi.js";
import { type Config, loadConfig } from "./config.js";
import type { CircuitBreaker } from "./retry.js";
import { traceContextStorage } from "./trace-context.js";
import {
  MemoryInvocationLedger,
  PostgresInvocationLedger,
  type InvocationLedger,
} from "./invocation-ledger.js";

export type { Config };
export { loadConfig };

interface PrebuiltBreakers {
  embeddingBreaker: CircuitBreaker;
  embeddingFallbackBreaker?: CircuitBreaker | null;
  rerankerBreaker: CircuitBreaker | null;
  rerankerFallbackBreaker?: CircuitBreaker | null;
  sparseBreaker: CircuitBreaker | null;
  hydeBreaker: CircuitBreaker | null;
  summaryBreaker: CircuitBreaker | null;
}

/**
 * Resolve the public base URL for OpenAPI spec generation.
 *
 * Priority:
 *   1. PUBLIC_URL environment variable (e.g. "https://api.example.com")
 *   2. X-Forwarded-Proto / Host headers (when behind a trusted proxy)
 *   3. Fallback: http://localhost:<port>
 */
function resolveServerUrl(req: Request, port: number): string {
  const envUrl = process.env["PUBLIC_URL"];
  if (envUrl) return envUrl.replace(/\/+$/, ""); // strip trailing slash

  // Attempt to infer from incoming request headers (works behind a reverse proxy)
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ??
    req.headers["host"];
  if (host) return `${proto}://${host}`;

  return `http://localhost:${port}`;
}

export function createApp(
  config: Config,
  postgresClient: PostgresClient,
  breakers?: PrebuiltBreakers,
  invocationLedger?: InvocationLedger,
): { app: Express; cleanup: () => void } {
  const app = express();

  const logger = pino({ level: config.logLevel, base: { pid: process.pid } });
  const httpMetrics = new HttpMetrics();

  // Strip control characters (including \r, \n) from HTTP header values to
  // prevent Node.js ERR_INVALID_CHAR errors when echoing client-supplied IDs.
  const sanitizeHeaderValue = (v: string): string =>
    v.replace(/[\x00-\x1f\x7f]/g, "");

  const httpLogger = pinoHttp({
    logger,
    redact: {
      paths: ["req.headers.cookie", "req.headers.authorization"],
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
    // Only attach req_id to child loggers — avoids repeating the full req
    // object (method, url, all headers) on every req.log.info() call.
    customProps: (req: IncomingMessage, _res: ServerResponse) => ({
      req_id: (req as IncomingMessage & { id?: string }).id,
    }),
    // Suppress the default req serializer so step-logs stay compact.
    serializers: {
      req: () => undefined,
      res: () => undefined,
    },
    autoLogging: {
      ignore: () => true,
    },
  });
  app.use(httpLogger);

  app.use(
    express.text({
      type: ["text/plain", "text/markdown"],
      limit: config.bodyLimit,
    }),
  );
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));

  const rateLimiter = createRateLimiter({
    max: config.rateLimit,
    windowMs: 60_000,
    trustProxy: config.trustProxy,
  });

  // ── Circuit breakers — created before clients so status getters can be
  // registered with the postgres client for /metrics and /health endpoints.
  const embeddingBreaker =
    breakers?.embeddingBreaker ??
    createCircuitBreaker({ name: "embedding-primary" });
  const embeddingFallbackBreaker =
    breakers?.embeddingFallbackBreaker ??
    (config.embedFallbackModel
      ? createCircuitBreaker({ name: "embedding-fallback" })
      : null);
  const rerankerBreaker =
    breakers !== undefined
      ? breakers.rerankerBreaker
      : config.rerankModel
        ? createCircuitBreaker({ name: "reranker-primary" })
        : null;
  const rerankerFallbackBreaker =
    breakers?.rerankerFallbackBreaker ??
    (config.rerankFallbackModel
      ? createCircuitBreaker({ name: "reranker-fallback" })
      : null);
  const sparseBreaker =
    breakers !== undefined
      ? breakers.sparseBreaker
      : config.sparseModel
        ? createCircuitBreaker({ name: "sparse-embedding" })
        : null;
  const hydeBreaker =
    breakers !== undefined
      ? breakers.hydeBreaker
      : config.hydeModel
        ? createCircuitBreaker({ name: "hyde" })
        : null;
  const summaryBreaker =
    breakers !== undefined
      ? breakers.summaryBreaker
      : config.summaryModel
        ? createCircuitBreaker({ name: "summary" })
        : null;

  // ── Request-ID store — AsyncLocalStorage gives each async context its own
  // request ID so concurrent requests never overwrite each other's correlation
  // ID (a race condition that existed when using a plain shared variable).
  const requestIdStorage = new AsyncLocalStorage<string>();

  app.use((req: Request, res: Response, next: NextFunction) => {
    // Run each request inside its own AsyncLocalStorage context so that
    // downstream HTTP clients (embedding, reranker, etc.) can read the
    // current request's correlation ID without a shared-state race condition.
    const reqId = (req as Request & { id?: string }).id ?? randomUUID();
    requestIdStorage.run(reqId, () => {
      const start = Date.now();
      const endMetrics = httpMetrics.begin();
      const finishRequest = (): void => {
        const route = req.route?.path ? String(req.route.path) : "__unmatched__";
        // Only canonical Express route templates are labels; raw paths, IDs,
        // tenants and query text are never exported. endMetrics is idempotent,
        // so finish followed by close records and decrements exactly once.
        endMetrics(req.method, route, res.statusCode);
      };
      res.on("finish", () => {
        finishRequest();
        req.log.info(
          {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            duration: Date.now() - start,
          },
          "Request finished",
        );
      });
      res.on("close", finishRequest);
      next();
    });
  });

  // ── W3C Trace Context propagation ─────────────────────────────────────────
  // Store incoming traceparent/tracestate in an AsyncLocalStorage context so
  // downstream HTTP clients (embedding, reranker, …) can forward them without
  // needing explicit parameter threading.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const tp = req.headers["traceparent"];
    const ts = req.headers["tracestate"];
    traceContextStorage.run(
      {
        traceparent: typeof tp === "string" ? tp : undefined,
        tracestate: typeof ts === "string" ? ts : undefined,
      },
      next,
    );
  });

  // ── Token Usage Context propagation ─────────────────────────────────────────
  app.use((req: Request, _res: Response, next: NextFunction) => {
    usageStorage.run({ inputTokens: 0, outputTokens: 0, cost: 0, modelCosts: {} }, next);
  });

  const primaryEmbeddingClient = createEmbeddingClient({
    embedUrl: config.embedUrl,
    embedModel: config.embedModel,
    inputField: config.embedInputField,
    logger,
    timeoutMs: config.fetchTimeoutMs,
    circuitBreaker: embeddingBreaker,
    getRequestId: () => requestIdStorage.getStore(),
    inputTokenCost: config.embedInputTokenCost,
    outputTokenCost: config.embedOutputTokenCost,
  });
  const fallbackEmbeddingClient =
    config.embedFallbackModel &&
    config.embedFallbackUrl &&
    embeddingFallbackBreaker
      ? createEmbeddingClient({
          embedUrl: config.embedFallbackUrl,
          embedModel: config.embedFallbackModel,
          inputField: config.embedFallbackInputField,
          logger,
          timeoutMs: config.fetchTimeoutMs,
          circuitBreaker: embeddingFallbackBreaker,
          getRequestId: () => requestIdStorage.getStore(),
          inputTokenCost: config.embedFallbackInputTokenCost,
          outputTokenCost: config.embedFallbackOutputTokenCost,
        })
      : null;
  const embeddingClient = fallbackEmbeddingClient
    ? createFallbackEmbeddingClient(
        primaryEmbeddingClient,
        fallbackEmbeddingClient,
        logger,
        config.embedExpectedDimension ?? undefined,
      )
    : primaryEmbeddingClient;

  const primaryRerankerClient =
    config.rerankModel && rerankerBreaker
      ? createRerankerClient({
          rerankUrl: config.rerankUrl,
          rerankModel: config.rerankModel,
          separator: config.rerankInputSeparator,
          endpoint: config.rerankEndpoint,
          documentsField: config.rerankDocumentsField,
          logger,
          timeoutMs: config.fetchTimeoutMs,
          circuitBreaker: rerankerBreaker,
          inputTokenCost: config.rerankInputTokenCost,
          outputTokenCost: config.rerankOutputTokenCost,
        })
      : null;
  const fallbackRerankerClient =
    config.rerankFallbackModel &&
    config.rerankFallbackUrl &&
    rerankerFallbackBreaker
      ? createRerankerClient({
          rerankUrl: config.rerankFallbackUrl,
          rerankModel: config.rerankFallbackModel,
          separator: config.rerankFallbackInputSeparator,
          endpoint: config.rerankFallbackEndpoint,
          documentsField: config.rerankFallbackDocumentsField,
          logger,
          timeoutMs: config.fetchTimeoutMs,
          circuitBreaker: rerankerFallbackBreaker,
          inputTokenCost: config.rerankFallbackInputTokenCost,
          outputTokenCost: config.rerankFallbackOutputTokenCost,
        })
      : null;
  const rerankerClient =
    primaryRerankerClient && fallbackRerankerClient
      ? createFallbackRerankerClient(
          primaryRerankerClient,
          fallbackRerankerClient,
          logger,
        )
      : primaryRerankerClient;

  const sparseClient =
    config.sparseModel && sparseBreaker
      ? createSparseEmbeddingClient({
          url: config.sparseUrl,
          model: config.sparseModel,
          vocabSize: config.sparseVocabSize,
          logger: logger,
          timeoutMs: config.fetchTimeoutMs,
          circuitBreaker: sparseBreaker,
          inputTokenCost: config.sparseInputTokenCost,
          outputTokenCost: config.sparseOutputTokenCost,
        })
      : null;

  const hydeClient =
    config.hydeModel && hydeBreaker
      ? createHydeClient({
          url: config.hydeUrl,
          model: config.hydeModel,
          maxTokens: config.hydeMaxTokens,
          enableThinking: config.hydeEnableThinking,
          token: config.hydeToken,
          logger: logger,
          timeoutMs: config.fetchTimeoutMs,
          circuitBreaker: hydeBreaker,
          inputTokenCost: config.hydeInputTokenCost,
          outputTokenCost: config.hydeOutputTokenCost,
        })
      : null;

  const summaryClient =
    config.summaryModel && summaryBreaker
      ? createSummaryClient({
          url: config.summaryUrl,
          model: config.summaryModel,
          maxTokens: config.summaryMaxTokens,
          enableThinking: config.summaryEnableThinking,
          token: config.summaryToken,
          logger: logger,
          timeoutMs: config.summaryTimeoutMs,
          maxConcurrency: config.summaryMaxConcurrency,
          circuitBreaker: summaryBreaker,
          inputTokenCost: config.summaryInputTokenCost,
          outputTokenCost: config.summaryOutputTokenCost,
        })
      : null;

  // ── OIDC provider (optional) ────────────────────────────────────────────
  // Enabled only when config.oidc is populated (OIDC_ISSUER + client creds set).
  // Cookies get the Secure attribute when running behind TLS (trustProxy).
  const oidcProvider: OidcProvider | null = config.oidc
    ? createOidcProvider(config.oidc, {
        logger,
        secureCookie: config.trustProxy,
        resolveBaseUrl: (req) => resolveServerUrl(req, config.port),
      })
    : null;

  // JWT Bearer verifier for API/MCP — multi-issuer JWKS, opt-in via API_OIDC_ISSUERS.
  const jwtVerifier = createJwtVerifier(
    config.apiOidcIssuers,
    config.defaultTenantId,
    config.tenantIsolationEnabled,
  );

  const baseAuthMiddleware = createAuthMiddleware(
    config.apiToken,
    oidcProvider ?? undefined,
    config.monitorToken,
    jwtVerifier,
    { scopes: config.apiServiceScopes, tenantId: config.apiServiceTenantId },
    {
      mode: config.authnMode,
      authzEnabled: config.authzEnabled,
      tenantIsolationEnabled: config.tenantIsolationEnabled,
      defaultTenantId: config.defaultTenantId,
    },
  );
  // Compose the optional "every read must be attributable" check INTO the auth
  // middleware, rather than adding it to each of the ~23 route definitions.
  // Attaching it once is the point: a route added later cannot forget it.
  const requireIdentity = createRequireIdentityMiddleware(
    config.authzEnabled && config.aclRequireIdentity,
  );
  const authMiddleware: RequestHandler = (req, res, next) => {
    baseAuthMiddleware(req, res, (err?: unknown) => {
      if (err !== undefined) {
        next(err);
        return;
      }
      requireIdentity(req, res, next);
    });
  };

  const webAuthMiddleware = createWebAuthMiddleware(
    config.monitorToken,
    oidcProvider ?? undefined,
    { mode: config.authnMode },
  );
  const uiPrincipalMiddleware = createUiPrincipalMiddleware(
    oidcProvider,
    {
      ...config.uiBff,
      authnMode: config.authnMode,
      authzEnabled: config.authzEnabled,
    },
  );
  const requireUiOperator = createRequireUiOperatorMiddleware(
    config.uiBff.operatorGroup,
    config.authnMode,
  );
  const uiMutationGuard = createUiMutationGuard((req) =>
    resolveServerUrl(req, config.port),
  );
  const loginHandler = createLoginHandler(config.monitorToken, config.trustProxy);

  const ingestDefaults = {
    defaultChunkSize: config.defaultChunkSize,
    defaultChunkOverlap: config.defaultChunkOverlap,
    hybridSearch: config.hybridSearch,
    contextPrefixSize: config.contextPrefixSize,
    defaultFtsLanguage: config.defaultFtsLanguage,
    lateChunkingAlpha: config.lateChunkingAlpha,
    sparseVocabSize: config.sparseModel ? config.sparseVocabSize : null,
    embeddingModel: config.embedModel,
    embeddingModelRevision: config.embedModelRevision,
    semanticChunking: config.semanticChunking,
    breakpointPercentile: config.breakpointPercentile,
    quantization: config.quantization,
    chapterSplitMaxChunks: config.chapterSplitMaxChunks,
  };

  const ingestHandler = createIngestHandler(
    embeddingClient,
    postgresClient,
    logger,
    ingestDefaults,
    sparseClient,
    summaryClient,
  );
  const ingestBatchHandler = createIngestBatchHandler(
    embeddingClient,
    postgresClient,
    ingestDefaults,
    sparseClient,
    summaryClient,
  );
  const ingestStreamHandler = createIngestStreamHandler(
    embeddingClient,
    postgresClient,
    ingestDefaults,
    sparseClient,
    summaryClient,
    logger,
  );
  const queryCache = createQueryEmbeddingCache(config.queryCacheSize);

  const searchHandler = createSearchHandler(
    embeddingClient,
    postgresClient,
    logger,
    {
      rerankerClient,
      candidateMultiplier: config.rerankCandidateMultiplier,
      hybridSearch: config.hybridSearch,
      hydeClient,
      sparseClient,
      queryCache,
    },
  );
  const deleteHandler = createDeleteHandler(postgresClient, logger);
  const adminStatsHandler = createAdminStatsHandler(postgresClient, logger);
  const healthHandler = createHealthHandler(
    { postgresClient, embeddingClient },
    logger,
  );
  const listCollectionsHandler = createListCollectionsHandler(
    postgresClient,
    logger,
  );
  const uiListCollectionsHandler = createListCollectionsHandler(
    postgresClient,
    logger,
    { filterByAcl: true },
  );
  const deleteCollectionHandler = createDeleteCollectionHandler(
    postgresClient,
    logger,
  );
  const metricsHandler = createMetricsHandler(postgresClient, httpMetrics, queryCache);
  const retrievalEvaluationHandler = createRetrievalEvaluationHandler(
    embeddingClient,
    postgresClient,
    logger,
    {
      hybridSearch: config.hybridSearch,
      candidateMultiplier: config.rerankCandidateMultiplier,
    },
  );
  const activityStreamHandler = createActivityStreamHandler();
  const queryHandlers = createQueryHandlers(postgresClient, logger, {
    defaultCollection: config.defaultCollection,
  });
  const putDocumentAssetHandler = createPutDocumentAssetHandler(postgresClient, logger);
  const getDocumentAssetHandler = createGetDocumentAssetHandler(postgresClient, logger);

  // MCP (Model Context Protocol) — Streamable HTTP transport.
  // Three routes on the same path, distinguished by HTTP method.
  // chunkingOptions forwards the server-wide chunking config so the MCP
  // ingest tool goes through the same pipeline as /ingest (Fix #1).
  const mcpChunkingOptions =
    config.defaultChunkSize !== null && config.defaultChunkOverlap !== null
      ? {
          enabled: true,
          chunkSize: config.defaultChunkSize,
          overlapSize: config.defaultChunkOverlap,
          contextPrefixSize: config.contextPrefixSize,
          lateChunkingAlpha: config.lateChunkingAlpha,
          useSemanticChunking: config.semanticChunking,
          breakpointPercentile: config.breakpointPercentile,
          // Summarization is active when a summary model is configured.
          // The summaryClient is passed separately so buildJobsForDocument
          // can use it — matching the behaviour of the REST /ingest endpoint.
          useSummarization: summaryClient !== null,
          chapterSplitMaxChunks: config.chapterSplitMaxChunks,
        }
      : null;

  const mcpOptions = {
    embeddingClient,
    postgresClient,
    sparseClient,
    queryCache,
    rerankerClient,
    logger,
    defaultCollection: config.defaultCollection,
    hybridSearchDefault: config.hybridSearch,
    candidateMultiplier: config.rerankCandidateMultiplier,
    chunkingOptions: mcpChunkingOptions,
    summaryClient,
    hydeClient,
    serviceName: config.mcpServiceName,
    serviceVersion: config.mcpServiceVersion,
    embeddingModel: config.embedModel,
    embeddingModelRevision: config.embedModelRevision,
    transactionConfig: {
      enforcement: config.transactionEnforcement,
      secret: config.transactionSecret,
      issuer: config.transactionIssuer,
      audience: config.transactionAudience,
      clockToleranceSeconds: config.transactionClockToleranceSeconds,
      maxTtlSeconds: config.transactionMaxTtlSeconds,
    },
    authzEnforcement: config.authzEnforcement,
    ...(invocationLedger !== undefined ? { invocationLedger } : {}),
  };
  const mcpHandlers = createMcpHandlers(mcpOptions);
  const mcp2026Handlers = createMcp2026Handlers(mcpOptions, config.mcp2026Path);

  const metadataMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    const metadataHeader = req.headers["x-metadata"] as string | undefined;
    const { metadata, error } = parseMetadataHeader(metadataHeader);
    if (error) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.locals["metadata"] = metadata;
    next();
  };

  // Collection-level ACL enforcement. Three variants differ only in how they
  // resolve the target collection from the request.
  const collectionAccessHeader = createCollectionAccessMiddleware(
    postgresClient,
    collectionFromHeader,
    { defaultCollection: config.defaultCollection, logger },
  );
  const collectionAccessQuery = createCollectionAccessMiddleware(
    postgresClient,
    collectionFromQuery,
    { defaultCollection: config.defaultCollection, logger },
  );
  const collectionAccessAsset = createCollectionAccessMiddleware(
    postgresClient,
    (req) =>
      (typeof req.query["collection"] === "string" ? req.query["collection"] : undefined) ??
      collectionFromHeader(req),
    { defaultCollection: config.defaultCollection, logger },
  );
  const collectionAccessParam = createCollectionAccessMiddleware(
    postgresClient,
    collectionFromParam,
    { logger },
  );
  const authorizeRead = createAuthorizationMiddleware("read", config.authzEnforcement);
  const authorizeWrite = createAuthorizationMiddleware("write", config.authzEnforcement);
  const authorizeDelete = createAuthorizationMiddleware("delete", config.authzEnforcement);
  const authorizeAdmin = createAuthorizationMiddleware("admin", config.authzEnforcement);
  const authorizeMetrics = createAuthorizationMiddleware("metrics", config.authzEnforcement);
  const authorizeGlobalAdmin = createAuthorizationMiddleware("global.admin", config.authzEnforcement);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.get("/health", healthHandler);
  app.get("/metrics", authMiddleware, authorizeMetrics, metricsHandler);

  // OpenAPI spec — no auth required so tooling (Swagger UI, etc.) can fetch it.
  app.get("/openapi.json", (req: Request, res: Response) => {
    const serverUrl = resolveServerUrl(req, config.port);
    res.status(200).json(buildOpenApiSpec(serverUrl));
  });
  app.get("/openapi.yaml", (req: Request, res: Response) => {
    const serverUrl = resolveServerUrl(req, config.port);
    res
      .status(200)
      .type("text/yaml; charset=utf-8")
      .send(buildOpenApiYaml(serverUrl));
  });

  app.get("/", webAuthMiddleware, (_req: Request, res: Response) => {
    res.status(200).type("html").send(getTestPageHtml());
  });

  app.post("/login", loginHandler);

  // ── OIDC login routes (registered only when OIDC is configured) ──────────
  if (oidcProvider) {
    app.get("/auth/login", oidcProvider.loginHandler);
    app.get("/auth/callback", oidcProvider.callbackHandler);
    app.get("/auth/logout", oidcProvider.logoutHandler);
  }

  // ── Browser backend-for-frontend ──────────────────────────────────────────
  // This boundary accepts only the signed OIDC session cookie. It translates
  // that session into a server-controlled tenant/scope principal and then
  // reuses the same operation and collection ACL middleware as the Bearer API.
  const ui = express.Router();
  ui.use(uiPrincipalMiddleware);
  ui.get(
    "/activity/stream",
    requireUiOperator,
    authorizeAdmin,
    activityStreamHandler,
  );
  ui.post(
    "/ingest",
    rateLimiter.middleware,
    uiMutationGuard,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessHeader,
    ingestHandler,
  );
  ui.post(
    "/ingest-stream",
    rateLimiter.middleware,
    uiMutationGuard,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessHeader,
    express.text({
      type: ["application/x-ndjson", "application/json"],
      limit: config.streamBodyLimit,
    }),
    ingestStreamHandler,
  );
  ui.post(
    "/search",
    rateLimiter.middleware,
    authorizeRead,
    metadataMiddleware,
    collectionAccessHeader,
    searchHandler,
  );
  ui.delete(
    "/delete",
    rateLimiter.middleware,
    uiMutationGuard,
    authorizeDelete,
    metadataMiddleware,
    collectionAccessHeader,
    deleteHandler,
  );
  ui.get("/documents", authorizeRead, collectionAccessQuery, queryHandlers.listDocuments);
  ui.get("/documents/content", authorizeRead, collectionAccessQuery, queryHandlers.getDocuments);
  ui.get("/document", authorizeRead, collectionAccessQuery, queryHandlers.getDocument);
  ui.get("/folders", authorizeRead, collectionAccessQuery, queryHandlers.listFolders);
  ui.get("/summaries", authorizeRead, collectionAccessQuery, queryHandlers.getSummaries);
  ui.get("/summary", authorizeRead, collectionAccessQuery, queryHandlers.getSummary);
  ui.get("/collection-stats", authorizeRead, collectionAccessQuery, queryHandlers.collectionStats);
  ui.get("/collections", authorizeRead, uiListCollectionsHandler);
  ui.get(
    "/admin/stats",
    requireUiOperator,
    authorizeAdmin,
    collectionAccessQuery,
    adminStatsHandler,
  );
  ui.delete(
    "/collections/:name",
    requireUiOperator,
    uiMutationGuard,
    authorizeGlobalAdmin,
    deleteCollectionHandler,
  );
  ui.post(
    "/collections/:name/rename",
    requireUiOperator,
    uiMutationGuard,
    authorizeGlobalAdmin,
    createRenameCollectionHandler(postgresClient, logger),
  );
  ui.post(
    "/collections/:name/backfill-summaries",
    requireUiOperator,
    uiMutationGuard,
    authorizeAdmin,
    collectionAccessParam,
    createBackfillSummariesHandler(postgresClient, summaryClient, logger),
  );
  ui.get(
    "/collections/:name/permissions",
    requireUiOperator,
    authorizeGlobalAdmin,
    createGetCollectionPermissionsHandler(postgresClient, logger),
  );
  ui.put(
    "/collections/:name/permissions",
    requireUiOperator,
    uiMutationGuard,
    authorizeGlobalAdmin,
    express.json(),
    createSetCollectionPermissionsHandler(postgresClient, logger),
  );
  app.use("/ui", ui);

  app.put(
    "/document-assets/:assetId",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessAsset,
    express.raw({
      type: [...DOCUMENT_ASSET_MIME_TYPES],
      limit: MAX_DOCUMENT_ASSET_BYTES,
    }),
    putDocumentAssetHandler,
  );
  app.get(
    "/document-assets/:assetId",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessAsset,
    getDocumentAssetHandler,
  );

  app.post(
    "/ingest",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessHeader,
    ingestHandler,
  );
  app.post(
    "/ingest-batch",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessHeader,
    ingestBatchHandler,
  );
  app.post(
    "/ingest-stream",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessHeader,
    express.text({
      type: ["application/x-ndjson", "application/json"],
      limit: config.streamBodyLimit,
    }),
    ingestStreamHandler,
  );
  app.post(
    "/search",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    metadataMiddleware,
    collectionAccessHeader,
    searchHandler,
  );
  app.post(
    "/evaluations/retrieval",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    retrievalEvaluationHandler,
  );
  app.delete(
    "/delete",
    rateLimiter.middleware,
    authMiddleware,
    authorizeDelete,
    metadataMiddleware,
    collectionAccessHeader,
    deleteHandler,
  );
  app.get("/admin/stats", authMiddleware, authorizeAdmin, collectionAccessQuery, adminStatsHandler);

  // ── Read-only query endpoints (mirror the MCP read tools) ────────────────
  app.get("/documents", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.listDocuments);
  app.get("/documents/content", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.getDocuments);
  app.get("/document", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.getDocument);
  app.get("/folders", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.listFolders);
  app.get("/summaries", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.getSummaries);
  app.get("/summary", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.getSummary);
  app.get("/collection-stats", authMiddleware, authorizeRead, collectionAccessQuery, queryHandlers.collectionStats);

  app.get("/collections", authMiddleware, authorizeGlobalAdmin, listCollectionsHandler);
  app.delete(
    "/collections/:name",
    authMiddleware,
    authorizeGlobalAdmin,
    deleteCollectionHandler,
  );
  app.post(
    "/collections/:name/rename",
    authMiddleware,
    authorizeGlobalAdmin,
    createRenameCollectionHandler(postgresClient, logger),
  );
  app.post(
    "/collections/:name/backfill-summaries",
    authMiddleware,
    authorizeAdmin,
    collectionAccessParam,
    createBackfillSummariesHandler(postgresClient, summaryClient, logger),
  );
  app.get(
    "/collections/:name/permissions",
    authMiddleware,
    authorizeGlobalAdmin,
    createGetCollectionPermissionsHandler(postgresClient, logger),
  );
  app.put(
    "/collections/:name/permissions",
    authMiddleware,
    authorizeGlobalAdmin,
    express.json(),
    createSetCollectionPermissionsHandler(postgresClient, logger),
  );

  // MCP endpoint — all three methods on /mcp, protected by Bearer token.
  app.post("/mcp", authMiddleware, mcpHandlers.post);
  app.get("/mcp", authMiddleware, mcpHandlers.get);
  app.delete("/mcp", authMiddleware, mcpHandlers.delete);

  // Stateless MCP 2026-07-28 endpoint. It deliberately shares auth,
  // principals, tool catalog, ACLs, activity and invocation ledger with /mcp.
  app.post(mcp2026Handlers.path, authMiddleware, mcp2026Handlers.post);
  app.get(mcp2026Handlers.path, authMiddleware, mcp2026Handlers.get);
  app.delete(mcp2026Handlers.path, authMiddleware, mcp2026Handlers.delete);

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const bodyError = err as { type?: string; status?: number };
    if (bodyError.type === "entity.too.large" || bodyError.status === 413) {
      res.status(413).json({ error: "Request body exceeds the configured size limit" });
      return;
    }
    const code =
      err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    const message = err instanceof Error ? err.message : String(err);
    // Correlation id so an operator can tie the client's 500 to the log line
    // that has the real message. This is what replaces returning `detail`.
    const errorId = randomUUID();
    req.log.error({ err, code, errorId }, "Unhandled error");
    // `detail` used to carry `err.message` straight to the caller. For a
    // database error that is the failing SQL, a constraint name, or a column
    // list — internal schema handed to whoever triggered the error. The message
    // stays in the log; the client gets an id to quote.
    //
    // `EXPOSE_ERROR_DETAIL=true` restores the old behaviour for local debugging
    // and is refused by the production readiness gate.
    const exposeDetail = config.exposeErrorDetail;
    res.status(500).json({
      error: "Internal Server Error",
      ...(code !== undefined ? { code } : {}),
      errorId,
      ...(exposeDetail ? { detail: message } : {}),
    });
  });

  /** Stop background timers (MCP session sweep, rate limiter cleanup). Call during graceful shutdown. */
  function cleanup(): void {
    mcpHandlers.close();
    rateLimiter.close();
  }

  return { app, cleanup };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(
      "Failed to load config:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }

  const logger = pino({ level: config.logLevel, base: { pid: process.pid } });

  // ── Production-readiness gate ────────────────────────────────────────────
  // Refuse to start in production with permissive settings rather than warning
  // into a log nobody reads. Non-production keeps the convenient defaults and
  // reports what WOULD be fatal, so the same config surfaces the same list
  // before it is promoted.
  const readiness = checkProductionReadiness(config);
  for (const w of readiness.warnings) {
    logger.warn({ readiness: true }, w);
  }
  if (readiness.fatal.length > 0) {
    for (const f of readiness.fatal) {
      logger.fatal({ readiness: true }, f);
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

  // Create circuit breakers before both createApp and createPostgresClient
  // so the status getters can be registered with the postgres client for
  // /metrics and /health endpoints.
  const embeddingBreaker = createCircuitBreaker({ name: "embedding-primary" });
  const embeddingFallbackBreaker = config.embedFallbackModel
    ? createCircuitBreaker({ name: "embedding-fallback" })
    : null;
  const rerankerBreaker = config.rerankModel
    ? createCircuitBreaker({ name: "reranker-primary" })
    : null;
  const rerankerFallbackBreaker = config.rerankFallbackModel
    ? createCircuitBreaker({ name: "reranker-fallback" })
    : null;
  const sparseBreaker = config.sparseModel
    ? createCircuitBreaker({ name: "sparse-embedding" })
    : null;
  const hydeBreaker = config.hydeModel
    ? createCircuitBreaker({ name: "hyde" })
    : null;
  const summaryBreaker = config.summaryModel
    ? createCircuitBreaker({ name: "summary" })
    : null;

  const circuitBreakerGetters = [
    embeddingBreaker,
    embeddingFallbackBreaker,
    rerankerBreaker,
    rerankerFallbackBreaker,
    sparseBreaker,
    hydeBreaker,
    summaryBreaker,
  ]
    .filter((b): b is NonNullable<typeof b> => b !== null)
    .map((b) => () => ({
      name: b.name,
      state: b.state,
      failures: b.failures,
    }));

  const postgresClient = createPostgresClient({
    connectionString: config.postgresUrl,
    logger,
    efSearch: config.hnswEfSearch,
    efConstruction: config.hnswEfConstruction,
    hnswM: config.hnswM,
    halfPrecision: config.halfPrecision,
    defaultFtsLanguage: config.defaultFtsLanguage,
    statsRetentionDays: config.statsRetentionDays,
    rrfK: config.rrfK,
    statsFlushIntervalMs: config.statsFlushIntervalMs,
    quantization: config.quantization,
    embeddingModel: config.embedModel,
    embeddingModelRevision: config.embedModelRevision,
    poolMax: config.pgPoolMax,
    statementTimeoutMs: config.pgStatementTimeoutMs,
    circuitBreakerGetters,
  });

  // Application construction is intentionally deferred until migrations and
  // durable invocation-ledger initialization have completed.

  // Wait for the database to be ready before accepting traffic.
  // This handles the common Docker Compose race where the app container starts
  // before PostgreSQL is fully initialised.
  try {
    await waitForDatabase(postgresClient, logger);
  } catch (err) {
    logger.error({ err }, "Database not reachable at startup; aborting");
    process.exit(1);
  }

  // Run schema migrations before the HTTP server accepts any traffic.
  // Safe for multi-instance deployments: an advisory lock ensures only one
  // instance applies migrations; others wait and skip once the lock is released.
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({
      connectionString: config.postgresUrl,
      max: 1, // migration runner needs only one connection
    });
    try {
      await runMigrations(pool, logger, {
        ddlConfig: {
          vecType: config.halfPrecision ? "halfvec" : "vector",
          cosineOps: config.halfPrecision
            ? "halfvec_cosine_ops"
            : "vector_cosine_ops",
          hnswM: config.hnswM,
          efConstruction: config.hnswEfConstruction,
        },
      });
    } finally {
      await pool.end();
    }
  } catch (err) {
    logger.error({ err }, "Schema migration failed; aborting startup");
    process.exit(1);
  }

  let invocationLedger: InvocationLedger;
  try {
    const postgresLedger = new PostgresInvocationLedger(postgresClient);
    await postgresLedger.initialize();
    invocationLedger = postgresLedger;
    logger.info("PostgreSQL invocation ledger initialized");
  } catch (err) {
    if (config.transactionEnforcement === "required") {
      logger.fatal(
        { err },
        "PostgreSQL invocation ledger initialization failed while TRANSACTION_ENFORCEMENT=required; refusing to start",
      );
      process.exit(1);
    }
    logger.warn(
      { err },
      "PostgreSQL invocation ledger initialization failed; falling back to single-process memory because transaction enforcement is not required",
    );
    invocationLedger = new MemoryInvocationLedger();
  }

  const { app, cleanup } = createApp(
    config,
    postgresClient,
    {
      embeddingBreaker,
      embeddingFallbackBreaker,
      rerankerBreaker,
      rerankerFallbackBreaker,
      sparseBreaker,
      hydeBreaker,
      summaryBreaker,
    },
    invocationLedger,
  );

  const server = app.listen(config.port, () => {
    logger.info(`vectorsearch listening on port ${config.port}`);
  });

  // Enforce a server-level request timeout to prevent slow or stalled
  // connections (e.g. a hanging embedding server) from exhausting the pool.
  // The timeout covers the entire request lifecycle, not just the body read.
  // Default: 2 × fetchTimeoutMs + 5 s headroom for DB round-trips.
  // When FETCH_TIMEOUT_MS=0 (disabled), also disable the server-level timeout
  // so that requests to slow local models are never cut off.
  const requestTimeoutMs =
    config.fetchTimeoutMs > 0 ? config.fetchTimeoutMs * 2 + 5_000 : 0;
  server.requestTimeout = requestTimeoutMs;
  logger.debug({ requestTimeoutMs }, "Server request timeout configured");

  const shutdown = (signal: string) => async () => {
    logger.info(`${signal} received, shutting down gracefully…`);
    cleanup();
    server.close(async () => {
      try {
        await postgresClient.close();
      } catch (err) {
        logger.error({ err }, "Error closing postgres client");
      }
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", shutdown("SIGTERM"));
  process.on("SIGINT", shutdown("SIGINT"));
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const isMainModule =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);

if (isMainModule) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

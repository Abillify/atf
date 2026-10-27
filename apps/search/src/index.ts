// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { createRemoteJWKSet } from "jose";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import { pino } from "pino";
import {
  pinoLogRedaction,
  profileShadowWarning,
  resolveOperationalProfile,
  withMaskedChildBindings,
  createServerWithOptionalTls,
} from "@atf/security-kit";
import {
  createTracer,
  formatTraceparent,
  parseTraceparent,
  type Tracer,
} from "@atf/observability";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  runEmbeddingFallbackCanary,
  type EmbeddingClient,
} from "./embedding-client.js";
import {
  createFallbackRerankerClient,
  createRerankerClient,
} from "./reranker-client.js";
import { createSparseEmbeddingClient } from "./sparse-embedding-client.js";
import { createHydeClient } from "./hyde-client.js";
import { createDecomposeClient } from "./decompose-client.js";
import { createSummaryClient } from "./summary-client.js";
import {
  createPostgresClient,
  type PostgresClient,
  waitForDatabase,
} from "./postgres-client.js";
import { runMigrations } from "./migrations.js";
import { registerFtsLanguages } from "./collection-ddl.js";
import { createCircuitBreaker } from "./retry.js";
import { createIngestHandler } from "./handlers/ingest.js";
import { createIngestBatchHandler } from "./handlers/ingest-batch.js";
import { createRevisionHandlers } from "./handlers/revisions.js";
import { createDocumentSourceHandlers } from "./handlers/document-sources.js";
import { createDocumentDiffHandler } from "./handlers/document-diff-v2.js";
import { createCitationsCheckHandler } from "./handlers/citations-check-v2.js";
import { createRevisionStore } from "./revision-store.js";
import { createRevisionTtlCleaner } from "./revision-ttl-cleaner.js";
import { createBatchWorker } from "./batch-worker.js";
import { createTokenCounter } from "./token-counter.js";
import { Pool as PgPool } from "pg";
import { createIngestStreamHandler } from "./handlers/ingest-stream.js";
import {
  CONVERTIBLE_MIME_TYPES,
  createIngestFileHandler,
} from "./handlers/ingest-file.js";
import { createSearchHandler } from "./handlers/search.js";
import { createSearchV2Handler } from "./handlers/search-v2.js";
import { createRetrieveV2Handler } from "./handlers/retrieve-v2.js";
import { createDeleteHandler } from "./handlers/delete.js";
import { createErasureHandler } from "./handlers/erasure.js";
import {
  createAdminStatsHandler,
  createHealthHandler,
  createLivenessHandler,
  createReadinessHandler,
  createListCollectionsHandler,
  createDeleteCollectionHandler,
} from "./handlers/admin.js";
import { createMetricsHandler } from "./handlers/metrics.js";
import { createRetrievalEvaluationHandler } from "./handlers/evaluation.js";
import { HttpMetrics } from "./http-metrics.js";
import { createMcpHandlers, createMcp2026Handlers } from "./handlers/mcp.js";
import { createEvidenceJwksHandler } from "./handlers/evidence-jwks.js";
import { parseEvidenceSigningKey } from "./evidence-signing.js";
import { createQueryHandlers } from "./handlers/query.js";
import {
  createV2AssetHandlers,
  V2_ASSET_MIME_TYPES,
  MAX_V2_ASSET_BYTES,
} from "./handlers/v2-assets.js";
import { createAssetStore } from "./asset-store.js";
import { createRenderCache } from "./render-cache.js";
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
import { type Config, deprecatedOptionWarnings, loadConfig } from "./config.js";
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
): {
  app: Express;
  cleanup: () => void;
  tracer: Tracer;
  embeddingFallbackClients: {
    primary: EmbeddingClient;
    fallback: EmbeddingClient;
  } | null;
} {
  const app = express();

  const logger = withMaskedChildBindings(pino({ level: config.logLevel, base: { pid: process.pid }, ...pinoLogRedaction() }));
  const httpMetrics = new HttpMetrics();

  // Strip control characters (including \r, \n) from HTTP header values to
  // prevent Node.js ERR_INVALID_CHAR errors when echoing client-supplied IDs.
  const sanitizeHeaderValue = (v: string): string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must go
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
    redisUrl: config.rateLimitRedisUrl,
    logger,
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
        const route = req.route?.path
          ? String(req.route.path)
          : "__unmatched__";
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

  // ── OTel server spans + W3C Trace Context propagation ────────────────────
  // Shared tracer implementation (@atf/observability, Req 11.6): every request
  // gets a server span, parented to an inbound traceparent when present. The
  // span's context doubles as the AsyncLocalStorage traceparent so downstream
  // HTTP clients (embedding, reranker, …) join this service's trace even when
  // the caller sent no traceparent at all.
  const tracer: Tracer = createTracer(
    {
      tracingEnabled: config.tracingEnabled,
      ...(config.otelExporterOtlpEndpoint !== null
        ? { otelExporterOtlpEndpoint: config.otelExporterOtlpEndpoint }
        : {}),
      otelServiceName: config.otelServiceName,
    },
    logger,
  );
  app.use((req: Request, res: Response, next: NextFunction) => {
    const tp = req.headers["traceparent"];
    const ts = req.headers["tracestate"];
    const inbound = parseTraceparent(typeof tp === "string" ? tp : undefined);
    const serverSpan = tracer.startSpan(
      `${req.method} ${req.route?.path ?? req.path}`,
      {
        kind: "server",
        ...(inbound !== undefined ? { parent: inbound } : {}),
        attributes: {
          "http.method": req.method,
          "http.route": req.route?.path ?? req.path,
          "http.target": req.originalUrl ?? req.path,
        },
      },
    );
    traceContextStorage.run(
      {
        traceparent: formatTraceparent(serverSpan.spanContext()),
        tracestate: typeof ts === "string" ? ts : undefined,
      },
      () => {
        res.on("finish", () => {
          // Rename once routing resolved the parameterised path: keeps span
          // names low-cardinality (e.g. "GET /api/documents/:id").
          serverSpan.updateName(`${req.method} ${req.route?.path ?? req.path}`);
          serverSpan
            .setAttribute("http.status_code", res.statusCode)
            .setStatus(res.statusCode >= 500 ? "error" : "ok")
            .end();
        });
        next();
      },
    );
  });

  // ── Token Usage Context propagation ─────────────────────────────────────────
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    usageStorage.run(
      { inputTokens: 0, outputTokens: 0, cost: 0, modelCosts: {} },
      next,
    );
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
        (source) => httpMetrics.recordEmbeddingRequest(source),
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
          scoreTransform: config.rerankScoreTransform,
          logger,
          timeoutMs: config.fetchTimeoutMs,
          batchSize: config.rerankBatchSize,
          batchConcurrency: config.rerankBatchConcurrency,
          globalConcurrency: config.rerankGlobalConcurrency,
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
          scoreTransform: config.rerankScoreTransform,
          logger,
          timeoutMs: config.fetchTimeoutMs,
          batchSize: config.rerankBatchSize,
          batchConcurrency: config.rerankBatchConcurrency,
          globalConcurrency: config.rerankGlobalConcurrency,
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
          cacheTtlMs: config.hydeCacheTtlSeconds * 1000,
          logger: logger,
          timeoutMs: config.fetchTimeoutMs,
          circuitBreaker: hydeBreaker,
          inputTokenCost: config.hydeInputTokenCost,
          outputTokenCost: config.hydeOutputTokenCost,
        })
      : null;

  // Optional model-based question decomposition for retrieve_for_answer;
  // null keeps the rule-based split. The cache TTL follows the HyDE knob.
  const decomposeClient =
    config.retrieveDecomposeUrl !== null && config.retrieveDecomposeModel !== null
      ? createDecomposeClient({
          url: config.retrieveDecomposeUrl,
          model: config.retrieveDecomposeModel,
          token: config.retrieveDecomposeToken,
          timeoutMs: config.retrieveDecomposeTimeoutMs,
          maxTokens: config.retrieveDecomposeMaxTokens,
          cacheTtlMs: config.hydeCacheTtlSeconds * 1000,
          logger,
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
      apiTokenNext: config.apiTokenNext,
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
  const uiPrincipalMiddleware = createUiPrincipalMiddleware(oidcProvider, {
    ...config.uiBff,
    authnMode: config.authnMode,
    authzEnabled: config.authzEnabled,
  });
  const requireUiOperator = createRequireUiOperatorMiddleware(
    config.uiBff.operatorGroup,
    config.authnMode,
  );
  const uiMutationGuard = createUiMutationGuard((req) =>
    resolveServerUrl(req, config.port),
  );
  const loginHandler = createLoginHandler(
    config.monitorToken,
    config.trustProxy,
  );

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
  // Task 4.2 (Requirement 2.4): after a document cascade commits, drop the
  // in-process embedding cache. The cache is keyed by query text alone, so a
  // per-collection subset cannot be addressed — the whole LRU is dropped.
  // Render-cache invalidation needs no hook here: derived render assets are
  // vs_assets rows, and the cascade deletes them with the document.
  postgresClient.setOnDocumentsDeleted?.((deletedCollection, rootRefs) => {
    logger.debug(
      { collection: deletedCollection, refs: rootRefs.length },
      "document cascade committed — clearing the query embedding cache",
    );
    queryCache.clear();
  });

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
      minRerankScore: config.minRerankScore,
      maxQueryChars: config.maxQueryChars,
      groupMaxChunksPerDocument: config.groupMaxChunksPerDocument,
    },
  );
  // Token counter used by the full multi-level unit builder to size
  // text chunks to 350–500 tokens and split oversize tables (Req 11.2 / 11.3),
  // and by /v2/search to fit rerank inputs into the reranker's token budget.
  // Degrades to a character heuristic when TEI /tokenize is unavailable.
  // Created before the v2 search handler so both share one instance/cache.
  const unitTokenCounter = createTokenCounter({
    tokenizeUrl: config.tokenizeUrl ?? "",
    enabled: config.tokenizeEnabled,
    logger,
    timeoutMs: config.tokenizeTimeoutMs,
    cacheSize: config.tokenizeCacheSize,
  });
  const searchV2Handler = createSearchV2Handler(
    embeddingClient,
    postgresClient,
    logger,
    {
      rerankerClient,
      candidateMultiplier: config.rerankCandidateMultiplier,
      hybridSearch: config.hybridSearch,
      sparseClient,
      queryCache,
      hydeClient,
      tokenCounter: unitTokenCounter,
      minRerankScore: config.minRerankScore,
      maxQueryChars: config.maxQueryChars,
      groupMaxChunksPerDocument: config.groupMaxChunksPerDocument,
    },
  );
  const retrieveV2Handler = createRetrieveV2Handler(
    embeddingClient,
    postgresClient,
    logger,
    {
      rerankerClient,
      candidateMultiplier: config.rerankCandidateMultiplier,
      hybridSearch: config.hybridSearch,
      sparseClient,
      queryCache,
      tokenCounter: unitTokenCounter,
      decomposeClient,
      maxQueryChars: config.maxQueryChars,
    },
  );
  const deleteHandler = createDeleteHandler(postgresClient, logger);
  const adminStatsHandler = createAdminStatsHandler(postgresClient, logger);
  const healthHandler = createHealthHandler(
    {
      postgresClient,
      embeddingClient,
      // An instance without authentication says so on /health.
      authDisabled: config.authnMode === "disabled",
    },
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
  const metricsHandler = createMetricsHandler(
    postgresClient,
    httpMetrics,
    queryCache,
  );
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

  // ── v2 revision API ───────────────────────────────
  // A dedicated pool for the revision staging tables keeps the revision store
  // self-contained (it owns its queries) while sharing the same database. The
  // TTL cleaner reaps uncommitted, expired revisions in the background.
  const revisionPool = new PgPool({
    connectionString: config.postgresUrl,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });
  revisionPool.on("error", (err) => {
    logger.error({ err }, "Unexpected idle revision pool client error");
  });
  const revisionStore = createRevisionStore(revisionPool);
  const documentSourceHandlers = createDocumentSourceHandlers(revisionPool, {
    identity: {
      claimTtlMs: config.sourceClaimTtlMs,
      nearDuplicateThreshold: config.dedupNearThreshold,
      duplicateSimilarity: config.dedupDuplicateSimilarity,
    },
    logger,
  });
  const documentDiffHandler = createDocumentDiffHandler(postgresClient, logger);
  const citationsCheckHandler = createCitationsCheckHandler(postgresClient, logger);
  const revisionHandlers = createRevisionHandlers(revisionStore, {
    revisionTtlMs: config.revisionTtlMs,
    logger,
  });

  // ── v2 asset API + AssetStore ────────────────────
  // Reuses the revision pool (vs_assets lives with the staging tables). The
  // backend is postgres (BYTEA) by default or a filesystem volume; derived
  // thumb/preview variants are generated on PUT so a GET is a pure read.
  const assetStore = createAssetStore(revisionPool, {
    backend: config.assetStoreBackend,
    dir: config.assetStoreDir,
  });
  const v2AssetHandlers = createV2AssetHandlers(assetStore, logger);

  // ── Zoom / full-resolution render-and-cache ────────────────────
  // The Search-side capability that, given an asset + region/full + target
  // pixels, returns the cached-or-rendered bytes: it reads the derived asset
  // (ACL-enforced) and, on a miss, has Extract render it via POST /v2/render and
  // caches the PNG as a `tile`/`page` asset variant. Only available when
  // CONVERTER_URL is configured — Search carries no poppler and must reach
  // Extract to render. MCP `get_asset(region)` tool calls
  // `renderCache.getOrRender`.
  const renderCache =
    config.converter !== null
      ? createRenderCache({ converter: config.converter, assetStore, logger })
      : null;
  const revisionTtlCleaner = createRevisionTtlCleaner(revisionStore, {
    intervalMs: config.revisionTtlSweepMs,
    logger,
  });

  // ── v2 batch-processing worker ──────────────────
  // Turns staged NDJSON batches into embedded, upserted index units. Shares the
  // revision pool (same staging tables). The loop is opt-in (BATCH_WORKER); the
  // worker is always constructed so tests can drive it via tick(). intervalMs=0
  // when disabled leaves the loop off but keeps tick() available.
  // Batch metrics (Requirement 18.1): every tick feeds
  // vectorsearch_batch_ticks_total / _duration_seconds / _units_total; the
  // backlog gauge (staged batches in 'received' / 'processing') is refreshed
  // from the tick observer, throttled so an idle 2 s poll does not add a count
  // query per tick. A failed backlog read keeps the previous gauge value.
  const BATCH_BACKLOG_REFRESH_MS = 15_000;
  let batchBacklogRefreshedAt = 0;
  let batchBacklogInFlight = false;
  async function refreshBatchBacklog(): Promise<void> {
    const now = Date.now();
    if (
      batchBacklogInFlight ||
      now - batchBacklogRefreshedAt < BATCH_BACKLOG_REFRESH_MS
    )
      return;
    batchBacklogInFlight = true;
    batchBacklogRefreshedAt = now;
    try {
      const res = await revisionPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM vs_ingest_batches
          WHERE status IN ('received', 'processing')`,
      );
      httpMetrics.setBatchBacklog(Number(res.rows[0]?.n ?? 0));
    } catch (err) {
      logger.debug({ err }, "Batch backlog gauge refresh failed");
    } finally {
      batchBacklogInFlight = false;
    }
  }
  const batchWorker = createBatchWorker(revisionPool, embeddingClient, {
    onTick: (outcome, durationMs) => {
      httpMetrics.recordBatchTick({
        outcome: outcome.kind,
        durationMs,
        ...(outcome.kind === "processed" ? { units: outcome.units } : {}),
      });
      // Not awaited: the gauge refresh must never delay the worker loop.
      void refreshBatchBacklog();
    },
    intervalMs: config.batchWorkerEnabled ? config.batchWorkerIntervalMs : 0,
    backoffMs: config.batchWorkerBackoffMs,
    embedConcurrency: config.batchWorkerEmbedConcurrency,
    tokenCounter: unitTokenCounter,
    vecType: config.halfPrecision ? "halfvec" : "vector",
    // Contextual embedding header (task 3.3, Req 11.4/11.6): prepend a small
    // per-unit context (title/section/pages/type/page-summary) to each
    // chunk/table/figure embed input, capped at a fraction of the chunk budget.
    // The optional per-chunk placement sentence reuses the SUMMARY_* text-LLM;
    // it is OFF by default and only active when a summary client is configured.
    contextHeaderMaxFraction: config.contextHeaderMaxFraction,
    ...(summaryClient ? { summaryClient } : {}),
    contextualChunkLlm: config.contextualChunkLlm,
    ftsContextualHeader: config.ftsContextualHeader === "on",
    // A document may arrive for a collection that does not exist yet; create
    // it with the same defaults the v1 ingest paths use.
    ensureCollection: (collection, vectorSize) =>
      postgresClient.ensureCollection(collection, vectorSize, {
        language: config.defaultFtsLanguage,
        ...(config.sparseModel
          ? { sparseVocabSize: config.sparseVocabSize }
          : {}),
        quantization: config.quantization,
        embeddingModel: config.embedModel,
        embeddingModelRevision: config.embedModelRevision,
      }),
    logger,
  });

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

  // Malformed key material throws here, at startup, rather than per request.
  const evidenceSigningKey = parseEvidenceSigningKey(config.evidenceSigningKey);
  const mcpOptions = {
    embeddingClient,
    postgresClient,
    sparseClient,
    queryCache,
    rerankerClient,
    tokenCounter: unitTokenCounter,
    logger,
    defaultCollection: config.defaultCollection,
    hybridSearchDefault: config.hybridSearch,
    candidateMultiplier: config.rerankCandidateMultiplier,
    minRerankScore: config.minRerankScore,
    maxQueryChars: config.maxQueryChars,
    groupMaxChunksPerDocument: config.groupMaxChunksPerDocument,
    mcpPrettyJson: config.mcpPrettyJson,
    evidenceSigningKey,
    chunkingOptions: mcpChunkingOptions,
    summaryClient,
    hydeClient,
    decomposeClient,
    serviceName: config.mcpServiceName,
    serviceVersion: config.mcpServiceVersion,
    embeddingModel: config.embedModel,
    embeddingModelRevision: config.embedModelRevision,
    // Navigation tools: get_asset variant reads via the AssetStore
    // and its optional region zoom via the render-cache (null when Extract is
    // not configured, disabling the zoom path only).
    assetStore,
    renderCache,
    transactionConfig: {
      enforcement: config.transactionEnforcement,
      secret: config.transactionSecret,
      algorithms: config.transactionAlgorithms,
      ...(config.transactionJwksUri !== null
        ? { jwks: createRemoteJWKSet(new URL(config.transactionJwksUri)) }
        : {}),
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
  // The v1 ingest routes create the collection on first write
  // (`ensureCollection` in the handler), so an unknown collection must not be
  // rejected there — it is what a first ingest looks like.
  const collectionAccessWrite = createCollectionAccessMiddleware(
    postgresClient,
    collectionFromHeader,
    {
      defaultCollection: config.defaultCollection,
      logger,
      allowUnknownCollection: true,
    },
  );
  const collectionAccessQuery = createCollectionAccessMiddleware(
    postgresClient,
    collectionFromQuery,
    { defaultCollection: config.defaultCollection, logger },
  );
  const collectionAccessAsset = createCollectionAccessMiddleware(
    postgresClient,
    (req) =>
      (typeof req.query["collection"] === "string"
        ? req.query["collection"]
        : undefined) ?? collectionFromHeader(req),
    { defaultCollection: config.defaultCollection, logger },
  );
  // POST /v2/citations/check carries the collection in the JSON body (the
  // global express.json parser runs before the routes), falling back to
  // ?collection= and X-Collection like the other read routes.
  const collectionAccessCitations = createCollectionAccessMiddleware(
    postgresClient,
    (req) => {
      const body = req.body as { collection?: unknown } | undefined;
      const fromBody =
        typeof body?.collection === "string" && body.collection !== ""
          ? body.collection
          : undefined;
      return fromBody ?? collectionFromQuery(req) ?? collectionFromHeader(req);
    },
    { defaultCollection: config.defaultCollection, logger },
  );
  const collectionAccessParam = createCollectionAccessMiddleware(
    postgresClient,
    collectionFromParam,
    { logger },
  );
  const authorizeRead = createAuthorizationMiddleware(
    "read",
    config.authzEnforcement,
  );
  const authorizeWrite = createAuthorizationMiddleware(
    "write",
    config.authzEnforcement,
  );
  const authorizeDelete = createAuthorizationMiddleware(
    "delete",
    config.authzEnforcement,
  );
  const authorizeErasure = createAuthorizationMiddleware(
    "erasure",
    config.authzEnforcement,
  );
  const authorizeAdmin = createAuthorizationMiddleware(
    "admin",
    config.authzEnforcement,
  );
  const authorizeMetrics = createAuthorizationMiddleware(
    "metrics",
    config.authzEnforcement,
  );
  const authorizeGlobalAdmin = createAuthorizationMiddleware(
    "global.admin",
    config.authzEnforcement,
  );

  // ── Routes ────────────────────────────────────────────────────────────────
  // Unauthenticated, so an orchestrator and API tooling need no credential.
  // /health/live never touches a dependency (process liveness only);
  // /health/ready gates the load balancer on the database;
  // /health stays the composite diagnostic probe for back-compat.
  app.get("/health", healthHandler);
  app.get("/health/live", createLivenessHandler());
  app.get("/health/ready", createReadinessHandler(postgresClient, logger));
  app.get("/metrics", authMiddleware, authorizeMetrics, metricsHandler);
  app.get(
    "/.well-known/atf-search-evidence-jwks.json",
    createEvidenceJwksHandler(evidenceSigningKey),
  );

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
    collectionAccessWrite,
    ingestHandler,
  );
  ui.post(
    "/ingest-stream",
    rateLimiter.middleware,
    uiMutationGuard,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessWrite,
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
  ui.get(
    "/documents",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.listDocuments,
  );
  ui.get(
    "/documents/content",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getDocuments,
  );
  ui.get(
    "/document",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getDocument,
  );
  ui.get(
    "/folders",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.listFolders,
  );
  ui.get(
    "/summaries",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getSummaries,
  );
  ui.get(
    "/summary",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getSummary,
  );
  ui.get(
    "/collection-stats",
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.collectionStats,
  );
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

  // ── v2 revision routes ────────────────────────────────────────────────────
  // Mounted behind the SAME auth / scope / tenant / collection-ACL chain as
  // /ingest: authMiddleware → authorize(read|write) → collectionAccessHeader
  // (resolves the collection from X-Collection and loads its ACL into
  // res.locals). The document reference is the URL-encoded :ref path param.
  app.post(
    "/v2/documents/:ref/revisions",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessHeader,
    revisionHandlers.create,
  );
  app.put(
    "/v2/documents/:ref/revisions/:rev/batches/:seq",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessHeader,
    express.raw({
      type: () => true,
      limit: config.revisionBatchBodyLimit,
    }),
    revisionHandlers.putBatch,
  );
  app.get(
    "/v2/documents/:ref/revisions/:rev",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessHeader,
    revisionHandlers.getState,
  );
  app.post(
    "/v2/documents/:ref/revisions/:rev/segments/:n/commit",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessHeader,
    revisionHandlers.commitSegment,
  );
  app.post(
    "/v2/documents/:ref/revisions/:rev/commit",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessHeader,
    revisionHandlers.commit,
  );
  app.post(
    "/v2/documents/:ref/revisions/:rev/heartbeat",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessHeader,
    revisionHandlers.heartbeat,
  );
  app.delete(
    "/v2/documents/:ref/revisions/:rev",
    rateLimiter.middleware,
    authMiddleware,
    authorizeDelete,
    collectionAccessHeader,
    revisionHandlers.abort,
  );

  // ── v2 source identification (dedup + version chains) ────────────────────
  app.post(
    "/v2/sources/identify",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessHeader,
    documentSourceHandlers.identify,
  );
  app.get(
    "/v2/documents/:ref/sources",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessHeader,
    documentSourceHandlers.list,
  );
  app.get(
    "/v2/documents/:ref/diff",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    documentDiffHandler,
  );
  app.post(
    "/v2/citations/check",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessCitations,
    citationsCheckHandler,
  );

  // ── v2 asset routes ──────────────────────────────
  // PUT gated on write scope; GET/HEAD on read scope. The collection is resolved
  // from ?collection= or X-Collection (collectionAccessAsset), its ACL is loaded
  // into res.locals, and the AssetStore enforces the asset's revision row ACL on
  // read (Requirement 14.5).
  app.put(
    "/v2/assets/:assetId",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    collectionAccessAsset,
    express.raw({
      type: [...V2_ASSET_MIME_TYPES],
      limit: MAX_V2_ASSET_BYTES,
    }),
    v2AssetHandlers.put,
  );
  app.get(
    "/v2/assets/:assetId",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessAsset,
    v2AssetHandlers.get,
  );
  app.head(
    "/v2/assets/:assetId",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    collectionAccessAsset,
    v2AssetHandlers.head,
  );

  app.post(
    "/ingest",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessWrite,
    ingestHandler,
  );
  // ── Binary document ingest via the converter (opt-in) ─────────────────────
  // Mounted only when CONVERTER_URL is configured, so a deployment without a
  // converter answers 404 rather than 502 from an address that was never set.
  //
  // `metadataMiddleware` deliberately does NOT appear in this chain. The proxy
  // merges converter provenance into X-Metadata *after* the conversion, so the
  // header must be parsed after that — the composed handler below runs it in the
  // right order instead.
  if (config.converter !== null) {
    // The route now starts a v2 job at Extract rather than proxying Markdown
    // into the local ingest path, so `metadataMiddleware` and the local
    // `ingestHandler` are no longer in the chain — the job's emitter writes
    // revisions (and figure assets) back through the revision API. The auth →
    // scope → collection-ACL chain is unchanged.
    app.post(
      "/ingest-file",
      rateLimiter.middleware,
      authMiddleware,
      authorizeWrite,
      collectionAccessHeader,
      express.raw({
        type: [...CONVERTIBLE_MIME_TYPES],
        limit: config.converter.uploadLimit,
      }),
      createIngestFileHandler({
        converter: config.converter,
        logger,
      }),
    );
  }
  app.post(
    "/ingest-batch",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessWrite,
    ingestBatchHandler,
  );
  app.post(
    "/ingest-stream",
    rateLimiter.middleware,
    authMiddleware,
    authorizeWrite,
    metadataMiddleware,
    collectionAccessWrite,
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
  // v2 search: a NEW endpoint with the v2 result shape, behind the
  // SAME auth / tenant / collection-ACL chain as /search. v1 /search above is
  // untouched (Requirement 13.7).
  app.post(
    "/v2/search",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    metadataMiddleware,
    collectionAccessHeader,
    searchV2Handler,
  );
  // Answer-ready retrieval: the HTTP twin of the MCP tool `retrieve_for_answer`,
  // behind the same chain as /v2/search.
  app.post(
    "/v2/retrieve",
    rateLimiter.middleware,
    authMiddleware,
    authorizeRead,
    metadataMiddleware,
    collectionAccessHeader,
    retrieveV2Handler,
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
  // Subject-related erasure (task 4.5, Requirement 2.5): service-authenticated,
  // scope `vectorsearch.erasure`, idempotent over requestId through the
  // invocation ledger. The body is parsed by the global JSON parser.
  app.post(
    "/v1/erasure",
    rateLimiter.middleware,
    authMiddleware,
    authorizeErasure,
    createErasureHandler({
      postgresClient,
      ledger: invocationLedger ?? new MemoryInvocationLedger(),
      subjectMetadataField: config.erasureSubjectMetadataField,
      statsQueryPepper: config.statsQueryPepper,
      logger,
    }),
  );
  app.get(
    "/admin/stats",
    authMiddleware,
    authorizeAdmin,
    collectionAccessQuery,
    adminStatsHandler,
  );

  // ── Read-only query endpoints (mirror the MCP read tools) ────────────────
  app.get(
    "/documents",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.listDocuments,
  );
  app.get(
    "/documents/content",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getDocuments,
  );
  app.get(
    "/document",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getDocument,
  );
  app.get(
    "/folders",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.listFolders,
  );
  app.get(
    "/summaries",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getSummaries,
  );
  app.get(
    "/summary",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.getSummary,
  );
  app.get(
    "/collection-stats",
    authMiddleware,
    authorizeRead,
    collectionAccessQuery,
    queryHandlers.collectionStats,
  );

  app.get(
    "/collections",
    authMiddleware,
    authorizeGlobalAdmin,
    listCollectionsHandler,
  );
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
      res
        .status(413)
        .json({ error: "Request body exceeds the configured size limit" });
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
    revisionTtlCleaner.stop();
    batchWorker.stop();
    // Flush buffered spans and stop the tracer timer (idempotent — awaited
    // again in the shutdown handler before the process exits).
    void tracer.shutdown().catch((err) => {
      logger.error({ err }, "Error flushing tracer spans");
    });
    void revisionPool.end().catch((err) => {
      logger.error({ err }, "Error closing revision pool");
    });
  }

  // Exposed for the startup embedding-fallback canary in main(); null when no
  // fallback embedding provider is configured.
  const embeddingFallbackClients = fallbackEmbeddingClient
    ? { primary: primaryEmbeddingClient, fallback: fallbackEmbeddingClient }
    : null;

  return { app, cleanup, tracer, embeddingFallbackClients };
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

  const logger = withMaskedChildBindings(pino({ level: config.logLevel, base: { pid: process.pid }, ...pinoLogRedaction() }));

  for (const warning of deprecatedOptionWarnings()) logger.warn(warning);

  // ── Production-readiness gate ────────────────────────────────────────────
  // Refuse to start in production with permissive settings rather than warning
  // into a log nobody reads. Non-production keeps the convenient defaults and
  // reports what WOULD be fatal, so the same config surfaces the same list
  // before it is promoted.
  const profileShadow = profileShadowWarning(
    resolveOperationalProfile(process.env, ["NODE_ENV"]),
  );
  if (profileShadow !== undefined) logger.warn({ readiness: true }, profileShadow);
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
        "ATF_PROFILE=development (or NODE_ENV=development) to accept them explicitly.",
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
    hnswIterativeScan: config.hnswIterativeScan,
    hnswMaxScanTuples: config.hnswMaxScanTuples,
    efConstruction: config.hnswEfConstruction,
    hnswM: config.hnswM,
    halfPrecision: config.halfPrecision,
    defaultFtsLanguage: config.defaultFtsLanguage,
    documentAclDefault: config.documentAclDefault,
    statsRetentionDays: config.statsRetentionDays,
    statsStoreRawQuery: config.statsStoreRawQuery,
    statsQueryPepper: config.statsQueryPepper,
    rrfK: config.rrfK,
    rrfWeightDense: config.rrfWeightDense,
    rrfWeightFts: config.rrfWeightFts,
    rrfWeightIdentifier: config.rrfWeightIdentifier,
    rrfWeightSparse: config.rrfWeightSparse,
    rrfMissingZero: config.rrfMissingZero,
    ftsRanker: config.ftsRanker,
    ftsContextualHeader: config.ftsContextualHeader === "on",
    ftsCompoundSplit: config.ftsCompoundSplit === "query",
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
  // Requirement 12.4: production defaults to dedicated migration Jobs
  // (`bun run migrate`) instead of DDL on the boot path (MIGRATE_ON_START).
  if (config.migrateOnStart) {
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
  } else {
    logger.info(
      "MIGRATE_ON_START is disabled — schema migrations are not applied at boot; " +
        "run `bun run migrate` (or the migration Job) first",
    );
  }

  // Operator-installed text search configurations (FTS_EXTRA_LANGUAGES, e.g. a
  // Hunspell `german_compound`): refuse to start when one is missing, rather
  // than failing every ingest and search of a collection that names it.
  if (config.ftsExtraLanguages.length > 0) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: config.postgresUrl, max: 1 });
    try {
      const { rows } = await pool.query<{ cfgname: string }>(
        "SELECT cfgname FROM pg_ts_config WHERE cfgname = ANY($1::text[])",
        [config.ftsExtraLanguages],
      );
      const present = new Set(rows.map((r) => r.cfgname));
      const missing = config.ftsExtraLanguages.filter((n) => !present.has(n));
      if (missing.length > 0) {
        logger.error(
          { missing },
          "FTS_EXTRA_LANGUAGES names text search configurations that do not exist in PostgreSQL; aborting startup",
        );
        process.exit(1);
      }
      registerFtsLanguages(config.ftsExtraLanguages);
      logger.info({ languages: config.ftsExtraLanguages }, "Extra FTS languages enabled");
    } catch (err) {
      logger.error({ err }, "FTS_EXTRA_LANGUAGES check failed; aborting startup");
      process.exit(1);
    } finally {
      await pool.end();
    }
  }

  // Check the installed pgvector version once at startup (Requirement 4.2):
  // < 0.8 forces hnsw.iterative_scan off with a warning. On a brand-new
  // database the extension is created lazily with the first collection, so a
  // null verdict here only defers the decision — searches re-check lazily.
  try {
    const supportsIterative = await postgresClient.ensurePgvectorVersion();
    if (supportsIterative === null) {
      logger.info(
        "pgvector extension not installed yet; iterative-scan support will be checked with the first search",
      );
    }
  } catch (err) {
    logger.warn({ err }, "pgvector version check failed at startup");
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

  const { app, cleanup, tracer, embeddingFallbackClients } = createApp(
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

  // Startup canary: verify primary and fallback embed the probe text into the
  // same vector space. A mismatch warns and (with EMBED_FALLBACK_SAME_SPACE)
  // aborts startup; an unreachable endpoint only warns.
  if (embeddingFallbackClients) {
    await runEmbeddingFallbackCanary(
      embeddingFallbackClients.primary,
      embeddingFallbackClients.fallback,
      logger,
      { abortOnMismatch: config.embedFallbackSameSpace },
    );
  }

  // Optional TLS/mTLS listener (Req 11.8): plain HTTP when config.tls is null.
  const server = createServerWithOptionalTls(app, config.tls);
  server.listen(config.port, () => {
    logger.info(
      `vectorsearch listening on port ${config.port}${config.tls !== null ? " (TLS)" : ""}`,
    );
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
      // Final flush so the last request's spans reach the collector (no-op
      // when tracing is disabled or already flushed).
      await tracer.shutdown().catch(() => undefined);
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

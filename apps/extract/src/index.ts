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

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTRACT_CONTRACT_ID as EXTRACT_CONTRACT_ID_V2 } from "@atf/extract-contract";
import { EXTRACT_CONTRACT_ID } from "@atf/extract-contract/v1";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import pino, { type Logger } from "pino";
import pinoHttp from "pino-http";
import {
  createAuthMiddleware,
  createLoginHandler,
  createWebAuthMiddleware,
} from "./auth.js";
import { createRequireScope } from "./authorize.js";
import { type Config, loadConfig } from "./config.js";
import { toErrorBody } from "./errors.js";
import { createConvertHandler } from "./handlers/convert.js";
import { createDocumentsRouter } from "./handlers/documents.js";
import { derivedPdfCacheDir } from "./jobs/derived-pdf-cache.js";
import { startRetentionSweeper } from "./jobs/job-retention.js";
import { probeLibreOfficeIdentity } from "./pipeline/office.js";
import { createErasureHandler } from "./handlers/erasure.js";
import {
  createHealthHandler,
  createLivenessHandler,
  createReadinessHandler,
  type HealthProbe,
} from "./handlers/health.js";
import { createIngestHandler } from "./handlers/ingest.js";
import { createIngestV2Handler } from "./handlers/ingest-v2.js";
import { createJobsRouter } from "./handlers/jobs.js";
import { createRenderHandler } from "./handlers/render.js";
import type { HostResolver, PinnedRequester } from "./handlers/source-url.js";
import type { UploadOffsetCommitter } from "./handlers/upload-session-lock.js";
import { createUploadsRouter } from "./handlers/uploads.js";
import { createWhoamiHandler } from "./handlers/whoami.js";
import { sanitizeHeaderValue } from "./header-utils.js";
import { HttpMetrics } from "./http-metrics.js";
import { createEmitter, type Emitter } from "./jobs/emitter.js";
import { createJobEventBus, type JobEventBus } from "./jobs/events.js";
import {
  createJobRunner,
  type JobRunnerDeps,
  PIPELINE_REVISION,
  type SourceIdentifier,
} from "./jobs/job-runner.js";
import { createPageAnalyzer } from "./jobs/page-analyzer.js";
import { createPageRenderer } from "./jobs/page-renderer.js";
import { buildSnapshot } from "./jobs/snapshot.js";
import type { JobRunner } from "./jobs/worker.js";
import { createJobWorker, type JobWorker } from "./jobs/worker.js";
import { createJwtVerifier } from "./jwt-verifier.js";
import { createOidcProvider, type OidcProvider } from "./oidc.js";
import { buildOpenApiSpec } from "./openapi.js";
import { createExtractStore, type ExtractStore } from "./persistence/index.js";
import { createExtractor, type Extractor } from "./pipeline/extract.js";
import {
  configureConverterTransport,
  configureSubprocessLimits,
} from "./pipeline/exec.js";
import { createIsolatedRunner } from "./pipeline/isolate.js";
import { MARKDOWN_BLOCKS_VERSION } from "./pipeline/markdown-blocks.js";
import { createOcrClient } from "./pipeline/ocr.js";
import type { BboxLayoutCapability } from "./pipeline/pdf.js";
import { probeBboxLayout } from "./pipeline/pdf.js";
import { checkProductionReadiness } from "./prod-gate.js";
import { createWorkQueue, type WorkQueue } from "./queue.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createRequireIdentityMiddleware } from "./request-principal.js";
import { createRevisionClient } from "./revision-client.js";
import { createSearchClient, type SearchClient } from "./search-client.js";
import { createServerUrlResolver } from "./server-url.js";
import {
  createFilesystemSourceStore,
  type SourceStore,
} from "./source-store.js";
import { createSummaryClient, type SummaryClient } from "./summary/client.js";
import { summaryPromptSet } from "./summary/prompts.js";
import { traceContextStorage } from "./trace-context.js";
import {
  createRequireUiOperatorMiddleware,
  createUiMutationGuard,
  createUiPrincipalMiddleware,
} from "./ui-auth.js";
import { getUiPageHtml } from "./ui-page.js";
import { createUploadMiddleware, sweepUploadScratch } from "./upload.js";
import { createVisionClient, type VisionClient } from "./vision/client.js";
import { pass1PromptSet, pass2PromptSet } from "./vision/prompts.js";

/** Seams for tests, which must not spawn converters or reach a model. */
export interface AppOverrides {
  logger?: Logger;
  vision?: VisionClient;
  /**
   * The text-LLM client for the summary hierarchy. Injected in tests
   * to observe/stub summary calls; in production it is built from `SUMMARY_URL`
   * when configured, else null (the summary pass is skipped). `null` explicitly
   * disables it even when the env is set.
   */
  summaryClient?: SummaryClient | null;
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
  /**
   * The v2 persistence store. Injected in tests so the resumable-upload routes
   * can be exercised against an in-memory fake without a database. In
   * production it is constructed from `EXTRACT_DATABASE_URL`; when neither is
   * present the /v2/uploads routes are not mounted.
   */
  store?: ExtractStore | null;
  /** The content-addressed source store; defaults to a filesystem one. */
  sourceStore?: SourceStore;
  /**
   * The in-process job-event bus feeding SSE and the callback from job/stage
   * events. Injected in tests to observe events; defaults to a fresh bus.
   */
  jobEvents?: JobEventBus;
  /**
   * The outbox emitter the job runner uses in its `emitting` phase.
   * Injected in tests to observe the send/reconcile against a fake Search;
   * defaults to one built from the Search target when configured, or null.
   */
  emitter?: Emitter | null;
  /**
   * Search's source identification (dedup, canonical reference). Injected in
   * tests; defaults to the revision client when a Search target is configured.
   * `null` disables identification.
   */
  sourceIdentifier?: SourceIdentifier | null;
  /**
   * When false (the default in tests), the background job worker loop is not
   * started even if a store is present, so an integration test drives ticks
   * itself. `main` passes true to run the loop in production.
   */
  startWorker?: boolean;
  /**
   * The LibreOffice build identity (`soffice --version`), probed once at start
   * by `main`. When set it is part of the pipeline hash, so a LibreOffice
   * upgrade is a changed stand: a resumed job does not silently mix pages
   * paginated by two converter builds. Omitted (tests, a failed probe) it
   * leaves the hash exactly as it was before this field existed.
   */
  converterIdentity?: string;
  /**
   * DNS resolver for the SSRF-guarded `source_url` pull. Injected in tests so
   * no real DNS lookup happens; defaults to node:dns with `all: true`.
   */
  sourceUrlResolver?: HostResolver;
  /**
   * The pinned HTTP requester for the `source_url` pull. Injected in tests to
   * serve a body without network; defaults to node:http(s) pinned to the
   * validated address.
   */
  sourceUrlRequest?: PinnedRequester;
  /**
   * Commits a resumable-upload chunk append + offset advance atomically per
   * session. Injected in tests with an in-memory store; defaults to the
   * Postgres row-lock implementation.
   */
  uploadOffsetCommitter?: UploadOffsetCommitter;
  /**
   * Builds the v2 job runner from the dependencies `createApp` wires (S2
   * analyzer, metrics, emitter, summary client, …). Defaults to
   * {@link createJobRunner}; a test injects a spy to assert the wiring.
   */
  createJobRunner?: (deps: JobRunnerDeps) => JobRunner;
  /**
   * Replaces the memoised poppler `-bbox-layout` capability probe the S2
   * analyzer uses. Injected in tests so no poppler binary is spawned.
   */
  bboxLayoutProbe?: () => Promise<BboxLayoutCapability>;
}

export interface CreatedApp {
  app: Express;
  /** Stop background timers. Call during graceful shutdown. */
  cleanup: () => void;
  /** Shared OTel tracer (@atf/observability). Flushed on graceful shutdown. */
  tracer: Tracer;
  /**
   * The v2 job worker, when a store is configured; null otherwise. Exposed so
   * an integration test can drive `tick()` deterministically and `main` can
   * stop the loop on shutdown.
   */
  worker: JobWorker | null;
}

/** Documents above this many pages are answered `202` by POST /v1/ingest (polled, not held). */
const SYNC_INGEST_PAGE_LIMIT = 250;
export function createApp(
  config: Config,
  overrides: AppOverrides = {},
): CreatedApp {
  const app = express();
  const logger =
    overrides.logger ??
    withMaskedChildBindings(pino({ level: config.logLevel, base: { pid: process.pid }, ...pinoLogRedaction() }));
  const metrics = overrides.metrics ?? new HttpMetrics();

  // ── Request logging ───────────────────────────────────────────────────────
  // autoLogging is off and the req/res serializers are suppressed: one line per
  // request is emitted below instead, so a conversion's own progress lines are
  // not buried under repeated header dumps.
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "req.headers['x-callback-url']",
        ],
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
        endMetrics(
          req.method,
          req.route?.path ? String(req.route.path) : "__unmatched__",
          res.statusCode,
        );
      };
      res.on("finish", () => {
        finish();
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
      res.on("close", finish);
      next();
    });
  });

  // ── OTel server spans + W3C Trace Context propagation ────────────────────
  // Shared tracer implementation (@atf/observability, Req 11.6): every request
  // gets a server span, parented to an inbound traceparent when present. The
  // span's context doubles as the AsyncLocalStorage traceparent so downstream
  // HTTP clients (vision, OCR, …) join this service's trace even when the
  // caller sent no traceparent at all.
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
          // names low-cardinality (e.g. "POST /jobs/:id").
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
        visionEnableThinking: config.visionEnableThinking ?? null,
        visionSupportsJsonSchema: config.visionSupportsJsonSchema,
      },
      logger,
    );

  // The summary text-LLM client. Only built when SUMMARY_URL is
  // configured; null skips the summary hierarchy so a deployment without the
  // text model still completes jobs with empty `document.end.summaries`.
  const summaryClient: SummaryClient | null =
    overrides.summaryClient !== undefined
      ? overrides.summaryClient
      : config.summary !== null
        ? createSummaryClient(config.summary, logger)
        : null;

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
        subprocessTimeoutMs: config.subprocessTimeoutMs,
        zipLimits: {
          maxEntries: config.zipMaxEntries,
          maxTotalBytes: config.zipMaxTotalBytes,
          maxEntryBytes: config.zipMaxEntryBytes,
          maxRatio: config.zipMaxRatio,
        },
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
      apiTokenNext: config.apiTokenNext,
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

  const webAuth = createWebAuthMiddleware(
    config.monitorToken,
    oidcProvider ?? undefined,
    {
      mode: config.authnMode,
    },
  );
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
  // Deleting a document is its own destructive permission, separate from
  // ingest — the same reasoning that keeps `convert` and `ingest` apart
  // (extract-outpost E2).
  const requireDelete = createRequireScope("extract.delete", {
    authzEnabled: config.authzEnabled,
  });
  // Erasure is the DSAR permission (task 4.6, requirements 2.7, 2.12): it
  // removes subject data across jobs, uploads, and source blobs, so it is a
  // scope of its own — `extract.delete` deletes one document operationally,
  // `extract.erasure` executes a compliance request.
  const requireErasure = createRequireScope("extract.erasure", {
    authzEnabled: config.authzEnabled,
  });
  const requireMetrics = createRequireScope("extract.metrics", {
    authzEnabled: config.authzEnabled,
  });
  // Reading a job's status is operational state, so it is gated on the read
  // scope (extract.admin), distinct from the write scope creating/mutating a job.
  const requireJobRead = createRequireScope("extract.admin", {
    authzEnabled: config.authzEnabled,
  });

  const rateLimiter = createRateLimiter({
    max: config.rateLimit,
    windowMs: 60_000,
    trustProxy: config.trustProxy,
    redisUrl: config.rateLimitRedisUrl,
    keyPrefix: "extract:rl",
    logger,
  });

  // `POST /v2/render` gets its own limiter: each render spawns a poppler
  // subprocess, so a zoom burst is CPU, not just bytes. A
  // research session issues many small renders, so its default budget is higher
  // than the write-path limiter above.
  const renderRateLimiter = createRateLimiter({
    max: config.renderRateLimit,
    windowMs: 60_000,
    trustProxy: config.trustProxy,
    redisUrl: config.rateLimitRedisUrl,
    // Distinct prefix: the render limiter has its own budget, and sharing a
    // GCRA key with the write limiter would mix two different emission rates.
    keyPrefix: "extract:render-rl",
    logger,
  });

  const upload = createUploadMiddleware({
    maxUploadBytes: config.maxUploadBytes,
    uploadMemoryThresholdBytes: config.uploadMemoryThresholdBytes,
    tempDir: config.tempDir,
  });

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

  // ── v2 persistence and source store ───────────────────────────────────────
  // The resumable-upload routes need a database to track session offsets. The
  // store is constructed only when EXTRACT_DATABASE_URL is set (or injected in a
  // test), preserving the "database is optional" guarantee for v1-only
  // deployments. The source store is a plain filesystem volume and always
  // available, but is only reached through the upload routes.
  let worker: JobWorker | null = null;
  // Hoisted so the browser BFF (`/ui/jobs`) can reuse the exact same router as
  // the machine API (`/v2/jobs`): the job overview UI fetches
  // and drives jobs through the session-cookie path, not a bearer token.
  let jobsRouter: Router | null = null;
  // Hoisted for the same reason: the "Neuer Job" tab uploads sources through
  // `/ui/uploads`, the cookie twin of `/v2/uploads`.
  let uploadsRouter: Router | null = null;
  const ownsStore = overrides.store === undefined && config.database !== null;
  const store: ExtractStore | null =
    overrides.store !== undefined
      ? overrides.store
      : config.database !== null
        ? createExtractStore(config.database, logger)
        : null;

  const sourceStore =
    overrides.sourceStore ??
    createFilesystemSourceStore(config.sourceStore.dir);

  // The native parsers run in a Worker thread with a heap ceiling so a
  // pathological document cannot take the service down with it: the main
  // thread keeps serving /health and lease heartbeats while a parse runs.
  // One runner serves both page renderers below.
  const isolatedRunner = createIsolatedRunner({
    enabled: config.parseIsolated,
    maxOldGenerationSizeMb: config.parseMemoryLimitMb,
    logger,
  });

  // The page renderer for on-demand rendering (`POST /v2/render`, task 3.8). It
  // is stateless beyond a per-request prepared source, so it is built once and
  // shared. It resolves the source from the store, converts office→PDF and
  // renders with the SAME poppler/sharp helpers the job pipeline uses, which is
  // what makes an on-demand render byte-identical to a pipeline render and lets
  // Search cache the result.
  const renderPageRenderer = createPageRenderer({
    config: {
      renderDpi: config.renderDpi,
      figureDpi: config.figureDpi,
      tempDir: config.tempDir,
      libreofficeBin: config.libreofficeBin,
      popplerBinDir: config.popplerBinDir,
      subprocessTimeoutMs: config.subprocessTimeoutMs,
      zipLimits: {
        maxEntries: config.zipMaxEntries,
        maxTotalBytes: config.zipMaxTotalBytes,
        maxEntryBytes: config.zipMaxEntryBytes,
        maxRatio: config.zipMaxRatio,
      },
      maxEmbedDepth: config.maxEmbedDepth,
      derivedPdfCache: config.derivedPdfCache,
      derivedPdfCacheMaxBytes: config.derivedPdfCacheMaxMb * 1024 * 1024,
      derivedPdfCacheMaxAgeMs: config.derivedPdfCacheMaxAgeHours * 3_600_000,
    },
    sourceStore,
    logger,
    isolated: isolatedRunner,
  });
  const renderHandler = createRenderHandler({
    sourceStore,
    pageRenderer: renderPageRenderer,
    config: {
      renderDpi: config.renderDpi,
      figureDpi: config.figureDpi,
      renderMaxPixels: config.renderMaxPixels,
      tileTargetPixels: config.tileTargetPixels,
      tileOverlapFraction: config.tileOverlapFraction,
      tileMaxPerPage: config.tileMaxPerPage,
    },
    logger,
  });

  // The pipeline/prompt snapshot frozen onto every new v2 job. Built here (not
  // only inside the store block) because the v2 `/v1/ingest` wrapper needs the
  // same stand to create its jobs. Pure and cheap, so building it unconditionally
  // is harmless in a v1-only deployment.
  const snapshot = buildSnapshot(
    {
      extractor: "poppler",
      renderer: "pdftoppm",
      visionModel: config.visionModel,
      renderDpi: config.renderDpi,
      figureDpi: config.figureDpi,
      // The runner's behaviour revision and the Markdown → block mapping are
      // part of the stand: a deploy that changes either trips a pinned job's
      // resume policy instead of mixing record shapes within one document.
      extra: {
        pageLabel: config.pageLabel,
        pipelineRevision: PIPELINE_REVISION,
        // Only when set: an unset switch must leave the stand (and every
        // pinned job) unchanged, while turning thinking on or off changes the
        // vision output and therefore trips the resume policy.
        ...(config.visionEnableThinking !== undefined && config.visionEnableThinking !== null
          ? { visionEnableThinking: config.visionEnableThinking }
          : {}),
        blockModel: MARKDOWN_BLOCKS_VERSION,
        ...(overrides.converterIdentity !== undefined
          ? { converter: overrides.converterIdentity }
          : {}),
      },
    },
    // Prompt set is versioned by tasks 2.3/2.5: the Pass-1 system prompt and
    // the per-kind Pass-2 prompts, plus their version tags, are folded into the
    // prompt hash so a redeploy that changes any prompt trips a pinned job's
    // resume policy rather than silently mixing two prompt versions into one
    // document. Deterministic and stable: an unchanged prompt set hashes
    // identically across restarts.
    // Task 2.7 folds the summary prompts in too, so a change to a summary
    // system prompt trips a pinned job's resume policy alongside the pass
    // prompts.
    { ...pass1PromptSet(), ...pass2PromptSet(), ...summaryPromptSet() },
  );

  // Ingest is available whenever a Search target is configured, regardless of
  // which implementation serves it. The actual handler is chosen after the job
  // machinery is wired below; the routes and UI that only need the boolean use
  // this.
  const ingestEnabled = searchClient !== null;

  // Assigned below: the v2 job-wrapper when a database AND a Search target are
  // both configured (the emitter needs both), otherwise the original
  // synchronous convert→forward handler so a v1-only deployment is unchanged.
  let ingestHandler: RequestHandler | null = null;

  const healthHandler = createHealthHandler({
    queue,
    vision,
    searchClient,
    logger,
    // An instance without authentication says so on /health.
    authDisabled: config.authnMode === "disabled",
    ...(overrides.probeBinary !== undefined
      ? { probeBinary: overrides.probeBinary }
      : {}),
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
  // /health/live never touches a dependency (process liveness only);
  // /health/ready gates the load balancer on the converter binaries and the
  // vision endpoint; /health stays the composite
  // diagnostic probe for back-compat.
  app.get("/health", healthHandler);
  app.get("/health/live", createLivenessHandler());
  app.get(
    "/health/ready",
    createReadinessHandler({
      vision,
      logger,
      ...(overrides.probeBinary !== undefined
        ? { probeBinary: overrides.probeBinary }
        : {}),
      config: {
        popplerBinDir: config.popplerBinDir,
        tempDir: config.tempDir,
      },
    }),
  );
  app.get("/openapi.json", (req: Request, res: Response) => {
    res.status(200).json(
      buildOpenApiSpec({
        serverUrl: resolveBaseUrl(req),
        ingestEnabled,
        v2Enabled: store !== null,
        deleteEnabled: store !== null && searchClient !== null,
        erasureEnabled: store !== null,
      }),
    );
  });

  app.get(
    "/metrics",
    authMiddleware,
    requireMetrics,
    (_req: Request, res: Response) => {
      res
        .status(200)
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(metrics.render());
    },
  );

  // ── whoami (extract-outpost E1) ───────────────────────────────────────────
  // Authenticated, no scope: the answer is the caller's own identity plus what
  // this instance can do, so a client (the Outpost) can validate its config
  // before the first upload. deleteByReference mirrors the E2 mount condition
  // (a store to cancel active jobs, a Search target to delete in); ownJobRead
  // mirrors E3 (the owner-scoped job read needs the job store).
  app.get(
    "/v1/whoami",
    rateLimiter.middleware,
    authMiddleware,
    createWhoamiHandler({
      features: {
        ingest: ingestEnabled,
        resumableUploads: store !== null,
        deleteByReference: store !== null && searchClient !== null,
        ownJobRead: store !== null,
      },
      maxUploadBytes: config.maxUploadBytes,
    }),
  );

  // Browser entry points are limited like the API: /login checks a token,
  // so it must not be open to unthrottled guessing.
  app.get("/", rateLimiter.middleware, webAuth, (_req: Request, res: Response) => {
    res
      .status(200)
      .type("html")
      .send(
        getUiPageHtml({
          logoutPath: oidcProvider !== null ? "/auth/logout" : null,
          ingestEnabled,
          jobsEnabled: store !== null,
          defaultCollection: config.search?.collection ?? "documents",
          maxUploadBytes: config.maxUploadBytes,
        }),
      );
  });

  app.post(
    "/login",
    rateLimiter.middleware,
    createLoginHandler(config.monitorToken, config.trustProxy),
  );

  if (oidcProvider !== null) {
    app.get("/auth/login", rateLimiter.middleware, oidcProvider.loginHandler);
    app.get("/auth/callback", rateLimiter.middleware, oidcProvider.callbackHandler);
    app.get("/auth/logout", rateLimiter.middleware, oidcProvider.logoutHandler);
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

  // ── v2 on-demand render ────────────────────────────────────────
  // Render a page or a bbox region from a stored source on demand — full
  // resolution is never pre-stored. Its own rate limiter
  // (poppler is CPU) sits ahead of the shared auth chain; rendering derives a
  // read-only image from a stored source, so it is gated on the read scope
  // (extract.admin), the same scope a job status read uses. The JSON body is
  // parsed by the global json() middleware; no upload parser is needed.
  app.post(
    "/v2/render",
    renderRateLimiter.middleware,
    authMiddleware,
    requireJobRead,
    renderHandler,
  );

  // ── v2 resumable uploads ──────────────────────────────────────────────────
  // Same rate-limit → authenticate → authorise chain as every other write
  // route. Storing a source is an ingest-class write, so it is gated on
  // `extract.ingest`. Mounted only when a store is available.
  if (store !== null) {
    uploadsRouter = createUploadsRouter({
      store,
      sourceStore,
      config: {
        tmpDir: config.sourceStore.tmpDir,
        maxUploadBytes: config.maxUploadBytes,
        sourceUrl: config.sourceUrl,
      },
      logger,
      ...(overrides.sourceUrlResolver !== undefined
        ? { resolver: overrides.sourceUrlResolver }
        : {}),
      ...(overrides.sourceUrlRequest !== undefined
        ? { requestImpl: overrides.sourceUrlRequest }
        : {}),
      ...(overrides.uploadOffsetCommitter !== undefined
        ? { offsetCommitter: overrides.uploadOffsetCommitter }
        : {}),
    });
    app.use(
      "/v2/uploads",
      rateLimiter.middleware,
      authMiddleware,
      requireIngest,
      uploadsRouter,
    );

    // ── v2 documents (E2: delete by reference) ────────────────────────────
    // Needs BOTH halves: the store to cancel the reference's active jobs and a
    // Search target to delete in. `requireDelete` runs before either happens,
    // so a caller without `extract.delete` never cancels a job or reaches
    // Search. The mount condition is exactly what
    // `whoami.features.deleteByReference` reports.
    if (searchClient !== null) {
      const documentsRouter = createDocumentsRouter({
        store,
        searchClient,
        logger,
        metrics,
        defaultCollection: config.search?.collection ?? "documents",
        sourceStore,
        tmpDir: config.sourceStore.tmpDir,
        ...(config.derivedPdfCache
          ? { derivedPdfCacheDir: derivedPdfCacheDir(config.tempDir) }
          : {}),
      });
      app.use(
        "/v2/documents",
        rateLimiter.middleware,
        authMiddleware,
        requireDelete,
        documentsRouter,
      );
    }

    // ── DSAR erasure (task 4.6, requirements 2.7, 2.12) ─────────────────
    // Subject-related deletion over jobs, upload sessions, and orphaned source
    // blobs, followed by the Search cascade for the same request. Needs the
    // store (the ledger lives there); a missing Search target is reported as
    // `not_configured`, never as success-by-omission. Idempotent over
    // `requestId`; service auth with the `extract.erasure` scope.
    app.post(
      "/v1/erasure",
      rateLimiter.middleware,
      authMiddleware,
      requireErasure,
      createErasureHandler({
        store,
        sourceStore,
        searchClient,
        logger,
        tmpDir: config.sourceStore.tmpDir,
        ...(config.derivedPdfCache
          ? { derivedPdfCacheDir: derivedPdfCacheDir(config.tempDir) }
          : {}),
      }),
    );

    // ── v2 jobs ─────────────────────────────────────────────────────────────
    // Same auth chain. A GET is a status read (extract.admin); everything else
    // creates or mutates a job and is an ingest-class write (extract.ingest).
    // The scope is chosen per request by method so one router serves both. The
    // snapshot is the hoisted one, shared with the v2 /v1/ingest wrapper.
    jobsRouter = createJobsRouter({
      store,
      sourceStore,
      logger,
      snapshot,
      defaultCollection: config.search?.collection ?? "documents",
      authzEnabled: config.authzEnabled,
    });
    // E3 (requirements 8.7, 8.13): reading ONE job by id is no longer an
    // operator-only read — the originator may poll their own job with
    // `extract.ingest`. The decision needs the row, so it belongs in the
    // handler (`canReadJob`), not here: a single-job GET is passed through and
    // the handler answers 200/404/403. Every other GET — the list, the figure
    // gallery — stays `extract.admin`, because listing other callers' jobs is
    // exactly what E3 must not grant.
    const SINGLE_JOB_GET =
      /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const requireJobScope: RequestHandler = (req, res, next) => {
      if (req.method === "GET") {
        if (SINGLE_JOB_GET.test(req.path)) {
          next();
          return;
        }
        requireJobRead(req, res, next);
        return;
      }
      requireIngest(req, res, next);
    };
    app.use(
      "/v2/jobs",
      rateLimiter.middleware,
      authMiddleware,
      requireJobScope,
      jobsRouter,
    );

    // ── v2 job worker ─────────────────────────────────────────────────────
    // The worker drives claimed jobs through the staged pipeline:
    // it renders pages from the source store on demand, runs render/vision/
    // parse/crops as checkpointed stages via a DB-backed ordered scheduler, and
    // publishes job/stage events onto the bus that feeds SSE and the callback.
    // The loop only runs in a real deployment (`startWorker`); tests drive it
    // by hand through the returned handle.
    const jobEvents = overrides.jobEvents ?? createJobEventBus();
    const pageRenderer = createPageRenderer({
      config: {
        renderDpi: config.renderDpi,
        figureDpi: config.figureDpi,
        tempDir: config.tempDir,
        libreofficeBin: config.libreofficeBin,
        popplerBinDir: config.popplerBinDir,
        subprocessTimeoutMs: config.subprocessTimeoutMs,
        zipLimits: {
          maxEntries: config.zipMaxEntries,
          maxTotalBytes: config.zipMaxTotalBytes,
          maxEntryBytes: config.zipMaxEntryBytes,
          maxRatio: config.zipMaxRatio,
        },
        maxEmbedDepth: config.maxEmbedDepth,
        derivedPdfCache: config.derivedPdfCache,
      derivedPdfCacheMaxBytes: config.derivedPdfCacheMaxMb * 1024 * 1024,
      derivedPdfCacheMaxAgeMs: config.derivedPdfCacheMaxAgeHours * 3_600_000,
      },
      sourceStore,
      logger,
      isolated: isolatedRunner,
    });
    // The emitter streams the staged outbox to Search's revision API and
    // reconciles on resume. It is only built when a Search target is
    // configured; without one the runner still processes and reaches `emitting`
    // but sends nothing.
    // One revision client serves the emitter and the source identification
    // (dedup, canonical reference) the runner does before any work.
    const revisionClient =
      config.search !== null
        ? createRevisionClient(
            {
              url: config.search.url,
              token: config.search.token,
              collection: config.search.collection,
              timeoutMs: config.search.timeoutMs,
              caCertFile: config.search.caCertFile,
            },
            logger,
          )
        : null;
    const identify = revisionClient?.identify;
    const sourceIdentifier: SourceIdentifier | null =
      overrides.sourceIdentifier !== undefined
        ? overrides.sourceIdentifier
        : // A test that injects its own emitter talks to no real Search.
          overrides.emitter === undefined &&
            revisionClient !== null &&
            identify !== undefined
          ? { identify: (args) => identify.call(revisionClient, args) }
          : null;
    const emitter =
      overrides.emitter !== undefined
        ? overrides.emitter
        : revisionClient !== null
          ? createEmitter({
              store,
              revisions: revisionClient,
              config: {
                emitBatchPages: config.emitter.emitBatchPages,
                segmentPages: config.emitter.segmentPages,
                assetUploadConcurrency: config.emitter.assetUploadConcurrency,
                finalizePass: config.emitter.finalizePass,
                contract: EXTRACT_CONTRACT_ID_V2,
                // Fallback stand for a job without a frozen snapshot.
                pipelineVersion: snapshot.pipelineHash,
                promptHash: snapshot.promptHash,
                visionModel: config.visionModel,
                renderDpi: config.renderDpi,
              },
              // `extract_emit_outbox_pending`.
              metrics,
              logger,
            })
          : null;
    // The deterministic S2 page analyzer:
    // `pdftotext -bbox-layout` per page with the same poppler binaries and
    // subprocess timeout as the renderer. The `-bbox-layout` capability is
    // probed once per process (memoised); without it every page analysis is
    // empty and pages degrade to the unhinted vision path.
    let bboxCapability: Promise<BboxLayoutCapability> | null = null;
    const bboxLayoutProbe =
      overrides.bboxLayoutProbe ??
      (() =>
        probeBboxLayout({
          binDir: config.popplerBinDir,
          home: config.tempDir,
        }));
    const pageAnalyzer = createPageAnalyzer({
      config: {
        popplerBinDir: config.popplerBinDir,
        subprocessTimeoutMs: config.subprocessTimeoutMs,
      },
      logger,
      capability: () => {
        if (bboxCapability === null) {
          bboxCapability = bboxLayoutProbe().catch(
            (err: unknown): BboxLayoutCapability => ({
              supported: false,
              version: null,
              reason: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return bboxCapability;
      },
    });
    const buildJobRunner = overrides.createJobRunner ?? createJobRunner;
    const jobRunner = buildJobRunner({
      store,
      vision,
      renderer: pageRenderer,
      analyzer: pageAnalyzer,
      events: jobEvents,
      config: {
        pageConcurrency: config.pageConcurrency,
        visionTokenEstimate: config.jobWorker.visionTokenEstimate,
        visionModel: config.visionModel,
        renderDpi: config.renderDpi,
        figureDpi: config.figureDpi,
        figurePass2Kinds: config.figurePass2Kinds,
        figurePass2MinArea: config.figurePass2MinArea,
        labelCoverageMin: config.labelCoverageMin,
        tileTargetPixels: config.tileTargetPixels,
        tileOverlapFraction: config.tileOverlapFraction,
        tileMaxPerPage: config.tileMaxPerPage,
        renderMaxPixels: config.renderMaxPixels,
        textFastPath: config.textFastPath,
        textFastPathMaxInkRatio: config.textFastPathMaxInkRatio,
        ...(config.summary !== null
          ? { summaryModel: config.summary.model }
          : {}),
        // The budget estimate mirrors the summary output budget; a summary call
        // is far cheaper than a vision page, so it reuses the same guard shape.
        summaryTokenEstimate: config.summary?.maxTokens ?? 512,
        // Token prices (USD per million) booked into every job's cost_usd.
        visionPricing: {
          inputPerMillion: config.visionInputTokenCost,
          outputPerMillion: config.visionOutputTokenCost,
        },
        ...(config.summary !== null
          ? {
              summaryPricing: {
                inputPerMillion: config.summary.inputTokenCost ?? 0,
                outputPerMillion: config.summary.outputTokenCost ?? 0,
              },
            }
          : {}),
        // JOB_MAX_TRANSIENT_WAIT_MS: retry a dependency outage
        // in place with backoff before pausing on dependency with auto-resume.
        maxTransientWaitMs: config.jobWorker.maxTransientWaitMs,
        // VISION_BUDGET_PAGES_PER_DAY: the tenant
        // daily VLM-page cap; 0 disables it (the prod gate warns about that).
        visionBudgetPagesPerDay: config.visionBudgetPagesPerDay,
        // MAX_PAGES: the same per-document ceiling the v1
        // extractor applies, enforced in the v2 runner before any model call.
        maxPages: config.maxPages,
      },
      emitter,
      identifier: sourceIdentifier,
      // OCR_FALLBACK=tesseract: on a VLM outage,
      // a scanned page's text comes from Tesseract with a warning instead of
      // failing the page for a retry. Disabled (the default) unless configured.
      ocr: createOcrClient(config),
      // E-mail attachments are stored here and ingested as jobs of their own.
      sourceStore,
      summaryClient,
      // The shared metrics registry: the fast-path route and fidelity counters
      // ("Anteil Fast-Path") and the per-stage duration/outcome/token series
      // all exposed on `/metrics`.
      metrics,
      logger,
    });
    worker = createJobWorker({
      store,
      runner: jobRunner,
      config: {
        leaseSeconds: config.jobWorker.leaseSeconds,
        heartbeatIntervalMs: config.jobWorker.heartbeatIntervalMs,
        pollIntervalMs: config.jobWorker.pollIntervalMs,
        jobConcurrency: config.jobWorker.jobConcurrency,
        currentSnapshot: snapshot,
        largeJobPageThreshold: config.queueLane.largeJobPageThreshold,
        largeJobMaxConcurrency: config.queueLane.largeJobMaxConcurrency,
      },
      logger,
    });
    if (overrides.startWorker === true) worker.start();
  }

  // ── Ingest handler selection ──────────────────────────────────
  // With BOTH a database and a Search target, `/v1/ingest` is a wrapper around
  // the v2 job + emitter: it stores the upload in the source store, creates a
  // job, drives it inline for a small document (so the historical synchronous
  // response is preserved), and the emitter stores figure assets. Without a
  // database it falls back to the original synchronous convert→forward handler,
  // so a v1-only deployment behaves exactly as before.
  if (searchClient !== null) {
    if (store !== null && worker !== null) {
      const runningWorker = worker;
      // When the background worker loop runs (production), it drains the queue,
      // so the handler only polls the job's status. Without the loop (tests,
      // or a deployment that runs no in-process worker), the handler drives the
      // job itself via the worker's tick. Either way the same staged pipeline +
      // emitter processes the job.
      const runOneJob =
        overrides.startWorker === true ? null : () => runningWorker.tick();
      ingestHandler = createIngestV2Handler({
        store,
        sourceStore,
        runOneJob,
        logger,
        metrics,
        snapshot,
        defaultCollection: config.search?.collection ?? "documents",
        // Pages above which POST /v1/ingest answers 202 instead of waiting. It
        // used to be SEGMENT_PAGES (250); the segment default is now smaller
        // for earlier visibility, which must not move this threshold.
        syncPageLimit: Math.max(SYNC_INGEST_PAGE_LIMIT, config.emitter.segmentPages),
        syncTimeoutMs: config.search?.timeoutMs ?? 120_000,
      });
    } else {
      ingestHandler = createIngestHandler({
        extractor,
        searchClient,
        queue,
        logger,
        metrics,
        defaultCollection: config.search?.collection ?? "documents",
      });
    }
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

  // ── Job overview ───────────────────────────────────────
  // The Jobs tab in the operator console reaches the very same job router as
  // `/v2/jobs`, but through the cookie-authenticated BFF: a browser must not
  // hold a bearer token. Reads (list + detail) need the read scope; the
  // pause/resume/retry/cancel POSTs are cookie-authenticated mutations, so they
  // additionally pass the CSRF guard and require an operator, mirroring
  // `/ui/ingest`. Mounted only when the v2 store — and hence the router — exists.
  if (jobsRouter !== null) {
    const uiJobs = express.Router();
    const guardedJobsRouter = jobsRouter;
    uiJobs.use((req, res, next) => {
      if (req.method === "GET") {
        requireJobRead(req, res, next);
        return;
      }
      // A cookie-authenticated write: CSRF guard → operator → ingest scope.
      uiMutationGuard(req, res, (err?: unknown) => {
        if (err !== undefined) {
          next(err);
          return;
        }
        requireUiOperator(req, res, (err2?: unknown) => {
          if (err2 !== undefined) {
            next(err2);
            return;
          }
          requireIngest(req, res, next);
        });
      });
    });
    uiJobs.use(rateLimiter.middleware, guardedJobsRouter);
    ui.use("/jobs", uiJobs);
  }

  // ── v2 sources and on-demand render for the console ───────────────────────
  // The "Neuer Job" tab uploads a source (resumable chunks or a source_url pull)
  // through the same upload router as `/v2/uploads`; every method there writes
  // or advances a session, so all of them pass the CSRF guard and require an
  // operator with the ingest scope. The page preview in the Jobs tab renders
  // through the same handler as `/v2/render`: read-only, so the read scope, but
  // a POST that spawns poppler, so it is CSRF-guarded and keeps its own limiter.
  if (uploadsRouter !== null) {
    ui.use(
      "/uploads",
      rateLimiter.middleware,
      uiMutationGuard,
      requireUiOperator,
      requireIngest,
      uploadsRouter,
    );
    ui.post(
      "/render",
      renderRateLimiter.middleware,
      uiMutationGuard,
      requireJobRead,
      renderHandler,
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
      err instanceof Error && "status" in err && typeof err.status === "number"
        ? err.status
        : 500;

    if (status >= 500) {
      req.log.error(
        { err, errorId, context: (err as { context?: unknown }).context },
        "Request failed",
      );
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

  // Retention: only the app that opened the store sweeps it; an injected
  // test store is the test's own.
  const retentionSweeper =
    ownsStore && store !== null
      ? startRetentionSweeper({
          store,
          logger,
          jobRetentionDays: config.jobRetentionDays,
          uploadMaxAgeHours: config.uploadSessionMaxAgeHours,
          intervalMs: config.retentionSweepIntervalMinutes * 60_000,
          tmpDir: config.sourceStore.tmpDir,
        })
      : null;
  // Derived-PDF cache limits (DERIVED_PDF_CACHE_MAX_AGE_HOURS/_MAX_MB): also
  // enforced at start and on the retention interval, not only after a new
  // Office conversion, so cached document content expires when no further
  // conversion arrives. Independent of JOB_RETENTION_DAYS.
  const derivedPdfSweepTimer =
    ownsStore &&
    config.derivedPdfCache &&
    (config.derivedPdfCacheMaxAgeHours > 0 || config.derivedPdfCacheMaxMb > 0)
      ? (() => {
          void renderPageRenderer.sweepDerivedPdfCache?.();
          const timer = setInterval(
            () => void renderPageRenderer.sweepDerivedPdfCache?.(),
            Math.max(60_000, config.retentionSweepIntervalMinutes * 60_000),
          );
          timer.unref();
          return timer;
        })()
      : null;
  function cleanup(): void {
    retentionSweeper?.stop();
    if (derivedPdfSweepTimer !== null) clearInterval(derivedPdfSweepTimer);
    rateLimiter.close();
    renderRateLimiter.close();
    // Best-effort: flush buffered spans before the pool closes under us.
    void tracer.shutdown().catch((err) => {
      logger.warn({ err }, "Tracer shutdown during cleanup failed");
    });
    if (worker !== null) void worker.stop();
    // Close the pool only when this app opened it; an injected test store is
    // owned by the test.
    if (ownsStore && store !== null) void store.close();
  }

  return { app, cleanup, worker, tracer };
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

  // ── Production-readiness gate ────────────────────────────────────────────
  // Refuse to start in production with permissive settings, rather than warning
  // into a log nobody reads. Non-production keeps the convenient defaults and
  // reports what WOULD be fatal, so the same config surfaces the same list
  // before it is promoted.
  const profileShadow = profileShadowWarning(
    resolveOperationalProfile(process.env, ["NODE_ENV"]),
  );
  if (profileShadow !== undefined) logger.warn({ readiness: true }, profileShadow);
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
        "ATF_PROFILE=development (or NODE_ENV=development) to accept them explicitly.",
    );
    process.exit(1);
  }
  logger.info(
    { environment: readiness.environment, warnings: readiness.warnings.length },
    "Production-readiness gate passed",
  );

  // Kernel-level memory/CPU ceilings for converter subprocesses. Applied
  // process-wide here rather than in `createApp` so the settings are a startup
  // concern and the test harness, which builds apps directly, keeps the inert
  // default. On non-Linux platforms, or where `prlimit` is absent, this is a
  // no-op and the container's cgroup limits apply instead.
  configureSubprocessLimits({
    memoryLimitMb: config.subprocessMemoryLimitMb,
    cpuLimitSeconds: config.subprocessCpuLimitSeconds,
  });

  // Requirement 5.7: with CONVERTER_MODE=isolated, the converter binaries run
  // in the extract-converter sidecar (no network, read-only root FS, seccomp)
  // and every call is forwarded over the Unix socket. The scratch directory
  // must exist at the same absolute path in both containers — the compose
  // contract mounts it from one volume — because the request carries paths,
  // not bytes. In isolated mode the binaries are not this container's
  // problem, so its own scratch directory is still created (the LibreOffice
  // profiles and pdftoppm prefixes are written here before the call crosses
  // the socket), but a failure to reach the sidecar surfaces as
  // CONVERTER_UNAVAILABLE on the first conversion rather than at boot.
  configureConverterTransport({
    mode: config.converterMode,
    socketPath: config.converterSocket,
  });
  if (config.converterMode === "isolated") {
    logger.info(
      { socket: config.converterSocket },
      "converter mode is isolated: conversions run in the extract-converter sidecar",
    );
  }

  // Fail here rather than on the first upload if a required directory is not
  // writable — a read-only filesystem is a common hardening default.
  try {
    await mkdir(config.tempDir, { recursive: true });
    // The source store and upload scratch are on (possibly separate) volumes.
    await mkdir(config.sourceStore.dir, { recursive: true });
    await mkdir(config.sourceStore.tmpDir, { recursive: true });
  } catch (err) {
    logger.fatal(
      { err, tempDir: config.tempDir, sourceStore: config.sourceStore },
      "A required directory is not writable; refusing to start",
    );
    process.exit(1);
  }

  // Nothing can have spooled an upload before this point, so this is the only
  // moment a scratch file left by a crashed previous process can be reaped
  // safely.
  await sweepUploadScratch(config.tempDir, logger);

  // Probe the poppler `-bbox-layout` capability once at startup and log it, so
  // the deterministic page analysis requirement is
  // visible in the boot log. It is *reported*, never fatal: a v1-only
  // deployment that never runs the analyzed stage still starts cleanly — a
  // missing capability only degrades S2 (pages fall through to vision).
  {
    const cap = await probeBboxLayout({
      binDir: config.popplerBinDir,
      home: config.tempDir,
    }).catch((err: unknown) => ({
      supported: false,
      version: null,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (cap.supported) {
      logger.info(
        { version: cap.version },
        "poppler supports pdftotext -bbox-layout; deterministic page analysis (S2) is available",
      );
    } else {
      logger.warn(
        { version: cap.version, reason: cap.reason },
        "poppler lacks pdftotext -bbox-layout; deterministic page analysis (S2) will be skipped and pages fall through to vision. Requires poppler >= 0.42.",
      );
    }
  }

  // The converter build is part of the pipeline stand (see AppOverrides). A
  // sidecar that is still starting gets a few seconds before the identity is
  // given up on; a failed probe only logs, it never blocks the start (the
  // stand then simply carries no converter field, as before).
  let converterIdentity: string | null = null;
  for (let attempt = 1; attempt <= 3 && converterIdentity === null; attempt++) {
    converterIdentity = await probeLibreOfficeIdentity(
      config.libreofficeBin,
      config.tempDir,
      { timeoutMs: Math.min(config.subprocessTimeoutMs || 15_000, 15_000) },
    );
    if (converterIdentity === null && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
  if (converterIdentity !== null) {
    logger.info({ converter: converterIdentity }, "LibreOffice build identity recorded in the pipeline stand");
  } else {
    logger.warn(
      "LibreOffice version could not be read; the pipeline stand carries no converter identity",
    );
  }
  const { app, cleanup, tracer } = createApp(config, {
    logger,
    startWorker: true,
    ...(converterIdentity !== null ? { converterIdentity } : {}),
  });

  // Optional TLS/mTLS listener (Req 11.8): plain HTTP when config.tls is null.
  const server: Server | HttpsServer = createServerWithOptionalTls(
    app,
    config.tls,
  );
  server.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        contract: EXTRACT_CONTRACT_ID,
        visionModel: config.visionModel,
        searchIngest: config.search !== null,
        renderDpi: config.renderDpi,
        figureDpi: config.figureDpi,
      },
      `extract listening on port ${config.port}${config.tls !== null ? " (TLS)" : ""}`,
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
      void (async () => {
        await tracer.shutdown().catch(() => undefined);
        process.exit(0);
      })();
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

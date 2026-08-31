// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import express, {
  Router,
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { Authenticator } from "./auth/authenticator.ts";
import type { AppConfig, SystemPromptConfig } from "./config/schema.ts";
import { authDisplayReferences } from "./config/auth-references.ts";
import { DatabaseManager, type DbProvider } from "./db/manager.ts";
import { MqttManager, type MqttProvider } from "./mqtt/manager.ts";
import { MonitorBus } from "./monitor/events.ts";
import { createMonitorRouter } from "./monitor/routes.ts";
import { ToolRegistry } from "./tools/registry.ts";
import type { ToolExecutor } from "./tools/types.ts";
import { createLlmClient, type ILlmClient } from "./llm/client.ts";
import { SystemPromptProvider } from "./router/system-prompt.ts";
import { RouterToolExecutor } from "./router/router-tool.ts";
import { createSseRouter } from "./mcp/sse.ts";
import { createStreamableRouter } from "./mcp/streamable.ts";
import { createStateless2026Router } from "./mcp/stateless-2026.ts";
import { createWellKnownRouter } from "./auth/well-known.ts";
import { createRateLimitStore } from "./server/rate-limit-store.ts";
import { createIdentityRateLimiter } from "./server/identity-rate-limit.ts";
import { createMetricsAuthMiddleware } from "./server/metrics-auth.ts";
import { installRequestTracker } from "./server/request-tracker.ts";
import { installHealthRoutes } from "./server/health-routes.ts";
import { resolveRedactOptions } from "./observability/redact.ts";
import { Metrics } from "./monitor/metrics.ts";
import { AuditSink } from "./monitor/audit.ts";
import { createMonitorClusterBridge, type MonitorClusterBridge } from "./monitor/cluster-bridge.ts";
import { logger } from "./logger.ts";
import { resolveEnvironment } from "./config/prod-gate.ts";
import { createWebhookReplayStore } from "./tools/webhook-replay-store.ts";
import {
  TransactionFabric,
  createInvocationLedger,
  transactionConfigFromEnv,
} from "./transaction/fabric.ts";

/** Dependency overrides, primarily for tests (inject fake DB / LLM / MQTT). */
export interface AppOverrides {
  db?: DbProvider;
  bus?: MonitorBus;
  llm?: ILlmClient;
  mqtt?: MqttProvider & { resolveBroker(b?: never): never };
}

export interface AppHandle {
  app: Express;
  bus: MonitorBus;
  db: DbProvider;
  registry: ToolRegistry;
  promptProvider?: SystemPromptProvider;
  instructions?: () => string | undefined;
  /** Number of HTTP requests currently being processed. */
  activeRequests(): number;
  /** Wait for in-flight requests to finish (up to timeoutMs) before shutdown. */
  drain(timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Wire the full application (auth, tools, optional router, MCP transports,
 * monitoring, MQTT, webhooks, rate-limiting, CORS, DNS-rebinding protection)
 * into an Express app without binding a port.
 */
export async function buildApp(
  config: AppConfig,
  overrides: AppOverrides = {},
): Promise<AppHandle> {
  const authReferences = authDisplayReferences(config);
  const redactOptions = resolveRedactOptions(config.monitoring.redact);
  // Relevant claims are deliberately shown in auth events; all other token
  // fields are removed by the MonitorBus before redaction and fan-out.
  redactOptions.claimAllowlist = [
    ...new Set([...redactOptions.claimAllowlist, ...authReferences.claims]),
  ];
  const bus =
    overrides.bus ??
    new MonitorBus(config.monitoring.bufferSize, redactOptions, authReferences);
  const authenticator = new Authenticator(config.auth, config.tenantIsolation);
  // Transaction ledger reuses an explicitly configured transaction URL first,
  // then the existing Redis infrastructure. Without one, the documented
  // compatibility fallback is single-process memory only.
  const transactionConfig = transactionConfigFromEnv();
  const transactionRedisUrl =
    transactionConfig.redisUrl ??
    (config.server.rateLimit.store.type === "redis"
      ? config.server.rateLimit.store.redisUrl
      : undefined) ??
    config.monitoring.cluster.redisUrl;
  const transactionLedger = await createInvocationLedger(
    transactionRedisUrl,
    transactionConfig.redisPrefix,
    {
      ttlSec: transactionConfig.retentionTtlSec,
      memoryMaxEntries: transactionConfig.memoryMaxEntries,
    },
  );
  const transactionFabric = new TransactionFabric(transactionConfig, transactionLedger);
  const hasWebhooks = config.tools.some((tool) => tool.type === "webhook" && tool.enabled);
  const webhookReplayStore = hasWebhooks
    ? await createWebhookReplayStore(transactionRedisUrl, resolveEnvironment())
    : undefined;
  const db = overrides.db ?? new DatabaseManager(config.databases);

  // MQTT manager (lazy — only connects when an mqtt tool subscribes). Always
  // available so mqtt-type tools can resolve their broker.
  const mqtt = (overrides.mqtt as unknown as MqttManager) ?? new MqttManager(config.mqtt);

  const registry = new ToolRegistry(config.tools, {
    db,
    bus,
    mqtt,
    outboundAllowedHosts: config.server.outbound.allowedHosts,
    authorizationEnabled: config.authorization.enabled,
    webhookReplayStore,
  }, config.schemaCompatibility.mode);

  let promptProvider: SystemPromptProvider | undefined;
  const promptProviders: SystemPromptProvider[] = [];
  if (config.router?.enabled) {
    const router = config.router;
    const llm = overrides.llm ?? createLlmClient(router.llm!, bus);

    const targetsFor = (access: "read" | "write") => ({
      definitions: () => registry.realDefinitions(access),
      get: (n: string) => (registry.accessOf(n) === access ? registry.getReal(n) : undefined),
    });

    const routers: Array<{ executor: ToolExecutor; access: "read" | "write" }> = [];

    const readPrompt = new SystemPromptProvider(router.systemPrompt, db, bus, (n) =>
      registry.getReal(n),
    );
    promptProvider = readPrompt;
    promptProviders.push(readPrompt);
    routers.push({
      access: "read",
      executor: new RouterToolExecutor(
        { name: router.name, description: router.description },
        targetsFor("read"),
        readPrompt,
        llm,
        bus,
        router.interpretResults ?? false,
        router.cache,
      ),
    });

    if (registry.realDefinitions("write").length > 0) {
      const writePrompt = new SystemPromptProvider(router.write.systemPrompt, db, bus, (n) =>
        registry.getReal(n),
      );
      promptProviders.push(writePrompt);
      routers.push({
        access: "write",
        executor: new RouterToolExecutor(
          { name: router.write.name, description: router.write.description },
          targetsFor("write"),
          writePrompt,
          llm,
          bus,
          router.interpretResults ?? false,
          router.cache,
        ),
      });
    }

    registry.configureRouters(routers, router.mode);
    await Promise.all(promptProviders.map((p) => p.start()));
  }

  // Server-level MCP instructions (returned in `initialize`).
  const instructionProviders: SystemPromptProvider[] = [];
  let buildInstructions: (() => string | undefined) | undefined;
  {
    const sources: SystemPromptConfig[] = [];
    if (config.instructions) {
      sources.push(config.instructions);
    } else if (config.router) {
      sources.push(config.router.systemPrompt);
      if (registry.realDefinitions("write").length > 0) {
        sources.push(config.router.write.systemPrompt);
      }
    }
    if (sources.length > 0) {
      const reuseRouterProviders = !config.instructions && config.router?.enabled === true;
      const providers = reuseRouterProviders
        ? promptProviders
        : sources.map((s) => new SystemPromptProvider(s, db, bus, (n) => registry.getReal(n)));
      if (!reuseRouterProviders) {
        instructionProviders.push(...providers);
        await Promise.all(providers.map((p) => p.start()));
      }
      buildInstructions = () => {
        const text = providers
          .map((p) => p.getRaw())
          .filter((s) => s.trim().length > 0)
          .join("\n\n");
        return text.trim().length > 0 ? text : undefined;
      };
    }
  }

  const app = express();
  app.disable("x-powered-by");
  // Trust the first proxy hop so express-rate-limit sees the real client IP
  // without the permissive `true` setting (which it rejects for safety).
  app.set("trust proxy", 1);

  // ── In-flight request tracking (for graceful shutdown draining) ─────────────
  const requestTracker = installRequestTracker(app);

  // ── Prometheus metrics ──────────────────────────────────────────────────────
  const metrics = new Metrics();
  metrics.attach(bus);
  if (config.server.metrics.enabled) {
    app.get(
      config.server.metrics.path,
      createMetricsAuthMiddleware(config.server.metrics),
      (_req, res) => {
        res.type("text/plain; version=0.0.4").send(metrics.render());
      },
    );
  }

  // ── Persistent audit log ──────────────────────────────────────────────────
  const audit = new AuditSink(config.monitoring.audit);
  audit.attach(bus);

  // ── Optional multi-instance monitor bridge (HA; opt-in) ─────────────────────
  // Shares MonitorBus events across instances via Redis pub/sub so the
  // dashboard/audit log are cluster-wide. Does NOT migrate MCP sessions —
  // sticky routing per instance is still required for horizontal scaling.
  let clusterBridge: MonitorClusterBridge | undefined;
  if (config.monitoring.cluster.redisUrl) {
    clusterBridge = await createMonitorClusterBridge(
      bus,
      config.monitoring.cluster.redisUrl,
      config.monitoring.cluster.channel,
    );
  }

  // ── DNS-rebinding protection ───────────────────────────────────────────────
  // Reject requests whose Host header hostname is not in the allow-list.
  if (config.server.allowedHosts.length > 0) {
    const allowed = new Set(config.server.allowedHosts.map((h) => h.toLowerCase()));
    app.use((req: Request, res: Response, next: NextFunction) => {
      const host = (req.headers.host ?? "").split(":")[0]?.toLowerCase();
      if (host && !allowed.has(host)) {
        logger.warn("rejected request: host not allowed", { host });
        res.status(403).json({ error: "Host not allowed" });
        return;
      }
      next();
    });
  }

  // ── CORS ────────────────────────────────────────────────────────────────────
  if (config.server.cors.enabled) {
    const origins = config.server.cors.origins;
    app.use(
      cors({
        origin: origins.includes("*") ? true : origins,
        credentials: true,
        // MCP session id is exchanged via a custom response header.
        exposedHeaders: ["Mcp-Session-Id"],
        allowedHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Accept"],
      }),
    );
  }

  // ── Health probes (never rate-limited) ───────────────────────────────────────
  installHealthRoutes(app, {
    db,
    toolCount: () => registry.size,
    transactionLedger,
    ...(webhookReplayStore !== undefined ? { webhookReplayStore } : {}),
  });

  // ── OAuth protected-resource metadata (RFC 9728, never rate-limited) ────────
  // Lets MCP clients (e.g. an IDE) discover which authorization server(s) to
  // run an OIDC/OAuth login against before presenting a bearer token.
  app.use(createWellKnownRouter({ serverConfig: config.server, authConfig: config.auth }));

  // ── Rate limiting ─────────────────────────────────────────────────────────────
  if (config.server.rateLimit.enabled) {
    const store = await createRateLimitStore(config.server.rateLimit);
    app.use(
      rateLimit({
        windowMs: config.server.rateLimit.windowMs,
        max: config.server.rateLimit.max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many requests" },
        ...(store ? { store } : {}),
      }),
    );
  }

  // ── Per-identity rate limiting (additive to the IP-based limit above) ──────
  // Keyed on the caller's auth subject rather than IP, applied to MCP tool
  // calls after authentication. Useful in multi-tenant deployments where many
  // callers share one egress IP. Disabled by default; in-memory unless
  // `store.type: redis` is configured (optional, for HA deployments).
  const identityRateLimiter = await createIdentityRateLimiter(config.server.rateLimit.perIdentity);

  // ── Inbound webhook receivers ─────────────────────────────────────────────────
  const webhooks = registry.webhookExecutors();
  if (webhooks.length > 0) {
    const webhookRouter = Router();
    const seen = new Set<string>();
    for (const wh of webhooks) {
      if (seen.has(wh.path)) {
        throw new Error(`Duplicate webhook path: ${wh.path}`);
      }
      seen.add(wh.path);
      wh.registerReceiver(webhookRouter, bus);
      logger.info(`webhook receiver mounted`, { path: wh.path });
    }
    app.use(webhookRouter);
  }

  const sseRouter = createSseRouter({
    serverConfig: config.server,
    authenticator,
    registry,
    bus,
    instructions: buildInstructions,
    identityRateLimiter,
    transactionFabric,
    authorizationEnabled: config.authorization.enabled,
    policies: config.policies,
  });
  const streamableRouter = createStreamableRouter({
    serverConfig: config.server,
    authenticator,
    registry,
    bus,
    instructions: buildInstructions,
    identityRateLimiter,
    transactionFabric,
    authorizationEnabled: config.authorization.enabled,
    policies: config.policies,
  });
  app.use(sseRouter);
  app.use(streamableRouter);
  if (config.server.mcp2026.enabled) {
    app.use(
      createStateless2026Router({
        serverConfig: config.server,
        authenticator,
        registry,
        bus,
        identityRateLimiter,
        transactionFabric,
        policies: config.policies,
        resources: config.resources,
        prompts: config.prompts,
        skills: config.skills,
        apps: config.apps,
        tasks: config.tasks,
      }),
    );
  }
  // Both routers expose their idle-session sweeper so shutdown can stop it.
  const stopSessionSweepers = (): void => {
    for (const r of [sseRouter, streamableRouter]) {
      (r as unknown as { stopSessions?: () => void }).stopSessions?.();
    }
  };

  if (config.monitoring.enabled) {
    app.use(
      createMonitorRouter({
        bus,
        config: config.monitoring,
        registry,
        instructions: buildInstructions,
      }),
    );
  }

  return {
    app,
    bus,
    db,
    registry,
    promptProvider,
    ...(buildInstructions !== undefined ? { instructions: buildInstructions } : {}),
    activeRequests: requestTracker.activeRequests,
    drain: requestTracker.drain,
    async shutdown() {
      for (const p of promptProviders) p.stop();
      for (const p of instructionProviders) p.stop();
      stopSessionSweepers();
      metrics.detach();
      await audit.close();
      await Promise.all([
        db.destroyAll(),
        mqtt.destroyAll?.(),
        identityRateLimiter?.close?.(),
        transactionLedger.close?.(),
        webhookReplayStore?.close?.(),
        clusterBridge?.close(),
      ]);
    },
  };
}

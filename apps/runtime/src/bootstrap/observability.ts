// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Observability builder (`src/bootstrap/observability.ts`)
 *
 * Creates all observability subsystems:
 *   - Metrics collector
 *   - Budget service + cost-anomaly detector + spend-recorder decorator
 *   - Token-limit service + enforcer
 *   - Audit log
 *   - Retention service
 *   - Data-retention sweep
 *
 * Grouped together because they all read from the same Database and share the
 * same webhook sink, keeping their wiring in one place rather than scattered
 * throughout index.ts.
 */

import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { Database } from "../db/database.js";
import type { MemoryStore } from "../graph/memory-store.js";
import { createMetrics, type Metrics } from "../observability/metrics.js";
import { BudgetService, PostgresCostStore } from "../observability/cost.js";
import type { SpendRecorder } from "../observability/cost.js";
import {
  PostgresTokenLimitStore,
  InMemoryTokenLimitStore,
  PostgresUsageAnalytics,
  EmptyUsageAnalytics,
  TokenLimitService,
  TokenLimitEnforcer,
  type TokenLimitStore,
  type UsageAnalytics,
} from "../observability/token-limits.js";
import {
  BudgetAlerter,
  createWebhookSink,
} from "../observability/budget-alerts.js";
import { createCostAnomalyDetector } from "../observability/cost-anomaly.js";
import { createAuditLog, type AuditLog } from "../observability/audit-log.js";
import { createAuditAnchorService } from "../observability/audit-anchor.js";
import { RetentionService } from "../observability/retention.js";
import {
  replayRetentionTarget,
  executionHistoryRetentionTarget,
  memoryRetentionTarget,
  piiVaultRetentionTarget,
} from "../observability/retention-targets.js";
import {
  analysisArtifactRetentionTarget,
  assistantDataRetentionTarget,
  assistantWorkspaceRetentionTarget,
  autopilotRunRetentionTarget,
  conversationCheckpointRetentionTarget,
  costLedgerRetentionTarget,
  DB_RETENTION_TARGET,
  rocketchatConnectRetentionTarget,
  uncoveredRetentionTarget,
} from "../observability/retention-db-targets.js";
import type { ReplayStore } from "../graph/replay.js";
import type { ExecutionStore } from "../monitoring/execution-store.js";
import type { PiiVaultStore } from "../graph/pii-vault.js";

export interface ObservabilityResult {
  metrics: Metrics;
  budgetService: BudgetService;
  spendRecorder: SpendRecorder;
  tokenLimitService: TokenLimitService;
  tokenLimitEnforcer: TokenLimitEnforcer;
  tokenLimitStore: TokenLimitStore;
  usageAnalytics: UsageAnalytics;
  auditLog: AuditLog;
  retentionService: RetentionService | undefined;
  auditAnchor: import("../observability/audit-anchor.js").AuditAnchorService | undefined;
}

export function buildObservability(
  config: AppConfig,
  logger: Logger,
  database: Database | undefined,
  {
    executionStore,
    replayStore,
    memoryStore,
    piiVaultStore,
    metrics: metricsOption,
  }: {
    executionStore?: ExecutionStore;
    replayStore?: ReplayStore;
    memoryStore?: MemoryStore;
    piiVaultStore?: PiiVaultStore;
    /**
     * Pre-built metrics registry. index.ts creates metrics before the cache
     * bundle (the memory extractor reports degradations through them,
     * Req 7.8) and hands the same instance to this bundle so every
     * subsystem shares one registry. Defaults to a fresh registry
     * honoring `METRICS_ENABLED`.
     */
    metrics?: Metrics;
  } = {},
): ObservabilityResult {
  // ── Metrics ───────────────────────────────────────────────────────────────
  const metrics = metricsOption ?? createMetrics(config.metricsEnabled ?? true);

  // ── Budget service ────────────────────────────────────────────────────────
  const costStore =
    database !== undefined ? new PostgresCostStore(database) : undefined;
  const budgetService = new BudgetService(
    config.budgetDailyPerTenant ?? 0,
    costStore,
    logger,
  );

  // ── Budget alerter ────────────────────────────────────────────────────────
  const webhookSink =
    config.budgetAlertWebhookUrl !== undefined
      ? createWebhookSink(config.budgetAlertWebhookUrl, { logger })
      : undefined;

  const budgetAlerter =
    webhookSink !== undefined &&
    (config.budgetAlertThresholds?.length ?? 0) > 0 &&
    (config.budgetDailyPerTenant ?? 0) > 0
      ? new BudgetAlerter({
          thresholds: config.budgetAlertThresholds ?? [],
          cap: config.budgetDailyPerTenant ?? 0,
          sink: webhookSink,
          logger,
        })
      : undefined;
  if (budgetAlerter !== undefined) {
    logger.info("Budget alerts enabled", {
      thresholds: config.budgetAlertThresholds,
    });
  }

  // ── Cost anomaly detector ─────────────────────────────────────────────────
  const costAnomalyDetector = createCostAnomalyDetector(
    {
      enabled: config.costAnomalyEnabled ?? false,
      windowMs: config.costAnomalyWindowMs,
      baselineDays: config.costAnomalyBaselineDays,
      minBaselineDays: config.costAnomalyMinBaselineDays,
      spikeMultiplier: config.costAnomalySpikeMultiplier,
      minAbsolute: config.costAnomalyMinAbsolute,
      cooldownMs: config.costAnomalyCooldownMs,
    },
    webhookSink,
    logger,
  );

  // ── Spend recorder (decorator over budget service) ────────────────────────
  const spendRecorder: SpendRecorder =
    budgetAlerter !== undefined || costAnomalyDetector !== undefined
      ? {
          record: (tenant, amount, detail) => {
            budgetService.record(tenant, amount, detail);
            if (budgetAlerter !== undefined) {
              void budgetService
                .check(tenant)
                .then((d) => budgetAlerter.observe(tenant, d.spent))
                .catch(() => {});
            }
            if (costAnomalyDetector !== undefined && amount > 0) {
              void costAnomalyDetector.observe(tenant, amount).catch(() => {});
            }
          },
        }
      : budgetService;

  // ── Token limits ──────────────────────────────────────────────────────────
  const tokenLimitStore: TokenLimitStore =
    database !== undefined
      ? new PostgresTokenLimitStore(database)
      : new InMemoryTokenLimitStore();
  const usageAnalytics: UsageAnalytics =
    database !== undefined
      ? new PostgresUsageAnalytics(database)
      : new EmptyUsageAnalytics();
  const tokenLimitService = new TokenLimitService(
    tokenLimitStore,
    usageAnalytics,
  );
  const tokenLimitEnforcer = new TokenLimitEnforcer(tokenLimitService);

  // ── Audit log ─────────────────────────────────────────────────────────────
  // Req 1.9 (platform-hardening): every failed durable audit write increments
  // the write-failure counter (readiness surfaces it as `degraded`, Prod_Gate
  // and alerting key off it) — a silently lost trail must be observable.
  const auditLog: AuditLog = createAuditLog(database, logger, () => {
    metrics.recordCounter("aiperator_audit_write_failures_total", {});
  });

  // ── Audit chain external anchoring (secret-gated) ──────────────────────────
  // Signs the chain tip periodically with an operator-held secret and stores it
  // OUTSIDE the audit DB, so a wholesale internally-consistent chain rebuild is
  // detectable — the strong guarantee the dossier's `tamperEvident` relies on.
  const auditAnchor = createAuditAnchorService(auditLog, {
    ...(config.auditAnchorSecret !== undefined
      ? { secret: config.auditAnchorSecret }
      : {}),
    ...(config.auditAnchorIntervalMs !== undefined
      ? { intervalMs: config.auditAnchorIntervalMs }
      : {}),
    ...(config.auditAnchorFile !== undefined
      ? { filePath: config.auditAnchorFile }
      : {}),
    logger,
  });
  if (auditAnchor !== undefined) {
    auditAnchor.start();
    logger.info("Audit chain anchoring enabled (signed external checkpoints)", {
      intervalMs: config.auditAnchorIntervalMs ?? 6 * 60 * 60_000,
      file: config.auditAnchorFile ?? "(memory only)",
    });
  }

  // ── Retention service ─────────────────────────────────────────────────────
  let retentionService: RetentionService | undefined;
  if (config.retentionEnabled === true) {
    const targets = [];
    if (replayStore !== undefined)
      targets.push(replayRetentionTarget(replayStore));
    // The PII vault resolves a user to their executions, so it must erase
    // before the execution history removes that attribution.
    if (piiVaultStore !== undefined)
      targets.push(
        piiVaultRetentionTarget(
          piiVaultStore,
          executionStore !== undefined
            ? (subject) => executionStore.executionIdsForSubject(subject)
            : undefined,
        ),
      );
    // Conversation checkpoints resolve a subject to its threads through the
    // execution history, so they too must erase before it.
    if (config.checkpointingEnabled === true) {
      targets.push(
        database !== undefined && executionStore !== undefined
          ? conversationCheckpointRetentionTarget(database, (subject) =>
              executionStore.conversationThreadsForSubject(subject),
            )
          : uncoveredRetentionTarget(
              DB_RETENTION_TARGET.conversationCheckpoints,
              "in-memory conversation checkpoints (no DATABASE_URL) are only cleared by a restart",
            ),
      );
    }
    if (config.assistantsEnabled === true) {
      targets.push(
        database !== undefined
          ? assistantDataRetentionTarget(database)
          : uncoveredRetentionTarget(
              DB_RETENTION_TARGET.assistantData,
              "in-memory assistant stores (no DATABASE_URL) are only cleared by a restart",
            ),
        assistantWorkspaceRetentionTarget(
          config.assistantWorkspaceRoot ?? "./data/assistants",
        ),
      );
    }
    if (database !== undefined) {
      targets.push(
        costLedgerRetentionTarget(database),
        analysisArtifactRetentionTarget(database),
        rocketchatConnectRetentionTarget(database),
        autopilotRunRetentionTarget(database),
      );
    }
    if (config.semanticCacheEnabled === true) {
      targets.push(
        uncoveredRetentionTarget(
          "semantic_cache",
          "semantic-cache entries are keyed by tenant and prompt, not by user; " +
            "they expire after SEMANTIC_CACHE_TTL_SECONDS",
        ),
      );
    }
    if (executionStore !== undefined)
      targets.push(executionHistoryRetentionTarget(executionStore));
    if (memoryStore !== undefined)
      targets.push(memoryRetentionTarget(memoryStore));

    if (targets.length === 0) {
      logger.warn(
        "RETENTION_ENABLED is set but no retention-capable store is active " +
          "(enable REPLAY_ENABLED / MEMORY_ENABLED / DATABASE_URL). Retention is inert.",
      );
    } else {
      retentionService = new RetentionService(
        targets,
        {
          ...(config.retentionMaxAgeDays !== undefined
            ? { maxAgeDaysByTarget: config.retentionMaxAgeDays }
            : {}),
          ...(config.retentionDefaultMaxAgeDays !== undefined
            ? { defaultMaxAgeDays: config.retentionDefaultMaxAgeDays }
            : {}),
        },
        { logger },
      );
      retentionService.start(config.retentionSweepIntervalMs ?? 21_600_000);
      logger.info("Data retention & RTBF enabled", {
        targets: retentionService.describeTargets(),
      });
    }
  }

  return {
    metrics,
    budgetService,
    spendRecorder,
    tokenLimitService,
    tokenLimitEnforcer,
    tokenLimitStore,
    usageAnalytics,
    auditLog,
    retentionService,
    auditAnchor,
  };
}

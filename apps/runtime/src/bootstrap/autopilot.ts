// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Continuous Safety & Quality Autopilot builder (`src/bootstrap/autopilot.ts`)
 *
 * Extracted from `index.ts` (ADR-0004 style split) so the composition root's
 * Autopilot wiring — canary registrar, judge-model resolution, the
 * red-team-run hook, the `/autopilot/*` router, and the health-signal
 * poller — lives in one focused, independently readable module instead of a
 * ~200-line inline block.
 *
 * Activation: only when `redTeamEngine`, `flowOptimizer`, and `flowStore` are
 * all defined (mirrors the original inline condition — the autopilot loop
 * needs all three subsystems). When inactive, a stub `/autopilot/*` router is
 * mounted that returns 503 with a descriptive message.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import type { Hono as HonoApp } from "hono";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../observability/logger.js";
import type { AuditLog } from "../observability/audit-log.js";
import type { Database } from "../db/database.js";
import type { RedTeamEngine } from "../security/red-team-engine.js";
import type { FlowOptimizer } from "../graph/flow-optimizer.js";
import type { FlowStore } from "../graph/flow-store.js";
import type { CanaryManager } from "../graph/canary.js";
import type { OperatorAuthorizer } from "../middleware/operator-rbac.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { ModelQualityRegistry } from "../graph/model-quality.js";
import type { AutopilotEngine } from "../autopilot/autopilot-engine.js";
import type { AuthContext } from "../middleware/auth.js";

export interface AutopilotBuildOptions {
  config: AppConfig;
  app: HonoApp<AuthContext>;
  logger: Logger;
  auditLog: AuditLog | undefined;
  database: Database | undefined;
  operatorAuth: OperatorAuthorizer;
  monitoringService: MonitoringServiceInterface;
  modelQuality: ModelQualityRegistry;
  canaryManager: CanaryManager;
  /** Defined only when RED_TEAM_ENABLED=true (see bootstrap red-team wiring). */
  redTeamEngine: RedTeamEngine | undefined;
  /** Defined only when OPTIMIZER_ENABLED=true and a generator/judge model resolved. */
  flowOptimizer: FlowOptimizer | undefined;
  /** Defined only when a durable or in-memory flow store is configured. */
  flowStore: FlowStore | undefined;
}

export interface AutopilotBuildResult {
  autopilotEngine: AutopilotEngine | undefined;
}

/**
 * Builds and mounts the Continuous Safety & Quality Autopilot when all three
 * prerequisite subsystems are available; otherwise mounts a stub router that
 * reports the feature as unavailable.
 */
export async function buildAutopilot(
  opts: AutopilotBuildOptions,
): Promise<AutopilotBuildResult> {
  const {
    config,
    app,
    logger,
    auditLog,
    database,
    operatorAuth,
    monitoringService,
    modelQuality,
    canaryManager,
    redTeamEngine,
    flowOptimizer,
    flowStore,
  } = opts;

  if (
    redTeamEngine === undefined ||
    flowOptimizer === undefined ||
    flowStore === undefined
  ) {
    const stubRouter = new Hono();
    stubRouter.all("/*", (ctx) =>
      ctx.json(
        {
          error: {
            message:
              "Autopilot requires RED_TEAM_ENABLED=true, OPTIMIZER_ENABLED=true, and FLOW_EDITOR_ENABLED=true.",
            type: "not_available_error",
          },
        },
        503,
      ),
    );
    app.route("/autopilot", stubRouter);
    return { autopilotEngine: undefined };
  }

  const { createAutopilotEngine } = await import(
    "../autopilot/autopilot-engine.js"
  );
  const { createCanaryFileRegistrar } = await import(
    "../autopilot/canary-registrar.js"
  );
  const { createAutopilotRouter } = await import("../routes/autopilot.js");
  const { createAutopilotRunHistory } = await import(
    "../autopilot/autopilot-run-history.js"
  );

  const canaryRegistrar = createCanaryFileRegistrar(
    config.flowsDir,
    canaryManager,
    logger,
  );

  const autopilotJudgeModelConfig =
    config.optimizerJudgeModel ?? config.canaryJudgeModel ?? config.defaultLlm;

  const autopilotEngine = createAutopilotEngine(
    {
      optimizer: flowOptimizer,
      flowStore,
      canaryRegistrar,
      auditLog,
      logger,
      ...(autopilotJudgeModelConfig !== undefined
        ? {
            judgeModelId: {
              provider: autopilotJudgeModelConfig.provider,
              model: autopilotJudgeModelConfig.model,
            },
          }
        : {}),
      history: createAutopilotRunHistory(database, logger),
    },
    {
      bypassRateThreshold: config.redTeamAutoTuneCeiling ?? 0.1,
      minScoreImprovement: config.optimizerScheduleMinScoreImprovement ?? 0.05,
      canaryTrafficPercent: 10,
      requireHumanApproval: config.autopilotRequireApproval ?? true,
      maxAutoPromotionsPerWindow:
        config.autopilotMaxAutoPromotionsPerWindow ?? 3,
      driftWindowMs: config.autopilotDriftWindowMs ?? 86_400_000,
    },
  );

  // Hook the autopilot into the red-team engine's post-run callback. The
  // cleanest seam without changing the RedTeamEngine interface is to wrap its
  // `run` method so every completed run also notifies the autopilot.
  const originalRun = redTeamEngine.run.bind(redTeamEngine);
  (redTeamEngine as unknown as Record<string, unknown>).run = async (
    ...args: Parameters<typeof originalRun>
  ) => {
    const result = await originalRun(...args);
    void autopilotEngine.onRedTeamRunCompleted(result).catch((err) => {
      logger.warn("[Autopilot] onRedTeamRunCompleted failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return result;
  };

  app.route(
    "/autopilot",
    createAutopilotRouter({
      autopilot: autopilotEngine,
      operatorAuth,
      auditLog,
    }),
  );

  logger.info("Continuous Safety & Quality Autopilot enabled at /autopilot/*", {
    bypassRateThreshold: autopilotEngine.config.bypassRateThreshold,
    minScoreImprovement: autopilotEngine.config.minScoreImprovement,
    canaryTrafficPercent: autopilotEngine.config.canaryTrafficPercent,
  });

  startHealthSignalPoller({
    config,
    logger,
    monitoringService,
    modelQuality,
    autopilotEngine,
  });

  return { autopilotEngine };
}

// ---------------------------------------------------------------------------
// Health-signal poller
// ---------------------------------------------------------------------------

interface HealthPollerOptions {
  config: AppConfig;
  logger: Logger;
  monitoringService: AutopilotBuildOptions["monitoringService"];
  modelQuality: ModelQualityRegistry;
  autopilotEngine: AutopilotEngine;
}

/**
 * Periodically computes error rate + P95 latency + model quality score for
 * each scheduled flow and feeds them into the autopilot's `onHealthSnapshot`,
 * closing the self-healing feedback loop for signals other than red-team
 * bypass rate (error spikes, latency regressions, silent quality decay).
 *
 * No-op when no flows are configured for red-team scheduling — the health
 * poller reuses that flow list rather than introducing a second one.
 */
function startHealthSignalPoller(opts: HealthPollerOptions): void {
  const { config, logger, monitoringService, modelQuality, autopilotEngine } =
    opts;
  const healthFlows = config.redTeamScheduleFlows ?? [];
  if (healthFlows.length === 0) return;

  const healthPollIntervalMs = (config.redTeamIntervalMs ?? 6 * 60 * 60_000) / 2;

  const healthTimer = setInterval(() => {
    void (async () => {
      for (const flowId of healthFlows) {
        try {
          const history = await monitoringService.getHistory(500);
          const windowStart = Date.now() - autopilotEngine.config.healthWindowMs;
          const recent = history.filter(
            (h) =>
              h.flow_id === flowId &&
              new Date(h.started_at).getTime() >= windowStart,
          );
          if (recent.length === 0) continue;

          const errorCount = recent.filter((h) => h.status === "error").length;
          const errorRate = errorCount / recent.length;

          const latencies = recent
            .map((h) => h.total_latency_ms ?? 0)
            .filter((ms): ms is number => ms > 0)
            .sort((a, b) => a - b);
          const p95Idx = Math.floor(latencies.length * 0.95);
          const p95LatencyMs = latencies[p95Idx] ?? 0;

          const qualitySnap = modelQuality.snapshot();
          const flowQuality =
            qualitySnap.length > 0
              ? qualitySnap.reduce(
                  (best, s) => (s.meanScore > best ? s.meanScore : best),
                  0,
                )
              : undefined;

          await autopilotEngine.onHealthSnapshot({
            flowId,
            executionCount: recent.length,
            errorRate,
            p95LatencyMs,
            ...(flowQuality !== undefined ? { qualityScore: flowQuality } : {}),
            windowStart: new Date(windowStart).toISOString(),
          });
        } catch (err) {
          logger.warn("[Health Poller] Snapshot failed for flow", {
            flowId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
  }, healthPollIntervalMs);
  healthTimer.unref?.();

  logger.info("Autopilot health-signal poller started", {
    flows: healthFlows,
    intervalMs: healthPollIntervalMs,
    signals: ["error-rate", "p95-latency", "quality-score"],
  });
}

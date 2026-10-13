// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Red-Team / AI Security Posture bootstrap (extracted verbatim from index.ts, 18.3).
 *
 * Builds the RedTeamEngine and the optional scheduler when RED_TEAM_ENABLED is
 * set. The attack executor previously existed twice (scheduler closure and
 * security-router closure); both bodies were identical, so a single shared
 * executor is returned and wired into both call sites.
 */

import crypto from "node:crypto";
import type { AppConfig } from "../config/index.js";
import type { ExecutionAdmissionService } from "../graph/execution-admission.js";
import { requireExecutionAdmission } from "../graph/execution-admission.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import { createLlmProvider } from "../graph/llm-factory.js";
import type { InputGuardrail } from "../graph/input-guardrails.js";
import type { ReplayStore } from "../graph/replay.js";
import type { Logger } from "../observability/logger.js";
import { createRedTeamEngine } from "../security/red-team-engine.js";
import type {
  RedTeamEngine,
  RedTeamExecutor,
} from "../security/red-team-engine.js";
import { createRedTeamScheduler } from "../security/red-team-scheduler.js";
import type { RedTeamScheduler } from "../security/red-team-scheduler.js";

export interface RedTeamDeps {
  config: AppConfig;
  logger: Logger;
  graphEngine: GraphEngineService;
  inputGuardrail: InputGuardrail | undefined;
  replayStore: ReplayStore | undefined;
  executionAdmission: ExecutionAdmissionService;
}

export interface RedTeamResult {
  engine: RedTeamEngine | undefined;
  scheduler: RedTeamScheduler | undefined;
  /** Shared attack executor — wired into both the scheduler and the security router. */
  executor: RedTeamExecutor | undefined;
}

export async function buildRedTeam(
  deps: RedTeamDeps,
): Promise<RedTeamResult> {
  const {
    config,
    logger,
    graphEngine,
    inputGuardrail,
    replayStore,
    executionAdmission,
  } = deps;

  let redTeamEngine: RedTeamEngine | undefined;
  let redTeamScheduler: RedTeamScheduler | undefined;
  let redTeamExecutor: RedTeamExecutor | undefined;

  if (config.redTeamEnabled === true) {
    // Boot the attack registry (with optional remote hot-updates) BEFORE the engine.
    const { createAttackRegistry } = await import(
      "../security/red-team-attack-registry.js"
    );
    createAttackRegistry({
      remoteUrl: config.redTeamAttacksUrl,
      pollIntervalMs: config.redTeamAttacksPollIntervalMs,
      logger,
    });
    if (config.redTeamAttacksUrl !== undefined) {
      logger.info("Red-team attack library remote updates enabled", {
        url: config.redTeamAttacksUrl,
        pollIntervalMs: config.redTeamAttacksPollIntervalMs,
      });
    }

    const redTeamJudgeModel = config.redTeamJudgeModel;
    const redTeamJudgeLlm =
      redTeamJudgeModel !== undefined
        ? (() => {
            try {
              return createLlmProvider(redTeamJudgeModel, config);
            } catch {
              return undefined;
            }
          })()
        : config.defaultLlm !== undefined
          ? createLlmProvider(config.defaultLlm, config)
          : undefined;

    const { createLlmJudge } = await import("../eval/llm-judge.js");
    redTeamEngine = createRedTeamEngine({
      attacksPerRun: config.redTeamAttacksPerRun,
      ...(redTeamJudgeLlm !== undefined
        ? { judge: createLlmJudge(redTeamJudgeLlm) }
        : {}),
      judgePassThreshold: config.redTeamJudgeThreshold ?? 0.7,
      autoTune: config.redTeamAutoTune ?? false,
      autoTuneBypassCeiling: config.redTeamAutoTuneCeiling ?? 0.1,
      postureAlertThreshold: config.redTeamPostureAlertThreshold ?? 0.7,
      alertWebhookUrl:
        config.redTeamAlertWebhookUrl ?? config.budgetAlertWebhookUrl,
      ...(replayStore !== undefined ? { replayStore } : {}),
      logger,
    });
    logger.info(
      "Red-team / security posture engine enabled at /security/red-team/*",
    );

    // Build the executor: runs an attack through the guardrail + graphEngine.
    redTeamExecutor = async (
      flowId: string,
      payload: string,
    ): Promise<{ response: string; blocked: boolean; inputScore: number }> => {
      // Heuristic input score.
      const { scoreText } = await import("../graph/input-guardrails.js");
      const scanResult = scoreText(payload, inputGuardrail?.threshold ?? 0.8);
      const inputScore = scanResult.score;

      // Apply guardrail in "block" mode for the red-team (we want to measure blocks).
      if (inputGuardrail !== undefined && scanResult.flagged) {
        return { response: "", blocked: true, inputScore };
      }

      const parts: string[] = [];
      const executionContext = {
        ssoToken: "red-team",
        executionId: crypto.randomUUID(),
      };
      await requireExecutionAdmission(
        executionAdmission,
        flowId,
        executionContext,
      );
      await graphEngine.executeFlow(
        flowId,
        [{ role: "user", content: payload }],
        executionContext,
        async (chunk) => {
          const delta = chunk.choices[0]?.delta?.content;
          if (typeof delta === "string") parts.push(delta);
        },
        async () => {},
      );
      return { response: parts.join(""), blocked: false, inputScore };
    };

    // Scheduled runs (opt-in).
    const redTeamScheduleFlows = config.redTeamScheduleFlows;
    if (redTeamScheduleFlows !== undefined && redTeamScheduleFlows.length > 0) {
      redTeamScheduler = createRedTeamScheduler(redTeamEngine, {
        flowIds: redTeamScheduleFlows,
        intervalMs: config.redTeamIntervalMs ?? 6 * 60 * 60_000,
        executor: redTeamExecutor,
        ...(inputGuardrail !== undefined ? { guardrail: inputGuardrail } : {}),
        logger,
      });
      redTeamScheduler.start();
      logger.info("Red-team scheduler started", {
        flows: redTeamScheduleFlows,
        intervalMs: config.redTeamIntervalMs ?? 6 * 60 * 60_000,
      });
    }
  }

  return {
    engine: redTeamEngine,
    scheduler: redTeamScheduler,
    executor: redTeamExecutor,
  };
}

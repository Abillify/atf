// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Routing advisor (`src/graph/routing-advisor.ts`)
 *
 * Combines the cost-router (cost savings) with the model-quality registry and
 * eval-judge scores (quality loss) to produce RoutingRecommendation[] for the
 * Studio Optimize panel (Req. 17).
 *
 * Design decisions:
 * - Pure function: no I/O, fully unit-testable.
 * - Configurable thresholds (Req. 17.2): only recommendations that clear both
 *   `minCostSavingPct` AND are within `maxQualityLossPct` are returned.
 * - Acceptance (Req. 17.3): `acceptRecommendation` starts a canary via the
 *   injected CanaryManager.
 *
 * No `any` at module boundaries.
 */

import type { FlowDefinition, LlmConfig } from "../types/flow.js";
import {
  selectModel,
  modelKey,
  parseRoutingConfig,
  type RoutingConfig,
  type ModelQualityStats,
} from "./cost-router.js";
import { getModelPricing } from "../observability/cost.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single cost+quality routing recommendation. */
export interface RoutingRecommendation {
  /** Flow this recommendation applies to. */
  flowId: string;
  /** Node id within the flow. */
  nodeId: string;
  /** Human-readable key for the current model, e.g. "openai/gpt-4o". */
  currentModel: string;
  /** Human-readable key for the suggested cheaper model. */
  suggestedModel: string;
  /** Expected percentage cost saving (0–100). */
  expectedCostSavingPct: number;
  /** Expected percentage quality loss (0–100). */
  expectedQualityLossPct: number;
  /**
   * Source of the quality loss estimate:
   * - "eval-judge": derived from recorded judge scores (preferred)
   * - "model-quality-registry": from the EMA quality registry
   * - "unknown": no quality data available (loss assumed 0 when below threshold)
   */
  source: "eval-judge" | "model-quality-registry" | "unknown";
}

/** Describes one candidate model for a node within a flow. */
export interface FlowNodeRoutingInfo {
  flowId: string;
  nodeId: string;
  currentModel: LlmConfig;
  candidateModels: LlmConfig[];
}

/** Thresholds controlling which recommendations are surfaced. */
export interface RoutingAdvisorThresholds {
  /**
   * Minimum expected cost saving to include a recommendation (percentage, 0–100).
   * Default 10.
   */
  minCostSavingPct?: number;
  /**
   * Maximum tolerable quality loss (percentage, 0–100).
   * Default 5.
   */
  maxQualityLossPct?: number;
}

/** Quality-lookup function injected from either the ModelQualityRegistry or eval scores. */
export type QualityLookup = (model: LlmConfig) => ModelQualityStats | undefined;

export interface RoutingAdvisorInput {
  nodes: FlowNodeRoutingInfo[];
  thresholds?: RoutingAdvisorThresholds;
  /**
   * Optional quality lookup. When provided, used to estimate quality loss from
   * the current model to the suggested model.
   */
  qualityLookup?: QualityLookup;
  /**
   * Optional eval-judge scores keyed by `provider/model`. These take precedence
   * over the qualityLookup when present (source = "eval-judge").
   */
  evalJudgeScores?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Blended price per 1M tokens. Returns Infinity for unknown models. */
function blendedPricePer1M(model: LlmConfig): number {
  const p = getModelPricing(model.provider, model.model);
  if (p === undefined) return Infinity;
  return p.prompt + p.completion;
}

/**
 * Estimates cost saving % when switching from `current` to `suggested`.
 * Returns 0 when either model lacks pricing data.
 */
export function estimateCostSavingPct(
  current: LlmConfig,
  suggested: LlmConfig,
): number {
  const currentPrice = blendedPricePer1M(current);
  const suggestedPrice = blendedPricePer1M(suggested);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
  if (!Number.isFinite(suggestedPrice)) return 0;
  if (suggestedPrice >= currentPrice) return 0;
  return ((currentPrice - suggestedPrice) / currentPrice) * 100;
}

/**
 * Estimates quality loss % when switching from `current` to `suggested`.
 * Uses evalJudgeScores (preferred) then qualityLookup as fallback.
 * Returns 0 when no quality data is available.
 */
export function estimateQualityLossPct(
  current: LlmConfig,
  suggested: LlmConfig,
  qualityLookup?: QualityLookup,
  evalJudgeScores?: Record<string, number>,
): { lossPct: number; source: RoutingRecommendation["source"] } {
  const currentKey = modelKey(current);
  const suggestedKey = modelKey(suggested);

  // Prefer eval-judge scores when available for both models
  if (evalJudgeScores !== undefined) {
    const currentScore = evalJudgeScores[currentKey];
    const suggestedScore = evalJudgeScores[suggestedKey];
    if (currentScore !== undefined && suggestedScore !== undefined) {
      const loss =
        Math.max(
          0,
          (currentScore - suggestedScore) / Math.max(currentScore, 0.0001),
        ) * 100;
      return { lossPct: loss, source: "eval-judge" };
    }
  }

  // Fallback: model-quality registry
  if (qualityLookup !== undefined) {
    const currentStats = qualityLookup(current);
    const suggestedStats = qualityLookup(suggested);
    if (currentStats !== undefined && suggestedStats !== undefined) {
      const loss =
        Math.max(
          0,
          (currentStats.meanScore - suggestedStats.meanScore) /
            Math.max(currentStats.meanScore, 0.0001),
        ) * 100;
      return { lossPct: loss, source: "model-quality-registry" };
    }
    // If only suggested score missing, assume neutral (0 loss)
    if (currentStats !== undefined) {
      return { lossPct: 0, source: "model-quality-registry" };
    }
  }

  return { lossPct: 0, source: "unknown" };
}

// ---------------------------------------------------------------------------
// Core advisor function
// ---------------------------------------------------------------------------

/**
 * Generates routing recommendations for a set of flow nodes.
 *
 * For each node, picks the cheapest candidate model via the cost-router
 * strategy, computes the expected cost saving and quality loss, and returns
 * only recommendations that clear both configured thresholds (Req. 17.2).
 */
export function computeRoutingRecommendations(
  input: RoutingAdvisorInput,
): RoutingRecommendation[] {
  const minSaving = input.thresholds?.minCostSavingPct ?? 10;
  const maxLoss = input.thresholds?.maxQualityLossPct ?? 5;

  const recommendations: RoutingRecommendation[] = [];

  for (const node of input.nodes) {
    if (node.candidateModels.length === 0) continue;

    // Build routing config with all candidates (including current) so the
    // cost-router can pick the cheapest alternative.
    const allCandidates = [node.currentModel, ...node.candidateModels];
    const routing: RoutingConfig = {
      strategy: "cheapest",
      candidates: allCandidates,
    };

    const suggested = selectModel(routing, {
      qualityStats: input.qualityLookup,
    });

    // Skip if the cheapest is the same as current
    if (modelKey(suggested) === modelKey(node.currentModel)) continue;

    const costSavingPct = estimateCostSavingPct(node.currentModel, suggested);
    if (costSavingPct < minSaving) continue;

    const { lossPct, source } = estimateQualityLossPct(
      node.currentModel,
      suggested,
      input.qualityLookup,
      input.evalJudgeScores,
    );
    if (lossPct > maxLoss) continue;

    recommendations.push({
      flowId: node.flowId,
      nodeId: node.nodeId,
      currentModel: modelKey(node.currentModel),
      suggestedModel: modelKey(suggested),
      expectedCostSavingPct: Math.round(costSavingPct * 10) / 10,
      expectedQualityLossPct: Math.round(lossPct * 10) / 10,
      source,
    });
  }

  return recommendations;
}

// ---------------------------------------------------------------------------
// Acceptance: one-click canary start (Req. 17.3)
// ---------------------------------------------------------------------------

export interface CanaryInstructionOptions {
  recommendation: RoutingRecommendation;
  /** The candidate flow id to run as canary (typically flowId + "-" + suggestedModel). */
  candidateFlowId: string;
  /** Traffic percentage for the canary. Default 10. */
  trafficPercent?: number;
}

/**
 * The canary entry an operator would add to `flows/canary.yaml` to trial a
 * recommendation.
 *
 * Deliberately returned as data rather than applied: the canary manager is
 * policy-file driven, so "accepting" a recommendation means writing that file
 * and letting the watcher reload it. Emitting the exact entry keeps the advisory
 * endpoint read-only — it cannot start routing production traffic to a different
 * model as a side effect of someone opening a dashboard tab.
 */
export interface CanaryInstruction {
  flow: string;
  candidate: string;
  trafficPercent: number;
}

export function buildCanaryInstruction(
  opts: CanaryInstructionOptions,
): CanaryInstruction {
  return {
    flow: opts.recommendation.flowId,
    candidate: opts.candidateFlowId,
    trafficPercent: opts.trafficPercent ?? 10,
  };
}

// ---------------------------------------------------------------------------
// Flow → advisor input
// ---------------------------------------------------------------------------

/**
 * Derives advisor input from loaded flows.
 *
 * Only nodes that already declare a cost-router candidate pool
 * (`config.routing.candidates`) are considered: those are the nodes whose author
 * has explicitly stated which models are acceptable substitutes. Guessing
 * candidates for a node that declares none would recommend swapping in a model
 * nobody vetted for that prompt.
 *
 * Pure — takes definitions, returns descriptors.
 */
export function collectRoutingCandidates(
  flows: readonly FlowDefinition[],
  defaultLlm?: LlmConfig,
): FlowNodeRoutingInfo[] {
  const infos: FlowNodeRoutingInfo[] = [];
  for (const flow of flows) {
    for (const node of flow.nodes) {
      const routing = parseRoutingConfig(node.config);
      if (routing === undefined) continue;
      // The node's effective model today: its own `llm`, else the global default.
      const currentModel = node.llm ?? defaultLlm;
      if (currentModel === undefined) continue;
      const candidateModels = (routing.candidates ?? []).filter(
        (c) => modelKey(c) !== modelKey(currentModel),
      );
      if (candidateModels.length === 0) continue;
      infos.push({
        flowId: flow.id,
        nodeId: node.id,
        currentModel,
        candidateModels,
      });
    }
  }
  return infos;
}

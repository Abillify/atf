// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cost-based model router (`src/graph/cost-router.ts`)
 *
 * Lets an LLM node pick the most economical model from a candidate pool at
 * request time instead of hard-coding a single model. This is the cost-control
 * lever that turns the platform from a static gateway into a routing layer:
 * cheap models handle the bulk of traffic, expensive models are reserved for
 * cases that explicitly need them (selected via dispatch rules / overrides that
 * choose the candidate pool).
 *
 * Strategies:
 *   - "cheapest"  — minimise blended $/token using the pricing table.
 *   - "balanced"  — minimise estimated cost for the *actual* prompt size, so a
 *                   model with a cheap prompt rate but pricey completions is
 *                   ranked by what this request will really cost.
 *
 * A node opts in via `node.config.routing`:
 *   {
 *     "routing": {
 *       "strategy": "cheapest",
 *       "candidates": [
 *         { "provider": "google", "model": "gemini-2.0-flash" },
 *         { "provider": "openai", "model": "gpt-4o-mini" }
 *       ]
 *     }
 *   }
 *
 * Pure functions only — no I/O — so the selection logic is fully unit-testable.
 *
 * No `any` at module boundaries.
 */

import type { LlmConfig } from "../types/flow.js";
import { getModelPricing } from "../observability/cost.js";

export type RoutingStrategy = "cheapest" | "balanced" | "quality-aware";

export interface RoutingConfig {
  strategy?: RoutingStrategy;
  candidates?: LlmConfig[];
  /**
   * For "quality-aware": the minimum observed quality score (0–1) a candidate
   * must meet to be eligible. Among eligible candidates the cheapest wins.
   * Default 0.7.
   */
  minQualityScore?: number;
  /**
   * For "quality-aware": how many observations a candidate needs before its
   * score is trusted. Below this it is treated as eligible (exploration) so a
   * new/cheaper model is given a chance instead of being starved. Default 5.
   */
  minQualitySamples?: number;
}

type PricingTable = Record<string, { prompt: number; completion: number }>;

/**
 * Parses and validates a node's `config.routing`. Returns undefined when no
 * usable routing config is present, so the caller keeps its default model.
 */
export function parseRoutingConfig(config: unknown): RoutingConfig | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const routing = (config as { routing?: unknown }).routing;
  if (routing === null || typeof routing !== "object") return undefined;
  const r = routing as {
    strategy?: unknown;
    candidates?: unknown;
    minQualityScore?: unknown;
    minQualitySamples?: unknown;
  };
  if (!Array.isArray(r.candidates) || r.candidates.length === 0)
    return undefined;

  const candidates: LlmConfig[] = [];
  for (const raw of r.candidates) {
    if (raw === null || typeof raw !== "object") continue;
    const c = raw as {
      provider?: unknown;
      model?: unknown;
      parameters?: unknown;
    };
    if (typeof c.provider !== "string" || typeof c.model !== "string") continue;
    const candidate: LlmConfig = {
      provider: c.provider as LlmConfig["provider"],
      model: c.model,
    };
    if (
      c.parameters !== undefined &&
      typeof c.parameters === "object" &&
      c.parameters !== null
    ) {
      candidate.parameters = c.parameters as LlmConfig["parameters"];
    }
    candidates.push(candidate);
  }
  if (candidates.length === 0) return undefined;

  const strategy: RoutingStrategy =
    r.strategy === "balanced"
      ? "balanced"
      : r.strategy === "quality-aware"
        ? "quality-aware"
        : "cheapest";

  const out: RoutingConfig = { strategy, candidates };
  if (
    typeof r.minQualityScore === "number" &&
    r.minQualityScore >= 0 &&
    r.minQualityScore <= 1
  ) {
    out.minQualityScore = r.minQualityScore;
  }
  if (typeof r.minQualitySamples === "number" && r.minQualitySamples >= 0) {
    out.minQualitySamples = Math.floor(r.minQualitySamples);
  }
  return out;
}

/** Blended price ($ per 1M tokens, prompt+completion) for ranking by "cheapest". */
function blendedPrice(candidate: LlmConfig, pricing?: PricingTable): number {
  const p = getModelPricing(candidate.provider, candidate.model, pricing);
  if (p === undefined) return Number.POSITIVE_INFINITY;
  return p.prompt + p.completion;
}

/** Estimated cost (USD) for a request of the given token shape. */
function estimatedCost(
  candidate: LlmConfig,
  promptTokens: number,
  expectedCompletionTokens: number,
  pricing?: PricingTable,
): number {
  const p = getModelPricing(candidate.provider, candidate.model, pricing);
  if (p === undefined) return Number.POSITIVE_INFINITY;
  return (
    (promptTokens / 1_000_000) * p.prompt +
    (expectedCompletionTokens / 1_000_000) * p.completion
  );
}

/** Observed quality of a model from production judging / evals. */
export interface ModelQualityStats {
  /** Mean (or EMA) judge score in [0,1]. */
  meanScore: number;
  /** How many observations back the score. */
  samples: number;
}

export interface SelectionInput {
  /** Estimated prompt tokens for the actual request (used by "balanced"). */
  promptTokens?: number;
  /** Expected completion tokens (defaults to a modest 256 when unknown). */
  expectedCompletionTokens?: number;
  pricing?: PricingTable;
  /**
   * For "quality-aware": looks up a candidate's observed quality. Injected so
   * the selection stays pure/testable (the live registry is passed in at the
   * call site). Returns undefined for an unseen model.
   */
  qualityStats?: (candidate: LlmConfig) => ModelQualityStats | undefined;
}

/** Stable pricing/quality key for a model. */
export function modelKey(c: Pick<LlmConfig, "provider" | "model">): string {
  return `${c.provider}/${c.model}`;
}

/**
 * Selects the model to use from a routing config. Returns the chosen
 * {@link LlmConfig}, or undefined when no candidate can be priced (caller keeps
 * its default). When all candidates lack pricing, the first candidate is
 * returned so routing still progresses deterministically.
 */
export function selectModel(
  routing: RoutingConfig,
  input: SelectionInput = {},
): LlmConfig {
  const candidates = routing.candidates ?? [];
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    throw new Error("selectModel called with no candidates");
  }
  if (candidates.length === 1) return firstCandidate;

  const strategy = routing.strategy ?? "cheapest";

  if (strategy === "quality-aware") {
    return selectQualityAware(routing, candidates, input);
  }

  const score = (c: LlmConfig): number =>
    strategy === "balanced"
      ? estimatedCost(
          c,
          input.promptTokens ?? 0,
          input.expectedCompletionTokens ?? 256,
          input.pricing,
        )
      : blendedPrice(c, input.pricing);

  let best = firstCandidate;
  let bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const s = score(c);
    if (s < bestScore) {
      best = c;
      bestScore = s;
    }
  }
  // When nothing could be priced (all Infinity), fall back to the first candidate.
  if (!Number.isFinite(bestScore)) return firstCandidate;
  return best;
}

/**
 * Picks the cheapest candidate whose observed quality clears the floor. A model
 * with too few observations is treated as eligible (exploration) so the system
 * tries cheaper/newer models rather than locking onto an incumbent. When no
 * candidate clears the floor, it falls back to the highest-scoring candidate
 * (best available quality), then to the cheapest if none has been scored.
 *
 * This is the adaptive lever: paired with the canary/A-B judge scores recorded
 * per model in production, traffic drifts toward the cheapest model that still
 * holds the quality bar — and away from one that has started to regress.
 */
function selectQualityAware(
  routing: RoutingConfig,
  candidates: LlmConfig[],
  input: SelectionInput,
): LlmConfig {
  const floor = routing.minQualityScore ?? 0.7;
  const minSamples = routing.minQualitySamples ?? 5;
  const statsOf = input.qualityStats ?? (() => undefined);
  const priceOf = (c: LlmConfig): number => {
    const est = estimatedCost(
      c,
      input.promptTokens ?? 0,
      input.expectedCompletionTokens ?? 256,
      input.pricing,
    );
    return Number.isFinite(est) ? est : blendedPrice(c, input.pricing);
  };

  const eligible: LlmConfig[] = [];
  for (const c of candidates) {
    const stats = statsOf(c);
    // Unproven (too few samples) → eligible for exploration.
    if (stats === undefined || stats.samples < minSamples) {
      eligible.push(c);
      continue;
    }
    if (stats.meanScore >= floor) eligible.push(c);
  }

  const firstEligible = eligible[0];
  if (firstEligible !== undefined) {
    let best = firstEligible;
    let bestPrice = priceOf(best);
    for (const c of eligible.slice(1)) {
      const p = priceOf(c);
      if (p < bestPrice) {
        best = c;
        bestPrice = p;
      }
    }
    return best;
  }

  // Nobody cleared the floor — take the best observed quality, ties → cheapest.
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    // Unreachable: the sole caller (selectModel) already validated a
    // non-empty candidate list before delegating here.
    throw new Error("selectQualityAware called with no candidates");
  }
  let best = firstCandidate;
  let bestScore = statsOf(best)?.meanScore ?? -1;
  let bestPrice = priceOf(best);
  for (const c of candidates.slice(1)) {
    const sc = statsOf(c)?.meanScore ?? -1;
    const pr = priceOf(c);
    if (sc > bestScore || (sc === bestScore && pr < bestPrice)) {
      best = c;
      bestScore = sc;
      bestPrice = pr;
    }
  }
  return best;
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Objective-Driven Routing / Solver-Loop (`src/graph/objective-solver.ts`)
 *
 * `cost-router.ts`'s `"quality-aware"` strategy already does one useful thing:
 * pick the cheapest candidate model whose observed quality clears A single
 * floor. That is a special case of a more general and more honestly-named
 * problem an operator actually has: *"minimize cost subject to a quality
 * floor"*, or *"minimize latency subject to a cost cap"*, or any small
 * combination of such constraints — declared once, per node, rather than
 * hardcoded into one strategy name.
 *
 * This module generalizes that special case into a small constraint solver:
 * a node declares a candidate pool and a list of `ObjectiveClause`s (a metric,
 * a comparison, a target value), and {@link solveObjective} walks the
 * candidates in ascending-cost order — bounded by `maxAttempts` — evaluating
 * each against every declared clause, and selects the first candidate that
 * clears them all. Every attempt is recorded (which candidate, which clauses
 * passed/failed/were unproven), so the decision is exactly as inspectable as
 * the Decision-Provenance Explainability Card (ADR-0017) already makes an
 * LLM node's routing decision — this is a strict generalization of that same
 * transparency requirement, not a new one.
 *
 * Design choices, and why:
 *
 *   - **Cost-ascending evaluation order.** The solver does not just filter
 *     candidates and pick "the best" by some blended score — it walks
 *     candidates from cheapest to most expensive and STOPS at the first one
 *     that satisfies every objective. This is what "minimize cost subject to
 *     a constraint" means operationally: don't pay for a more expensive
 *     model than the cheapest one that already clears the bar.
 *   - **Unproven objectives don't block selection.** Exactly like
 *     `selectQualityAware`'s exploration behaviour: a candidate with too few
 *     quality observations (`< minQualitySamples`) is treated as eligible for
 *     an unproven clause rather than rejected, so a new/cheaper model is
 *     given a chance to prove itself in production instead of being
 *     permanently starved by a floor it has never had the chance to clear.
 *     Cost, by contrast, is never "unproven" — it is either priced or it
 *     isn't (unpriced sorts last / is treated as `Infinity`).
 *   - **Bounded attempts (`maxAttempts`).** A genuinely bounded loop, not an
 *     unbounded search — a large candidate pool does not turn one routing
 *     decision into an unbounded scan; the solver stops after evaluating at
 *     most `maxAttempts` candidates (default = pool size) and falls back.
 *   - **Explicit fallback strategy.** When no candidate (within the attempt
 *     budget) satisfies every objective, the solver does not silently pick an
 *     arbitrary candidate — the configured `fallback` strategy
 *     (`"cheapest"` | `"best-quality"` | `"first"`) decides, and the result
 *     records `fallbackUsed: true` plus a human-readable reason, so a reader
 *     of the attempt trace (or the Explain Card) never mistakes a fallback
 *     pick for a genuinely satisfied objective.
 *
 * Pure functions only — no I/O, no provider calls — so the whole solve is
 * fully unit-testable offline. Reuses the existing pricing table
 * (`observability/cost.ts`) and the same `ModelQualityStats` shape
 * `cost-router.ts` already defines, rather than inventing a parallel quality
 * model.
 *
 * No `any` at module boundaries.
 */

import type { LlmConfig } from "../types/flow.js";
import { getModelPricing } from "../observability/cost.js";
import { modelKey, type ModelQualityStats } from "./cost-router.js";

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

export type ObjectiveMetric = "quality" | "cost";
export type ObjectiveOp = "gte" | "lte";

/** One declarative constraint: `<metric> <op> <value>`, e.g. "quality gte 0.8". */
export interface ObjectiveClause {
  metric: ObjectiveMetric;
  op: ObjectiveOp;
  value: number;
}

export type ObjectiveFallback = "cheapest" | "best-quality" | "first";

export interface ObjectiveConfig {
  candidates: LlmConfig[];
  /** The constraints every selected candidate must clear (all of them). */
  objectives: ObjectiveClause[];
  /**
   * Below this many quality observations a candidate's quality clause is
   * "unproven" (treated as eligible — exploration) rather than evaluated
   * strictly. Only applies to `metric: "quality"` clauses. Default 5.
   */
  minQualitySamples?: number;
  /**
   * Max candidates evaluated before falling back. Default = pool size (i.e.
   * every candidate is tried). A lower value bounds the solve to the N
   * cheapest candidates only.
   */
  maxAttempts?: number;
  /** Strategy when no candidate (within the attempt budget) satisfies every
   * objective. Default `"cheapest"`. */
  fallback?: ObjectiveFallback;
}

// ---------------------------------------------------------------------------
// Result shape — the attempt trace
// ---------------------------------------------------------------------------

/** Verdict for one clause against one candidate. */
export interface ObjectiveClauseResult {
  clause: ObjectiveClause;
  /** The candidate's observed/estimated value for this clause's metric, when known. */
  observedValue?: number;
  /** True when the clause is proven (enough samples for "quality"; always true for "cost"). */
  proven: boolean;
  /** True when the clause is met (only meaningful when `proven`). */
  met: boolean;
}

/** One candidate evaluated during the solve, in the order it was tried. */
export interface ObjectiveAttempt {
  candidate: string;
  estimatedCostUsd?: number;
  observedQuality?: number;
  qualitySamples?: number;
  clauses: ObjectiveClauseResult[];
  /** True when every clause is either proven+met, or unproven (exploration). */
  satisfied: boolean;
}

export interface ObjectiveSolveResult {
  selected: LlmConfig;
  attempts: ObjectiveAttempt[];
  /** True when `selected` was chosen because it satisfied every objective. */
  satisfiedObjective: boolean;
  /** True when no attempted candidate satisfied every objective and the
   * configured fallback strategy chose `selected` instead. */
  fallbackUsed: boolean;
  /** Human-readable reason, present when `fallbackUsed` is true. */
  fallbackReason?: string;
}

type PricingTable = Record<string, { prompt: number; completion: number }>;

export interface SolveObjectiveInput {
  promptTokens?: number;
  expectedCompletionTokens?: number;
  pricing?: PricingTable;
  /** Injected quality lookup, e.g. `runtime.modelQuality.lookup()`. */
  qualityStats?: (candidate: LlmConfig) => ModelQualityStats | undefined;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parses and validates a node's `config.objective`. Returns `undefined` when
 * absent or malformed — tolerant, so a bad edit never crashes routing; the
 * caller keeps its default model / falls back to `config.routing` when
 * present. Mirrors `parseRoutingConfig`'s tolerance and shape conventions.
 */
export function parseObjectiveConfig(config: unknown): ObjectiveConfig | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const raw = (config as { objective?: unknown }).objective;
  if (raw === null || typeof raw !== "object") return undefined;
  const o = raw as {
    candidates?: unknown;
    objectives?: unknown;
    minQualitySamples?: unknown;
    maxAttempts?: unknown;
    fallback?: unknown;
  };

  if (!Array.isArray(o.candidates) || o.candidates.length === 0) return undefined;
  const candidates: LlmConfig[] = [];
  for (const rawCandidate of o.candidates) {
    if (rawCandidate === null || typeof rawCandidate !== "object") continue;
    const c = rawCandidate as { provider?: unknown; model?: unknown };
    if (typeof c.provider !== "string" || typeof c.model !== "string") continue;
    candidates.push({
      provider: c.provider as LlmConfig["provider"],
      model: c.model,
    });
  }
  if (candidates.length === 0) return undefined;

  if (!Array.isArray(o.objectives) || o.objectives.length === 0) return undefined;
  const objectives: ObjectiveClause[] = [];
  for (const rawClause of o.objectives) {
    if (rawClause === null || typeof rawClause !== "object") continue;
    const c = rawClause as { metric?: unknown; op?: unknown; value?: unknown };
    if (c.metric !== "quality" && c.metric !== "cost") continue;
    if (c.op !== "gte" && c.op !== "lte") continue;
    if (typeof c.value !== "number" || !Number.isFinite(c.value)) continue;
    objectives.push({ metric: c.metric, op: c.op, value: c.value });
  }
  if (objectives.length === 0) return undefined;

  const out: ObjectiveConfig = { candidates, objectives };
  if (typeof o.minQualitySamples === "number" && o.minQualitySamples >= 0) {
    out.minQualitySamples = Math.floor(o.minQualitySamples);
  }
  if (typeof o.maxAttempts === "number" && o.maxAttempts > 0) {
    out.maxAttempts = Math.floor(o.maxAttempts);
  }
  if (
    o.fallback === "cheapest" ||
    o.fallback === "best-quality" ||
    o.fallback === "first"
  ) {
    out.fallback = o.fallback;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Solve
// ---------------------------------------------------------------------------

/** Estimated cost (USD) for a request of the given token shape. Infinity when unpriced. */
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

function compare(observed: number, op: ObjectiveOp, target: number): boolean {
  return op === "gte" ? observed >= target : observed <= target;
}

/**
 * Evaluates every declared clause against one candidate. Cost clauses are
 * always `proven` (cost is either priced or it isn't — never a sample-count
 * question). Quality clauses are `proven` only once `minQualitySamples` is
 * met; below that they are reported as unproven with `met: false`, but — per
 * the exploration rule — an unproven clause does NOT by itself make the
 * candidate unsatisfying (see {@link candidateSatisfies}).
 */
function evaluateClauses(
  candidate: LlmConfig,
  cfg: ObjectiveConfig,
  costUsd: number,
  input: SolveObjectiveInput,
): { results: ObjectiveClauseResult[]; observedQuality?: number; qualitySamples?: number } {
  const minSamples = cfg.minQualitySamples ?? 5;
  const stats = input.qualityStats?.(candidate);
  const results: ObjectiveClauseResult[] = [];
  for (const clause of cfg.objectives) {
    if (clause.metric === "cost") {
      results.push({
        clause,
        observedValue: costUsd,
        proven: true,
        met: Number.isFinite(costUsd) && compare(costUsd, clause.op, clause.value),
      });
      continue;
    }
    // metric === "quality"
    if (stats === undefined || stats.samples < minSamples) {
      results.push({
        clause,
        ...(stats !== undefined ? { observedValue: stats.meanScore } : {}),
        proven: false,
        met: false,
      });
      continue;
    }
    results.push({
      clause,
      observedValue: stats.meanScore,
      proven: true,
      met: compare(stats.meanScore, clause.op, clause.value),
    });
  }
  return {
    results,
    ...(stats !== undefined ? { observedQuality: stats.meanScore, qualitySamples: stats.samples } : {}),
  };
}

/** A candidate satisfies the objective when every clause is either proven+met, or unproven. */
function candidateSatisfies(results: ObjectiveClauseResult[]): boolean {
  return results.every((r) => !r.proven || r.met);
}

/**
 * Walks `cfg.candidates` in ascending-cost order (bounded by `maxAttempts`),
 * evaluating each against every declared objective clause, and selects the
 * first candidate that satisfies them all. Falls back to the configured
 * strategy when none do. Pure — no I/O.
 */
export function solveObjective(
  cfg: ObjectiveConfig,
  input: SolveObjectiveInput = {},
): ObjectiveSolveResult {
  const firstCandidate = cfg.candidates[0];
  if (firstCandidate === undefined) {
    throw new Error("solveObjective called with no candidates");
  }
  if (cfg.candidates.length === 1) {
    return {
      selected: firstCandidate,
      attempts: [],
      satisfiedObjective: false,
      fallbackUsed: false,
    };
  }

  const promptTokens = input.promptTokens ?? 0;
  const expectedCompletionTokens = input.expectedCompletionTokens ?? 256;
  const pricing = input.pricing;

  const withCost = cfg.candidates.map((c) => ({
    candidate: c,
    costUsd: estimatedCost(c, promptTokens, expectedCompletionTokens, pricing),
  }));
  withCost.sort((a, b) => a.costUsd - b.costUsd);

  const maxAttempts = cfg.maxAttempts ?? withCost.length;
  const attempts: ObjectiveAttempt[] = [];
  let winner: LlmConfig | undefined;

  for (const { candidate, costUsd } of withCost.slice(0, maxAttempts)) {
    const { results, observedQuality, qualitySamples } = evaluateClauses(
      candidate,
      cfg,
      costUsd,
      input,
    );
    const satisfied = candidateSatisfies(results);
    attempts.push({
      candidate: modelKey(candidate),
      ...(Number.isFinite(costUsd) ? { estimatedCostUsd: costUsd } : {}),
      ...(observedQuality !== undefined ? { observedQuality } : {}),
      ...(qualitySamples !== undefined ? { qualitySamples } : {}),
      clauses: results,
      satisfied,
    });
    if (satisfied && winner === undefined) {
      winner = candidate;
      break; // cheapest-first: stop at the first candidate that clears every objective
    }
  }

  if (winner !== undefined) {
    return {
      selected: winner,
      attempts,
      satisfiedObjective: true,
      fallbackUsed: false,
    };
  }

  // No attempted candidate satisfied every objective — apply the fallback.
  const fallback = cfg.fallback ?? "cheapest";
  const { selected, reason } = resolveFallback(fallback, withCost, cfg.candidates, input);
  return {
    selected,
    attempts,
    satisfiedObjective: false,
    fallbackUsed: true,
    fallbackReason: reason,
  };
}

function resolveFallback(
  strategy: ObjectiveFallback,
  withCost: Array<{ candidate: LlmConfig; costUsd: number }>,
  originalOrder: readonly LlmConfig[],
  input: SolveObjectiveInput,
): { selected: LlmConfig; reason: string } {
  const first = withCost[0];
  if (first === undefined) {
    // Unreachable: solveObjective already validated a non-empty candidate
    // list (and returns early for a single candidate) before calling this.
    throw new Error("resolveFallback called with no candidates");
  }

  if (strategy === "first") {
    // The FIRST candidate in the AUTHOR-DECLARED order, not the cost-sorted
    // one — "first" means "the one the flow author listed first", which is a
    // deliberately different tiebreak from "cheapest" (they coincide only by
    // accident when the pool happens to already be cost-ascending).
    const declaredFirst = originalOrder[0] ?? first.candidate;
    return {
      selected: declaredFirst,
      reason: "No candidate satisfied every objective; falling back to the first configured candidate.",
    };
  }

  if (strategy === "best-quality") {
    let best = first.candidate;
    let bestScore = input.qualityStats?.(best)?.meanScore ?? -1;
    let bestCost = first.costUsd;
    for (const { candidate, costUsd } of withCost.slice(1)) {
      const score = input.qualityStats?.(candidate)?.meanScore ?? -1;
      if (score > bestScore || (score === bestScore && costUsd < bestCost)) {
        best = candidate;
        bestScore = score;
        bestCost = costUsd;
      }
    }
    return {
      selected: best,
      reason: "No candidate satisfied every objective; falling back to the highest observed quality (ties broken by cost).",
    };
  }

  // "cheapest" (default): withCost is already cost-ascending.
  return {
    selected: first.candidate,
    reason: "No candidate satisfied every objective; falling back to the cheapest candidate.",
  };
}

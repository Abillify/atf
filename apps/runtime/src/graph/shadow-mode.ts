// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Shadow Mode — Continuous Quality Monitoring (`src/graph/shadow-mode.ts`)
 *
 * The Killer Feature: every production request is silently re-executed against
 * a configured "shadow" flow (a new model, a new prompt version, a new routing
 * strategy) and the two responses are automatically graded by an LLM judge.
 * The user ALWAYS sees the stable production answer. The shadow run is invisible
 * to the user. The judge score is recorded, aggregated, and surfaced in the
 * dashboard — so you get continuous production validation WITHOUT:
 *
 *   - Exposing any user to a potentially degraded response (unlike Canary)
 *   - Needing a manual eval dataset (unlike offline regression testing)
 *   - Introducing any latency to the production response (shadow runs async)
 *
 * This is the missing piece for regulated environments: you can validate a new
 * Anthropic Claude migration, a new RAG prompt, or a new model on live prod
 * traffic, measuring real quality over real questions — without any user risk.
 *
 * Architecture:
 *   - ShadowModeConfig (per-flow, loaded from flows/shadow.json) declares which
 *     production flow maps to which shadow flow and what the judge criteria are.
 *   - ShadowRunner executes shadow runs fire-and-forget AFTER the production
 *     response is delivered. It reuses the same ReplayExecutor interface.
 *   - ShadowScoreStore accumulates per-flow aggregate stats.
 *   - The /monitoring/shadow route exposes stats to the dashboard.
 *   - chat/metering.ts calls ShadowRunner.maybeRunShadow() post-finalize.
 *
 * Fail-safe design:
 *   - Shadow runs NEVER affect the production response or its latency.
 *   - Errors in shadow runs are logged and discarded.
 *   - The LLM judge call is bounded by a configurable timeout.
 *   - Shadow runs count toward concurrency limits via a separate semaphore so
 *     they cannot starve production traffic.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type { ChatMessage } from "../types/openai.js";
import type { Judge } from "../eval/eval-runner.js";
import type { ReplayExecutor } from "./replay.js";
import type { Logger } from "../observability/logger.js";

// ---------------------------------------------------------------------------
// Shadow config (loaded from flows/shadow.json)
// ---------------------------------------------------------------------------

export interface ShadowFlowConfig {
  /** Production flow id this shadow config applies to. */
  productionFlow: string;
  /** Shadow flow id to run in parallel. */
  shadowFlow: string;
  /**
   * Fraction of production requests that trigger a shadow run, in (0, 1].
   * Default 1.0 (every request). Set lower to reduce shadow execution cost.
   */
  samplingRate?: number;
  /**
   * Natural-language grading criteria for the LLM judge.
   * Default: "Overall quality, accuracy and helpfulness of the response."
   */
  judgeCriteria?: string;
  /**
   * Score threshold below which the shadow run is flagged as a regression
   * compared to the production response. When the shadow score is more than
   * `regressionDelta` LOWER than the production score, it is flagged.
   * Default 0.1.
   */
  regressionDelta?: number;
  /**
   * Maximum concurrent shadow executions for this flow pair.
   * Default 2. Shadow runs will be skipped (not queued) when the limit is hit.
   */
  maxConcurrent?: number;
  /** When true, shadow comparison is disabled but config is preserved. */
  disabled?: boolean;
}

export interface ShadowConfig {
  /** One entry per production flow that has a shadow counterpart. */
  flows: ShadowFlowConfig[];
}

// ---------------------------------------------------------------------------
// Per-comparison result
// ---------------------------------------------------------------------------

export interface ShadowComparison {
  id: string;
  productionFlow: string;
  shadowFlow: string;
  /** Production answer judge score (0–1). */
  productionScore: number;
  /** Shadow answer judge score (0–1). */
  shadowScore: number;
  /** Shadow score minus production score. Positive = shadow is better. */
  scoreDelta: number;
  /** Shadow answer latency in milliseconds. */
  shadowLatencyMs: number;
  /** True when the shadow score regressed by more than the configured delta. */
  flaggedRegression: boolean;
  /** True when the shadow score is better than production by a meaningful margin (> 0.05). */
  flaggedImprovement: boolean;
  createdAt: string;
  /** First 256 chars of the user query (for dashboard display). */
  queryPreview?: string;
}

// ---------------------------------------------------------------------------
// Aggregate stats per flow pair
// ---------------------------------------------------------------------------

export interface ShadowFlowStats {
  productionFlow: string;
  shadowFlow: string;
  /** Total comparisons evaluated. */
  totalComparisons: number;
  /** Mean production score across all evaluated comparisons. */
  avgProductionScore: number;
  /** Mean shadow score across all evaluated comparisons. */
  avgShadowScore: number;
  /** Mean score delta (shadow − production). Positive means shadow is consistently better. */
  avgScoreDelta: number;
  /** Number of comparisons flagged as regressions. */
  regressionCount: number;
  /** Number of comparisons flagged as improvements. */
  improvementCount: number;
  /** Mean shadow execution latency in ms. */
  avgShadowLatencyMs: number;
  /** ISO timestamp of the last comparison. */
  lastComparedAt: string | undefined;
  /** The 20 most recent comparison records (for detail view). */
  recent: ShadowComparison[];
}

// ---------------------------------------------------------------------------
// Score store
// ---------------------------------------------------------------------------

export interface ShadowScoreStore {
  record(comparison: ShadowComparison): void;
  statsFor(productionFlow: string): ShadowFlowStats | undefined;
  allStats(): ShadowFlowStats[];
  /** Returns the N most recent comparisons across all flow pairs. */
  recentComparisons(limit: number): ShadowComparison[];
}

/** Mutable running accumulator for one production→shadow flow pair. */
interface ShadowStatAccumulator {
  productionFlow: string;
  shadowFlow: string;
  sumProd: number;
  sumShadow: number;
  sumDelta: number;
  sumLatency: number;
  count: number;
  regressions: number;
  improvements: number;
  lastAt: string | undefined;
  recent: ShadowComparison[];
}

class InMemoryShadowScoreStore implements ShadowScoreStore {
  /** key = `${productionFlow}::${shadowFlow}` */
  private readonly stats = new Map<string, ShadowStatAccumulator>();
  private readonly allRecent: ShadowComparison[] = [];
  private readonly maxRecent = 500;

  record(c: ShadowComparison): void {
    const key = `${c.productionFlow}::${c.shadowFlow}`;
    let s = this.stats.get(key);
    if (s === undefined) {
      s = {
        productionFlow: c.productionFlow,
        shadowFlow: c.shadowFlow,
        sumProd: 0,
        sumShadow: 0,
        sumDelta: 0,
        sumLatency: 0,
        count: 0,
        regressions: 0,
        improvements: 0,
        lastAt: undefined,
        recent: [],
      };
      this.stats.set(key, s);
    }
    s.sumProd += c.productionScore;
    s.sumShadow += c.shadowScore;
    s.sumDelta += c.scoreDelta;
    s.sumLatency += c.shadowLatencyMs;
    s.count++;
    if (c.flaggedRegression) s.regressions++;
    if (c.flaggedImprovement) s.improvements++;
    s.lastAt = c.createdAt;
    s.recent.unshift(c);
    if (s.recent.length > 20) s.recent.pop();

    this.allRecent.unshift(c);
    if (this.allRecent.length > this.maxRecent) this.allRecent.pop();
  }

  statsFor(productionFlow: string): ShadowFlowStats | undefined {
    for (const s of this.stats.values()) {
      if (s.productionFlow === productionFlow) return this._toStats(s);
    }
    return undefined;
  }

  allStats(): ShadowFlowStats[] {
    return [...this.stats.values()].map((s) => this._toStats(s));
  }

  recentComparisons(limit: number): ShadowComparison[] {
    return this.allRecent.slice(0, Math.max(1, limit));
  }

  private _toStats(s: ShadowStatAccumulator): ShadowFlowStats {
    const n = s.count;
    return {
      productionFlow: s.productionFlow,
      shadowFlow: s.shadowFlow,
      totalComparisons: n,
      avgProductionScore: n > 0 ? Math.round((s.sumProd / n) * 1000) / 1000 : 0,
      avgShadowScore: n > 0 ? Math.round((s.sumShadow / n) * 1000) / 1000 : 0,
      avgScoreDelta: n > 0 ? Math.round((s.sumDelta / n) * 1000) / 1000 : 0,
      regressionCount: s.regressions,
      improvementCount: s.improvements,
      avgShadowLatencyMs: n > 0 ? Math.round(s.sumLatency / n) : 0,
      lastComparedAt: s.lastAt,
      recent: s.recent,
    };
  }
}

// ---------------------------------------------------------------------------
// ShadowRunner
// ---------------------------------------------------------------------------

export interface ShadowRunnerOptions {
  /** LLM judge for scoring both production and shadow answers. Required for quality comparison. */
  judge: Judge;
  /** Executor that runs a flow (same interface as the replay executor). */
  executor: ReplayExecutor;
  /** Score store that accumulates results. */
  store: ShadowScoreStore;
  /**
   * Default judge criteria (used when the config entry does not specify its own).
   */
  defaultJudgeCriteria?: string;
  /**
   * Timeout (ms) for the shadow flow execution. Default 60 000 ms.
   * The production response is never affected — this only bounds the async shadow run.
   */
  shadowTimeoutMs?: number;
  /**
   * Timeout (ms) for each LLM judge call. Default 30 000 ms.
   */
  judgeTimeoutMs?: number;
  logger?: Logger;
}

export interface MaybeRunShadowInput {
  /** The production flow that just completed. */
  productionFlow: string;
  /** The production response text (already delivered to the user). */
  productionResponse: string;
  /** The original user messages (used for the shadow run AND the judge). */
  messages: ChatMessage[];
  /** Optional request metadata forwarded to the shadow run. */
  metadata?: Record<string, unknown>;
}

export class ShadowRunner {
  private readonly judge: Judge;
  private readonly executor: ReplayExecutor;
  private readonly store: ShadowScoreStore;
  private readonly defaultCriteria: string;
  private readonly shadowTimeoutMs: number;
  private readonly judgeTimeoutMs: number;
  private readonly logger: Logger | undefined;
  /** Per-(prod→shadow) concurrent execution counts */
  private readonly inflight = new Map<string, number>();

  constructor(opts: ShadowRunnerOptions) {
    this.judge = opts.judge;
    this.executor = opts.executor;
    this.store = opts.store;
    this.defaultCriteria =
      opts.defaultJudgeCriteria ??
      "Overall quality, accuracy, completeness and helpfulness of the response given the user's question.";
    this.shadowTimeoutMs = opts.shadowTimeoutMs ?? 60_000;
    this.judgeTimeoutMs = opts.judgeTimeoutMs ?? 30_000;
    this.logger = opts.logger;
  }

  /**
   * Fire-and-forget shadow run + judge comparison. Called AFTER the production
   * response is fully delivered — never blocks the production path.
   *
   * Returns immediately. All errors are caught and logged.
   */
  maybeRunShadow(
    input: MaybeRunShadowInput,
    configs: ShadowFlowConfig[],
  ): void {
    const applicable = configs.filter(
      (c) => c.productionFlow === input.productionFlow && c.disabled !== true,
    );
    if (applicable.length === 0) return;

    for (const cfg of applicable) {
      void this._runOne(input, cfg).catch((err) => {
        this.logger?.warn("Shadow mode run failed (ignored)", {
          productionFlow: input.productionFlow,
          shadowFlow: cfg.shadowFlow,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  private async _runOne(
    input: MaybeRunShadowInput,
    cfg: ShadowFlowConfig,
  ): Promise<void> {
    // Sampling gate
    const samplingRate = cfg.samplingRate ?? 1.0;
    if (samplingRate < 1.0 && Math.random() > samplingRate) return;

    const key = `${cfg.productionFlow}::${cfg.shadowFlow}`;
    const maxConcurrent = cfg.maxConcurrent ?? 2;
    const current = this.inflight.get(key) ?? 0;
    if (current >= maxConcurrent) {
      this.logger?.debug("Shadow run skipped — max concurrent reached", { key });
      return;
    }
    this.inflight.set(key, current + 1);

    const criteria = cfg.judgeCriteria ?? this.defaultCriteria;
    const regressionDelta = cfg.regressionDelta ?? 0.1;
    const id = crypto.randomUUID();
    const queryPreview =
      input.messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join(" ")
        .slice(0, 256) || undefined;

    try {
      // ── Execute shadow flow ─────────────────────────────────────────────────
      const shadowStart = Date.now();
      let shadowText: string;
      try {
        const shadowResult = await Promise.race([
          this.executor(cfg.shadowFlow, input.messages, input.metadata),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Shadow timeout after ${this.shadowTimeoutMs}ms`)), this.shadowTimeoutMs),
          ),
        ]);
        shadowText = shadowResult.text;
      } catch (err) {
        this.logger?.warn("Shadow flow execution failed", {
          shadowFlow: cfg.shadowFlow,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const shadowLatencyMs = Date.now() - shadowStart;

      // ── Judge both responses ────────────────────────────────────────────────
      const withTimeout = <T>(p: Promise<T>): Promise<T> =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Judge timeout after ${this.judgeTimeoutMs}ms`)),
              this.judgeTimeoutMs,
            ),
          ),
        ]);

      let productionScore: number;
      let shadowScore: number;
      try {
        const [prodVerdict, shadowVerdict] = await Promise.all([
          withTimeout(
            this.judge({ criteria, response: input.productionResponse, messages: input.messages }),
          ),
          withTimeout(
            this.judge({ criteria, response: shadowText, messages: input.messages }),
          ),
        ]);
        productionScore = Math.max(0, Math.min(1, prodVerdict.score));
        shadowScore = Math.max(0, Math.min(1, shadowVerdict.score));
      } catch (err) {
        this.logger?.warn("Shadow mode judge call failed", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      const scoreDelta = Math.round((shadowScore - productionScore) * 1000) / 1000;
      const flaggedRegression = scoreDelta < -regressionDelta;
      const flaggedImprovement = scoreDelta > 0.05;

      const comparison: ShadowComparison = {
        id,
        productionFlow: cfg.productionFlow,
        shadowFlow: cfg.shadowFlow,
        productionScore: Math.round(productionScore * 1000) / 1000,
        shadowScore: Math.round(shadowScore * 1000) / 1000,
        scoreDelta,
        shadowLatencyMs,
        flaggedRegression,
        flaggedImprovement,
        createdAt: new Date().toISOString(),
        ...(queryPreview !== undefined ? { queryPreview } : {}),
      };

      this.store.record(comparison);

      this.logger?.info("Shadow mode comparison recorded", {
        productionFlow: cfg.productionFlow,
        shadowFlow: cfg.shadowFlow,
        productionScore: comparison.productionScore,
        shadowScore: comparison.shadowScore,
        delta: scoreDelta,
        ...(flaggedRegression ? { regression: true } : {}),
        ...(flaggedImprovement ? { improvement: true } : {}),
      });

      if (flaggedRegression) {
        this.logger?.warn("Shadow mode REGRESSION detected", {
          productionFlow: cfg.productionFlow,
          shadowFlow: cfg.shadowFlow,
          productionScore: comparison.productionScore,
          shadowScore: comparison.shadowScore,
          delta: scoreDelta,
          threshold: -regressionDelta,
        });
      }
    } finally {
      const next = (this.inflight.get(key) ?? 1) - 1;
      if (next <= 0) {
        this.inflight.delete(key);
      } else {
        this.inflight.set(key, next);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shadow config file loader (hot-reload compatible)
// ---------------------------------------------------------------------------

export interface ShadowModeService {
  /** Shadow runner (undefined when no judge configured). */
  runner: ShadowRunner | undefined;
  /** Score store (always present, even without a judge). */
  store: ShadowScoreStore;
  /** All loaded shadow flow configs. */
  configs(): ShadowFlowConfig[];
  /** Hot-reload from a new raw config object. */
  reload(raw: unknown): void;
  /** Aggregate stats for all flow pairs. */
  allStats(): ShadowFlowStats[];
  /** Stats for one production flow. */
  statsFor(productionFlow: string): ShadowFlowStats | undefined;
  /** Most recent N comparisons across all flow pairs. */
  recentComparisons(limit: number): ShadowComparison[];
}

class ShadowModeServiceImpl implements ShadowModeService {
  runner: ShadowRunner | undefined;
  readonly store: ShadowScoreStore;
  private _configs: ShadowFlowConfig[] = [];

  constructor(store: ShadowScoreStore, runner?: ShadowRunner) {
    this.store = store;
    this.runner = runner;
  }

  configs(): ShadowFlowConfig[] {
    return this._configs;
  }

  allStats(): ShadowFlowStats[] {
    return this.store.allStats();
  }

  statsFor(productionFlow: string): ShadowFlowStats | undefined {
    return this.store.statsFor(productionFlow);
  }

  recentComparisons(limit: number): ShadowComparison[] {
    return this.store.recentComparisons(limit);
  }

  reload(raw: unknown): void {
    if (raw === null || typeof raw !== "object") {
      this._configs = [];
      return;
    }
    const obj = raw as Record<string, unknown>;
    const flows = Array.isArray(obj.flows) ? obj.flows : [];
    this._configs = flows
      .filter(
        (f): f is ShadowFlowConfig =>
          f !== null &&
          typeof f === "object" &&
          typeof (f as ShadowFlowConfig).productionFlow === "string" &&
          typeof (f as ShadowFlowConfig).shadowFlow === "string",
      )
      .map((f) => ({
        productionFlow: f.productionFlow,
        shadowFlow: f.shadowFlow,
        ...(typeof f.samplingRate === "number" ? { samplingRate: f.samplingRate } : {}),
        ...(typeof f.judgeCriteria === "string" ? { judgeCriteria: f.judgeCriteria } : {}),
        ...(typeof f.regressionDelta === "number" ? { regressionDelta: f.regressionDelta } : {}),
        ...(typeof f.maxConcurrent === "number" ? { maxConcurrent: f.maxConcurrent } : {}),
        ...(typeof f.disabled === "boolean" ? { disabled: f.disabled } : {}),
      }));
  }
}

export function createShadowModeService(opts: {
  judge?: Judge;
  executor: ReplayExecutor;
  shadowTimeoutMs?: number;
  judgeTimeoutMs?: number;
  defaultJudgeCriteria?: string;
  logger?: Logger;
}): ShadowModeService {
  const store = new InMemoryShadowScoreStore();
  const runner =
    opts.judge !== undefined
      ? new ShadowRunner({
          judge: opts.judge,
          executor: opts.executor,
          store,
          defaultJudgeCriteria: opts.defaultJudgeCriteria,
          shadowTimeoutMs: opts.shadowTimeoutMs,
          judgeTimeoutMs: opts.judgeTimeoutMs,
          logger: opts.logger,
        })
      : undefined;
  return new ShadowModeServiceImpl(store, runner);
}

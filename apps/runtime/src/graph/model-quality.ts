// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Model quality registry (`src/graph/model-quality.ts`)
 *
 * Tracks an exponentially-weighted moving average of per-model judge scores
 * observed in production. The platform already computes LLM-judge scores for
 * canary variants and A/B experiments; feeding those scores here gives the
 * {@link selectModel} "quality-aware" strategy a live, self-updating view of
 * how each model is actually performing — so traffic can drift toward the
 * cheapest model that still holds the quality bar, and away from one that has
 * begun to regress.
 *
 * The EMA (rather than a plain mean) means the score reflects *recent* quality:
 * a model that degrades after a provider-side change is down-weighted within a
 * few dozen requests instead of being anchored to its lifetime average. A decay
 * also lets a stat go stale if a model stops being used.
 *
 * In-memory and per-replica — a model's score is a soft routing hint, not a
 * correctness guarantee, so eventual per-replica convergence is fine and needs
 * no shared store. Injectable clock keeps it fully unit-testable.
 *
 * No `any` at module boundaries.
 */

import type { LlmConfig } from "../types/flow.js";
import { modelKey, type ModelQualityStats } from "./cost-router.js";

/** A monotonic clock (ms). Injectable so tests are deterministic. */
export type Clock = () => number;

interface QualityEntry {
  ema: number;
  samples: number;
  lastUpdated: number;
}

export interface ModelQualitySnapshot extends ModelQualityStats {
  model: string;
  lastUpdated: number;
}

export interface ModelQualityRegistryOptions {
  /**
   * EMA smoothing factor in (0,1]. Higher = more weight on the latest score
   * (faster to react, noisier). Default 0.2.
   */
  alpha?: number;
  /**
   * Half-life (ms) after which an untouched score decays toward neutral, so a
   * model that stops being judged does not keep a stale high/low score forever.
   * 0 disables decay. Default 0 (no decay).
   */
  halfLifeMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  clock?: Clock;
}

/**
 * Maintains an EMA judge score per `provider/model`. Scores are clamped to
 * [0,1]; out-of-range or non-finite observations are ignored.
 */
export class ModelQualityRegistry {
  private readonly entries = new Map<string, QualityEntry>();
  private readonly alpha: number;
  private readonly halfLifeMs: number;
  private readonly clock: Clock;

  constructor(options: ModelQualityRegistryOptions = {}) {
    const a = options.alpha ?? 0.2;
    this.alpha = a > 0 && a <= 1 ? a : 0.2;
    this.halfLifeMs = Math.max(0, options.halfLifeMs ?? 0);
    this.clock = options.clock ?? Date.now;
  }

  /** Records a judge score (0–1) for a model. Out-of-range inputs are ignored. */
  record(model: Pick<LlmConfig, "provider" | "model">, score: number): void {
    if (!Number.isFinite(score) || score < 0 || score > 1) return;
    const key = modelKey(model);
    const now = this.clock();
    const existing = this.entries.get(key);
    if (existing === undefined) {
      this.entries.set(key, { ema: score, samples: 1, lastUpdated: now });
      return;
    }
    existing.ema = this.alpha * score + (1 - this.alpha) * existing.ema;
    existing.samples += 1;
    existing.lastUpdated = now;
  }

  /** Current stats for a model, or undefined when never observed. */
  get(
    model: Pick<LlmConfig, "provider" | "model">,
  ): ModelQualityStats | undefined {
    const entry = this.entries.get(modelKey(model));
    if (entry === undefined) return undefined;
    return { meanScore: this.decayed(entry), samples: entry.samples };
  }

  /** A lookup function bound to this registry, for {@link SelectionInput.qualityStats}. */
  lookup(): (c: LlmConfig) => ModelQualityStats | undefined {
    return (c) => this.get(c);
  }

  /** All known model stats (for the dashboard / diagnostics). */
  snapshot(): ModelQualitySnapshot[] {
    const out: ModelQualitySnapshot[] = [];
    for (const [model, entry] of this.entries) {
      out.push({
        model,
        meanScore: this.decayed(entry),
        samples: entry.samples,
        lastUpdated: entry.lastUpdated,
      });
    }
    return out.sort((a, b) => b.meanScore - a.meanScore);
  }

  /**
   * Applies time decay toward a neutral 0.5 so a stale score loses influence.
   * With no half-life configured this returns the raw EMA unchanged.
   */
  private decayed(entry: QualityEntry): number {
    if (this.halfLifeMs === 0) return entry.ema;
    const age = this.clock() - entry.lastUpdated;
    if (age <= 0) return entry.ema;
    const weight = 0.5 ** (age / this.halfLifeMs);
    return entry.ema * weight + 0.5 * (1 - weight);
  }
}

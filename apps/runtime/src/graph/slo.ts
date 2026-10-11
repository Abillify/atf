// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Declarative cost/quality SLO registry (`src/graph/slo.ts`)
 *
 * The adaptive quality-aware router already picks "the cheapest candidate model
 * whose observed judge score clears a floor" per node. This module lifts that
 * from a per-node hint to a DECLARATIVE, flow-level Service-Level Objective and
 * makes attainment continuously observable:
 *
 *   - An operator declares, per flow, a target: a minimum quality score and/or
 *     a maximum cost per request (`flows/slo.json|yaml`, hot-reloaded).
 *   - The platform records the quality score (from the same LLM judge that
 *     feeds canary/A-B and the quality-aware router) and the estimated cost of
 *     each run as exponentially-weighted moving averages per flow.
 *   - {@link SloRegistry.report} exposes, per flow: the observed quality/cost,
 *     the target, and whether the SLO is currently attained — so an operator can
 *     see at a glance whether "cheapest model that still holds the bar" is
 *     actually holding the bar, and a dashboard/alert can fire when it drifts.
 *
 * Quality observations require a judge (`CANARY_JUDGE_MODEL`) and are sampled
 * from judged runs (canary/A-B), exactly like the model-quality registry; cost
 * observations are recorded on every run. Per-replica and in-memory — an SLO is
 * a soft objective and a routing/observability signal, not a correctness gate,
 * so it needs no shared store.
 *
 * Pure/deterministic given an injected clock; fully unit-tested offline.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import { egressFetch } from "../security/egress.js";

/** A monotonic clock (ms). Injectable for deterministic tests. */
export type Clock = () => number;

export interface SloTarget {
  /** Flow id the objective applies to (`*` = default for any unmatched flow). */
  flow: string;
  /** Minimum acceptable EWMA judge quality score in [0,1]. */
  minQualityScore?: number;
  /** Maximum acceptable EWMA cost (USD) per request. */
  maxCostUsdPerRequest?: number;
  /** Below this many samples the objective is "unproven" (not yet asserted). */
  minSamples?: number;
  /** EWMA half-life (ms); older observations decay. Default 24h. */
  halfLifeMs?: number;
}

export interface SloObservation {
  /** Judge quality score in [0,1], when a judged run produced one. */
  qualityScore?: number;
  /** Estimated cost (USD) of the run. */
  costUsd?: number;
}

export interface SloReportEntry {
  flow: string;
  target: SloTarget;
  /** EWMA observed quality in [0,1], or undefined when no quality sample yet. */
  observedQuality?: number;
  /** EWMA observed cost (USD) per request, or undefined when no cost sample yet. */
  observedCostUsd?: number;
  qualitySamples: number;
  costSamples: number;
  /** True when quality is proven (≥ minSamples) and meets the floor. */
  meetsQuality: boolean;
  /** True when cost is proven and within the cap. */
  meetsCost: boolean;
  /** True when every declared objective is met (unproven objectives don't fail). */
  attained: boolean;
  /** Whether enough samples exist to assert the objective at all. */
  proven: boolean;
}

interface Ewma {
  value: number;
  samples: number;
  lastMs: number;
}

const DEFAULT_HALF_LIFE_MS = 24 * 60 * 60_000;
const DEFAULT_MIN_SAMPLES = 5;

/** Exponential decay factor for an EWMA given elapsed time and half-life. */
function decay(elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return 1;
  return 0.5 ** (elapsedMs / halfLifeMs);
}

/** Optional breach-alerting configuration. */
export interface SloAlertOptions {
  /** Webhook URL fired (JSON POST) when a flow's SLO transitions to breached. */
  webhookUrl?: string;
  /** Minimum interval between alerts for the same flow (ms). Default 1h. */
  cooldownMs?: number;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchFn?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean }>;
}

export interface SloRegistry {
  /** Replaces the declared targets (hot-reload). */
  setTargets(targets: readonly SloTarget[]): void;
  /** Records an observation for a flow (quality and/or cost). */
  record(flow: string, obs: SloObservation): void;
  /** Per-flow attainment report. */
  report(): SloReportEntry[];
  /** True when at least one target is declared. */
  readonly enabled: boolean;
}

class SloRegistryImpl implements SloRegistry {
  private targets: SloTarget[] = [];
  private readonly quality = new Map<string, Ewma>();
  private readonly cost = new Map<string, Ewma>();
  /** Last breach-alert time per flow key (cooldown) and last known breach state. */
  private readonly lastAlertMs = new Map<string, number>();
  private readonly breachedState = new Map<string, boolean>();

  constructor(
    private readonly clock: Clock = Date.now,
    private readonly logger?: Logger,
    private readonly alert: SloAlertOptions = {},
  ) {}

  get enabled(): boolean {
    return this.targets.length > 0;
  }

  setTargets(targets: readonly SloTarget[]): void {
    this.targets = [...targets];
    this.logger?.info("SLO targets loaded", {
      flows: this.targets.map((t) => t.flow),
    });
  }

  /** Resolves the target for a flow (exact match, else the `*` default). */
  private targetFor(flow: string): SloTarget | undefined {
    return (
      this.targets.find((t) => t.flow === flow) ??
      this.targets.find((t) => t.flow === "*")
    );
  }

  private updateEwma(
    map: Map<string, Ewma>,
    flow: string,
    sample: number,
    halfLifeMs: number,
  ): void {
    const now = this.clock();
    const cur = map.get(flow);
    if (cur === undefined) {
      map.set(flow, { value: sample, samples: 1, lastMs: now });
      return;
    }
    // Decay the old weight toward the new sample by elapsed-time half-life.
    const w = decay(now - cur.lastMs, halfLifeMs);
    // Blend: newer sample gets (1-w') weight where w' keeps recent dominant.
    const alpha = 1 - w * 0.5; // recent sample weight in [0.5,1]
    map.set(flow, {
      value: cur.value * (1 - alpha) + sample * alpha,
      samples: cur.samples + 1,
      lastMs: now,
    });
  }

  record(flow: string, obs: SloObservation): void {
    const target = this.targetFor(flow);
    if (target === undefined) return; // no SLO for this flow — ignore
    // Key the EWMA by the MATCHED TARGET's flow, not the raw flow id. For an
    // exact target this is identical; for the `*` wildcard it aggregates all
    // unmatched flows into the `*` bucket that report() reads — otherwise
    // observations recorded under a concrete id would never surface in the
    // wildcard entry.
    const key = target.flow;
    const halfLife = target.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
    if (obs.qualityScore !== undefined && Number.isFinite(obs.qualityScore)) {
      this.updateEwma(this.quality, key, obs.qualityScore, halfLife);
    }
    if (obs.costUsd !== undefined && Number.isFinite(obs.costUsd)) {
      this.updateEwma(this.cost, key, obs.costUsd, halfLife);
    }
    // Fire a breach alert on the transition into a proven-but-not-attained
    // state (edge-triggered + cooldown), so a busy flow doesn't spam the channel.
    this.maybeAlertBreach(target);
  }

  /** Fires the breach webhook on a fresh, proven breach (edge-triggered + cooldown). */
  private maybeAlertBreach(target: SloTarget): void {
    if (this.alert.webhookUrl === undefined) return;
    const entry = this.evaluateTarget(target);
    const key = target.flow;
    const isBreach = entry.proven && !entry.attained;
    const was = this.breachedState.get(key) ?? false;
    this.breachedState.set(key, isBreach);
    if (!isBreach || was) return; // not a fresh breach transition

    const now = this.clock();
    const last = this.lastAlertMs.get(key) ?? -Infinity;
    const cooldown = this.alert.cooldownMs ?? 60 * 60_000;
    if (now - last < cooldown) return;
    this.lastAlertMs.set(key, now);

    const doFetch =
      this.alert.fetchFn ??
      ((url, init) =>
        egressFetch(url, init) as unknown as Promise<{ ok: boolean }>);
    const body = JSON.stringify({
      type: "slo_breach",
      flow: entry.flow,
      target: entry.target,
      observedQuality: entry.observedQuality,
      observedCostUsd: entry.observedCostUsd,
      meetsQuality: entry.meetsQuality,
      meetsCost: entry.meetsCost,
      at: new Date(now).toISOString(),
    });
    void doFetch(this.alert.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch((err: unknown) =>
      this.logger?.warn("SLO breach webhook failed", {
        flow: key,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  /** Builds the report entry for a single target (shared by report() + alerting). */
  private evaluateTarget(target: SloTarget): SloReportEntry {
    const flow = target.flow;
    const q = this.quality.get(flow);
    const c = this.cost.get(flow);
    const minSamples = target.minSamples ?? DEFAULT_MIN_SAMPLES;
    return this.buildEntry(target, q, c, minSamples);
  }

  report(): SloReportEntry[] {
    return this.targets.map((target) => this.evaluateTarget(target));
  }

  private buildEntry(
    target: SloTarget,
    q: Ewma | undefined,
    c: Ewma | undefined,
    minSamples: number,
  ): SloReportEntry {
    {
      const flow = target.flow;

      const qualityProven = q !== undefined && q.samples >= minSamples;
      const costProven = c !== undefined && c.samples >= minSamples;

      // An objective is "met" when it's either not declared, or proven and within bound.
      const meetsQuality =
        target.minQualityScore === undefined ||
        (qualityProven && q !== undefined && q.value >= target.minQualityScore);
      const meetsCost =
        target.maxCostUsdPerRequest === undefined ||
        (costProven && c !== undefined && c.value <= target.maxCostUsdPerRequest);

      // "proven" = every DECLARED objective has enough samples to assert.
      const proven =
        (target.minQualityScore === undefined || qualityProven) &&
        (target.maxCostUsdPerRequest === undefined || costProven);

      // Attained only counts a declared+proven objective as failing; an
      // unproven objective is neither attained nor failed (reported via `proven`).
      const qualityOk =
        target.minQualityScore === undefined || !qualityProven || meetsQuality;
      const costOk =
        target.maxCostUsdPerRequest === undefined || !costProven || meetsCost;

      return {
        flow,
        target,
        ...(q !== undefined ? { observedQuality: round(q.value) } : {}),
        ...(c !== undefined ? { observedCostUsd: round(c.value) } : {}),
        qualitySamples: q?.samples ?? 0,
        costSamples: c?.samples ?? 0,
        meetsQuality,
        meetsCost,
        attained: proven && qualityOk && costOk,
        proven,
      };
    }
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function createSloRegistry(
  clock: Clock = Date.now,
  logger?: Logger,
  alert: SloAlertOptions = {},
): SloRegistry {
  return new SloRegistryImpl(clock, logger, alert);
}

// ---------------------------------------------------------------------------
// Parsing (validates the flows/slo.json|yaml shape)
// ---------------------------------------------------------------------------

/**
 * Parses a raw (JSON/YAML-decoded) SLO config into validated targets. Tolerant:
 * a malformed entry is skipped (logged by the caller) rather than throwing, so
 * a bad edit never disables the whole registry silently. Returns [] for a
 * missing/invalid document.
 */
export function parseSloTargets(raw: unknown): SloTarget[] {
  if (raw === null || typeof raw !== "object") return [];
  const arr = (raw as { slos?: unknown; targets?: unknown }).slos ??
    (raw as { targets?: unknown }).targets;
  if (!Array.isArray(arr)) return [];
  const out: SloTarget[] = [];
  for (const e of arr) {
    if (e === null || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.flow !== "string" || o.flow.length === 0) continue;
    const t: SloTarget = { flow: o.flow };
    if (typeof o.minQualityScore === "number" && o.minQualityScore >= 0 && o.minQualityScore <= 1) {
      t.minQualityScore = o.minQualityScore;
    }
    if (typeof o.maxCostUsdPerRequest === "number" && o.maxCostUsdPerRequest > 0) {
      t.maxCostUsdPerRequest = o.maxCostUsdPerRequest;
    }
    if (typeof o.minSamples === "number" && o.minSamples > 0) {
      t.minSamples = Math.floor(o.minSamples);
    }
    if (typeof o.halfLifeMs === "number" && o.halfLifeMs > 0) {
      t.halfLifeMs = o.halfLifeMs;
    }
    // Only keep entries that declare at least one objective.
    if (t.minQualityScore !== undefined || t.maxCostUsdPerRequest !== undefined) {
      out.push(t);
    }
  }
  return out;
}

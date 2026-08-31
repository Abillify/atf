// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cost anomaly detection (`src/observability/cost-anomaly.ts`)
 *
 * Detects sudden spend spikes per tenant by comparing a rolling 1h window
 * against a configurable baseline window (default: trailing 7 days, same
 * hour-of-day bucket to control for diurnal patterns).
 *
 * Algorithm:
 *   - The detector maintains a circular buffer of (timestamp, amount) events.
 *   - On each `observe()` call it computes:
 *       recent   = sum of cost in the last `windowMs` (default 1h)
 *       baseline = median of daily costs in the same hour-of-day slot over
 *                  `baselineDays` (default 7), multiplied by `windowMs/86400000`
 *                  to scale to the window size.
 *   - A spike is triggered when `recent > baseline * multiplier` AND the
 *     absolute spend exceeds `minAbsolute` (to avoid spurious alerts on
 *     near-zero baselines).
 *   - Alerts fire at most once per tenant per `cooldownMs` window
 *     (default: 1h) so a prolonged spike does not flood the channel.
 *   - When no baseline is available (< `minBaselineDays` days of history) the
 *     detector skips to avoid false positives on new tenants.
 *
 * The HTTP sink is the same `AlertSink` type used by `BudgetAlerter`, so an
 * existing webhook endpoint receives both budget-threshold and anomaly alerts.
 *
 * No `any` at module boundaries.
 */

import type { AlertSink } from "./budget-alerts.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Emitted when a cost spike is detected. */
export interface CostAnomalyAlert {
  type: "cost_anomaly";
  tenant: string;
  /** Rolling window spend. */
  recent: number;
  /** Expected spend for the same window. */
  baseline: number;
  /** recent / baseline, rounded to 2 dp. */
  multiplier: number;
  /** ISO timestamp of the detection. */
  at: string;
  /** Detection window length in ms. */
  windowMs: number;
}

/** One spend event captured in the rolling buffer. */
interface SpendEvent {
  ts: number;
  amount: number;
}

export interface CostAnomalyDetectorOptions {
  /**
   * Detection window in ms — spend accumulated in this window is compared
   * against the baseline. Default 3600000 (1 h).
   */
  windowMs?: number;
  /**
   * How many trailing days to use for the baseline. Only days that have at
   * least one event in the same hour-of-day bucket count. Default 7.
   */
  baselineDays?: number;
  /**
   * Minimum number of baseline days before detection fires, to avoid false
   * positives for brand-new tenants. Default 3.
   */
  minBaselineDays?: number;
  /**
   * Spike threshold: recent / baseline must exceed this. Default 3.0
   * (3× the normal hourly spend).
   */
  spikeMultiplier?: number;
  /**
   * Minimum absolute spend in the detection window before an alert can fire.
   * Prevents noise on tenants with near-zero usage. Default 0.10.
   */
  minAbsolute?: number;
  /**
   * Minimum time between alerts per tenant (ms). Default 3600000 (1 h).
   */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  clock?: () => number;
  /** Injectable webhook sink (reuses the same interface as BudgetAlerter). */
  sink?: AlertSink;
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

interface TenantState {
  /** Circular buffer of spend events kept for up to `baselineDays` + 1 day. */
  events: SpendEvent[];
  /** Epoch ms of the last dispatched alert (per-tenant cooldown). */
  lastAlertAt: number;
}

const MS_PER_DAY = 86_400_000;

export class CostAnomalyDetector {
  private readonly windowMs: number;
  private readonly baselineDays: number;
  private readonly minBaselineDays: number;
  private readonly spikeMultiplier: number;
  private readonly minAbsolute: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly sink?: AlertSink;
  private readonly logger?: Logger;
  private readonly state = new Map<string, TenantState>();

  constructor(opts: CostAnomalyDetectorOptions = {}) {
    this.windowMs = opts.windowMs ?? 3_600_000;
    this.baselineDays = opts.baselineDays ?? 7;
    this.minBaselineDays = opts.minBaselineDays ?? 3;
    this.spikeMultiplier = opts.spikeMultiplier ?? 3.0;
    this.minAbsolute = opts.minAbsolute ?? 0.1;
    this.cooldownMs = opts.cooldownMs ?? 3_600_000;
    this.clock = opts.clock ?? Date.now;
    this.sink = opts.sink;
    this.logger = opts.logger;
  }

  /**
   * Record a spend increment and check for anomalies. Returns the alert that
   * was dispatched (or undefined when nothing fired). Never throws into the
   * hot path.
   */
  async observe(
    tenant: string | undefined,
    amount: number,
  ): Promise<CostAnomalyAlert | undefined> {
    if (amount <= 0) return undefined;
    const key = tenant ?? "default";
    const now = this.clock();

    // Retrieve or create state, pruning events older than baselineDays + 1 day.
    let s = this.state.get(key);
    if (s === undefined) {
      s = { events: [], lastAlertAt: 0 };
      this.state.set(key, s);
    }

    // Append and prune: keep only events within the history horizon.
    s.events.push({ ts: now, amount });
    const horizon = now - (this.baselineDays + 1) * MS_PER_DAY;
    s.events = s.events.filter((e) => e.ts >= horizon);

    // Recent window spend.
    const recent = s.events
      .filter((e) => e.ts >= now - this.windowMs)
      .reduce((acc, e) => acc + e.amount, 0);

    if (recent < this.minAbsolute) return undefined;

    // Build baseline: collect daily totals for the same hour-of-day slot over
    // the past `baselineDays` days (ignoring today).
    const todayStart = now - (now % MS_PER_DAY);
    const hourOfDay =
      Math.floor((now % MS_PER_DAY) / this.windowMs) * this.windowMs;

    const dailyTotals: number[] = [];
    for (let d = 1; d <= this.baselineDays; d++) {
      const slotStart = todayStart - d * MS_PER_DAY + hourOfDay;
      const slotEnd = slotStart + this.windowMs;
      const slotSum = s.events
        .filter((e) => e.ts >= slotStart && e.ts < slotEnd)
        .reduce((acc, e) => acc + e.amount, 0);
      if (slotSum > 0) dailyTotals.push(slotSum);
    }

    if (dailyTotals.length < this.minBaselineDays) return undefined; // not enough history

    // Median of daily totals as a robust baseline (outlier-resistant).
    const sorted = [...dailyTotals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const midValue = sorted[mid];
    if (midValue === undefined) return undefined; // unreachable given the length check above
    let baseline: number;
    if (sorted.length % 2 === 0) {
      const midPrevValue = sorted[mid - 1];
      if (midPrevValue === undefined) return undefined; // unreachable: length is even and >= 2 here
      baseline = (midPrevValue + midValue) / 2;
    } else {
      baseline = midValue;
    }

    const ratio = baseline > 0 ? recent / baseline : Infinity;
    if (ratio < this.spikeMultiplier) return undefined;

    // Cooldown: don't fire again within the cooldown window.
    if (now - s.lastAlertAt < this.cooldownMs) return undefined;
    s.lastAlertAt = now;

    const alert: CostAnomalyAlert = {
      type: "cost_anomaly",
      tenant: key,
      recent: Math.round(recent * 1_000_000) / 1_000_000,
      baseline: Math.round(baseline * 1_000_000) / 1_000_000,
      multiplier: Math.round(ratio * 100) / 100,
      at: new Date(now).toISOString(),
      windowMs: this.windowMs,
    };

    this.logger?.warn("Cost anomaly detected", {
      tenant: key,
      recent: alert.recent,
      baseline: alert.baseline,
      multiplier: alert.multiplier,
    });

    if (this.sink !== undefined) {
      try {
        // The AlertSink contract takes a BudgetAlert, but our anomaly alert
        // has a compatible JSON structure for webhook delivery. Cast via unknown.
        await this.sink(alert as unknown as Parameters<AlertSink>[0]);
      } catch (err) {
        this.logger?.warn("Cost anomaly webhook failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return alert;
  }

  /** Current event buffer sizes per tenant (for diagnostics). */
  stats(): Record<string, { events: number; lastAlertAt: number }> {
    const out: Record<string, { events: number; lastAlertAt: number }> = {};
    for (const [tenant, s] of this.state) {
      out[tenant] = { events: s.events.length, lastAlertAt: s.lastAlertAt };
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Config + factory
// ---------------------------------------------------------------------------

export interface CostAnomalyConfig {
  enabled?: boolean;
  windowMs?: number;
  baselineDays?: number;
  minBaselineDays?: number;
  spikeMultiplier?: number;
  minAbsolute?: number;
  cooldownMs?: number;
}

/**
 * Creates a {@link CostAnomalyDetector} when enabled and a webhook sink is
 * available, else returns undefined (zero-overhead when disabled).
 */
export function createCostAnomalyDetector(
  config: CostAnomalyConfig,
  sink: AlertSink | undefined,
  logger?: Logger,
): CostAnomalyDetector | undefined {
  if (config.enabled !== true) return undefined;
  const detector = new CostAnomalyDetector({
    windowMs: config.windowMs,
    baselineDays: config.baselineDays,
    minBaselineDays: config.minBaselineDays,
    spikeMultiplier: config.spikeMultiplier,
    minAbsolute: config.minAbsolute,
    cooldownMs: config.cooldownMs,
    sink,
    logger,
  });
  logger?.info("Cost anomaly detection enabled", {
    windowMs: config.windowMs ?? 3_600_000,
    spikeMultiplier: config.spikeMultiplier ?? 3.0,
    minBaselineDays: config.minBaselineDays ?? 3,
  });
  return detector;
}

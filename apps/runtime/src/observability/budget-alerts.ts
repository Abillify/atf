// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Budget alerts & webhooks (`src/observability/budget-alerts.ts`)
 *
 * Per-tenant daily caps reject traffic at 100% (HTTP 402), but operators want
 * warning *before* a tenant is cut off. This module fires an alert when a
 * tenant's rolling-window spend crosses configured fractions of its cap
 * (e.g. 50% / 80% / 100%), delivered as a JSON webhook POST. Each threshold
 * fires at most once per tenant per window, so a busy tenant does not spam the
 * channel; the per-tenant ledger resets when its 24h window rolls over.
 *
 * The HTTP delivery and clock are injected, so the alerter is fully
 * unit-testable without real network or timers. Delivery never throws into the
 * hot path — a failed webhook is logged and retried on the next crossing.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "./logger.js";

/** Payload POSTed to the configured webhook when a threshold is crossed. */
export interface BudgetAlert {
  type: "budget_threshold";
  tenant: string;
  /** Crossed threshold as a fraction of the cap (e.g. 0.8). */
  threshold: number;
  spent: number;
  cap: number;
  /** spent / cap, rounded to 4 dp. */
  utilization: number;
  /** ISO timestamp of the crossing. */
  at: string;
}

/** Injected webhook delivery. Returns true on success. */
export type AlertSink = (alert: BudgetAlert) => Promise<boolean>;

export interface BudgetAlerterOptions {
  /** Fractions of the cap to alert on, e.g. [0.5, 0.8, 1.0]. */
  thresholds: number[];
  /** Per-tenant daily cap. When ≤ 0 alerting is inert. */
  cap: number;
  /** Webhook delivery backend. */
  sink: AlertSink;
  /** Rolling window length (ms). Default 24h — matches the cost tracker. */
  windowMs?: number;
  clock?: () => number;
  logger?: Logger;
}

interface TenantAlertState {
  /** Thresholds already fired in the current window. */
  fired: Set<number>;
  resetAt: number;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Tracks threshold crossings per tenant and dispatches webhook alerts.
 * Stateless across replicas (per-replica de-dup); good enough for alerting,
 * where an occasional duplicate after a deploy is harmless.
 */
export class BudgetAlerter {
  private readonly thresholds: number[];
  private readonly cap: number;
  private readonly sink: AlertSink;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly logger?: Logger;
  private readonly state = new Map<string, TenantAlertState>();

  constructor(opts: BudgetAlerterOptions) {
    // Sort ascending and de-duplicate so crossings are evaluated low → high.
    this.thresholds = [...new Set(opts.thresholds)].sort((a, b) => a - b);
    this.cap = opts.cap;
    this.sink = opts.sink;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.clock ?? Date.now;
    this.logger = opts.logger;
  }

  /** True when alerting can actually fire (cap set and thresholds configured). */
  get active(): boolean {
    return this.cap > 0 && this.thresholds.length > 0;
  }

  private current(tenant: string): TenantAlertState {
    const now = this.clock();
    let s = this.state.get(tenant);
    if (s === undefined || s.resetAt <= now) {
      s = { fired: new Set(), resetAt: now + this.windowMs };
      this.state.set(tenant, s);
    }
    return s;
  }

  /**
   * Records a tenant's current window spend and fires any newly-crossed
   * threshold alerts. Call after each spend update. Returns the alerts that
   * were dispatched (mainly for tests / metrics). Never throws.
   */
  async observe(
    tenant: string | undefined,
    spent: number,
  ): Promise<BudgetAlert[]> {
    if (!this.active) return [];
    const key = tenant ?? "default";
    const s = this.current(key);
    const utilization = spent / this.cap;
    const dispatched: BudgetAlert[] = [];

    for (const threshold of this.thresholds) {
      if (utilization < threshold || s.fired.has(threshold)) continue;
      s.fired.add(threshold);
      const alert: BudgetAlert = {
        type: "budget_threshold",
        tenant: key,
        threshold,
        spent: Math.round(spent * 1_000_000) / 1_000_000,
        cap: this.cap,
        utilization: Math.round(utilization * 10_000) / 10_000,
        at: new Date(this.clock()).toISOString(),
      };
      try {
        const ok = await this.sink(alert);
        if (!ok) {
          // Allow a retry on the next crossing evaluation.
          s.fired.delete(threshold);
          this.logger?.warn("Budget alert webhook returned non-OK", {
            tenant: key,
            threshold,
          });
        } else {
          dispatched.push(alert);
          this.logger?.info("Budget alert dispatched", {
            tenant: key,
            threshold,
            utilization: alert.utilization,
          });
        }
      } catch (err) {
        s.fired.delete(threshold);
        this.logger?.warn("Budget alert webhook failed", {
          tenant: key,
          threshold,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return dispatched;
  }
}

/**
 * Builds an {@link AlertSink} that POSTs alerts as JSON to a webhook URL with a
 * bounded timeout. Treats any 2xx as success. Injectable fetch for tests.
 */
export function createWebhookSink(
  url: string,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    logger?: Logger;
  } = {},
): AlertSink {
  const timeoutMs = options.timeoutMs ?? 5000;
  const doFetch = options.fetchImpl ?? fetch;
  return async (alert: BudgetAlert): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alert),
        signal: controller.signal,
      });
      return res.ok;
    } catch (err) {
      options.logger?.warn("Webhook delivery error", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

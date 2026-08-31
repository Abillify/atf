// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Usage metering + billing export (`src/observability/billing.ts`)
 *
 * Aggregates token consumption and cost per tenant into a daily/per-model
 * ledger and exposes it as Stripe-compatible usage records for billing
 * integration. Two complementary layers:
 *
 *   - {@link UsageMeter} — accumulates live usage into the `billing_usage`
 *     table (or an in-memory map when no DB is set). Called by the graph
 *     engine whenever a successful LLM node completes. A periodic roll-up
 *     merges the hot in-memory buffer into the DB so reads are always fast
 *     (`billing_usage` answers dashboard queries in one DB round-trip).
 *
 *   - {@link BillingExport} — wraps the DB data in Stripe's
 *     `UsageRecord`-compatible shape so an external billing job can
 *     `POST /v1/subscription_items/:id/usage_records` without any
 *     transformation. Pure output layer — no Stripe SDK dependency.
 *
 * No `any` at module boundaries.
 */

import type { Database } from "../db/database.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Usage record shapes
// ---------------------------------------------------------------------------

export interface UsageIncrement {
  tenantId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface DailyUsage {
  tenantId: string;
  periodStart: string; // ISO date, YYYY-MM-DD
  provider?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  requestCount: number;
}

/** Summary aggregated across providers/models for a tenant. */
export interface TenantUsageSummary {
  tenantId: string;
  periodStart: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCost: number;
  totalRequests: number;
  breakdown: Array<{
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cost: number;
    requestCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Stripe-compatible usage record
// ---------------------------------------------------------------------------

export interface StripeUsageRecord {
  /** Unix timestamp. */
  timestamp: number;
  /** Quantity to report (we use total_tokens as the metered value). */
  quantity: number;
  action: "increment";
  metadata: {
    tenant_id: string;
    period_start: string;
    cost: string;
    providers: string;
  };
}

export function toStripeUsageRecord(
  summary: TenantUsageSummary,
): StripeUsageRecord {
  const totalTokens = summary.totalPromptTokens + summary.totalCompletionTokens;
  const providers = [...new Set(summary.breakdown.map((b) => b.provider))].join(
    ",",
  );
  return {
    timestamp: Math.floor(new Date(summary.periodStart).getTime() / 1000),
    quantity: totalTokens,
    action: "increment",
    metadata: {
      tenant_id: summary.tenantId,
      period_start: summary.periodStart,
      cost: summary.totalCost.toFixed(6),
      providers,
    },
  };
}

// ---------------------------------------------------------------------------
// UsageMeter
// ---------------------------------------------------------------------------

export interface UsageMeter {
  /** Records one LLM call's usage (best-effort, non-blocking). */
  record(inc: UsageIncrement): void;
  /** Fetches daily usage for a tenant (most recent days first). */
  getTenantUsage(tenantId: string, days?: number): Promise<DailyUsage[]>;
  /** Aggregated usage summary for a tenant over a date range. */
  getSummary(
    tenantId: string,
    periodStart: string,
    periodEnd?: string,
  ): Promise<TenantUsageSummary>;
  /** Flushes the in-memory buffer to the DB (no-op for in-memory store). */
  flush(): Promise<void>;
}

const today = (): string => new Date().toISOString().slice(0, 10);

function rowToDaily(r: Record<string, unknown>): DailyUsage {
  const toNum = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    tenantId: String(r.tenant_id ?? r.tenantId ?? ""),
    periodStart: String(r.period_start ?? r.periodStart ?? ""),
    ...(r.provider != null ? { provider: String(r.provider) } : {}),
    ...(r.model != null ? { model: String(r.model) } : {}),
    promptTokens: toNum(r.prompt_tokens ?? r.promptTokens),
    completionTokens: toNum(r.completion_tokens ?? r.completionTokens),
    cost: Math.round(toNum(r.cost) * 1_000_000) / 1_000_000,
    requestCount: toNum(r.request_count ?? r.requestCount),
  };
}

// ---- In-memory ----

type BufferKey = string; // `tenantId|YYYY-MM-DD|provider|model`

interface Buffer {
  data: DailyUsage;
  dirty: boolean;
}

/** Purely in-memory usage meter (per-replica, for dev). */
export class InMemoryUsageMeter implements UsageMeter {
  private readonly buf = new Map<BufferKey, Buffer>();

  private key(inc: UsageIncrement): BufferKey {
    return `${inc.tenantId}|${today()}|${inc.provider}|${inc.model}`;
  }

  record(inc: UsageIncrement): void {
    const k = this.key(inc);
    let entry = this.buf.get(k);
    if (entry === undefined) {
      entry = {
        data: {
          tenantId: inc.tenantId,
          periodStart: today(),
          provider: inc.provider,
          model: inc.model,
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
          requestCount: 0,
        },
        dirty: false,
      };
      this.buf.set(k, entry);
    }
    entry.data.promptTokens += inc.promptTokens;
    entry.data.completionTokens += inc.completionTokens;
    entry.data.cost =
      Math.round((entry.data.cost + inc.cost) * 1_000_000) / 1_000_000;
    entry.data.requestCount += 1;
  }

  async getTenantUsage(tenantId: string, days = 30): Promise<DailyUsage[]> {
    const cutoff = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return [...this.buf.values()]
      .map((e) => e.data)
      .filter((d) => d.tenantId === tenantId && d.periodStart >= cutoff)
      .sort((a, b) => (b.periodStart > a.periodStart ? 1 : -1));
  }

  async getSummary(
    tenantId: string,
    periodStart: string,
    periodEnd?: string,
  ): Promise<TenantUsageSummary> {
    const end = periodEnd ?? today();
    const rows = [...this.buf.values()]
      .map((e) => e.data)
      .filter(
        (d) =>
          d.tenantId === tenantId &&
          d.periodStart >= periodStart &&
          d.periodStart <= end,
      );
    return buildSummary(tenantId, periodStart, rows);
  }

  async flush(): Promise<void> {
    /* no-op for in-memory */
  }
}

// ---- Postgres ----

const UPSERT_SQL = `
INSERT INTO billing_usage
  (tenant_id, period_start, provider, model, prompt_tokens, completion_tokens, cost, request_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, 1)
ON CONFLICT (tenant_id, period_start, provider, model) DO UPDATE
  SET prompt_tokens     = billing_usage.prompt_tokens     + EXCLUDED.prompt_tokens,
      completion_tokens = billing_usage.completion_tokens + EXCLUDED.completion_tokens,
      cost          = billing_usage.cost          + EXCLUDED.cost,
      request_count     = billing_usage.request_count     + 1
`;

/** Postgres-backed usage meter — durable, cross-replica. */
export class PostgresUsageMeter implements UsageMeter {
  /** Hot in-memory buffer — flushed every `flushIntervalMs`. */
  private readonly buf = new Map<
    BufferKey,
    UsageIncrement & { day: string; count: number }
  >();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: Database,
    flushIntervalMs = 5_000,
    private readonly logger?: Logger,
  ) {
    this.timer = setInterval(() => void this.flush(), flushIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** Runs `cb` with the RLS tenant context bound (pass-through when disabled). */
  private scoped<T>(
    tenantId: string,
    cb: (db: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.withTenant ? this.db.withTenant(tenantId, cb) : cb(this.db);
  }

  record(inc: UsageIncrement): void {
    const day = today();
    const k: BufferKey = `${inc.tenantId}|${day}|${inc.provider}|${inc.model}`;
    const e = this.buf.get(k);
    if (e === undefined) {
      this.buf.set(k, { ...inc, day, count: 1 });
    } else {
      e.promptTokens += inc.promptTokens;
      e.completionTokens += inc.completionTokens;
      e.cost += inc.cost;
      e.count += 1;
    }
  }

  async flush(): Promise<void> {
    if (this.buf.size === 0) return;
    const entries = [...this.buf.values()];
    this.buf.clear();
    for (const e of entries) {
      try {
        await this.scoped(e.tenantId, (db) =>
          db.query(UPSERT_SQL, [
            e.tenantId,
            e.day,
            e.provider,
            e.model,
            e.promptTokens,
            e.completionTokens,
            Math.round(e.cost * 1_000_000) / 1_000_000,
          ]),
        );
      } catch (err) {
        this.logger?.warn("Failed to flush billing usage", {
          tenant: e.tenantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async getTenantUsage(tenantId: string, days = 30): Promise<DailyUsage[]> {
    const since = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const rows = await this.scoped(tenantId, (db) =>
      db.query<Record<string, unknown>>(
        `SELECT tenant_id, period_start::TEXT, provider, model,
                prompt_tokens, completion_tokens, cost, request_count
           FROM billing_usage
          WHERE tenant_id=$1 AND period_start >= $2
          ORDER BY period_start DESC, model`,
        [tenantId, since],
      ),
    );
    return rows.map(rowToDaily);
  }

  async getSummary(
    tenantId: string,
    periodStart: string,
    periodEnd?: string,
  ): Promise<TenantUsageSummary> {
    const end = periodEnd ?? today();
    const rows = await this.scoped(tenantId, (db) =>
      db.query<Record<string, unknown>>(
        `SELECT tenant_id, period_start::TEXT, provider, model,
                prompt_tokens, completion_tokens, cost, request_count
           FROM billing_usage
          WHERE tenant_id=$1 AND period_start >= $2 AND period_start <= $3`,
        [tenantId, periodStart, end],
      ),
    );
    return buildSummary(tenantId, periodStart, rows.map(rowToDaily));
  }

  stop(): void {
    clearInterval(this.timer);
    // Final best-effort flush (fire and forget).
    void this.flush();
  }
}

function buildSummary(
  tenantId: string,
  periodStart: string,
  rows: DailyUsage[],
): TenantUsageSummary {
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCost = 0;
  let totalReq = 0;
  const byModel = new Map<string, DailyUsage>();
  for (const r of rows) {
    totalPrompt += r.promptTokens;
    totalCompletion += r.completionTokens;
    totalCost += r.cost;
    totalReq += r.requestCount;
    const k = `${r.provider ?? ""}|${r.model ?? ""}`;
    const existing = byModel.get(k);
    if (existing === undefined) {
      byModel.set(k, { ...r });
    } else {
      existing.promptTokens += r.promptTokens;
      existing.completionTokens += r.completionTokens;
      existing.cost += r.cost;
      existing.requestCount += r.requestCount;
    }
  }
  return {
    tenantId,
    periodStart,
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    totalRequests: totalReq,
    breakdown: [...byModel.values()].map((d) => ({
      provider: d.provider ?? "",
      model: d.model ?? "",
      promptTokens: d.promptTokens,
      completionTokens: d.completionTokens,
      cost: Math.round(d.cost * 1_000_000) / 1_000_000,
      requestCount: d.requestCount,
    })),
  };
}

/** Builds the appropriate meter depending on whether a database is configured. */
export function createUsageMeter(db?: Database, logger?: Logger): UsageMeter {
  return db !== undefined
    ? new PostgresUsageMeter(db, 5_000, logger)
    : new InMemoryUsageMeter();
}

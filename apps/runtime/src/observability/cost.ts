// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Cost estimation & per-tenant budget control (`src/observability/cost.ts`)
 *
 * - A built-in pricing table (per 1M tokens, denominated in the configured
 *   display currency — `CURRENCY`, default EUR; values are never converted
 *   between currencies) for common models, overridable via AppConfig.llmPricing.
 * - `estimateCost()` turns a TokenUsage into a cost figure in that currency.
 * - `CostTracker` accumulates spend per tenant in a rolling 24h window and
 *   enforces an optional daily cap (fail-closed on the budget decision; the
 *   tracker itself never throws).
 *
 * The tracker is in-memory (per replica). For cluster-wide budgets a Redis
 * store can be injected later via the same interface — kept intentionally
 * small so it can be swapped without touching call sites.
 *
 * No `any` at module boundaries.
 */

import type { TokenUsage } from "../types/openai.js";
import type { Database } from "../db/database.js";
import type { Logger } from "./logger.js";

export interface ModelPrice {
  /** Price per 1,000,000 prompt (input) tokens, in the configured currency. */
  prompt: number;
  /** Price per 1,000,000 completion (output) tokens, in the configured currency. */
  completion: number;
}

/**
 * Built-in pricing (per 1M tokens, in the configured display currency —
 * `CURRENCY`, default EUR; no conversion is ever applied) for frequently used
 * models. These are conservative published list prices and can be overridden
 * via LLM_PRICING. Ollama / local models default to 0.
 */
const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "openai/gpt-4o": { prompt: 2.5, completion: 10 },
  "openai/gpt-4o-mini": { prompt: 0.15, completion: 0.6 },
  "openai/gpt-4.1": { prompt: 2, completion: 8 },
  "openai/gpt-4.1-mini": { prompt: 0.4, completion: 1.6 },
  "openai/gpt-4.1-nano": { prompt: 0.1, completion: 0.4 },
  "openai/o3-mini": { prompt: 1.1, completion: 4.4 },
  "google/gemini-2.0-flash": { prompt: 0.1, completion: 0.4 },
  "google/gemini-1.5-pro": { prompt: 1.25, completion: 5 },
  "google/gemini-1.5-flash": { prompt: 0.075, completion: 0.3 },
  // Anthropic Claude (direct API) — published list prices (USD / 1M tokens).
  "anthropic/claude-opus-4-20250514": { prompt: 15, completion: 75 },
  "anthropic/claude-sonnet-4-20250514": { prompt: 3, completion: 15 },
  "anthropic/claude-sonnet-5": { prompt: 3, completion: 15 },
  "anthropic/claude-3-7-sonnet-latest": { prompt: 3, completion: 15 },
  "anthropic/claude-3-5-sonnet-latest": { prompt: 3, completion: 15 },
  "anthropic/claude-3-5-haiku-latest": { prompt: 0.8, completion: 4 },
  "anthropic/claude-3-haiku-20240307": { prompt: 0.25, completion: 1.25 },
  // AWS Bedrock — keyed by Bedrock model ID (published on-demand list prices).
  "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0": {
    prompt: 3,
    completion: 15,
  },
  "bedrock/anthropic.claude-3-5-haiku-20241022-v1:0": {
    prompt: 0.8,
    completion: 4,
  },
  "bedrock/anthropic.claude-3-haiku-20240307-v1:0": {
    prompt: 0.25,
    completion: 1.25,
  },
  "bedrock/meta.llama3-1-70b-instruct-v1:0": { prompt: 0.72, completion: 0.72 },
  // Claude 4.x on Bedrock (published on-demand list prices, USD / 1M tokens).
  "bedrock/anthropic.claude-haiku-4-5-20251001-v1:0": {
    prompt: 0.8,
    completion: 4,
  },
  "bedrock/anthropic.claude-sonnet-4-5-20250514-v1:0": {
    prompt: 3,
    completion: 15,
  },
  "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0": {
    prompt: 3,
    completion: 15,
  },
  "bedrock/anthropic.claude-sonnet-5": { prompt: 3, completion: 15 },
  "bedrock/anthropic.claude-opus-4-20250514-v1:0": {
    prompt: 15,
    completion: 75,
  },
  // Azure OpenAI uses arbitrary deployment names, so it cannot be priced by a
  // fixed table — operators should set LLM_PRICING for their deployments.
};

/**
 * AWS Bedrock cross-region inference model IDs are prefixed with a two-letter
 * region code (e.g. `eu.anthropic.claude-3-5-sonnet…`, `us.anthropic.…`,
 * `ap.anthropic.…`). Strip that prefix so pricing lookups hit the same base
 * key regardless of which inference region is configured in the flow.
 */
function stripBedrockRegionPrefix(model: string): string {
  // Matches eu. / us. / ap. / ca. / sa. at the start of the model ID.
  return model.replace(/^(?:eu|us|ap|ca|sa)\./, "");
}

/**
 * Resolves the price for a provider/model, honouring overrides. Falls back to a
 * bare-model lookup (ignoring provider) and finally to zero (e.g. local Ollama).
 */
export function resolveModelPrice(
  provider: string,
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice {
  const key = `${provider}/${model}`;
  const override = overrides?.[key];
  if (override) return override;
  const defaultPrice = DEFAULT_PRICING[key];
  if (defaultPrice) return defaultPrice;
  // For Bedrock cross-region inference IDs (eu./us./ap. prefix) retry without
  // the regional prefix so the base model ID hits the pricing table.
  const normalized = stripBedrockRegionPrefix(model);
  if (normalized !== model) {
    const normalizedKey = `${provider}/${normalized}`;
    const normalizedOverride = overrides?.[normalizedKey];
    if (normalizedOverride) return normalizedOverride;
    const normalizedDefault = DEFAULT_PRICING[normalizedKey];
    if (normalizedDefault) return normalizedDefault;
  }
  // Try a provider-agnostic override match (operator may key by bare model)
  const bareOverride = overrides?.[model];
  if (bareOverride) return bareOverride;
  return { prompt: 0, completion: 0 };
}

/**
 * Returns the price for a provider/model when it is KNOWN (built-in table or an
 * override), or `undefined` when no price is available. Unlike
 * {@link resolveModelPrice} this does NOT fall back to zero — callers that need
 * to rank models by cost (e.g. the cost router) must distinguish "free/local"
 * from "unknown price", otherwise an unpriced model looks artificially cheapest.
 */
export function getModelPricing(
  provider: string,
  model: string,
  overrides?: Record<string, ModelPrice>,
): ModelPrice | undefined {
  const key = `${provider}/${model}`;
  const override = overrides?.[key];
  if (override) return override;
  const defaultPrice = DEFAULT_PRICING[key];
  if (defaultPrice) return defaultPrice;
  // Same regional-prefix normalisation as resolveModelPrice.
  const normalized = stripBedrockRegionPrefix(model);
  if (normalized !== model) {
    const normalizedKey = `${provider}/${normalized}`;
    const normalizedOverride = overrides?.[normalizedKey];
    if (normalizedOverride) return normalizedOverride;
    const normalizedDefault = DEFAULT_PRICING[normalizedKey];
    if (normalizedDefault) return normalizedDefault;
  }
  const bareOverride = overrides?.[model];
  if (bareOverride) return bareOverride;
  return undefined;
}

/**
 * Estimates the cost of a token usage for a given provider/model, in the same
 * currency as the configured pricing table (USD by convention).
 * Returns 0 when the model has no known/overridden price (e.g. local models).
 */
export function estimateCost(
  provider: string,
  model: string,
  usage: Pick<TokenUsage, "prompt_tokens" | "completion_tokens">,
  overrides?: Record<string, ModelPrice>,
): number {
  const price = resolveModelPrice(provider, model, overrides);
  const cost =
    (usage.prompt_tokens / 1_000_000) * price.prompt +
    (usage.completion_tokens / 1_000_000) * price.completion;
  // Round to 6 decimal places (micro-currency precision).
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/**
 * Coarse token estimator used as a FALLBACK when a provider does not report
 * usage in its stream (e.g. some Ollama models). Uses the widely-used
 * ~4-characters-per-token heuristic. Never returns negative; empty/whitespace
 * text yields 0. This keeps cost accounting and budget enforcement working even
 * when upstream usage is missing — accuracy is approximate by design.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.ceil(trimmed.length / 4);
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface TenantSpend {
  amount: number;
  resetAt: number;
}

export interface BudgetDecision {
  allowed: boolean;
  /** Spend in the current window, excluding the pending request. */
  spent: number;
  /** Configured cap; 0 = unlimited. */
  cap: number;
}

/**
 * Tracks per-tenant spend in a rolling daily window and answers budget queries.
 * "default" is used as the tenant key when a request carries no tenant id.
 */
export class CostTracker {
  private readonly spend = new Map<string, TenantSpend>();
  /** Per-user rolling spend (+ best-known label). Mirrors `spend`. */
  private readonly userSpend = new Map<
    string,
    TenantSpend & { label: string }
  >();
  /** Per-flow rolling spend. Mirrors `spend`. */
  private readonly flowSpend = new Map<string, TenantSpend>();
  private readonly sweep: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly dailyCap: number = 0) {
    // Periodically evict expired tenant windows so the map cannot grow forever.
    this.sweep = setInterval(() => this.evictExpired(), WINDOW_MS);
    (this.sweep as unknown as { unref?: () => void }).unref?.();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, s] of this.spend) {
      if (s.resetAt <= now) this.spend.delete(key);
    }
    for (const [key, s] of this.userSpend) {
      if (s.resetAt <= now) this.userSpend.delete(key);
    }
    for (const [key, s] of this.flowSpend) {
      if (s.resetAt <= now) this.flowSpend.delete(key);
    }
  }

  private current(tenant: string): TenantSpend {
    const now = Date.now();
    let s = this.spend.get(tenant);
    if (s === undefined || s.resetAt <= now) {
      s = { amount: 0, resetAt: now + WINDOW_MS };
      this.spend.set(tenant, s);
    }
    return s;
  }

  /** Returns whether a tenant is currently under budget (does not record spend). */
  check(tenant: string | undefined): BudgetDecision {
    const key = tenant ?? "default";
    const s = this.current(key);
    const allowed = this.dailyCap <= 0 || s.amount < this.dailyCap;
    return { allowed, spent: s.amount, cap: this.dailyCap };
  }

  /** Records additional spend for a tenant in the current window. */
  record(
    tenant: string | undefined,
    amount: number,
    detail?: CostDetail,
  ): void {
    if (amount <= 0) return;
    const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
    const key = tenant ?? "default";
    const s = this.current(key);
    s.amount = round(s.amount + amount);

    // Per-user attribution (only when the caller knows the user).
    if (detail?.userId !== undefined && detail.userId !== "") {
      const now = Date.now();
      let u = this.userSpend.get(detail.userId);
      if (u === undefined || u.resetAt <= now) {
        u = { amount: 0, resetAt: now + WINDOW_MS, label: detail.userId };
        this.userSpend.set(detail.userId, u);
      }
      u.amount = round(u.amount + amount);
      // Keep the most recent non-empty label so renames are reflected.
      if (detail.userLabel !== undefined && detail.userLabel !== "") {
        u.label = detail.userLabel;
      }
    }

    // Per-flow attribution (only when the caller knows the flow).
    if (detail?.flowId !== undefined && detail.flowId !== "") {
      const now = Date.now();
      let f = this.flowSpend.get(detail.flowId);
      if (f === undefined || f.resetAt <= now) {
        f = { amount: 0, resetAt: now + WINDOW_MS };
        this.flowSpend.set(detail.flowId, f);
      }
      f.amount = round(f.amount + amount);
    }
  }

  /** Snapshot of all tenants' spend in the current window (for the dashboard). */
  snapshot(): Array<{
    tenant: string;
    spent: number;
    cap: number;
    resetAt: number;
  }> {
    const now = Date.now();
    const out: Array<{
      tenant: string;
      spent: number;
      cap: number;
      resetAt: number;
    }> = [];
    for (const [tenant, s] of this.spend) {
      if (s.resetAt <= now) continue;
      out.push({
        tenant,
        spent: s.amount,
        cap: this.dailyCap,
        resetAt: s.resetAt,
      });
    }
    return out;
  }

  /** Per-user spend snapshot in the current window. */
  snapshotByUser(): Array<{ userId: string; label: string; spent: number }> {
    const now = Date.now();
    const out: Array<{ userId: string; label: string; spent: number }> = [];
    for (const [userId, s] of this.userSpend) {
      if (s.resetAt <= now) continue;
      out.push({ userId, label: s.label, spent: s.amount });
    }
    return out;
  }

  /** Per-flow spend snapshot in the current window. */
  snapshotByFlow(): Array<{ flowId: string; spent: number }> {
    const now = Date.now();
    const out: Array<{ flowId: string; spent: number }> = [];
    for (const [flowId, s] of this.flowSpend) {
      if (s.resetAt <= now) continue;
      out.push({ flowId, spent: s.amount });
    }
    return out;
  }

  stop(): void {
    if (this.sweep !== undefined) clearInterval(this.sweep);
    this.spend.clear();
  }
}

// ---------------------------------------------------------------------------
// Durable cost persistence (Postgres) + budget service
// ---------------------------------------------------------------------------

/** Optional per-spend detail recorded alongside the dollar amount. */
export interface CostDetail {
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Authenticated user id (JWT `sub` / OWUI header) this spend is attributed to. */
  userId?: string;
  /** Display name/email for the user, captured at spend time (denormalised). */
  userLabel?: string;
  /** Id of the flow whose execution issued the LLM call. */
  flowId?: string;
}

/** The subset of {@link CostDetail} that attributes spend to a user + flow. */
export type CostAttribution = Pick<
  CostDetail,
  "userId" | "userLabel" | "flowId"
>;

/**
 * Builds the user/flow attribution for a spend record from the request context
 * and the executing flow. The user label prefers a human name, then email, then
 * the raw id. Fields are only included when known so a partially-identified
 * request (e.g. anonymous, single-tenant) records clean NULLs rather than empty
 * strings. Shape is spread into the {@link CostDetail} at each `record(...)`.
 */
export function buildCostAttribution(
  ctx: { userId?: string; userName?: string; userEmail?: string },
  flowId: string | undefined,
): CostAttribution {
  const label = ctx.userName ?? ctx.userEmail ?? ctx.userId;
  return {
    ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
    ...(label !== undefined ? { userLabel: label } : {}),
    ...(flowId !== undefined ? { flowId } : {}),
  };
}

/**
 * Minimal contract the graph engine depends on to record spend. Both the
 * in-memory {@link CostTracker} and {@link BudgetService} satisfy it, so the
 * engine never needs to know whether persistence is enabled.
 */
export interface SpendRecorder {
  record(
    tenant: string | undefined,
    amount: number,
    detail?: CostDetail,
  ): void;
}

/** One tenant's spend in the current rolling window. */
export interface TenantSpendSummary {
  tenant: string;
  spent: number;
  cap: number;
  resetAt: number;
}

/** One authenticated user's spend in the current rolling window. */
export interface UserSpendSummary {
  /** Stable user id (JWT `sub` / OWUI header). */
  userId: string;
  /** Best-known display name/email for the user (may equal the id). */
  label: string;
  spent: number;
}

/** One flow's spend in the current rolling window. */
export interface FlowSpendSummary {
  flowId: string;
  spent: number;
}

/**
 * Durable backing store for per-tenant spend over a rolling 24h window.
 * Implemented by {@link PostgresCostStore}; the absence of a store means the
 * in-memory {@link CostTracker} is authoritative (per replica, reset on boot).
 */
export interface CostStore {
  /** Persists a spend entry. */
  record(tenant: string, amount: number, detail?: CostDetail): Promise<void>;
  /** Sum of spend for a tenant within the rolling window. */
  getWindowSpend(tenant: string): Promise<number>;
  /** Per-tenant spend snapshot within the window. */
  snapshot(): Promise<Array<{ tenant: string; spent: number }>>;
  /** Per-user spend snapshot within the window (rows lacking a user id are omitted). */
  snapshotByUser(): Promise<
    Array<{ userId: string; label: string; spent: number }>
  >;
  /** Per-flow spend snapshot within the window (rows lacking a flow id are omitted). */
  snapshotByFlow(): Promise<Array<{ flowId: string; spent: number }>>;
  /**
   * Daily spend series for one tenant over the trailing `days` days, oldest
   * first. Backs FinOps burn-rate forecasting (`src/observability/finops.ts`)
   * — a single rolling-window sum (as returned by {@link getWindowSpend})
   * cannot reveal a trend, but a day-bucketed series can. Optional: only the
   * durable Postgres-backed store implements it; the in-memory tracker has no
   * daily granularity, so forecasting degrades to "unavailable" without a
   * database (consistent with other historical-analysis features).
   */
  dailySeries?(
    tenant: string,
    days: number,
  ): Promise<Array<{ day: string; cost: number }>>;
}

/** Rolling window length used by the durable store (matches in-memory tracker). */
const COST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Postgres-backed cost store. Writes one row per spend into `cost_ledger` and
 * answers budget queries by summing the rolling 24h window. Survives restarts
 * and is shared across replicas, so per-tenant daily caps hold cluster-wide.
 */
export class PostgresCostStore implements CostStore {
  constructor(private readonly db: Database) {}

  /**
   * Runs `cb` with the RLS tenant context bound to `tenant` when the database
   * has tenant scoping enabled; otherwise a transparent pass-through.
   */
  private scoped<T>(
    tenant: string,
    cb: (db: Database) => Promise<T>,
  ): Promise<T> {
    return this.db.withTenant ? this.db.withTenant(tenant, cb) : cb(this.db);
  }

  async record(
    tenant: string,
    amount: number,
    detail?: CostDetail,
  ): Promise<void> {
    await this.scoped(tenant, (db) =>
      db.query(
        `INSERT INTO cost_ledger
           (tenant_id, provider, model, prompt_tokens, completion_tokens, cost,
            user_id, user_label, flow_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          tenant,
          detail?.provider ?? null,
          detail?.model ?? null,
          detail?.promptTokens ?? 0,
          detail?.completionTokens ?? 0,
          amount,
          detail?.userId ?? null,
          detail?.userLabel ?? null,
          detail?.flowId ?? null,
        ],
      ),
    );
  }

  async getWindowSpend(tenant: string): Promise<number> {
    const since = new Date(Date.now() - COST_WINDOW_MS).toISOString();
    const rows = await this.scoped(tenant, (db) =>
      db.query<{ total: number | string | null }>(
        `SELECT COALESCE(sum(cost), 0) AS total
           FROM cost_ledger
          WHERE tenant_id = $1 AND created_at >= $2`,
        [tenant, since],
      ),
    );
    return toNumber(rows[0]?.total);
  }

  // Cross-tenant operator-plane read (dashboard): intentionally NOT tenant
  // scoped. Under enforced RLS this runs on the BYPASSRLS operator pool — see
  // docs/adr/0005-tenant-data-isolation.md.
  async snapshot(): Promise<Array<{ tenant: string; spent: number }>> {
    const since = new Date(Date.now() - COST_WINDOW_MS).toISOString();
    const rows = await this.db.withOperator((db) =>
      db.query<{ tenant_id: string; total: number | string | null }>(
        `SELECT tenant_id, COALESCE(sum(cost), 0) AS total
           FROM cost_ledger
          WHERE created_at >= $1
          GROUP BY tenant_id`,
        [since],
      ),
    );
    return rows.map((r) => ({
      tenant: r.tenant_id,
      spent: toNumber(r.total),
    }));
  }

  // Cross-tenant operator-plane reads (dashboard) — intentionally NOT tenant
  // scoped, same as snapshot() above. Rows without a user/flow id are excluded
  // so a partially-attributed history doesn't create a noisy "unknown" bucket.
  async snapshotByUser(): Promise<
    Array<{ userId: string; label: string; spent: number }>
  > {
    const since = new Date(Date.now() - COST_WINDOW_MS).toISOString();
    const rows = await this.db.withOperator((db) =>
      db.query<{
        user_id: string;
        label: string | null;
        total: number | string | null;
      }>(
        `SELECT user_id,
                MAX(user_label) AS label,
                COALESCE(sum(cost), 0) AS total
           FROM cost_ledger
          WHERE created_at >= $1 AND user_id IS NOT NULL
          GROUP BY user_id`,
        [since],
      ),
    );
    return rows.map((r) => ({
      userId: r.user_id,
      label: r.label ?? r.user_id,
      spent: toNumber(r.total),
    }));
  }

  async snapshotByFlow(): Promise<Array<{ flowId: string; spent: number }>> {
    const since = new Date(Date.now() - COST_WINDOW_MS).toISOString();
    const rows = await this.db.withOperator((db) =>
      db.query<{
        flow_id: string;
        total: number | string | null;
      }>(
        `SELECT flow_id, COALESCE(sum(cost), 0) AS total
           FROM cost_ledger
          WHERE created_at >= $1 AND flow_id IS NOT NULL
          GROUP BY flow_id`,
        [since],
      ),
    );
    return rows.map((r) => ({
      flowId: r.flow_id,
      spent: toNumber(r.total),
    }));
  }

  async dailySeries(
    tenant: string,
    days: number,
  ): Promise<Array<{ day: string; cost: number }>> {
    const since = new Date(
      Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = await this.scoped(tenant, (db) =>
      db.query<{ day: string | Date; total: number | string | null }>(
        `SELECT date_trunc('day', created_at) AS day, COALESCE(sum(cost), 0) AS total
           FROM cost_ledger
          WHERE tenant_id = $1 AND created_at >= $2
          GROUP BY day
          ORDER BY day ASC`,
        [tenant, since],
      ),
    );
    return rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      cost: toNumber(r.total),
    }));
  }
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Budget enforcement facade used by the chat route and graph engine.
 *
 * - With a {@link CostStore} (Postgres): spend is durable and cluster-wide, so
 *   daily caps survive restarts and hold across replicas. `check` reads the
 *   authoritative window sum from the store.
 * - Without a store: it delegates to an in-memory {@link CostTracker} (per
 *   replica, reset on boot) — identical to the previous behaviour.
 *
 * Cap semantics are SOFT: enforcement happens at request admission, so a single
 * in-flight request may push a tenant slightly over the cap. This is intentional
 * — it never blocks a request that was already admitted, and avoids the latency
 * of per-token reservation.
 */
export class BudgetService implements SpendRecorder {
  private readonly mem: CostTracker;

  constructor(
    private readonly cap: number,
    private readonly store?: CostStore,
    private readonly logger?: Logger,
  ) {
    this.mem = new CostTracker(cap);
  }

  /** Whether spend is durably persisted (vs. in-memory only). */
  get durable(): boolean {
    return this.store !== undefined;
  }

  async check(tenant: string | undefined): Promise<BudgetDecision> {
    const key = tenant ?? "default";
    if (this.cap <= 0) {
      return { allowed: true, spent: 0, cap: this.cap };
    }
    if (this.store === undefined) {
      return this.mem.check(key);
    }
    try {
      const spent = await this.store.getWindowSpend(key);
      return { allowed: spent < this.cap, spent, cap: this.cap };
    } catch (err) {
      // Fail OPEN on a store outage so a database blip never blocks traffic.
      this.logger?.warn("Budget check failed — allowing request (fail-open)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { allowed: true, spent: 0, cap: this.cap };
    }
  }

  record(
    tenant: string | undefined,
    amount: number,
    detail?: CostDetail,
  ): void {
    if (amount <= 0) return;
    const key = tenant ?? "default";
    // Always update the in-memory mirror (fast snapshot + no-store fallback).
    this.mem.record(key, amount, detail);
    // Write through to durable storage without blocking the hot path.
    if (this.store !== undefined) {
      void this.store.record(key, amount, detail).catch((err) => {
        this.logger?.warn("Failed to persist cost entry", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async snapshot(): Promise<TenantSpendSummary[]> {
    if (this.store === undefined) {
      return this.mem.snapshot();
    }
    try {
      const rows = await this.store.snapshot();
      return rows.map((r) => ({
        tenant: r.tenant,
        spent: r.spent,
        cap: this.cap,
        resetAt: Date.now() + COST_WINDOW_MS,
      }));
    } catch (err) {
      this.logger?.warn("Budget snapshot failed; using in-memory mirror", {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.mem.snapshot();
    }
  }

  /** Per-user spend snapshot (durable when DB-backed, else in-memory mirror). */
  async snapshotByUser(): Promise<UserSpendSummary[]> {
    if (this.store === undefined) {
      return this.mem.snapshotByUser();
    }
    try {
      return await this.store.snapshotByUser();
    } catch (err) {
      this.logger?.warn(
        "Per-user spend snapshot failed; using in-memory mirror",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return this.mem.snapshotByUser();
    }
  }

  /**
   * Daily spend series for one tenant, oldest first. `undefined` when no
   * durable store is configured (the in-memory tracker keeps only a single
   * rolling-window total, not day-bucketed history) — callers treat this as
   * "forecast unavailable" rather than a zero/empty trend.
   */
  async dailySeries(
    tenant: string,
    days: number,
  ): Promise<Array<{ day: string; cost: number }> | undefined> {
    if (this.store?.dailySeries === undefined) return undefined;
    try {
      return await this.store.dailySeries(tenant, days);
    } catch (err) {
      this.logger?.warn("Daily spend series query failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Per-flow spend snapshot (durable when DB-backed, else in-memory mirror). */
  async snapshotByFlow(): Promise<FlowSpendSummary[]> {
    if (this.store === undefined) {
      return this.mem.snapshotByFlow();
    }
    try {
      return await this.store.snapshotByFlow();
    } catch (err) {
      this.logger?.warn(
        "Per-flow spend snapshot failed; using in-memory mirror",
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return this.mem.snapshotByFlow();
    }
  }

  stop(): void {
    this.mem.stop();
  }
}

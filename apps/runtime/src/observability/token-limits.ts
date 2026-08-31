// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Configurable token limits + usage analytics (`src/observability/token-limits.ts`).
 *
 * Two concerns live here:
 *
 *  1. {@link TokenLimitStore} — CRUD for operator-configured limit rules. A rule
 *     caps total tokens (prompt+completion) for a scope (global / a user / a
 *     flow), optionally narrowed to a single model, over a rolling period
 *     (day/week/month). Persisted in `token_limits` (durable) or in memory.
 *
 *  2. {@link UsageAnalytics} — read-only aggregation over `cost_ledger`. Powers
 *     both the per-limit consumption view (how much of each limit is used in its
 *     window) and a free-range time-series (tokens/cost bucketed by hour/day/week).
 *
 * These are OPERATOR-PLANE reads/writes: the usage aggregation spans tenants by
 * design (like {@link PostgresCostStore.snapshot}) and, under enforced RLS, must
 * run via a BYPASSRLS role (see docs/adr/0005-tenant-data-isolation.md).
 *
 * Enforcement (blocking a request once a limit is hit) is intentionally NOT done
 * here — this module only configures and reports. The data model is ready for a
 * future enforcement pass.
 */

import crypto from "node:crypto";
import type { Database } from "../db/database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rolling window a limit is measured over. */
export type LimitPeriod = "day" | "week" | "month";
/** What a limit applies to. */
export type LimitScopeType = "global" | "user" | "flow";
/** Time-series bucket granularity. */
export type UsageBucket = "hour" | "day" | "week";

/** Rolling window length per period, in milliseconds. */
const PERIOD_MS: Record<LimitPeriod, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
};

const LIMIT_PERIODS: readonly LimitPeriod[] = ["day", "week", "month"];
const LIMIT_SCOPES: readonly LimitScopeType[] = ["global", "user", "flow"];
const USAGE_BUCKETS: readonly UsageBucket[] = ["hour", "day", "week"];

export function isLimitPeriod(v: unknown): v is LimitPeriod {
  return (
    typeof v === "string" && (LIMIT_PERIODS as readonly string[]).includes(v)
  );
}
export function isLimitScopeType(v: unknown): v is LimitScopeType {
  return (
    typeof v === "string" && (LIMIT_SCOPES as readonly string[]).includes(v)
  );
}
export function isUsageBucket(v: unknown): v is UsageBucket {
  return (
    typeof v === "string" && (USAGE_BUCKETS as readonly string[]).includes(v)
  );
}

/** Start of the rolling window for a period, measured back from `now`. */
export function periodWindowStart(
  period: LimitPeriod,
  now: number = Date.now(),
): Date {
  return new Date(now - PERIOD_MS[period]);
}

/** A configured limit rule. */
export interface TokenLimit {
  id: string;
  scopeType: LimitScopeType;
  /** user_id / flow_id the limit applies to; null for a global limit. */
  scopeId: string | null;
  /** Model the limit applies to; null = all models. */
  model: string | null;
  period: LimitPeriod;
  /** Max total tokens (prompt+completion) allowed in the window. */
  limitTokens: number;
  createdAt: string;
  updatedAt: string;
}

/** Fields accepted when creating/updating a limit. */
export interface TokenLimitInput {
  scopeType: LimitScopeType;
  scopeId?: string | null;
  model?: string | null;
  period: LimitPeriod;
  limitTokens: number;
}

/** Summed token/cost usage. */
export interface TokenUsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/** A limit paired with its current consumption in the period window. */
export interface LimitConsumption extends TokenLimit {
  used: TokenUsageTotals;
  /** used.totalTokens / limitTokens (0 when the limit is 0). May exceed 1. */
  usedFraction: number;
  /** ISO start of the rolling window the usage was summed over. */
  windowStart: string;
}

/** One point of a usage time-series. */
export interface UsageSeriesPoint {
  /** ISO timestamp of the bucket start. */
  bucket: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/** Narrows a usage aggregation to a scope/model. */
export interface UsageFilter {
  scopeType?: LimitScopeType;
  scopeId?: string | null;
  model?: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates + normalises raw input into a {@link TokenLimitInput}. */
export function parseLimitInput(
  raw: unknown,
): { ok: true; value: TokenLimitInput } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const r = raw as Record<string, unknown>;
  if (!isLimitScopeType(r.scopeType)) {
    return { ok: false, error: "scopeType must be one of global|user|flow." };
  }
  if (!isLimitPeriod(r.period)) {
    return { ok: false, error: "period must be one of day|week|month." };
  }
  const scopeType = r.scopeType;
  const period = r.period;

  // Scoped limits need a scopeId; a global limit must not carry one.
  const rawScopeId = r.scopeId;
  let scopeId: string | null = null;
  if (scopeType === "global") {
    scopeId = null;
  } else {
    if (typeof rawScopeId !== "string" || rawScopeId.trim() === "") {
      return {
        ok: false,
        error: `scopeId is required for a ${scopeType} limit.`,
      };
    }
    scopeId = rawScopeId.trim();
  }

  const rawModel = r.model;
  const model =
    rawModel === undefined || rawModel === null || rawModel === ""
      ? null
      : typeof rawModel === "string"
        ? rawModel.trim()
        : null;

  const limitTokens = Number(r.limitTokens);
  if (!Number.isFinite(limitTokens) || limitTokens <= 0) {
    return { ok: false, error: "limitTokens must be a positive number." };
  }

  return {
    ok: true,
    value: {
      scopeType,
      scopeId,
      model,
      period,
      limitTokens: Math.floor(limitTokens),
    },
  };
}

// ---------------------------------------------------------------------------
// Limit store
// ---------------------------------------------------------------------------

/** CRUD contract for limit rules. */
export interface TokenLimitStore {
  list(): Promise<TokenLimit[]>;
  /** Creates a rule, or updates the existing rule for the same combo (upsert). */
  upsert(input: TokenLimitInput): Promise<TokenLimit>;
  /** Updates a rule by id. Returns null when the id is unknown. */
  update(id: string, input: TokenLimitInput): Promise<TokenLimit | null>;
  /** Deletes a rule by id. Returns false when the id is unknown. */
  remove(id: string): Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Same-combo check (NULL-safe), used by the in-memory upsert. */
function sameCombo(
  a: TokenLimit | (TokenLimit & object),
  b: TokenLimitInput,
): boolean {
  return (
    a.scopeType === b.scopeType &&
    (a.scopeId ?? null) === (b.scopeId ?? null) &&
    (a.model ?? null) === (b.model ?? null) &&
    a.period === b.period
  );
}

/** In-memory limit store (dev / no-DB). Config is lost on restart. */
export class InMemoryTokenLimitStore implements TokenLimitStore {
  private readonly byId = new Map<string, TokenLimit>();

  async list(): Promise<TokenLimit[]> {
    return [...this.byId.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : -1,
    );
  }

  async upsert(input: TokenLimitInput): Promise<TokenLimit> {
    for (const existing of this.byId.values()) {
      if (sameCombo(existing, input)) {
        const updated: TokenLimit = {
          ...existing,
          limitTokens: input.limitTokens,
          updatedAt: nowIso(),
        };
        this.byId.set(existing.id, updated);
        return updated;
      }
    }
    const ts = nowIso();
    const limit: TokenLimit = {
      id: crypto.randomUUID(),
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      model: input.model ?? null,
      period: input.period,
      limitTokens: input.limitTokens,
      createdAt: ts,
      updatedAt: ts,
    };
    this.byId.set(limit.id, limit);
    return limit;
  }

  async update(id: string, input: TokenLimitInput): Promise<TokenLimit | null> {
    const existing = this.byId.get(id);
    if (existing === undefined) return null;
    const updated: TokenLimit = {
      ...existing,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      model: input.model ?? null,
      period: input.period,
      limitTokens: input.limitTokens,
      updatedAt: nowIso(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

interface LimitRow {
  id: string;
  scope_type: string;
  scope_id: string | null;
  model: string | null;
  period: string;
  limit_tokens: number | string;
  created_at: string | Date;
  updated_at: string | Date;
}

function rowToLimit(r: LimitRow): TokenLimit {
  return {
    id: r.id,
    scopeType: r.scope_type as LimitScopeType,
    scopeId: r.scope_id,
    model: r.model,
    period: r.period as LimitPeriod,
    limitTokens: Number(r.limit_tokens),
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt:
      r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

/** Postgres-backed durable limit store. */
export class PostgresTokenLimitStore implements TokenLimitStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<TokenLimit[]> {
    const rows = await this.db.query<LimitRow>(
      `SELECT id, scope_type, scope_id, model, period, limit_tokens, created_at, updated_at
         FROM token_limits
        ORDER BY scope_type, scope_id NULLS FIRST, model NULLS FIRST, period`,
    );
    return rows.map(rowToLimit);
  }

  async upsert(input: TokenLimitInput): Promise<TokenLimit> {
    // Find an existing rule for the same combo (NULL-safe) and update it,
    // otherwise insert. Two statements, but limit writes are rare and this
    // avoids ON CONFLICT against an expression index.
    const existing = await this.db.query<LimitRow>(
      `SELECT id, scope_type, scope_id, model, period, limit_tokens, created_at, updated_at
         FROM token_limits
        WHERE scope_type = $1
          AND scope_id IS NOT DISTINCT FROM $2
          AND model IS NOT DISTINCT FROM $3
          AND period = $4`,
      [
        input.scopeType,
        input.scopeId ?? null,
        input.model ?? null,
        input.period,
      ],
    );
    const found = existing[0];
    if (found !== undefined) {
      const updated = await this.update(found.id, input);
      // update() only returns null on a concurrent delete; fall through to insert.
      if (updated !== null) return updated;
    }
    const id = crypto.randomUUID();
    const rows = await this.db.query<LimitRow>(
      `INSERT INTO token_limits (id, scope_type, scope_id, model, period, limit_tokens)
         VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, scope_type, scope_id, model, period, limit_tokens, created_at, updated_at`,
      [
        id,
        input.scopeType,
        input.scopeId ?? null,
        input.model ?? null,
        input.period,
        input.limitTokens,
      ],
    );
    const row = rows[0];
    if (row === undefined) {
      // Unreachable: the INSERT ... RETURNING above always yields one row.
      throw new Error("Failed to read back newly created token limit.");
    }
    return rowToLimit(row);
  }

  async update(id: string, input: TokenLimitInput): Promise<TokenLimit | null> {
    const rows = await this.db.query<LimitRow>(
      `UPDATE token_limits
          SET scope_type = $2, scope_id = $3, model = $4, period = $5,
              limit_tokens = $6, updated_at = now()
        WHERE id = $1
       RETURNING id, scope_type, scope_id, model, period, limit_tokens, created_at, updated_at`,
      [
        id,
        input.scopeType,
        input.scopeId ?? null,
        input.model ?? null,
        input.period,
        input.limitTokens,
      ],
    );
    return rows[0] !== undefined ? rowToLimit(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM token_limits WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Usage analytics (aggregation over cost_ledger)
// ---------------------------------------------------------------------------

/** Read-only token/cost aggregation for the dashboard. */
/** Per-model token/cost breakdown, keyed by "<provider>/<model>". */
export interface ModelUsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface UsageAnalytics {
  /** Sum of usage matching `filter` since `sinceIso` (and before `untilIso`). */
  totals(
    filter: UsageFilter,
    sinceIso: string,
    untilIso?: string,
  ): Promise<TokenUsageTotals>;
  /** Bucketed time-series over a free [from, to) range. */
  series(
    opts: { fromIso: string; toIso: string; bucket: UsageBucket } & UsageFilter,
  ): Promise<UsageSeriesPoint[]>;
  /** Distinct model names seen in the ledger (for the model picker). */
  distinctModels(): Promise<string[]>;
  /**
   * Per-model token/cost totals since `sinceIso`, keyed by "<provider>/<model>".
   * Durable (survives restarts, shared cluster-wide) — the source the dashboard
   * should prefer over the in-memory-only `Metrics.summary()` breakdown, which
   * resets on restart and does not aggregate across replicas.
   */
  byModel(sinceIso: string): Promise<Record<string, ModelUsageBreakdown>>;
}

function num(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Appends scope/model predicates to a WHERE clause, pushing bound params.
 * `user`/`flow` scopes filter by the matching column; `global` adds nothing.
 */
function appendFilter(filter: UsageFilter, params: unknown[]): string {
  const clauses: string[] = [];
  if (
    filter.scopeType === "user" &&
    filter.scopeId != null &&
    filter.scopeId !== ""
  ) {
    params.push(filter.scopeId);
    clauses.push(`user_id = $${params.length}`);
  }
  if (
    filter.scopeType === "flow" &&
    filter.scopeId != null &&
    filter.scopeId !== ""
  ) {
    params.push(filter.scopeId);
    clauses.push(`flow_id = $${params.length}`);
  }
  if (filter.model != null && filter.model !== "") {
    params.push(filter.model);
    clauses.push(`model = $${params.length}`);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

interface TotalsRow {
  p: number | string | null;
  c: number | string | null;
  cost: number | string | null;
}

/** Postgres implementation over `cost_ledger`. */
export class PostgresUsageAnalytics implements UsageAnalytics {
  constructor(private readonly db: Database) {}

  async totals(
    filter: UsageFilter,
    sinceIso: string,
    untilIso?: string,
  ): Promise<TokenUsageTotals> {
    const params: unknown[] = [sinceIso];
    let where = `created_at >= $1`;
    if (untilIso !== undefined) {
      params.push(untilIso);
      where += ` AND created_at < $${params.length}`;
    }
    where += appendFilter(filter, params);
    const rows = await this.db.query<TotalsRow>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS p,
              COALESCE(SUM(completion_tokens), 0) AS c,
              COALESCE(SUM(cost), 0) AS cost
         FROM cost_ledger
        WHERE ${where}`,
      params,
    );
    const r = rows[0];
    const promptTokens = num(r?.p);
    const completionTokens = num(r?.c);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cost: num(r?.cost),
    };
  }

  async series(
    opts: { fromIso: string; toIso: string; bucket: UsageBucket } & UsageFilter,
  ): Promise<UsageSeriesPoint[]> {
    // bucket is validated by the caller against the UsageBucket allowlist, so
    // it is safe to bind as date_trunc's first argument.
    const params: unknown[] = [opts.bucket, opts.fromIso, opts.toIso];
    let where = `created_at >= $2 AND created_at < $3`;
    where += appendFilter(opts, params);
    const rows = await this.db.query<{ ts: string | Date } & TotalsRow>(
      `SELECT date_trunc($1, created_at) AS ts,
              COALESCE(SUM(prompt_tokens), 0) AS p,
              COALESCE(SUM(completion_tokens), 0) AS c,
              COALESCE(SUM(cost), 0) AS cost
         FROM cost_ledger
        WHERE ${where}
        GROUP BY ts
        ORDER BY ts ASC`,
      params,
    );
    return rows.map((r) => {
      const promptTokens = num(r.p);
      const completionTokens = num(r.c);
      return {
        bucket: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cost: num(r.cost),
      };
    });
  }

  async distinctModels(): Promise<string[]> {
    const rows = await this.db.query<{ model: string }>(
      `SELECT DISTINCT model FROM cost_ledger
        WHERE model IS NOT NULL AND model <> ''
        ORDER BY model`,
    );
    return rows.map((r) => r.model);
  }

  async byModel(sinceIso: string): Promise<Record<string, ModelUsageBreakdown>> {
    const rows = await this.db.query<{
      provider: string | null;
      model: string | null;
      p: number | string | null;
      c: number | string | null;
      cost: number | string | null;
    }>(
      `SELECT provider, model,
              COALESCE(SUM(prompt_tokens), 0) AS p,
              COALESCE(SUM(completion_tokens), 0) AS c,
              COALESCE(SUM(cost), 0) AS cost
         FROM cost_ledger
        WHERE created_at >= $1 AND model IS NOT NULL AND model <> ''
        GROUP BY provider, model`,
      [sinceIso],
    );
    const out: Record<string, ModelUsageBreakdown> = {};
    for (const r of rows) {
      const key = r.provider ? `${r.provider}/${r.model}` : String(r.model);
      out[key] = {
        promptTokens: num(r.p),
        completionTokens: num(r.c),
        cost: num(r.cost),
      };
    }
    return out;
  }
}

/** No-data analytics used when no database is configured. */
export class EmptyUsageAnalytics implements UsageAnalytics {
  async totals(): Promise<TokenUsageTotals> {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
  }
  async series(): Promise<UsageSeriesPoint[]> {
    return [];
  }
  async distinctModels(): Promise<string[]> {
    return [];
  }
  async byModel(): Promise<Record<string, ModelUsageBreakdown>> {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Service — limits + their current consumption
// ---------------------------------------------------------------------------

/** Combines the limit store with usage analytics for the dashboard. */
export class TokenLimitService {
  constructor(
    readonly store: TokenLimitStore,
    readonly analytics: UsageAnalytics,
  ) {}

  /** Every configured limit paired with its consumption in its period window. */
  async listWithConsumption(): Promise<LimitConsumption[]> {
    const limits = await this.store.list();
    const now = Date.now();
    return Promise.all(
      limits.map(async (limit) => {
        const windowStart = periodWindowStart(limit.period, now);
        const used = await this.analytics.totals(
          {
            scopeType: limit.scopeType,
            scopeId: limit.scopeId,
            model: limit.model,
          },
          windowStart.toISOString(),
        );
        const usedFraction =
          limit.limitTokens > 0 ? used.totalTokens / limit.limitTokens : 0;
        return {
          ...limit,
          used,
          usedFraction,
          windowStart: windowStart.toISOString(),
        };
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/** Identity of the request being admitted, for limit matching. */
export interface EnforcementRequest {
  userId?: string | undefined;
  flowId?: string | undefined;
  /**
   * Models the request may use (from the flow definition). Model-specific
   * limits are only enforced when the model is in this set; omit/empty to
   * enforce model-agnostic limits only.
   */
  models?: readonly string[];
}

/** A limit that blocked a request, with the numbers behind the decision. */
export interface LimitViolation {
  limit: TokenLimit;
  usedTokens: number;
  limitTokens: number;
  windowStart: string;
}

/**
 * Admission-time enforcement of configured token limits — the write-side twin
 * of {@link TokenLimitService}. Semantics mirror {@link BudgetService}:
 *
 *  - SOFT: checked once at admission, so a single in-flight request may push a
 *    scope slightly over its limit; it never interrupts an admitted run.
 *  - FAIL-OPEN: any error computing consumption admits the request (a metrics/DB
 *    blip must never block traffic).
 *
 * A limit applies to a request when its scope matches (global, or user/flow with
 * the matching id) AND its model is either "all" (null) or one of the request's
 * candidate {@link EnforcementRequest.models}.
 */
export class TokenLimitEnforcer {
  constructor(private readonly service: TokenLimitService) {}

  /** Whether any limit exists at all (lets callers skip the check cheaply). */
  private async hasAnyLimit(): Promise<boolean> {
    const limits = await this.service.store.list();
    return limits.length > 0;
  }

  /**
   * Returns the first fully-consumed limit that applies to the request, or null
   * when the request is within every applicable limit (or none is configured).
   */
  async check(request: EnforcementRequest): Promise<LimitViolation | null> {
    if (!(await this.hasAnyLimit())) return null;
    const consumptions = await this.service.listWithConsumption();
    for (const c of consumptions) {
      if (!scopeApplies(c, request)) continue;
      if (c.model !== null && !(request.models ?? []).includes(c.model))
        continue;
      if (c.limitTokens > 0 && c.used.totalTokens >= c.limitTokens) {
        return {
          limit: {
            id: c.id,
            scopeType: c.scopeType,
            scopeId: c.scopeId,
            model: c.model,
            period: c.period,
            limitTokens: c.limitTokens,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
          },
          usedTokens: c.used.totalTokens,
          limitTokens: c.limitTokens,
          windowStart: c.windowStart,
        };
      }
    }
    return null;
  }
}

/** Whether a limit's scope matches the request identity. */
function scopeApplies(
  limit: Pick<TokenLimit, "scopeType" | "scopeId">,
  request: EnforcementRequest,
): boolean {
  switch (limit.scopeType) {
    case "global":
      return true;
    case "user":
      return request.userId !== undefined && limit.scopeId === request.userId;
    case "flow":
      return request.flowId !== undefined && limit.scopeId === request.flowId;
  }
}

/** A human-readable one-line description of a limit (for error messages/logs). */
export function describeLimit(limit: TokenLimit): string {
  const scope =
    limit.scopeType === "global"
      ? "global"
      : `${limit.scopeType} '${limit.scopeId ?? ""}'`;
  const model = limit.model === null ? "all models" : `model '${limit.model}'`;
  return `${scope} · ${model} · per ${limit.period}`;
}

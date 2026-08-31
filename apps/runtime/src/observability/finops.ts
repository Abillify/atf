// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FinOps forecasting + CO2/ESG accounting (`src/observability/finops.ts`)
 *
 * Two complementary reports that turn the existing cost ledger into forward-
 * looking and sustainability evidence, without adding a new hot-path write:
 *
 *   - {@link forecastBudget} — per-tenant burn-rate forecast. The platform
 *     already tracks a rolling-window spend total and a daily cap
 *     (`BudgetService`/`CostTracker`), but that only answers "how much has
 *     been spent" — not "when will the cap run out at the current rate". This
 *     fits a simple linear trend over the tenant's recent daily spend
 *     ({@link CostStore.dailySeries}) and projects the day the cap would be
 *     exhausted, so an operator gets a warning before the 402 does.
 *
 *   - {@link estimateCo2 } / {@link co2Report} — per-model CO2e estimate.
 *     Token usage already flows through a per-model pricing table
 *     (`resolveModelPrice`); this mirrors that pattern with an energy-per-
 *     1k-tokens factor (kWh) times a configurable grid carbon intensity
 *     (kg CO2e / kWh), so "$/tenant" gets an "kg CO2e/tenant" sibling for EU
 *     B2B ESG/CSRD reporting — a report most AI-gateway competitors don't
 *     offer at all.
 *
 * Both are pure, injectable, and unit-testable — no I/O beyond the data
 * already read by the caller (a {@link CostStore}/{@link BudgetService}
 * daily series, or a token-usage breakdown the caller already has).
 *
 * No `any` at module boundaries.
 */

import type { BudgetService } from "./cost.js";

// ---------------------------------------------------------------------------
// Budget burn-rate forecast
// ---------------------------------------------------------------------------

/** One point of a tenant's daily spend history (oldest first). */
export interface DailySpendPoint {
  /** ISO date (YYYY-MM-DD). */
  day: string;
  cost: number;
}

export interface BudgetForecast {
  tenant: string;
  /** Configured daily cap for this tenant (0 = unlimited / not applicable). */
  capPerDay: number;
  /** Current rolling-window spend (same figure `BudgetService.check` reports). */
  currentSpend: number;
  /**
   * Recent average daily spend LEVEL ($/day) over the supplied series — i.e.
   * how much is actually being burned per day, NOT how fast that figure is
   * changing. This is the number compared against `capPerDay`.
   */
  dailyBurnRate: number;
  /**
   * Day-over-day TREND in daily spend ($/day²): positive = spend rising,
   * ≤ 0 = flat or falling. Used to project when a rising level crosses the cap.
   */
  dailyTrend: number;
  /**
   * Estimated calendar days until a single day's spend is projected to reach
   * the cap. Present when the cap is not yet reached but an upward trend will
   * cross it (or 0 when the current level already meets/exceeds the cap).
   * `undefined` when there is no cap, no upward trend below the cap, or too
   * little history (see {@link BudgetForecast.status}).
   */
  daysToExhaustion?: number;
  /** ISO date the cap is projected to be reached, when {@link daysToExhaustion} is set. */
  projectedExhaustionDate?: string;
  /**
   * `unbounded`    — no cap configured, forecasting is not applicable.
   * `insufficient_data` — fewer than `minDays` days of history.
   * `at_risk`      — the daily spend already meets/exceeds a large fraction of
   *                   the cap, OR a rising trend is projected to cross the cap
   *                   within `atRiskWindowDays`.
   * `on_track`     — a cap exists and spend is rising, but is projected to cross
   *                   the cap only beyond the at-risk window.
   * `stable`       — spend is flat or falling and comfortably below the cap.
   */
  status: "unbounded" | "insufficient_data" | "stable" | "at_risk" | "on_track";
}

export interface ForecastOptions {
  /** Minimum days of history required to forecast. Default 3. */
  minDays?: number;
  /** Days ahead within which a projected cap crossing is flagged "at_risk". Default 3. */
  atRiskWindowDays?: number;
  /**
   * Fraction of the cap at/above which a FLAT (non-rising) daily spend is
   * already treated as `at_risk` — catches the "spending near the cap every
   * day, but not increasing" case a slope-only model would miss. Default 0.9.
   */
  nearCapFraction?: number;
}

const DEFAULT_MIN_DAYS = 3;
const DEFAULT_AT_RISK_WINDOW_DAYS = 3;
const DEFAULT_NEAR_CAP_FRACTION = 0.9;

/** Arithmetic mean of the daily spend levels in a series. */
function meanDailySpend(points: readonly DailySpendPoint[]): number {
  if (points.length === 0) return 0;
  const total = points.reduce((s, p) => s + p.cost, 0);
  return total / points.length;
}

/**
 * Ordinary-least-squares slope of `points` (cost per day) — a simple linear
 * trend fit, deliberately unweighted and unsmoothed. This is a forecasting
 * HINT, not a guarantee: a single anomalous day (see `costAnomaly*` config
 * elsewhere in the platform) can swing the slope. Pure function.
 */
export function linearTrendSlope(points: readonly DailySpendPoint[]): number {
  const n = points.length;
  if (n < 2) return 0;
  // x = day index (0..n-1); y = cost. Standard OLS slope formula.
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const [i, point] of points.entries()) {
    const y = point.cost;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Builds a {@link BudgetForecast} for one tenant from its daily spend history,
 * current rolling-window spend, and configured cap. Pure — no I/O; the caller
 * fetches `series` (e.g. via {@link BudgetService.dailySeries}) beforehand.
 */
export function forecastBudget(
  tenant: string,
  series: readonly DailySpendPoint[] | undefined,
  currentSpend: number,
  capPerDay: number,
  options: ForecastOptions = {},
): BudgetForecast {
  const minDays = options.minDays ?? DEFAULT_MIN_DAYS;
  const atRiskWindowDays = options.atRiskWindowDays ?? DEFAULT_AT_RISK_WINDOW_DAYS;
  const nearCapFraction = options.nearCapFraction ?? DEFAULT_NEAR_CAP_FRACTION;

  const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

  if (capPerDay <= 0) {
    return {
      tenant,
      capPerDay,
      currentSpend,
      dailyBurnRate: series !== undefined ? round6(meanDailySpend(series)) : 0,
      dailyTrend: series !== undefined ? round6(linearTrendSlope(series)) : 0,
      status: "unbounded",
    };
  }

  if (series === undefined || series.length < minDays) {
    return {
      tenant,
      capPerDay,
      currentSpend,
      dailyBurnRate: 0,
      dailyTrend: 0,
      status: "insufficient_data",
    };
  }

  const dailyBurnRate = round6(meanDailySpend(series));
  const dailyTrend = round6(linearTrendSlope(series));
  // Current daily spend level: prefer the live rolling-24h figure the budget
  // service reports; fall back to the most recent series point.
  const currentLevel =
    currentSpend > 0 ? currentSpend : (series[series.length - 1]?.cost ?? dailyBurnRate);

  const base = { tenant, capPerDay, currentSpend, dailyBurnRate, dailyTrend };

  // Already spending at/over the cap on the current day.
  if (currentLevel >= capPerDay) {
    return {
      ...base,
      daysToExhaustion: 0,
      projectedExhaustionDate: new Date().toISOString().slice(0, 10),
      status: "at_risk",
    };
  }

  if (dailyTrend <= 0) {
    // Flat or declining. A flat spend sitting near the cap is still a risk a
    // slope-only model would miss — flag it; otherwise it is genuinely stable.
    return {
      ...base,
      status: dailyBurnRate >= capPerDay * nearCapFraction ? "at_risk" : "stable",
    };
  }

  // Rising trend below the cap — project when the daily level crosses it.
  const daysToExhaustion =
    Math.round(((capPerDay - currentLevel) / dailyTrend) * 100) / 100;
  const projected = new Date(Date.now() + daysToExhaustion * 86_400_000);

  return {
    ...base,
    daysToExhaustion,
    projectedExhaustionDate: projected.toISOString().slice(0, 10),
    status: daysToExhaustion <= atRiskWindowDays ? "at_risk" : "on_track",
  };
}

/**
 * Convenience wrapper that pulls a tenant's daily series + current spend from
 * a {@link BudgetService} and produces a {@link BudgetForecast}. Returns the
 * `insufficient_data`/`unbounded` shape gracefully when the service has no
 * durable daily-series backing (in-memory-only deployment).
 */
export async function forecastTenantBudget(
  budgetService: Pick<BudgetService, "check" | "dailySeries">,
  tenant: string,
  days = 14,
  options?: ForecastOptions,
): Promise<BudgetForecast> {
  const [decision, series] = await Promise.all([
    budgetService.check(tenant),
    budgetService.dailySeries(tenant, days),
  ]);
  return forecastBudget(tenant, series, decision.spent, decision.cap, options);
}

// ---------------------------------------------------------------------------
// CO2 / ESG accounting
// ---------------------------------------------------------------------------

/** Energy + emissions factor for one provider/model. */
export interface EnergyFactor {
  provider: string;
  /** Case-insensitive glob (`*` wildcard) matched against the model id; provider-level rule when omitted. */
  modelPattern?: string;
  /** Estimated energy consumption per 1,000 tokens (prompt+completion combined), in kWh. */
  kwhPer1kTokens: number;
}

/**
 * Built-in energy-per-1k-tokens estimates (kWh), derived from published
 * third-party LLM energy-consumption studies (e.g. Epoch AI / Hugging Face
 * ML CO2 impact estimates for comparably-sized dense and MoE transformer
 * models serving a typical chat-length request). These are ORDER-OF-MAGNITUDE
 * estimates, not measured values for any specific deployment or hardware —
 * override with `CO2_ENERGY_FACTORS` when a provider publishes its own figures
 * (e.g. Google's or Microsoft's per-query energy disclosures) or your own
 * infrastructure telemetry is available. Local models default to a
 * conservative on-prem GPU estimate; unknown models fall back to a mid-size
 * default rather than zero, so a forgotten factor does not silently
 * under-report.
 */
const DEFAULT_ENERGY_FACTORS: readonly EnergyFactor[] = [
  // Large flagship models — higher parameter count, higher energy/token.
  { provider: "openai", modelPattern: "*gpt-4o*", kwhPer1kTokens: 0.004 },
  { provider: "openai", modelPattern: "*gpt-4.1*", kwhPer1kTokens: 0.004 },
  { provider: "openai", modelPattern: "*o3*", kwhPer1kTokens: 0.006 },
  { provider: "openai", modelPattern: "*mini*", kwhPer1kTokens: 0.0015 },
  { provider: "openai", modelPattern: "*nano*", kwhPer1kTokens: 0.0008 },
  { provider: "anthropic", modelPattern: "*opus*", kwhPer1kTokens: 0.006 },
  { provider: "anthropic", modelPattern: "*sonnet*", kwhPer1kTokens: 0.004 },
  { provider: "anthropic", modelPattern: "*haiku*", kwhPer1kTokens: 0.0015 },
  { provider: "bedrock", modelPattern: "*opus*", kwhPer1kTokens: 0.006 },
  { provider: "bedrock", modelPattern: "*sonnet*", kwhPer1kTokens: 0.004 },
  { provider: "bedrock", modelPattern: "*haiku*", kwhPer1kTokens: 0.0015 },
  { provider: "google", modelPattern: "*pro*", kwhPer1kTokens: 0.004 },
  { provider: "google", modelPattern: "*flash*", kwhPer1kTokens: 0.0012 },
  // Local inference — no network hop, but the GPU still draws power. A
  // conservative on-prem estimate for a consumer/prosumer GPU serving a
  // small-to-mid local model.
  { provider: "ollama", kwhPer1kTokens: 0.001 },
  // Azure deployment names are arbitrary — no default; operators should set
  // CO2_ENERGY_FACTORS for their deployments, mirroring the LLM_PRICING pattern.
];

/** Fallback for a provider/model with no matching rule (mid-size estimate). */
const UNKNOWN_MODEL_KWH_PER_1K_TOKENS = 0.003;

/** Compiles a `*`-glob to a case-insensitive full-match RegExp (mirrors model-capabilities.ts). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Resolves the effective kWh/1k-tokens factor for a (provider, model) pair.
 * Provider-level rules apply first; a matching model-glob rule overrides it
 * (later declaration wins on tie, same convention as `getModelCapabilities`).
 * Falls back to {@link UNKNOWN_MODEL_KWH_PER_1K_TOKENS} for anything unmatched.
 */
export function resolveEnergyFactor(
  provider: string,
  model: string,
  overrides?: readonly EnergyFactor[],
): number {
  const table = [...DEFAULT_ENERGY_FACTORS, ...(overrides ?? [])];
  let factor: number | undefined;
  for (const rule of table) {
    if (rule.provider !== provider) continue;
    if (
      rule.modelPattern !== undefined &&
      !globToRegExp(rule.modelPattern).test(model)
    )
      continue;
    factor = rule.kwhPer1kTokens;
  }
  return factor ?? UNKNOWN_MODEL_KWH_PER_1K_TOKENS;
}

export interface Co2EstimateOptions {
  /** kg CO2e emitted per kWh of grid electricity. Default 0.4 (rough global-average grid mix). */
  gridCarbonIntensity?: number;
  /** Additional/override energy factors, checked after the built-in table. */
  energyFactors?: readonly EnergyFactor[];
}

const DEFAULT_GRID_CARBON_INTENSITY = 0.4; // kg CO2e / kWh — conservative global-average estimate

/**
 * Estimates the kg CO2e emitted for one model call given its token usage.
 * `estimatedKwh` is exposed alongside `estimatedKgCo2e` so a deployment with
 * its own (lower) grid intensity — e.g. a data-center on a renewables-heavy
 * grid — can re-derive the emissions figure without re-running the token math.
 */
export function estimateCo2(
  provider: string,
  model: string,
  usage: { promptTokens: number; completionTokens: number },
  options: Co2EstimateOptions = {},
): { estimatedKwh: number; estimatedKgCo2e: number } {
  const totalTokens = usage.promptTokens + usage.completionTokens;
  const kwhPer1k = resolveEnergyFactor(provider, model, options.energyFactors);
  const estimatedKwh = Math.round((totalTokens / 1000) * kwhPer1k * 1_000_000) / 1_000_000;
  const gridIntensity =
    options.gridCarbonIntensity ?? DEFAULT_GRID_CARBON_INTENSITY;
  const estimatedKgCo2e = Math.round(estimatedKwh * gridIntensity * 1_000_000) / 1_000_000;
  return { estimatedKwh, estimatedKgCo2e };
}

/** Per-model CO2 breakdown row for a reporting window. */
export interface ModelCo2Row {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedKwh: number;
  estimatedKgCo2e: number;
}

/** Aggregate CO2 report over a set of per-model usage totals. */
export interface Co2Report {
  gridCarbonIntensity: number;
  totalEstimatedKwh: number;
  totalEstimatedKgCo2e: number;
  byModel: ModelCo2Row[];
  /**
   * Human-scale equivalence for the total emissions figure (e.g. "≈ N km
   * driven in an average passenger car"), so a raw kg CO2e number has an
   * intuitive anchor for a non-specialist reader of the compliance dossier.
   * Uses a widely cited ~0.12 kg CO2e/km passenger-car average.
   */
  carKmEquivalent: number;
}

const CAR_KG_CO2E_PER_KM = 0.12;

/**
 * Builds a full CO2 report from a per-model usage breakdown (the same shape
 * `UsageAnalytics.byModel()` / `Metrics.summary().tokensByModel` already
 * produce), so this can sit directly alongside the existing cost breakdown
 * on the Cost & Tokens dashboard.
 */
export function co2Report(
  usageByModel: Record<
    string,
    { promptTokens: number; completionTokens: number }
  >,
  options: Co2EstimateOptions = {},
): Co2Report {
  const rows: ModelCo2Row[] = [];
  let totalKwh = 0;
  let totalKg = 0;
  for (const [key, usage] of Object.entries(usageByModel)) {
    const slash = key.indexOf("/");
    const provider = slash > 0 ? key.slice(0, slash) : "unknown";
    const model = slash > 0 ? key.slice(slash + 1) : key;
    const { estimatedKwh, estimatedKgCo2e } = estimateCo2(
      provider,
      model,
      usage,
      options,
    );
    totalKwh += estimatedKwh;
    totalKg += estimatedKgCo2e;
    rows.push({
      provider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimatedKwh,
      estimatedKgCo2e,
    });
  }
  return {
    gridCarbonIntensity:
      options.gridCarbonIntensity ?? DEFAULT_GRID_CARBON_INTENSITY,
    totalEstimatedKwh: Math.round(totalKwh * 1_000_000) / 1_000_000,
    totalEstimatedKgCo2e: Math.round(totalKg * 1_000_000) / 1_000_000,
    byModel: rows.sort((a, b) => b.estimatedKgCo2e - a.estimatedKgCo2e),
    carKmEquivalent: Math.round((totalKg / CAR_KG_CO2E_PER_KM) * 10) / 10,
  };
}

# 18. FinOps budget forecasting + CO2/ESG accounting

Date: 2026-07-20

## Status

Accepted

## Context

The platform's cost machinery (`BudgetService`, `CostTracker`, `cost_ledger`)
already answers "how much has this tenant spent" via a rolling 24h window sum
against a daily cap. It does not answer "at the current rate, when will the
cap run out" — an operator only finds out a tenant is about to be cut off when
the `402` actually fires. Separately, the platform tracks $/token cost per
model but has no notion of energy or emissions at all, even though EU B2B
customers increasingly need a CO2/ESG figure alongside a cost figure for
CSRD/ESG reporting — and no AI-gateway competitor bundles this today.

## Decision

Add `src/observability/finops.ts` with two independent, pure, unit-tested
capabilities, exposed via `src/routes/finops.ts` at `/admin/finops/*`
(`monitoring:read`):

1. **Budget burn-rate forecast** (`forecastBudget` / `forecastTenantBudget`).
   Reports two distinct figures over a tenant's recent daily spend
   (`CostStore.dailySeries`, a new optional method alongside the existing
   rolling-window `getWindowSpend`): the **level** (`dailyBurnRate` — the mean
   $/day actually being spent) and the **trend** (`dailyTrend` — the
   ordinary-least-squares day-over-day slope). Because the cap is a *rolling
   daily* cap (not a fixed ceiling that spend accumulates toward), the status
   logic checks both: a daily spend already at ≥ 90% of the cap is `at_risk`
   even when flat (the "spending near the cap every day but not increasing"
   case a slope-only model silently misses), while a rising trend below the cap
   is projected forward to the day it would cross. Reports one of five statuses
   (`unbounded`, `insufficient_data`, `stable`, `at_risk`, `on_track`) rather
   than a bare number, so the UI renders a clear signal.

   > An earlier draft used the trend slope *as* the burn rate, which reported a
   > flat-but-high spender as `stable` — a false negative in a budget-warning
   > feature. The level/trend split above is the fix; both are surfaced.

   `dailySeries` is **optional on the `CostStore` interface** and implemented
   only by `PostgresCostStore` — the in-memory `CostTracker` keeps a single
   rolling total, not day-bucketed history, so a deployment without
   `DATABASE_URL` reports `insufficient_data` rather than fabricating a trend
   from one number. This mirrors the existing pattern where several dashboard
   features (usage time-series, audit trail) already require a database for
   their historical view — consistent, not a new class of limitation.

2. **CO2/ESG accounting** (`estimateCo2` / `co2Report`). Deliberately mirrors
   the existing per-model pricing table (`resolveModelPrice` in
   `src/observability/cost.ts`): a static table of `kWh per 1,000 tokens` per
   provider/model (glob-matched, same convention as `getModelCapabilities` in
   `model-capabilities.ts`), multiplied by a configurable grid carbon
   intensity (`kg CO2e / kWh`, default 0.4 — a conservative global-average
   estimate) to produce `estimatedKwh` / `estimatedKgCo2e`. Aggregated from
   the SAME per-model token breakdown the Cost & Tokens dashboard already
   reads (`Metrics.summary().tokensByModel`), so no new metering was added —
   only a new lens on data already collected.

   The built-in energy-factor table is explicitly labelled as
   **order-of-magnitude estimates** derived from published third-party LLM
   energy-consumption studies, not measured values for any specific
   deployment. `CO2_ENERGY_FACTORS` lets an operator override with a
   provider's own disclosed per-query figures or their own infrastructure
   telemetry — same override philosophy as `LLM_PRICING`.

### Why not integrate a real carbon-accounting API (e.g. Electricity Maps)?

Rejected for this iteration: it would add a required third-party network
dependency and API key to get a number at all, when the goal is a
zero-dependency default that a deployment can refine later. The
`CO2_GRID_CARBON_INTENSITY` / `CO2_ENERGY_FACTORS` overrides are the
integration seam for an operator who wants to feed in a live grid-intensity
API's output instead of the static default — without the platform depending
on that API directly.

## Consequences

- **Positive.** Both reports are pure functions over data the platform already
  holds (or, for the daily series, a straightforward new read query) — no new
  hot-path writes, fully unit-tested independent of a live provider or
  network call (`src/observability/__tests__/finops.test.ts`,
  `src/routes/__tests__/finops.test.ts`). Backward compatible — inert unless
  read.
- **Negative / residual.** The burn-rate forecast is a **linear** fit — a
  genuinely non-linear spend pattern (e.g. weekly cyclical traffic) will
  under- or over-project; this is documented as a "hint, not a guarantee" in
  the module doc, same posture as the platform's existing cost-anomaly
  detector. The CO2 figures are estimates with an explicitly labelled margin
  of error; they should not be presented as measured/audited emissions without
  operator-supplied, verified energy factors and grid intensity.
- **No per-tenant CO2 breakdown yet.** `co2Report` aggregates across all
  models platform-wide (matching the existing `Metrics.summary()` scope); a
  per-tenant CO2 breakdown would need per-tenant token-by-model data, which
  the current `UsageAnalytics.byModel()` does not filter by tenant. A natural
  follow-up, not implemented here to keep this change additive and minimal.

## Implementation

- `src/observability/finops.ts` — `linearTrendSlope`, `forecastBudget`,
  `forecastTenantBudget`, `resolveEnergyFactor`, `estimateCo2`, `co2Report`.
- `src/observability/cost.ts` — `CostStore.dailySeries?` (optional),
  `PostgresCostStore.dailySeries`, `BudgetService.dailySeries` /
  `BudgetService.dailyCap`.
- `src/routes/finops.ts` — `GET /admin/finops/forecast/:tenantId`,
  `GET /admin/finops/co2` (`monitoring:read`).
- `src/config/schema.ts` / `load.ts` — `CO2_GRID_CARBON_INTENSITY`,
  `CO2_ENERGY_FACTORS`.
- `src/index.ts` — wires the route off the existing `budgetService` + `metrics`.
- `apps/control/src/components/FinOpsPanel.tsx` — dashboard panel, shown as a
  **FinOps Forecast** tab on `/cost` alongside the existing spend/token
  breakdown.

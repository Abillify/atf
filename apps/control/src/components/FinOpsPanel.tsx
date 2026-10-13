"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FinOpsPanel — budget burn-rate forecast + CO2/ESG accounting.
 *
 * Two sections built on `GET /admin/finops/forecast/:tenantId` and
 * `GET /admin/finops/co2`:
 *   - Burn-rate forecast: pick a tenant, see the projected days until its
 *     daily cap is exhausted at the current spend trend.
 *   - CO2/ESG report: aggregate estimated kWh + kg CO2e across all models
 *     used, with a car-km equivalence for a non-specialist reader.
 *
 * Complements `CostPanel` (which shows past/current spend) with a forward-
 * looking and sustainability view — the FinOps forecasting + CO2/ESG
 * accounting killer feature.
 */

import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { formatCost } from "../lib/currency";
import { authFetch } from "../lib/auth-fetch";
import {
  Badge,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { formatNumber } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Types (mirror src/observability/finops.ts)
// ---------------------------------------------------------------------------

interface BudgetForecast {
  tenant: string;
  capPerDay: number;
  currentSpend: number;
  dailyBurnRate: number;
  dailyTrend: number;
  daysToExhaustion?: number;
  projectedExhaustionDate?: string;
  status: "unbounded" | "insufficient_data" | "stable" | "at_risk" | "on_track";
}

interface ModelCo2Row {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimatedKwh: number;
  estimatedKgCo2e: number;
}

interface Co2Report {
  gridCarbonIntensity: number;
  totalEstimatedKwh: number;
  totalEstimatedKgCo2e: number;
  byModel: ModelCo2Row[];
  carKmEquivalent: number;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchForecast(
  tenantId: string,
  token: string | undefined,
): Promise<BudgetForecast> {
  const res = await authFetch(
    backendUrl(`/admin/finops/forecast/${encodeURIComponent(tenantId)}`),
    token,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { forecast: BudgetForecast };
  return data.forecast;
}

async function fetchCo2Report(token: string | undefined): Promise<Co2Report> {
  const res = await authFetch(backendUrl("/admin/finops/co2"), token);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { report: Co2Report };
  return data.report;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<BudgetForecast["status"], string> = {
  unbounded: "No cap configured",
  insufficient_data: "Insufficient history",
  stable: "Stable / decreasing",
  at_risk: "At risk",
  on_track: "On track",
};

function statusVariant(status: BudgetForecast["status"]): BadgeVariant {
  switch (status) {
    case "at_risk":
      return "destructive";
    case "stable":
    case "unbounded":
      return "success";
    case "on_track":
      return "secondary";
    case "insufficient_data":
    default:
      return "outline";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FinOpsPanel(): React.JSX.Element {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled (no
  // token; the backend serves the operator plane anonymously).
  const { token, ready, isAuthenticated } = useAuth();
  const [tenantId, setTenantId] = useState("default");
  const [submittedTenant, setSubmittedTenant] = useState("default");

  const {
    data: forecast,
    isLoading: loadingForecast,
    error: forecastError,
  } = useQuery<BudgetForecast, Error>({
    queryKey: ["finops-forecast", submittedTenant],
    queryFn: () => fetchForecast(submittedTenant, token),
    enabled: ready && isAuthenticated && !!submittedTenant,
  });

  const {
    data: co2Report,
    isLoading: loadingCo2,
    error: co2Error,
  } = useQuery<Co2Report, Error>({
    queryKey: ["finops-co2"],
    queryFn: () => fetchCo2Report(token),
    enabled: ready && isAuthenticated,
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Budget burn-rate forecast */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Budget burn-rate forecast
        </h3>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedTenant(tenantId.trim() || "default");
          }}
        >
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="Tenant id…"
            aria-label="Tenant id"
            className="w-56 rounded-md border border-border px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90"
          >
            Forecast
          </button>
        </form>

        {loadingForecast && (
          <p className="py-4 text-sm text-muted-foreground" aria-busy="true">
            Loading forecast…
          </p>
        )}
        {forecastError && (
          <div role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
            Failed to load forecast: {forecastError.message}
          </div>
        )}
        {forecast && !loadingForecast && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant={statusVariant(forecast.status)}>
                {STATUS_LABEL[forecast.status]}
              </Badge>
              {forecast.daysToExhaustion !== undefined && (
                <span className="text-sm text-foreground">
                  ≈ {forecast.daysToExhaustion.toFixed(1)} day(s) until cap
                  exhaustion
                  {forecast.projectedExhaustionDate !== undefined &&
                    ` (${forecast.projectedExhaustionDate})`}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
              <div>
                <dt className="uppercase tracking-wide">Cap/day</dt>
                <dd className="text-foreground">
                  {forecast.capPerDay > 0
                    ? formatCost(forecast.capPerDay, 2)
                    : "unlimited"}
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Current spend</dt>
                <dd className="text-foreground">
                  {formatCost(forecast.currentSpend, 4)}
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Burn rate</dt>
                <dd className="text-foreground">
                  {formatCost(forecast.dailyBurnRate, 4)}/day
                </dd>
              </div>
              <div>
                <dt className="uppercase tracking-wide">Trend</dt>
                <dd className="text-foreground">
                  {forecast.dailyTrend >= 0 ? "+" : ""}
                  {formatCost(forecast.dailyTrend, 4)}/day²
                </dd>
              </div>
            </dl>
            {forecast.status === "insufficient_data" && (
              <p className="text-xs text-muted-foreground">
                A daily spend history requires a durable (Postgres-backed) cost
                store. Configure <code>DATABASE_URL</code> to enable this
                forecast.
              </p>
            )}
          </div>
        )}
      </section>

      {/* CO2 / ESG report */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          CO2 / ESG accounting
        </h3>
        {loadingCo2 && (
          <p className="py-4 text-sm text-muted-foreground" aria-busy="true">
            Loading CO2 report…
          </p>
        )}
        {co2Error && (
          <div role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
            Failed to load CO2 report: {co2Error.message}
          </div>
        )}
        {co2Report && !loadingCo2 && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-6">
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Est. energy</span>
                <span className="text-2xl font-bold text-foreground">
                  {co2Report.totalEstimatedKwh.toFixed(3)} kWh
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Est. emissions</span>
                <span className="text-2xl font-bold text-success">
                  {co2Report.totalEstimatedKgCo2e.toFixed(3)} kg CO2e
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">≈ car km driven</span>
                <span className="text-2xl font-bold text-foreground">
                  {co2Report.carKmEquivalent.toFixed(1)} km
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-xs text-muted-foreground">Grid intensity</span>
                <span className="text-sm text-foreground">
                  {co2Report.gridCarbonIntensity} kg CO2e/kWh
                </span>
              </div>
            </div>
            {co2Report.byModel.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                No token usage recorded yet.
              </p>
            ) : (
              <Table>
                <TableHead>
                  <TableRow className="uppercase tracking-wide">
                    <TableHeaderCell>Model</TableHeaderCell>
                    <TableHeaderCell className="text-right">Tokens</TableHeaderCell>
                    <TableHeaderCell className="text-right">kWh</TableHeaderCell>
                    <TableHeaderCell className="text-right">kg CO2e</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {co2Report.byModel.map((m) => (
                    <TableRow key={`${m.provider}/${m.model}`}>
                      <TableCell className="font-mono text-xs text-foreground">
                        {m.provider}/{m.model}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatNumber((m.promptTokens + m.completionTokens))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {m.estimatedKwh.toFixed(4)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-success">
                        {m.estimatedKgCo2e.toFixed(4)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              Estimates only — derived from published per-token energy studies
              and a configurable grid carbon intensity (
              <code>CO2_GRID_CARBON_INTENSITY</code>,{" "}
              <code>CO2_ENERGY_FACTORS</code>), not measured infrastructure
              telemetry.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /shadow — Shadow-mode A/B quality monitoring.
 *
 * Shows aggregate stats for every production↔shadow flow pair, recent
 * individual comparison records (score deltas, regressions), and per-flow
 * drill-down. Data comes from:
 *   GET /monitoring/shadow               — all pairs + active configs
 *   GET /monitoring/shadow/comparisons   — recent comparison records
 *   GET /monitoring/shadow/:flowId       — single-pair drill-down
 */

import { useState, useCallback, useEffect } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";
import { Badge, Button, Table, TableHead, TableBody, TableRow, TableHeaderCell, TableCell } from "../../../lib/ui";
import { formatTime } from "../../../lib/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShadowConfig {
  productionFlow: string;
  shadowFlow: string;
  samplingRate: number;
  regressionDelta: number;
  maxConcurrent: number;
  disabled: boolean;
}

interface ShadowStats {
  productionFlow: string;
  shadowFlow: string;
  totalComparisons: number;
  regressions: number;
  improvements: number;
  avgDelta?: number;
}

interface ShadowOverview {
  enabled: boolean;
  configured: number;
  stats: ShadowStats[];
  configs: ShadowConfig[];
}

interface Comparison {
  id?: string;
  productionFlow: string;
  shadowFlow: string;
  executionId?: string;
  productionScore?: number;
  shadowScore?: number;
  delta?: number;
  regression: boolean;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deltaColor(delta: number | undefined): string {
  if (delta === undefined) return "text-muted-foreground";
  if (delta > 0) return "text-success";
  if (delta < 0) return "text-danger";
  return "text-muted-foreground";
}

function fmt(n: number | undefined, digits = 2): string {
  return n === undefined ? "—" : n.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ShadowPage() {
  const { token, ready, isAuthenticated } = useAuth();
  const [overview, setOverview] = useState<ShadowOverview | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [selectedFlow, setSelectedFlow] = useState<string | null>(null);
  const [flowStats, setFlowStats] = useState<ShadowStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    setLoading(true);
    setError(null);
    try {
      const [ovRes, cmpRes] = await Promise.all([
        authFetch(backendUrl("/monitoring/shadow"), token),
        authFetch(backendUrl("/monitoring/shadow/comparisons?limit=50"), token),
      ]);
      if (!ovRes.ok) throw new Error(`shadow overview: HTTP ${ovRes.status}`);
      if (!cmpRes.ok) throw new Error(`comparisons: HTTP ${cmpRes.status}`);
      setOverview((await ovRes.json()) as ShadowOverview);
      const cmpData = (await cmpRes.json()) as { comparisons: Comparison[] };
      setComparisons(cmpData.comparisons ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // The flagged "comparisons" below is `cmpData.comparisons` (from the
    // `as { comparisons: ... }` cast above), not the `comparisons` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ready, isAuthenticated]);

  const fetchFlowStats = useCallback(async (flowId: string) => {
    if (!ready || !isAuthenticated) return;
    try {
      const res = await authFetch(backendUrl(`/monitoring/shadow/${encodeURIComponent(flowId)}`), token);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFlowStats((await res.json()) as ShadowStats);
    } catch {
      setFlowStats(null);
    }
  }, [token, ready, isAuthenticated]);

  useEffect(() => {
    if (ready && isAuthenticated) void fetchAll();
  }, [ready, isAuthenticated, fetchAll]);

  useEffect(() => {
    if (selectedFlow) void fetchFlowStats(selectedFlow);
    else setFlowStats(null);
  }, [selectedFlow, fetchFlowStats]);

  const isEnabled = overview?.enabled ?? false;

  return (
    <div className="mx-auto w-full max-w-screen-xl p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Shadow Mode</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            A/B quality monitoring — each production request is silently replayed against
            a shadow flow and the responses are scored side-by-side.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void fetchAll()} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded border border-danger-border bg-danger-soft px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Feature status */}
      {overview && (
        <div className={`rounded border px-4 py-3 text-sm ${isEnabled ? "border-success-border bg-success-soft text-success" : "border-warning-border bg-warning-soft text-warning"}`}>
          {isEnabled
            ? `✓ Shadow runner active — ${overview.configured} flow pair(s) configured.`
            : "Shadow runner is not active on this deployment. Set SHADOW_ENABLED=true and configure shadow-flow pairs in your flow YAML to enable."}
        </div>
      )}

      {/* Configured pairs */}
      {overview && overview.configs.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground mb-3">Configured Pairs</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHead>
                <TableRow className="uppercase tracking-wide">
                  <TableHeaderCell>Production flow</TableHeaderCell>
                  <TableHeaderCell>Shadow flow</TableHeaderCell>
                  <TableHeaderCell className="text-right">Sample rate</TableHeaderCell>
                  <TableHeaderCell className="text-right">Regression δ</TableHeaderCell>
                  <TableHeaderCell className="text-center">Status</TableHeaderCell>
                  <TableHeaderCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {overview.configs.map((c) => (
                  <TableRow key={`${c.productionFlow}→${c.shadowFlow}`}>
                    <TableCell className="font-mono text-sm">{c.productionFlow}</TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">{c.shadowFlow}</TableCell>
                    <TableCell className="text-right tabular-nums">{(c.samplingRate * 100).toFixed(0)}%</TableCell>
                    <TableCell className="text-right tabular-nums">{c.regressionDelta.toFixed(2)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={c.disabled ? "secondary" : "success"}>
                        {c.disabled ? "disabled" : "active"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSelectedFlow(
                          selectedFlow === c.productionFlow ? null : c.productionFlow
                        )}
                      >
                        {selectedFlow === c.productionFlow ? "Hide stats" : "Stats"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Per-flow drill-down */}
          {flowStats && selectedFlow && (
            <div className="mt-4 rounded border border-border bg-muted p-4">
              <h3 className="text-sm font-semibold text-foreground mb-3">
                {selectedFlow} — detail
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                {[
                  { label: "Total comparisons", value: flowStats.totalComparisons },
                  { label: "Regressions", value: flowStats.regressions, red: true },
                  { label: "Improvements", value: flowStats.improvements, green: true },
                  { label: "Avg Δ score", value: flowStats.avgDelta !== undefined ? fmt(flowStats.avgDelta, 3) : "—", color: deltaColor(flowStats.avgDelta) },
                ].map(({ label, value, red, green, color }) => (
                  <div key={label} className="rounded border border-border bg-background p-3 text-center">
                    <div className={`text-xl font-bold tabular-nums ${red ? "text-danger" : green ? "text-success" : (color ?? "text-foreground")}`}>{value}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Recent comparisons */}
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold text-foreground mb-3">
          Recent Comparisons ({comparisons.length})
        </h2>
        {comparisons.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No comparison records yet. Shadow comparisons appear here as production requests
            are replayed.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHead>
                <TableRow className="uppercase tracking-wide">
                  <TableHeaderCell>Production</TableHeaderCell>
                  <TableHeaderCell>Shadow</TableHeaderCell>
                  <TableHeaderCell className="text-right">Prod score</TableHeaderCell>
                  <TableHeaderCell className="text-right">Shadow score</TableHeaderCell>
                  <TableHeaderCell className="text-right">Δ</TableHeaderCell>
                  <TableHeaderCell className="text-center">Result</TableHeaderCell>
                  <TableHeaderCell>Time</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {comparisons.map((c, i) => (
                  <TableRow key={c.id ?? i}>
                    <TableCell className="font-mono text-xs">{c.productionFlow}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{c.shadowFlow}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(c.productionScore, 3)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(c.shadowScore, 3)}</TableCell>
                    <TableCell className={`text-right tabular-nums font-medium ${deltaColor(c.delta)}`}>
                      {c.delta !== undefined ? (c.delta >= 0 ? "+" : "") + fmt(c.delta, 3) : "—"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant={c.regression ? "destructive" : "success"}>
                        {c.regression ? "regression" : "ok"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {c.createdAt ? formatTime(c.createdAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

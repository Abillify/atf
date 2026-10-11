"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SloPanel — declarative cost/quality SLO attainment (see backend graph/slo.ts).
 *
 * Fetches GET /monitoring/slo and shows, per flow, the declared objective
 * (min quality / max cost per request), the observed EWMA values, and whether
 * the SLO is currently attained — the "cheapest model that still holds the bar"
 * objective made continuously observable.
 */

import type React from "react";
import { useEffect, useState, useCallback } from "react";
import { Button } from "../lib/ui";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { formatCost } from "../lib/currency";
import { authFetch } from "../lib/auth-fetch";

interface SloTarget {
  flow: string;
  minQualityScore?: number;
  maxCostUsdPerRequest?: number;
  minSamples?: number;
}

interface SloReportEntry {
  flow: string;
  target: SloTarget;
  observedQuality?: number;
  observedCostUsd?: number;
  qualitySamples: number;
  costSamples: number;
  meetsQuality: boolean;
  meetsCost: boolean;
  attained: boolean;
  proven: boolean;
}

interface SloResponse {
  enabled: boolean;
  slos: SloReportEntry[];
}

function statusBadge(e: SloReportEntry): { label: string; cls: string } {
  if (!e.proven)
    return {
      label: "unproven",
      cls: "border-border bg-muted text-muted-foreground",
    };
  return e.attained
    ? { label: "attained", cls: "border-success-border bg-success-soft text-success" }
    : { label: "breached", cls: "border-danger-border bg-danger-soft text-danger" };
}

export function SloPanel(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();
  const [data, setData] = useState<SloResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSlo = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await authFetch(backendUrl("/monitoring/slo"), token);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData((await resp.json()) as SloResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, ready, isAuthenticated]);

  useEffect(() => {
    void fetchSlo();
  }, [fetchSlo]);

  return (
    <div className="mt-6 flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            🎯 Cost / Quality SLOs
          </h2>
          <p className="text-xs text-muted-foreground">
            Declared per-flow objectives (min quality / max cost per request)
            and their live attainment. Declare targets in{" "}
            <code className="font-mono">flows/slo.json</code>.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchSlo()}
          disabled={loading}
        >
          {loading ? "Loading…" : "↻ Refresh"}
        </Button>
      </div>

      {error && (
        <div className="rounded border border-danger-border bg-danger-soft px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {data && !data.enabled && (
        <div className="rounded border border-warning-border bg-warning-soft px-4 py-2 text-xs text-warning">
          No SLOs declared. Create <code className="font-mono">flows/slo.json</code>{" "}
          with entries like{" "}
          <code className="font-mono">
            {"{ flow, minQualityScore, maxCostUsdPerRequest }"}
          </code>{" "}
          to track cost/quality objectives.
        </div>
      )}

      {data && data.enabled && (
        <div className="flex flex-col gap-2">
          {data.slos.map((e) => {
            const b = statusBadge(e);
            return (
              <div
                key={e.flow}
                className="rounded border border-border bg-card px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs font-medium text-foreground">
                    {e.flow}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${b.cls}`}
                  >
                    {b.label}
                  </span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
                  {e.target.minQualityScore !== undefined && (
                    <div className={e.meetsQuality ? "text-success" : "text-danger"}>
                      quality:{" "}
                      {e.observedQuality !== undefined
                        ? (e.observedQuality * 100).toFixed(0) + "%"
                        : "—"}{" "}
                      / ≥ {(e.target.minQualityScore * 100).toFixed(0)}%{" "}
                      <span className="text-muted-foreground">
                        ({e.qualitySamples} samples)
                      </span>
                    </div>
                  )}
                  {e.target.maxCostUsdPerRequest !== undefined && (
                    <div className={e.meetsCost ? "text-success" : "text-danger"}>
                      cost/req:{" "}
                      {e.observedCostUsd !== undefined
                        ? formatCost(e.observedCostUsd, 5)
                        : "—"}{" "}
                      / ≤ {formatCost(e.target.maxCostUsdPerRequest, 5)}{" "}
                      <span className="text-muted-foreground">
                        ({e.costSamples} samples)
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

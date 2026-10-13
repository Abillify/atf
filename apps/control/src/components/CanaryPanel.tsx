"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import type { CanaryStatusEntry, CanaryStats } from "../types/control";
import { Badge } from "../lib/ui";

export interface CanaryPanelProps {
  deployments: CanaryStatusEntry[];
  isLoading?: boolean;
  error?: string | null;
}

function errorRate(s: CanaryStats): number {
  return s.samples > 0 ? (s.errors / s.samples) * 100 : 0;
}

function meanScore(s: CanaryStats): number | null {
  return s.scoreCount > 0 ? s.scoreSum / s.scoreCount : null;
}

function VariantStats({
  label,
  stats,
  accent,
}: {
  label: string;
  stats: CanaryStats;
  accent: string;
}): React.JSX.Element {
  const score = meanScore(stats);
  return (
    <div className="flex-1 rounded-md border border-border bg-card p-3">
      <div
        className={`text-xs font-semibold uppercase tracking-wide ${accent}`}
      >
        {label}
      </div>
      <dl className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>Samples</dt>
          <dd className="tabular-nums">{stats.samples}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Error rate</dt>
          <dd className="tabular-nums">{errorRate(stats).toFixed(1)}%</dd>
        </div>
        <div className="flex justify-between">
          <dt>Mean score</dt>
          <dd className="tabular-nums">
            {score === null ? "—" : score.toFixed(3)}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Live canary rollout status: traffic split, per-variant stats and rollback
 * state. The candidate is auto-rolled-back by the backend when it regresses.
 */
export function CanaryPanel({
  deployments,
  isLoading,
  error,
}: CanaryPanelProps): React.JSX.Element {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Canary rollouts{" "}
          <span className="font-normal text-muted-foreground">
            ({deployments.length})
          </span>
        </h3>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      {isLoading && deployments.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : deployments.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card py-12 text-center">
          <p className="text-sm text-muted-foreground">
            No canary deployments configured.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Add <span className="font-mono">flows/canary.json</span> to roll out
            a candidate flow.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {deployments.map((d) => (
            <div
              key={d.flow}
              className="rounded-lg border border-border bg-muted p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono text-sm font-semibold text-foreground">
                    {d.flow}
                  </span>
                  <span className="text-muted-foreground"> → </span>
                  <span className="font-mono text-sm text-accent">
                    {d.candidate}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    {d.rolledBack ? "0" : d.trafficPercent}% canary
                  </Badge>
                  {d.rolledBack ? (
                    <Badge variant="destructive">rolled back</Badge>
                  ) : (
                    <Badge variant="success">active</Badge>
                  )}
                </div>
              </div>
              <div className="mt-3 flex gap-3">
                <VariantStats
                  label="Stable"
                  stats={d.stable}
                  accent="text-muted-foreground"
                />
                <VariantStats
                  label="Candidate"
                  stats={d.canary}
                  accent="text-info"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

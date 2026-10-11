"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import type { MetricsSummary } from "../types/metrics";
import { Card } from "../lib/ui";
import { currencySymbol } from "../lib/currency";

export interface StatsBarProps {
  summary: MetricsSummary;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCurrency(n: number): string {
  const symbol = currencySymbol();
  if (n === 0) return `${symbol}0`;
  if (n < 0.01) return `${symbol}${n.toFixed(5)}`;
  return `${symbol}${n.toFixed(2)}`;
}

interface KpiProps {
  label: string;
  value: string;
  accent?: string;
  hint?: string;
}

function Kpi({
  label,
  value,
  accent = "text-foreground",
  hint,
}: KpiProps): React.JSX.Element {
  return (
    <Card
      noPadding
      role="group"
      aria-label={label}
      className="flex min-w-[120px] flex-1 flex-col px-4 py-3"
    >
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={`mt-0.5 text-xl font-bold tabular-nums ${accent}`}>
        {value}
      </span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </Card>
  );
}

/**
 * Top KPI strip summarising platform-wide runtime metrics polled from the
 * backend (`/monitoring/metrics`): throughput, in-flight load, token usage,
 * estimated cost and error rate.
 */
export function StatsBar({ summary }: StatsBarProps): React.JSX.Element {
  const totalTokens = summary.tokensPrompt + summary.tokensCompletion;
  const errorRate =
    summary.llmCallsTotal > 0
      ? (summary.llmErrorsTotal / summary.llmCallsTotal) * 100
      : 0;

  const groundednessTotal =
    summary.groundednessPassed + summary.groundednessFailed;
  const groundedPct =
    groundednessTotal > 0
      ? (summary.groundednessPassed / groundednessTotal) * 100
      : 0;
  const approvalsTotal = summary.approvalsApproved + summary.approvalsDenied;

  return (
    <div className="flex flex-wrap gap-3 border-b border-border bg-muted px-6 py-3">
      <Kpi label="Requests" value={formatNumber(summary.requestsTotal)} />
      <Kpi
        label="Active"
        value={String(summary.activeExecutions)}
        accent="text-warning"
        hint={
          summary.queueDepth > 0 ? `${summary.queueDepth} queued` : "no backlog"
        }
      />
      <Kpi label="LLM calls" value={formatNumber(summary.llmCallsTotal)} />
      <Kpi
        label="Tokens"
        value={formatNumber(totalTokens)}
        hint={`${formatNumber(summary.tokensPrompt)} in / ${formatNumber(summary.tokensCompletion)} out`}
      />
      <Kpi
        label="Est. cost"
        value={formatCurrency(summary.costTotal)}
        accent="text-success"
      />
      <Kpi
        label="Avg node"
        value={`${summary.avgNodeLatencyMs.toFixed(0)} ms`}
      />
      <Kpi
        label="Error rate"
        value={`${errorRate.toFixed(1)}%`}
        accent={errorRate > 5 ? "text-danger" : "text-foreground"}
      />
      {groundednessTotal > 0 && (
        <Kpi
          label="Grounded"
          value={`${groundedPct.toFixed(0)}%`}
          accent={groundedPct < 80 ? "text-warning" : "text-foreground"}
          hint={`${summary.groundednessFailed} ungrounded`}
        />
      )}
      {approvalsTotal > 0 && (
        <Kpi
          label="Approvals"
          value={String(approvalsTotal)}
          hint={`${summary.approvalsApproved} ok / ${summary.approvalsDenied} denied`}
        />
      )}
    </div>
  );
}

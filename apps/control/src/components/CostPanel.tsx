"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { MetricsSummary } from "../types/metrics";
import { activeCurrency, formatCost } from "../lib/currency";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";

export interface CostPanelProps {
  summary: MetricsSummary;
}

const BAR_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#0891b2",
  "#16a34a",
  "#ca8a04",
  "#dc2626",
];

/**
 * Cost & token breakdown by model, plus per-tenant daily spend against the
 * configured budget cap. Complements the live node graph with the economic
 * view operators need for a multi-tenant B2B deployment.
 */
export function CostPanel({ summary }: CostPanelProps): React.JSX.Element {
  const costData = Object.entries(summary.costByModel)
    .map(([model, amount]) => ({
      model,
      amount: Math.round(amount * 1e6) / 1e6,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  const tokenData = Object.entries(summary.tokensByModel)
    .map(([model, t]) => ({
      model,
      prompt: t.prompt,
      completion: t.completion,
    }))
    .sort((a, b) => b.prompt + b.completion - (a.prompt + a.completion))
    .slice(0, 6);

  const tenants = [...summary.tenants]
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 8);

  const users = [...summary.spendByUser]
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 8);

  const flows = [...summary.spendByFlow]
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 8);

  // Shared max for a simple proportional usage bar (relative to the top spender).
  const maxUserSpend = users.reduce((m, u) => Math.max(m, u.spent), 0);
  const maxFlowSpend = flows.reduce((m, f) => Math.max(m, f.spent), 0);

  const totalCacheRequests = summary.cacheHits + summary.cacheMisses;
  const cacheHitRatePct =
    totalCacheRequests > 0
      ? Math.round((summary.cacheHits / totalCacheRequests) * 1000) / 10
      : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Cost by model */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Estimated cost by model ({activeCurrency()})
        </h3>
        {costData.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No cost recorded yet.
          </p>
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(120, costData.length * 34)}
          >
            <BarChart
              data={costData}
              layout="vertical"
              margin={{ left: 8, right: 16 }}
            >
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="model"
                width={140}
                tick={{ fontSize: 10 }}
              />
              <Tooltip
                formatter={(v) => formatCost(Number(v ?? 0), 5)}
              />
              <Bar dataKey="amount">
                {costData.map((_, i) => (
                  <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* Tokens by model */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Tokens by model
        </h3>
        {tokenData.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No token usage yet.
          </p>
        ) : (
          <ResponsiveContainer
            width="100%"
            height={Math.max(120, tokenData.length * 34)}
          >
            <BarChart
              data={tokenData}
              layout="vertical"
              margin={{ left: 8, right: 16 }}
            >
              <XAxis type="number" tick={{ fontSize: 10 }} />
              <YAxis
                type="category"
                dataKey="model"
                width={140}
                tick={{ fontSize: 10 }}
              />
              <Tooltip />
              <Bar dataKey="prompt" stackId="t" fill="#93c5fd" name="prompt" />
              <Bar
                dataKey="completion"
                stackId="t"
                fill="#2563eb"
                name="completion"
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </section>

      {/* Response cache analytics */}
      {totalCacheRequests > 0 && (
        <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-foreground">
            Response cache analytics
          </h3>
          <div className="mb-3 flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Hit rate</span>
              <span className="text-2xl font-bold text-emerald-600">
                {cacheHitRatePct}%
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Total requests</span>
              <span className="text-2xl font-bold text-foreground">
                {totalCacheRequests.toLocaleString()}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-xs text-muted-foreground">Hits saved</span>
              <span className="text-2xl font-bold text-accent">
                {summary.cacheHits.toLocaleString()}
              </span>
            </div>
          </div>
          {/* Hit/miss bar */}
          <div className="mb-3 h-3 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-500"
              style={{ width: `${cacheHitRatePct}%` }}
            />
          </div>
          {/* Layer breakdown */}
          <Table>
            <TableHead>
              <TableRow className="uppercase tracking-wide">
                <TableHeaderCell>Layer</TableHeaderCell>
                <TableHeaderCell className="text-right">Hits</TableHeaderCell>
                <TableHeaderCell className="text-right">Share</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[
                {
                  label: "Exact match",
                  hits: summary.cacheExactHits,
                  color: "bg-blue-500",
                },
                {
                  label: "Semantic (near-dup)",
                  hits: summary.cacheSemanticHits,
                  color: "bg-violet-500",
                },
              ].map(({ label, hits, color }) => (
                <TableRow key={label}>
                  <TableCell className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${color}`}
                    />
                    <span className="text-foreground">{label}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {hits.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {summary.cacheHits > 0
                      ? `${Math.round((hits / summary.cacheHits) * 1000) / 10}%`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="font-medium">
                <TableCell className="text-muted-foreground">Misses</TableCell>
                <TableCell className="text-right tabular-nums">
                  {summary.cacheMisses.toLocaleString()}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {totalCacheRequests > 0
                    ? `${Math.round((summary.cacheMisses / totalCacheRequests) * 1000) / 10}%`
                    : "—"}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </section>
      )}

      {/* Per-tenant spend */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Per-tenant spend (24h)
        </h3>
        {tenants.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No tenant spend recorded.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow className="uppercase tracking-wide">
                <TableHeaderCell>Tenant</TableHeaderCell>
                <TableHeaderCell className="text-right">Spent</TableHeaderCell>
                <TableHeaderCell className="text-right">Cap</TableHeaderCell>
                <TableHeaderCell className="pl-3">Usage</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tenants.map((t) => {
                const pct =
                  t.cap > 0
                    ? Math.min(100, (t.spent / t.cap) * 100)
                    : 0;
                const over = t.cap > 0 && t.spent >= t.cap;
                return (
                  <TableRow key={t.tenant}>
                    <TableCell className="font-mono text-xs text-foreground">
                      {t.tenant}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCost(t.spent, 4)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {t.cap > 0 ? formatCost(t.cap, 2) : "—"}
                    </TableCell>
                    <TableCell className="pl-3">
                      {t.cap > 0 ? (
                        <div className="h-2 w-full overflow-hidden rounded bg-muted">
                          <div
                            className={`h-full ${over ? "bg-red-500" : "bg-emerald-500"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">unlimited</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Spend per authenticated user */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Spend per user (24h)
        </h3>
        {users.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No user-attributed spend recorded.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow className="uppercase tracking-wide">
                <TableHeaderCell>User</TableHeaderCell>
                <TableHeaderCell className="text-right">Spent</TableHeaderCell>
                <TableHeaderCell className="pl-3">Share</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {users.map((u) => {
                const pct =
                  maxUserSpend > 0 ? (u.spent / maxUserSpend) * 100 : 0;
                return (
                  <TableRow key={u.userId}>
                    <TableCell className="text-xs text-foreground" title={u.userId}>
                      {u.label}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCost(u.spent, 4)}
                    </TableCell>
                    <TableCell className="pl-3">
                      <div className="h-2 w-full overflow-hidden rounded bg-muted">
                        <div
                          className="h-full bg-accent"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Spend per flow */}
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Spend per flow (24h)
        </h3>
        {flows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No flow-attributed spend recorded.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow className="uppercase tracking-wide">
                <TableHeaderCell>Flow</TableHeaderCell>
                <TableHeaderCell className="text-right">Spent</TableHeaderCell>
                <TableHeaderCell className="pl-3">Share</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {flows.map((f) => {
                const pct =
                  maxFlowSpend > 0 ? (f.spent / maxFlowSpend) * 100 : 0;
                return (
                  <TableRow key={f.flowId}>
                    <TableCell className="font-mono text-xs text-foreground">
                      {f.flowId}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCost(f.spent, 4)}
                    </TableCell>
                    <TableCell className="pl-3">
                      <div className="h-2 w-full overflow-hidden rounded bg-muted">
                        <div
                          className="h-full bg-cyan-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

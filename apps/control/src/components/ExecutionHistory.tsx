"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import type { NodeExecutionEvent } from "../types/monitoring";
import { withCurrency } from "../lib/currency";
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

export interface ExecutionHistoryProps {
  events: NodeExecutionEvent[];
}

interface ExecutionSummary {
  executionId: string;
  startedAt: number;
  nodes: number;
  errors: number;
  running: number;
  totalLatencyMs: number;
  totalCost: number;
}

/** Formats an estimated cost with the configured display currency symbol. */
function formatCost(cost: number): string {
  const bare =
    cost === 0
      ? "0"
      : cost < 0.01
        ? cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
        : cost.toFixed(cost < 1 ? 4 : 2);
  return withCurrency(bare);
}

/**
 * Groups the flat NodeExecutionEvent stream by execution_id to give a per-request
 * audit view: how many nodes ran, total latency, and error count. Most recent
 * execution first.
 */
function summarise(events: NodeExecutionEvent[]): ExecutionSummary[] {
  const byExec = new Map<string, NodeExecutionEvent[]>();
  for (const e of events) {
    const list = byExec.get(e.execution_id) ?? [];
    list.push(e);
    byExec.set(e.execution_id, list);
  }

  const out: ExecutionSummary[] = [];
  for (const [executionId, evs] of byExec) {
    const latestByNode = new Map<string, NodeExecutionEvent>();
    for (const e of evs) latestByNode.set(e.node_id, e);

    let errors = 0;
    let running = 0;
    let totalLatencyMs = 0;
    let totalCost = 0;
    let startedAt = Number.POSITIVE_INFINITY;
    for (const e of latestByNode.values()) {
      if (e.status === "error") errors++;
      else if (e.status === "running") running++;
      if (e.latency_ms) totalLatencyMs += e.latency_ms;
      if (e.cost) totalCost += e.cost;
      const t = new Date(e.start_time).getTime();
      if (!Number.isNaN(t)) startedAt = Math.min(startedAt, t);
    }

    out.push({
      executionId,
      startedAt: Number.isFinite(startedAt) ? startedAt : 0,
      nodes: latestByNode.size,
      errors,
      running,
      totalLatencyMs,
      totalCost,
    });
  }

  return out.sort((a, b) => b.startedAt - a.startedAt);
}

function statusBadge(s: ExecutionSummary): {
  label: string;
  variant: BadgeVariant;
} {
  if (s.running > 0) return { label: "running", variant: "warning" };
  if (s.errors > 0) return { label: "error", variant: "destructive" };
  return { label: "ok", variant: "success" };
}

export function ExecutionHistory({
  events,
}: ExecutionHistoryProps): React.JSX.Element {
  const rows = summarise(events).slice(0, 50);

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="mb-2 text-sm font-semibold text-foreground">
        Execution history{" "}
        <span className="font-normal text-muted-foreground">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No executions yet.
        </p>
      ) : (
        <Table>
          <TableHead>
            <TableRow className="uppercase tracking-wide">
              <TableHeaderCell>Execution</TableHeaderCell>
              <TableHeaderCell className="text-right">Nodes</TableHeaderCell>
              <TableHeaderCell className="text-right">Latency</TableHeaderCell>
              <TableHeaderCell className="text-right">Cost</TableHeaderCell>
              <TableHeaderCell className="text-center">Status</TableHeaderCell>
              <TableHeaderCell className="text-right">Started</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => {
              const b = statusBadge(r);
              return (
                <TableRow key={r.executionId}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {r.executionId.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.nodes}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.totalLatencyMs} ms
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-700">
                    {r.totalCost > 0 ? formatCost(r.totalCost) : "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={b.variant}>{b.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {r.startedAt
                      ? new Date(r.startedAt).toLocaleTimeString()
                      : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

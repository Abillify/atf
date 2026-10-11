"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  LineChart,
  Line,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { NodeExecutionEvent } from "../types/monitoring";
import type { ExecutionPickerItem } from "./ExecutionPicker";
import { Button } from "../lib/ui";
import { FlowPicker } from "./FlowPicker";
import { formatTime } from "../lib/i18n";
import { useChartPalette } from "../lib/theme/palette";

export interface MetricsSidebarProps {
  events: NodeExecutionEvent[];
  /** Execution-level items for timeseries (startedAt, durationMs, flowId). */
  executions?: ExecutionPickerItem[];
  /** When true, renders without the aside wrapper (embedded inside another panel). */
  embedded?: boolean;
  /** Flow names by id, for the flow filter (falls back to the id). */
  flowNames?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Time range options
// ---------------------------------------------------------------------------

type TimeRange = "5m" | "15m" | "1h" | "6h" | "24h" | "all";

const TIME_RANGE_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "all", label: "All" },
];

function rangeToMs(range: TimeRange): number | null {
  switch (range) {
    case "5m": return 5 * 60 * 1000;
    case "15m": return 15 * 60 * 1000;
    case "1h": return 60 * 60 * 1000;
    case "6h": return 6 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "all": return null;
  }
}

// ---------------------------------------------------------------------------
// Metrics aggregation
// ---------------------------------------------------------------------------

interface NodeMetrics {
  activeRequests: number;
  completed: number;
  errors: number;
  totalNodes: number;
}

function aggregateMetrics(events: NodeExecutionEvent[]): NodeMetrics {
  const latestByNodeId = new Map<string, NodeExecutionEvent>();
  for (const event of events) {
    latestByNodeId.set(event.node_id, event);
  }

  let activeRequests = 0;
  let completed = 0;
  let errors = 0;

  for (const event of latestByNodeId.values()) {
    if (event.status === "running") activeRequests++;
    else if (event.status === "completed") completed++;
    else if (event.status === "error") errors++;
  }

  return { activeRequests, completed, errors, totalNodes: latestByNodeId.size };
}

// ---------------------------------------------------------------------------
// Timeseries data builder
// ---------------------------------------------------------------------------

interface TimeseriesBucket {
  time: string; // display label
  ts: number; // epoch ms (for sorting)
  requests: number;
  avgDuration: number; // ms
  [key: string]: unknown; // per-flow counts e.g. "flow:abc"
}

/**
 * Buckets executions into time intervals for the timeseries chart.
 * Automatically chooses bucket size based on the range.
 */
function buildTimeseries(
  executions: ExecutionPickerItem[],
  rangeMs: number | null,
  flowFilter: string | null,
): TimeseriesBucket[] {
  const now = Date.now();
  const cutoff = rangeMs != null ? now - rangeMs : 0;

  const filtered = executions.filter(
    (e) =>
      // Skip unknown timestamps (startedAt === 0) so they don't bucket to 1970.
      e.startedAt > 0 &&
      e.startedAt >= cutoff &&
      (flowFilter === null || e.flowId === flowFilter),
  );

  if (filtered.length === 0) return [];

  // Determine bucket size
  const span = rangeMs ?? (now - Math.min(...filtered.map((e) => e.startedAt)));
  let bucketMs: number;
  if (span <= 5 * 60 * 1000) bucketMs = 15 * 1000; // 15s buckets
  else if (span <= 15 * 60 * 1000) bucketMs = 60 * 1000; // 1m
  else if (span <= 60 * 60 * 1000) bucketMs = 5 * 60 * 1000; // 5m
  else if (span <= 6 * 60 * 60 * 1000) bucketMs = 15 * 60 * 1000; // 15m
  else bucketMs = 60 * 60 * 1000; // 1h

  const buckets = new Map<
    number,
    { requests: number; durationSum: number; durationCount: number }
  >();
  for (const e of filtered) {
    const bucket = Math.floor(e.startedAt / bucketMs) * bucketMs;
    const cur = buckets.get(bucket) ?? {
      requests: 0,
      durationSum: 0,
      durationCount: 0,
    };
    cur.requests += 1;
    // Average only over executions that actually have a duration (completed
    // runs) so in-flight ones don't drag the average toward zero.
    if (typeof e.durationMs === "number" && e.durationMs >= 0) {
      cur.durationSum += e.durationMs;
      cur.durationCount += 1;
    }
    buckets.set(bucket, cur);
  }

  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  return sorted.map(([ts, data]) => ({
    time: formatTime(ts, {
      hour: "2-digit",
      minute: "2-digit",
    }),
    ts,
    requests: data.requests,
    avgDuration:
      data.durationCount > 0
        ? Math.round(data.durationSum / data.durationCount)
        : 0,
  }));
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  valueClassName = "text-foreground",
}: {
  label: string;
  value: number;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-0.5 text-xl font-bold tabular-nums ${valueClassName}`}>
        {value}
      </p>
    </div>
  );
}

/** Fullscreen overlay for the timeseries chart */
function FullscreenChart({
  data,
  onClose,
}: {
  data: TimeseriesBucket[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const chart = useChartPalette();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Request timeseries (fullscreen)"
    >
      <div
        className="relative w-[90vw] max-w-4xl h-[60vh] bg-card rounded-xl shadow-2xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="absolute top-3 right-3"
          aria-label="Close fullscreen chart"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </Button>
        <h3 className="text-sm font-semibold text-foreground mb-4">
          Request Timeseries
        </h3>
        <ResponsiveContainer width="100%" height="85%">
          <LineChart data={data}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke={chart.grid}
              opacity={0.3}
            />
            <XAxis dataKey="time" tick={{ fontSize: 11 }} />
            <YAxis
              yAxisId="left"
              allowDecimals={false}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 11 }}
              unit="ms"
            />
            <Tooltip
              contentStyle={{
                backgroundColor: chart.tooltipBg,
                border: "none",
                borderRadius: 8,
              }}
              labelStyle={{ color: chart.tooltipLabel }}
              itemStyle={{ color: chart.tooltipItem }}
            />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="requests"
              stroke={chart.run}
              strokeWidth={2}
              dot={false}
              name="Requests"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="avgDuration"
              stroke={chart.cost}
              strokeWidth={2}
              dot={false}
              name="Avg Duration (ms)"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * MetricsSidebar — Requirement 9.5
 *
 * Displays real-time aggregated statistics, a time-range selector, and a
 * timeseries chart showing request count and average duration (filterable by
 * flow). The timeseries chart is clickable to open a fullscreen view.
 */
export function MetricsSidebar({
  events,
  executions = [],
  embedded = false,
  flowNames,
}: MetricsSidebarProps): React.JSX.Element {
  const [timeRange, setTimeRange] = useState<TimeRange>("1h");
  const [flowFilter, setFlowFilter] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const chart = useChartPalette();

  const metrics = aggregateMetrics(events);

  // Unique flow IDs for the filter dropdown
  const flowIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of executions) {
      if (e.flowId) ids.add(e.flowId);
    }
    return [...ids].sort();
  }, [executions]);

  // Build timeseries data
  const tsData = useMemo(
    () => buildTimeseries(executions, rangeToMs(timeRange), flowFilter),
    [executions, timeRange, flowFilter],
  );

  const chartData = [
    { name: "Run", value: metrics.activeRequests, color: chart.cost },
    { name: "Done", value: metrics.completed, color: chart.c4 },
    { name: "Err", value: metrics.errors, color: chart.c6 },
  ];

  return (
    <aside
      className={
        embedded
          ? "flex flex-col gap-3 p-4 overflow-y-auto"
          : "flex h-full w-72 shrink-0 flex-col gap-3 border-l border-border bg-muted p-4 overflow-y-auto"
      }
    >
      <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
        Live Metrics
      </h2>

      {/* Time range selector */}
      <div className="flex flex-wrap gap-1">
        {TIME_RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setTimeRange(opt.value)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              timeRange === opt.value
                ? "bg-accent text-accent-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted-foreground/20"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          label="Active Requests"
          value={metrics.activeRequests}
          valueClassName="text-warning"
        />
        <StatCard
          label="Completed"
          value={metrics.completed}
          valueClassName="text-success"
        />
        <StatCard
          label="Errors"
          value={metrics.errors}
          valueClassName="text-danger"
        />
        <StatCard label="Total Nodes" value={metrics.totalNodes} />
      </div>

      {/* Node status distribution */}
      <div className="rounded-lg border border-border bg-card p-2 shadow-sm">
        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Node Status
        </p>
        <BarChart width={embedded ? 460 : 230} height={90} data={chartData}>
          <XAxis dataKey="name" tick={{ fontSize: 10 }} />
          <YAxis allowDecimals={false} width={20} tick={{ fontSize: 10 }} />
          <Bar dataKey="value">
            {chartData.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Bar>
        </BarChart>
      </div>

      {/* Timeseries chart */}
      <div className="rounded-lg border border-border bg-card p-2 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Request Timeseries
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFullscreen(true)}
            title="Open fullscreen"
          >
            ⛶
          </Button>
        </div>

        {/* Flow filter */}
        {flowIds.length > 1 && (
          <div className="mb-1">
            <FlowPicker
              flows={flowIds.map((id) => ({
                id,
                name: flowNames?.get(id) ?? id,
              }))}
              value={flowFilter ?? ""}
              onChange={(id) => setFlowFilter(id === "" ? null : id)}
              emptyOption="All flows"
              placeholder="All flows"
              ariaLabel="Filter metrics by flow"
              className="w-full"
            />
          </div>
        )}

        {tsData.length > 0 ? (
          <div
            className="cursor-pointer"
            onClick={() => setFullscreen(true)}
            title="Click to expand"
          >
            <LineChart width={embedded ? 460 : 230} height={100} data={tsData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke={chart.grid}
                opacity={0.2}
              />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 8 }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                allowDecimals={false}
                width={18}
                tick={{ fontSize: 8 }}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                width={24}
                tick={{ fontSize: 8 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: chart.tooltipBg,
                  border: "none",
                  borderRadius: 6,
                  fontSize: 10,
                }}
                labelStyle={{ color: chart.tooltipLabel }}
                itemStyle={{ color: chart.tooltipItem }}
              />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="requests"
                stroke={chart.run}
                strokeWidth={1.5}
                dot={false}
                name="Requests"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="avgDuration"
                stroke={chart.cost}
                strokeWidth={1.5}
                dot={false}
                name="Avg ms"
              />
            </LineChart>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground py-4 text-center">
            No data in selected range.
          </p>
        )}
      </div>

      {/* Fullscreen overlay */}
      {fullscreen && (
        <FullscreenChart data={tsData} onClose={() => setFullscreen(false)} />
      )}
    </aside>
  );
}

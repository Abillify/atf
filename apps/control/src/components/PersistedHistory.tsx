"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  FileJson,
  Filter,
  Loader2,
  Play,
  ScrollText,
  Sparkles,
} from "lucide-react";
import type { PersistedExecution } from "../types/history";
import { withCurrency } from "../lib/currency";
import { FlowMultiSelect } from "./FlowMultiSelect";
import { UserSelectFilter } from "./UserSelectFilter";
import {
  Badge,
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { formatDateTime } from "../lib/i18n";

export interface PersistedHistoryProps {
  executions: PersistedExecution[];
  isLoading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  /** When provided, renders a "Replay" action per row (time-travel). */
  onReplay?: (executionId: string) => void;
  /** Execution id currently being replayed (disables its button). */
  replayingId?: string | null;
  /**
   * When provided, renders a "View" action per row that opens the execution
   * in the Live Graph view (shows system prompt, tool calls, response per node).
   */
  onViewEvents?: (executionId: string) => void;
  /**
   * When provided, renders a "JSON" action per row that downloads the full,
   * untruncated debug trace (all prompts, LLM responses, tool calls + results,
   * RAG chunks, tool selection) as a JSON file.
   */
  onDownloadDebug?: (executionId: string) => void;
  /** Execution id whose debug trace is currently being downloaded (disables its button). */
  downloadingId?: string | null;
  /**
   * When provided, renders an "Analyze" action per row that runs an LLM
   * post-mortem of the execution's debug trace (root cause + findings +
   * improvement suggestions) via POST /optimizer/analyze/:executionId.
   */
  onAnalyze?: (executionId: string) => void;
  /** Execution id currently being analysed (disables its button). */
  analyzingId?: string | null;
  /**
   * When provided, renders a "Trace" action per row that opens the execution
   * in the Trace Viewer (`/traces?execution=<id>`) — step replay, OTel
   * waterfall and the Decision-Provenance explainability card.
   */
  onOpenTrace?: (executionId: string) => void;

  // --- Filtering (optional) -------------------------------------------------
  /** Distinct flow ids to offer in the flow filter dropdown. */
  flowOptions?: string[];
  /** Flow names by id, shown and searchable in the flow filters. */
  flowNames?: ReadonlyMap<string, string>;
  /** Distinct user names to offer in the user filter dropdown. */
  userOptions?: string[];
  /** Currently included/excluded flow ids. Exclusion takes precedence. */
  includeFlows?: string[];
  excludeFlows?: string[];
  /** Currently selected user filter ("" = all). */
  userFilter?: string;
  onIncludeFlowsChange?: (flowIds: string[]) => void;
  onExcludeFlowsChange?: (flowIds: string[]) => void;
  /** Called when the user filter changes. */
  onUserFilterChange?: (userName: string) => void;

  // --- Pagination (optional) ------------------------------------------------
  /** Total rows matching the current filters (across all pages). */
  total?: number;
  /** Page size (rows per page). */
  pageSize?: number;
  /** Current offset (rows skipped from newest). */
  offset?: number;
  /** Called with the new offset when the user pages. */
  onOffsetChange?: (offset: number) => void;

  // --- Sorting (optional) ---------------------------------------------------
  /**
   * Column currently sorted server-side. Matches the runtime's whitelisted
   * history sort columns (started_at, flow_id, user_name, node_count,
   * total_latency_ms, total_cost, runtime).
   */
  sortBy?: string;
  /** Current sort direction. Default "desc". */
  sortDir?: "asc" | "desc";
  /**
   * When provided, sortable column headers become buttons that call this with
   * the clicked column key (the parent owns toggling direction + refetching).
   */
  onSortChange?: (column: string) => void;
}

interface SortableHeaderProps {
  label: string;
  /** Backend sort column key, e.g. "total_cost". */
  column: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  onSortChange?: (column: string) => void;
  align?: "right" | "center";
}

/**
 * A table header that, when sorting is wired up, is a clickable button with a
 * direction indicator and a proper `aria-sort` state on the `<th>`; otherwise
 * it renders as a plain header cell.
 */
function SortableHeader({
  label,
  column,
  sortBy,
  sortDir,
  onSortChange,
  align,
}: SortableHeaderProps): React.JSX.Element {
  const alignClass =
    align === "right" ? "text-right" : align === "center" ? "text-center" : undefined;
  const active = sortBy === column;
  const dir = active ? (sortDir ?? "desc") : undefined;
  if (onSortChange === undefined) {
    return <TableHeaderCell className={alignClass}>{label}</TableHeaderCell>;
  }
  return (
    <TableHeaderCell
      className={alignClass}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
        onClick={() => onSortChange(column)}
        title={`Sort by ${label}`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp size={12} aria-hidden="true" />
          ) : (
            <ArrowDown size={12} aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown size={12} className="opacity-40" aria-hidden="true" />
        )}
      </button>
    </TableHeaderCell>
  );
}

/** Formats a wall-clock duration in ms as a compact human string. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/** Wall-clock runtime of a run (finished_at - started_at), or null if running. */
function runtimeMs(e: PersistedExecution): number | null {
  if (!e.finished_at) return null;
  const start = new Date(e.started_at).getTime();
  const end = new Date(e.finished_at).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

function badge(status: PersistedExecution["status"]): {
  label: string;
  variant: BadgeVariant;
} {
  if (status === "running") return { label: "running", variant: "warning" };
  if (status === "error") return { label: "error", variant: "destructive" };
  return { label: "ok", variant: "success" };
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
 * Aggregated figures shown in a thread's group header row: flow and user
 * (identical across a conversation's requests — shown only when they truly
 * are), summed runtime and cost, an error-preferring status (error if any
 * request failed, otherwise the newest request's status) and the start date
 * of the oldest request.
 */
function threadSummary(requests: PersistedExecution[]): {
  flow: string | null;
  user: string | null;
  runtime: number | null;
  cost: number | null;
  status: PersistedExecution["status"];
  startedAt: number | null;
} {
  const sameOr = (values: Array<string | null>): string | null => {
    const first = values[0] ?? null;
    return values.every((v) => v === first) ? first : null;
  };
  let runtime: number | null = null;
  let cost: number | null = null;
  let latest: PersistedExecution | null = null;
  let oldest = Number.POSITIVE_INFINITY;
  let hasError = false;
  for (const r of requests) {
    if (r.status === "error") hasError = true;
    const rMs = runtimeMs(r);
    if (rMs !== null) runtime = (runtime ?? 0) + rMs;
    if (r.total_cost != null) cost = (cost ?? 0) + r.total_cost;
    const t = new Date(r.started_at).getTime();
    if (!Number.isNaN(t)) {
      if (
        latest === null ||
        t >= new Date(latest.started_at).getTime()
      )
        latest = r;
      oldest = Math.min(oldest, t);
    }
  }
  return {
    flow: sameOr(requests.map((r) => r.flow_id)),
    user: sameOr(requests.map((r) => r.user_name)),
    runtime,
    cost,
    status: hasError
      ? "error"
      : (latest?.status ?? requests[0]?.status ?? "completed"),
    startedAt: Number.isFinite(oldest) ? oldest : null,
  };
}

interface RequestRowProps {
  execution: PersistedExecution;
  /**
   * Marks the row as a member of an expanded thread group: a left accent
   * bar, tinted background and indented id make the group's requests
   * instantly distinguishable from the plain rows around them.
   */
  threadChild?: boolean;
  onViewEvents?: (executionId: string) => void;
  onDownloadDebug?: (executionId: string) => void;
  downloadingId?: string | null;
  onAnalyze?: (executionId: string) => void;
  analyzingId?: string | null;
  onOpenTrace?: (executionId: string) => void;
  onReplay?: (executionId: string) => void;
  replayingId?: string | null;
}

/**
 * Shared shape for the per-row action buttons in the table. Icon-only, but
 * full-size (`size="icon"` — a fixed square without the `px-3` of `size="sm"`,
 * which used to crush the 15 px icons down to a few pixels) and outlined, so
 * they are clearly recognisable as buttons at a glance.
 */
const ACTION_BUTTON_CLASS =
  "text-muted-foreground hover:text-foreground";
const ACTION_BUTTON_VARIANT = "outline" as const;

/** One execution as a table row (used for single requests and inside threads). */
function RequestRow({
  execution: e,
  threadChild = false,
  onViewEvents,
  onDownloadDebug,
  downloadingId,
  onAnalyze,
  analyzingId,
  onOpenTrace,
  onReplay,
  replayingId,
}: RequestRowProps): React.JSX.Element {
  const b = badge(e.status);
  const started = new Date(e.started_at);
  const hasActions =
    onViewEvents !== undefined ||
    onDownloadDebug !== undefined ||
    onAnalyze !== undefined ||
    onOpenTrace !== undefined ||
    onReplay !== undefined;
  return (
    <TableRow
      {...(threadChild
        ? {
            "data-testid": "thread-request-row",
            className: "border-l-2 border-l-primary/60 bg-muted/30",
          }
        : {})}
    >
      <TableCell
        className={`font-mono text-xs text-muted-foreground${threadChild ? " pl-7" : ""}`}
      >
        {threadChild && (
          <span aria-hidden="true" className="mr-1 text-muted-foreground/60">
            └
          </span>
        )}
        {e.execution_id.slice(0, 8)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {e.flow_id ?? "—"}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {e.user_name ?? "—"}
      </TableCell>
      <TableCell className="text-right tabular-nums">{e.node_count}</TableCell>
      <TableCell className="text-right tabular-nums">
        {e.total_latency_ms ?? 0} ms
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {(() => {
          const r = runtimeMs(e);
          return r === null ? "—" : formatDuration(r);
        })()}
      </TableCell>
      <TableCell className="text-right tabular-nums text-success">
        {e.total_cost != null && e.total_cost > 0
          ? formatCost(e.total_cost)
          : "—"}
      </TableCell>
      <TableCell className="text-center">
        <Badge variant={b.variant}>{b.label}</Badge>
      </TableCell>
      <TableCell className="text-right text-xs text-muted-foreground">
        {Number.isNaN(started.getTime()) ? "—" : formatDateTime(started)}
      </TableCell>
      {hasActions && (
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {onViewEvents && (
              <Button
                variant={ACTION_BUTTON_VARIANT}
                size="icon"
                className={ACTION_BUTTON_CLASS}
                onClick={() => onViewEvents(e.execution_id)}
                title="Open in Live Graph — shows system prompt, tool calls and response per node"
                aria-label="Open in Live Graph"
              >
                <Eye size={15} aria-hidden="true" />
              </Button>
            )}
            {onOpenTrace && (
              <Button
                variant={ACTION_BUTTON_VARIANT}
                size="icon"
                className={ACTION_BUTTON_CLASS}
                onClick={() => onOpenTrace(e.execution_id)}
                title="Open in Trace Viewer — step replay, waterfall and the Decision-Provenance explainability card"
                aria-label="Open in Trace Viewer"
              >
                <ScrollText size={15} aria-hidden="true" />
              </Button>
            )}
            {onDownloadDebug && (
              <Button
                variant={ACTION_BUTTON_VARIANT}
                size="icon"
                className={ACTION_BUTTON_CLASS}
                onClick={() => onDownloadDebug(e.execution_id)}
                disabled={downloadingId === e.execution_id}
                title="Download the full debug trace as JSON — all prompts, LLM responses, tool calls with results, RAG chunks and tool selection"
                aria-label="Download debug trace as JSON"
              >
                {downloadingId === e.execution_id ? (
                  <Loader2
                    size={15}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <FileJson size={15} aria-hidden="true" />
                )}
              </Button>
            )}
            {onAnalyze && (
              <Button
                variant={ACTION_BUTTON_VARIANT}
                size="icon"
                className={ACTION_BUTTON_CLASS}
                onClick={() => onAnalyze(e.execution_id)}
                disabled={analyzingId === e.execution_id}
                title="Run an LLM post-mortem of this run — root cause, findings and improvement suggestions from its debug trace"
                aria-label="Analyse this run with an LLM post-mortem"
              >
                {analyzingId === e.execution_id ? (
                  <Loader2
                    size={15}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Sparkles size={15} aria-hidden="true" />
                )}
              </Button>
            )}
            {onReplay && (
              <Button
                variant={ACTION_BUTTON_VARIANT}
                size="icon"
                className={ACTION_BUTTON_CLASS}
                onClick={() => onReplay(e.execution_id)}
                disabled={replayingId === e.execution_id}
                title="Replay this run — time-travel the flow with its original inputs"
                aria-label="Replay this run"
              >
                {replayingId === e.execution_id ? (
                  <Loader2
                    size={15}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Play size={15} aria-hidden="true" />
                )}
              </Button>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

/**
 * Durable execution history sourced from the backend audit log (Postgres).
 * Survives page reloads, unlike the live in-session event view.
 */
export function PersistedHistory({
  executions,
  isLoading,
  error,
  onRefresh,
  onReplay,
  replayingId,
  onViewEvents,
  onDownloadDebug,
  downloadingId,
  onAnalyze,
  analyzingId,
  onOpenTrace,
  flowOptions,
  flowNames,
  userOptions,
  includeFlows = [],
  excludeFlows = [],
  userFilter,
  onIncludeFlowsChange,
  onExcludeFlowsChange,
  onUserFilterChange,
  total,
  pageSize,
  offset,
  onOffsetChange,
  sortBy,
  sortDir,
  onSortChange,
}: PersistedHistoryProps): React.JSX.Element {
  const showFilters =
    onIncludeFlowsChange !== undefined ||
    onExcludeFlowsChange !== undefined ||
    onUserFilterChange !== undefined;
  const showPager =
    onOffsetChange !== undefined &&
    pageSize !== undefined &&
    offset !== undefined &&
    total !== undefined;

  const totalCount = total ?? executions.length;
  const currentOffset = offset ?? 0;
  const size = pageSize ?? (executions.length || 1);
  const pageStart = totalCount === 0 ? 0 : currentOffset + 1;
  const pageEnd = Math.min(currentOffset + executions.length, totalCount);
  const canPrev = currentOffset > 0;
  const canNext = currentOffset + size < totalCount;

  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(
    () => new Set(),
  );
  // The filters live behind a filter icon (like the Live Graph's request
  // picker) so the header stays compact even with flows + user active.
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (!filterRef.current?.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filterOpen]);
  const activeFilterCount =
    includeFlows.length +
    excludeFlows.length +
    (userFilter !== undefined && userFilter !== "" ? 1 : 0);
  // The default view (newest first) groups a conversation's requests into a
  // collapsible thread shown chronologically. For any *custom* sort the server
  // already ordered the rows by the chosen column — re-sorting here would
  // undo that, so the incoming order is preserved instead.
  const defaultSort =
    (sortBy === undefined || sortBy === "started_at") &&
    (sortDir === undefined || sortDir !== "asc");
  const threads = useMemo(() => {
    const grouped = new Map<string, PersistedExecution[]>();
    for (const execution of executions) {
      const stableId =
        execution.conversation_id ?? execution.chat_id ?? execution.session_id;
      const key =
        stableId == null
          ? `execution:${execution.execution_id}`
          : `thread:${stableId}`;
      const values = grouped.get(key) ?? [];
      values.push(execution);
      grouped.set(key, values);
    }
    const groups = [...grouped.entries()].map(([key, requests]) => ({
      key,
      label: key.startsWith("thread:")
        ? key.slice(7)
        : (requests[0]?.execution_id ?? key),
      requests: defaultSort
        ? [...requests].sort(
            (a, b) =>
              new Date(a.started_at).getTime() -
              new Date(b.started_at).getTime(),
          )
        : requests,
    }));
    if (!defaultSort) return groups;
    return groups.sort((a, b) => {
      const aTime = new Date(a.requests.at(-1)?.started_at ?? 0).getTime();
      const bTime = new Date(b.requests.at(-1)?.started_at ?? 0).getTime();
      return bTime - aTime;
    });
  }, [executions, defaultSort]);
  // All row actions live in one compact icon column, so the table gains a
  // single extra column whenever any action is wired up.
  const hasActions = Boolean(
    onViewEvents || onDownloadDebug || onAnalyze || onOpenTrace || onReplay,
  );
  const toggleThread = (key: string): void => {
    setCollapsedThreads((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          Execution history{" "}
          <span className="font-normal text-muted-foreground">
            ({totalCount})
          </span>
        </h3>
        <div className="flex flex-wrap items-center gap-3">
          {showFilters && (
            <div className="relative" ref={filterRef}>
              <button
                type="button"
                onClick={() => setFilterOpen((open) => !open)}
                aria-expanded={filterOpen}
                aria-label="Filter: Flows und User"
                title="Filter: Flows und User"
                className={`relative flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                  filterOpen || activeFilterCount > 0
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Filter size={14} aria-hidden />
                {activeFilterCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-semibold text-accent-foreground">
                    {activeFilterCount}
                  </span>
                )}
              </button>
              {filterOpen && (
                <div className="absolute right-0 z-30 mt-1 flex w-64 flex-col gap-2 rounded-md border border-border bg-card p-2 shadow-lg">
                  {onIncludeFlowsChange && (
                    <FlowMultiSelect
                      label="Flows einschließen"
                      options={flowOptions ?? []}
                      {...(flowNames !== undefined ? { names: flowNames } : {})}
                      value={includeFlows}
                      onChange={onIncludeFlowsChange}
                    />
                  )}
                  {onExcludeFlowsChange && (
                    <FlowMultiSelect
                      label="Flows ausschließen"
                      options={flowOptions ?? []}
                      {...(flowNames !== undefined ? { names: flowNames } : {})}
                      value={excludeFlows}
                      onChange={onExcludeFlowsChange}
                    />
                  )}
                  {onUserFilterChange && (
                    <UserSelectFilter
                      label="User"
                      options={userOptions ?? []}
                      value={userFilter ?? ""}
                      onChange={onUserFilterChange}
                    />
                  )}
                </div>
              )}
            </div>
          )}
          {error && (
            <span className="text-xs text-danger">
              {error}
            </span>
          )}
          {onRefresh && (
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              Refresh
            </Button>
          )}
        </div>
      </div>
      {isLoading && executions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Loading…
        </p>
      ) : executions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No executions recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHead>
              <TableRow className="uppercase tracking-wide">
                <TableHeaderCell>Execution</TableHeaderCell>
                <SortableHeader
                  label="Flow"
                  column="flow_id"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                />
                <SortableHeader
                  label="User"
                  column="user_name"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                />
                <SortableHeader
                  label="Nodes"
                  column="node_count"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                  align="right"
                />
                <SortableHeader
                  label="Latency"
                  column="total_latency_ms"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                  align="right"
                />
                <SortableHeader
                  label="Runtime"
                  column="runtime"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                  align="right"
                />
                <SortableHeader
                  label="Cost"
                  column="total_cost"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                  align="right"
                />
                <TableHeaderCell className="text-center">
                  Status
                </TableHeaderCell>
                <SortableHeader
                  label="Started"
                  column="started_at"
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSortChange={onSortChange}
                  align="right"
                />
                {(onViewEvents ||
                  onDownloadDebug ||
                  onAnalyze ||
                  onOpenTrace ||
                  onReplay) && (
                  <TableHeaderCell className="text-right">
                    Aktionen
                  </TableHeaderCell>
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {threads.map((thread) => {
                const collapsed = collapsedThreads.has(thread.key);
                // A single request needs no disclosure row — it renders as a
                // plain table row; only real multi-request threads get the
                // collapsible group header.
                if (thread.requests.length < 2) {
                  const e = thread.requests[0];
                  if (e === undefined) return null;
                  return (
                    <RequestRow
                      key={thread.key}
                      execution={e}
                      onViewEvents={onViewEvents}
                      onDownloadDebug={onDownloadDebug}
                      downloadingId={downloadingId}
                      onAnalyze={onAnalyze}
                      analyzingId={analyzingId}
                      onOpenTrace={onOpenTrace}
                      onReplay={onReplay}
                      replayingId={replayingId}
                    />
                  );
                }
                const summary = threadSummary(thread.requests);
                const groupBadge = badge(summary.status);
                const groupStarted =
                  summary.startedAt === null
                    ? null
                    : new Date(summary.startedAt);
                return (
                  <React.Fragment key={thread.key}>
                    <TableRow
                      className="bg-muted/60"
                      data-testid="thread-group-row"
                    >
                      <TableCell>
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 text-left text-xs font-medium text-foreground"
                          onClick={() => toggleThread(thread.key)}
                          aria-expanded={!collapsed}
                          title={thread.label}
                        >
                          <span aria-hidden="true">
                            {collapsed ? "▶" : "▼"}
                          </span>
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 tabular-nums text-foreground">
                            {thread.requests.length} Requests
                          </span>
                        </button>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {summary.flow ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {summary.user ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        —
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        —
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {summary.runtime === null
                          ? "—"
                          : formatDuration(summary.runtime)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-success">
                        {summary.cost != null && summary.cost > 0
                          ? formatCost(summary.cost)
                          : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={groupBadge.variant}>
                          {groupBadge.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {groupStarted === null ||
                        Number.isNaN(groupStarted.getTime())
                          ? "—"
                          : formatDateTime(groupStarted)}
                      </TableCell>
                      {hasActions && <TableCell />}
                    </TableRow>
                    {!collapsed &&
                      thread.requests.map((e) => (
                        <RequestRow
                          key={e.execution_id}
                          execution={e}
                          threadChild
                          onViewEvents={onViewEvents}
                          onDownloadDebug={onDownloadDebug}
                          downloadingId={downloadingId}
                          onAnalyze={onAnalyze}
                          analyzingId={analyzingId}
                          onOpenTrace={onOpenTrace}
                          onReplay={onReplay}
                          replayingId={replayingId}
                        />
                      ))}
                  </React.Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {showPager && totalCount > 0 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {pageStart}–{pageEnd} of {totalCount}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!canPrev}
              onClick={() =>
                onOffsetChange?.(Math.max(currentOffset - size, 0))
              }
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!canNext}
              onClick={() => onOffsetChange?.(currentOffset + size)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

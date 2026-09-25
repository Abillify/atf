"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useMemo, useState } from "react";
import type { PersistedExecution } from "../types/history";
import { FlowMultiSelect } from "./FlowMultiSelect";
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

/** Formats an estimated cost (currency-agnostic, no symbol) for display. */
function formatCost(cost: number): string {
  if (cost === 0) return "0";
  if (cost < 0.01) return cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return cost.toFixed(cost < 1 ? 4 : 2);
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

  const selectClass =
    "rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground";
  const [collapsedThreads, setCollapsedThreads] = useState<Set<string>>(
    () => new Set(),
  );
  const threads = useMemo(() => {
    const grouped = new Map<string, PersistedExecution[]>();
    for (const execution of executions) {
      const stableId =
        execution.conversation_id ?? execution.chat_id ?? execution.session_id;
      const key = stableId == null
        ? `execution:${execution.execution_id}`
        : `thread:${stableId}`;
      const values = grouped.get(key) ?? [];
      values.push(execution);
      grouped.set(key, values);
    }
    return [...grouped.entries()]
      .map(([key, requests]) => ({
        key,
        label: key.startsWith("thread:") ? key.slice(7) : requests[0]?.execution_id ?? key,
        requests: requests.sort(
          (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
        ),
      }))
      .sort((a, b) => {
        const aTime = new Date(a.requests.at(-1)?.started_at ?? 0).getTime();
        const bTime = new Date(b.requests.at(-1)?.started_at ?? 0).getTime();
        return bTime - aTime;
      });
  }, [executions]);
  const columnCount =
    9 + Number(Boolean(onViewEvents)) + Number(Boolean(onDownloadDebug)) +
    Number(Boolean(onAnalyze)) + Number(Boolean(onReplay));
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
            <>
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
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  User
                  <select
                    className={selectClass}
                    value={userFilter ?? ""}
                    onChange={(ev) => onUserFilterChange(ev.target.value)}
                  >
                    <option value="">All</option>
                    {(userOptions ?? []).map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
          {onRefresh && (
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              Refresh
            </Button>
          )}
        </div>
      </div>
      {isLoading && executions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
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
              <TableHeaderCell>Flow</TableHeaderCell>
              <TableHeaderCell>User</TableHeaderCell>
              <TableHeaderCell className="text-right">Nodes</TableHeaderCell>
              <TableHeaderCell className="text-right">Latency</TableHeaderCell>
              <TableHeaderCell className="text-right">Runtime</TableHeaderCell>
              <TableHeaderCell className="text-right">Cost</TableHeaderCell>
              <TableHeaderCell className="text-center">Status</TableHeaderCell>
              <TableHeaderCell className="text-right">Started</TableHeaderCell>
              {onViewEvents && (
                <TableHeaderCell className="text-right">Debug</TableHeaderCell>
              )}
              {onDownloadDebug && (
                <TableHeaderCell className="text-right">Export</TableHeaderCell>
              )}
              {onAnalyze && (
                <TableHeaderCell className="text-right">Analyze</TableHeaderCell>
              )}
              {onReplay && (
                <TableHeaderCell className="text-right">Replay</TableHeaderCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {threads.map((thread) => {
              const collapsed = collapsedThreads.has(thread.key);
              return (
                <React.Fragment key={thread.key}>
                  <TableRow className="bg-muted/60">
                    <TableCell colSpan={columnCount}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 text-left text-xs font-medium text-foreground"
                        onClick={() => toggleThread(thread.key)}
                        aria-expanded={!collapsed}
                      >
                        <span aria-hidden="true">{collapsed ? "▶" : "▼"}</span>
                        <span className="font-mono">{thread.label}</span>
                        <span className="text-muted-foreground">
                          {thread.requests.length} Request{thread.requests.length === 1 ? "" : "s"}
                        </span>
                      </button>
                    </TableCell>
                  </TableRow>
                  {!collapsed && thread.requests.map((e) => {
                    const b = badge(e.status);
                    const started = new Date(e.started_at);
                    return (
                <TableRow key={e.execution_id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.execution_id.slice(0, 8)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.flow_id ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.user_name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.node_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {e.total_latency_ms ?? 0} ms
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {(() => {
                      const r = runtimeMs(e);
                      return r === null ? "—" : formatDuration(r);
                    })()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-emerald-700">
                    {e.total_cost != null && e.total_cost > 0
                      ? formatCost(e.total_cost)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={b.variant}>{b.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {Number.isNaN(started.getTime())
                      ? "—"
                      : started.toLocaleString()}
                  </TableCell>
                  {onViewEvents && (
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onViewEvents(e.execution_id)}
                        title="Open in Live Graph — shows system prompt, tool calls and response per node"
                      >
                        View
                      </Button>
                    </TableCell>
                  )}
                  {onDownloadDebug && (
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onDownloadDebug(e.execution_id)}
                        disabled={downloadingId === e.execution_id}
                        title="Download the full debug trace as JSON — all prompts, LLM responses, tool calls with results, RAG chunks and tool selection"
                      >
                        {downloadingId === e.execution_id ? "…" : "JSON"}
                      </Button>
                    </TableCell>
                  )}
                  {onAnalyze && (
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onAnalyze(e.execution_id)}
                        disabled={analyzingId === e.execution_id}
                        title="Run an LLM post-mortem of this run — root cause, findings and improvement suggestions from its debug trace"
                      >
                        {analyzingId === e.execution_id ? "…" : "Analyze"}
                      </Button>
                    </TableCell>
                  )}
                  {onReplay && (
                    <TableCell className="text-right">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => onReplay(e.execution_id)}
                        disabled={replayingId === e.execution_id}
                      >
                        {replayingId === e.execution_id ? "…" : "Replay"}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
                    );
                  })}
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

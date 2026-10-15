"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Filter, Search, X } from "lucide-react";
import { Badge, Button } from "../lib/ui";
import { FlowMultiSelect } from "./FlowMultiSelect";
import { UserSelectFilter } from "./UserSelectFilter";
import { formatDate, formatTime, translate } from "../lib/i18n";

export interface ExecutionPickerItem {
  executionId: string;
  /** Epoch ms when the run started; 0 when unknown. */
  startedAt: number;
  status: "running" | "completed" | "error";
  nodeCount: number;
  errorCount: number;
  flowId?: string | null;
  /** True when the run's events are in the live SSE buffer. */
  live: boolean;
  /** Display name of the user who triggered the run, when known. */
  user?: string | null;
  /** Preview of the user's prompt (last user message), when known. */
  prompt?: string | null;
  /** Wall-clock duration of the run in ms; undefined while unknown. */
  durationMs?: number | undefined;
  /** Total estimated cost of the run (sum of node costs); undefined when none. */
  cost?: number | undefined;
}

export interface ExecutionPickerProps {
  items: ExecutionPickerItem[];
  flowOptions?: string[];
  /** Flow names by id, shown and searchable in the flow filters. */
  flowNames?: ReadonlyMap<string, string>;
  /** Free-text keyword the visible flows are filtered by (id or name). */
  flowQuery?: string;
  onFlowQueryChange?: (query: string) => void;
  /** Flow ids that must be shown. An empty list includes every flow. */
  includeFlows?: string[];
  /** Flow ids that must be hidden (takes precedence over inclusion). */
  excludeFlows?: string[];
  onIncludeFlowsChange?: (flows: string[]) => void;
  onExcludeFlowsChange?: (flows: string[]) => void;
  /** Distinct user names to offer in the user filter (from history facets). */
  userOptions?: string[];
  /** Currently selected user filter ("" = all users). */
  userFilter?: string;
  /** Called when the user filter changes ("" clears it). */
  onUserFilterChange?: (userName: string) => void;
  /** Currently selected execution_id, or null while following live. */
  selectedId: string | null;
  /** True when the view auto-tracks the newest execution. */
  following: boolean;
  onSelect: (executionId: string) => void;
  onFollowLive: () => void;
  /** Clears the durable execution history. Optional. */
  onClearHistory?: () => void;
}

function statusDot(status: ExecutionPickerItem["status"]): string {
  switch (status) {
    case "running":
      return "bg-warning-solid";
    case "error":
      return "bg-danger-solid";
    case "completed":
      return "bg-success-solid";
  }
}

/** Formats a millisecond duration compactly (e.g. "820ms", "2.4s", "1m 3s"). */
function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/**
 * Sidebar list of recent executions. Selecting one scopes the Live Graph to
 * that single run; "Follow live" returns to auto-tracking the newest run.
 */
export function ExecutionPicker({
  items,
  flowOptions,
  flowNames,
  flowQuery = "",
  onFlowQueryChange,
  includeFlows = [],
  excludeFlows = [],
  onIncludeFlowsChange,
  onExcludeFlowsChange,
  userOptions,
  userFilter = "",
  onUserFilterChange,
  selectedId,
  following,
  onSelect,
  onFollowLive,
  onClearHistory,
}: ExecutionPickerProps): React.JSX.Element {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement | null>(null);

  // Close the include/exclude popover on outside click or Escape.
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
    includeFlows.length + excludeFlows.length + (userFilter !== "" ? 1 : 0);
  const showFilterButton =
    onIncludeFlowsChange !== undefined ||
    onExcludeFlowsChange !== undefined ||
    onUserFilterChange !== undefined;

  return (
    <aside className="flex w-full shrink-0 flex-col border-r border-border bg-card lg:w-64">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {translate("executionPicker.requests")}
        </h3>
        <button type="button"
          onClick={onFollowLive}
          className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
            following
              ? "bg-accent text-accent-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted"
          }`}
          aria-pressed={following}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              following ? "bg-card" : "bg-accent"
            }`}
          />
          {translate("executionPicker.live")}
        </button>
      </div>

      {(onFlowQueryChange || showFilterButton) && (
        <div className="flex items-center gap-1.5 border-b border-border p-2">
          {onFlowQueryChange && (
            <div className="relative min-w-0 flex-1">
              <Search
                size={13}
                aria-hidden
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={flowQuery}
                onChange={(e) => onFlowQueryChange(e.target.value)}
                placeholder={translate("executions.filterPlaceholder")}
                aria-label={translate("executions.filterLabel")}
                className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-6 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-accent"
              />
              {flowQuery !== "" && (
                <button
                  type="button"
                  onClick={() => onFlowQueryChange("")}
                  aria-label={translate("executions.clearKeyword")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X size={13} aria-hidden />
                </button>
              )}
            </div>
          )}
          {showFilterButton && (
            <div className="relative shrink-0" ref={filterRef}>
              <button
                type="button"
                onClick={() => setFilterOpen((open) => !open)}
                aria-expanded={filterOpen}
                aria-label={translate("executions.filterButton")}
                title={translate("executions.filterButton")}
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
                      label={translate("executions.includeFlows")}
                      options={flowOptions ?? []}
                      {...(flowNames !== undefined ? { names: flowNames } : {})}
                      value={includeFlows}
                      onChange={onIncludeFlowsChange}
                    />
                  )}
                  {onExcludeFlowsChange && (
                    <FlowMultiSelect
                      label={translate("executions.excludeFlows")}
                      options={flowOptions ?? []}
                      {...(flowNames !== undefined ? { names: flowNames } : {})}
                      value={excludeFlows}
                      onChange={onExcludeFlowsChange}
                    />
                  )}
                  {onUserFilterChange && (
                    <UserSelectFilter
                      label={translate("executionPicker.user")}
                      options={userOptions ?? []}
                      value={userFilter}
                      onChange={onUserFilterChange}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {translate("executionPicker.noRequestsYet")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => {
              const active = !following && it.executionId === selectedId;
              return (
                <li key={it.executionId}>
                  <button type="button"
                    onClick={() => onSelect(it.executionId)}
                    className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                      active ? "bg-accent/10" : "hover:bg-muted"
                    }`}
                    aria-current={active}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusDot(
                          it.status,
                        )} ${it.status === "running" ? "animate-pulse" : ""}`}
                      />
                      <span className="truncate text-xs font-medium text-foreground">
                        {it.user && it.user.trim() !== ""
                          ? it.user
                          : translate("executionPicker.anonymous")}
                      </span>
                      {!it.live && (
                        <Badge
                          variant="outline"
                          className="ml-auto uppercase"
                          title={translate("executionPicker.loadedFromDurableHistory")}
                        >
                          hist
                        </Badge>
                      )}
                    </div>
                    {it.flowId && (
                      <div
                        className="flex items-center gap-1 text-[11px] font-medium text-accent"
                        title={translate("executionPicker.flowFlowId", { flowId: it.flowId })}
                      >
                        <svg
                          className="h-3 w-3 shrink-0 text-accent"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          aria-hidden="true"
                        >
                          <circle cx="6" cy="6" r="2.5" />
                          <circle cx="18" cy="18" r="2.5" />
                          <path d="M8 6h6a4 4 0 0 1 4 4v6" />
                        </svg>
                        <span className="truncate">{it.flowId}</span>
                      </div>
                    )}
                    {it.prompt && it.prompt.trim() !== "" && (
                      <p
                        className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
                        title={it.prompt}
                      >
                        {it.prompt}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>
                        {it.nodeCount} node{it.nodeCount === 1 ? "" : "s"}
                        {it.errorCount > 0 && (
                          <span className="ml-1 text-danger">
                            · {it.errorCount} err
                          </span>
                        )}
                        {formatDuration(it.durationMs) && (
                          <span className="ml-1 text-muted-foreground">
                            · {formatDuration(it.durationMs)}
                          </span>
                        )}
                        {it.cost != null && (
                          <span
                            className="ml-1 font-medium text-success"
                            title={translate("executionPicker.estimatedCost")}
                          >
                            · {it.cost.toFixed(4)}
                          </span>
                        )}
                      </span>
                      <span className="text-right leading-tight">
                        <span className="block">
                          {it.startedAt
                            ? formatTime(it.startedAt)
                            : "—"}
                        </span>
                        <span className="block">
                          {it.startedAt
                            ? formatDate(it.startedAt,  {
                                  day: "2-digit",
                                  month: "2-digit",
                                  year: "2-digit",
                                })
                            : ""}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className="font-mono">
                        {it.executionId.slice(0, 8)}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {onClearHistory && (
        <div className="border-t border-border p-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={onClearHistory}
            disabled={items.length === 0}
            className="w-full"
            title={translate("executionPicker.deleteAllStoredRequestsFrom")}
          >
            {translate("executionPicker.clearHistory")}
          </Button>
        </div>
      )}
    </aside>
  );
}

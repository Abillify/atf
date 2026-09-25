"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import { Badge, Button } from "../lib/ui";
import { FlowMultiSelect } from "./FlowMultiSelect";

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
  /** Flow ids that must be shown. An empty list includes every flow. */
  includeFlows?: string[];
  /** Flow ids that must be hidden (takes precedence over inclusion). */
  excludeFlows?: string[];
  onIncludeFlowsChange?: (flows: string[]) => void;
  onExcludeFlowsChange?: (flows: string[]) => void;
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
      return "bg-yellow-500";
    case "error":
      return "bg-red-500";
    case "completed":
      return "bg-green-500";
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
  includeFlows = [],
  excludeFlows = [],
  onIncludeFlowsChange,
  onExcludeFlowsChange,
  selectedId,
  following,
  onSelect,
  onFollowLive,
  onClearHistory,
}: ExecutionPickerProps): React.JSX.Element {
  return (
    <aside className="flex w-full shrink-0 flex-col border-r border-border bg-card lg:w-64">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Requests
        </h3>
        <button
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
          Live
        </button>
      </div>

      {(onIncludeFlowsChange || onExcludeFlowsChange) && (
        <div className="flex flex-col gap-2 border-b border-border p-2">
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
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No requests yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => {
              const active = !following && it.executionId === selectedId;
              return (
                <li key={it.executionId}>
                  <button
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
                          : "Anonymous"}
                      </span>
                      {!it.live && (
                        <Badge
                          variant="outline"
                          className="ml-auto uppercase"
                          title="Loaded from durable history"
                        >
                          hist
                        </Badge>
                      )}
                    </div>
                    {it.flowId && (
                      <div
                        className="flex items-center gap-1 text-[11px] font-medium text-accent"
                        title={`Flow: ${it.flowId}`}
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
                          <span className="ml-1 text-red-600 dark:text-red-400">
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
                            className="ml-1 font-medium text-emerald-600"
                            title="Estimated cost"
                          >
                            · {it.cost.toFixed(4)}
                          </span>
                        )}
                      </span>
                      <span>
                        {it.startedAt
                          ? new Date(it.startedAt).toLocaleTimeString()
                          : "—"}
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
            title="Delete all stored requests from the history"
          >
            Clear history
          </Button>
        </div>
      )}
    </aside>
  );
}

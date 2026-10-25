"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * useExecutionScoping — encapsulates the Live Graph's execution-selection logic.
 *
 * Extracts from the monolithic page.tsx:
 *   - liveExecutions:   picker rows built from the SSE buffer (newest first)
 *   - pickerItems:      merged live + durable history rows (newest first)
 *   - displayEvents:    events scoped to the currently selected execution
 *   - effectiveExecutionId, following, selectedExecutionId
 *   - handlers: handleSelectExecution, handleFollowLive
 *
 */

import { useState, useEffect, useMemo, useRef } from "react";
import type { NodeExecutionEvent } from "../types/monitoring";
import type { ExecutionPickerItem } from "../components/ExecutionPicker";
import type { PersistedExecution } from "../types/history";
import { useExecutionEvents } from "./useExecutionEvents";
import { useExecutionDebugTrace } from "./useExecutionDebugTrace";
import { FLOW_END_NODE_ID } from "../components/graph/graphUtils";
import type { DebugTrace } from "../types/debug-trace";

export interface UseExecutionScopingOptions {
  /** Accumulated live SSE events from useMonitoringEvents. */
  events: NodeExecutionEvent[];
  /** Durable history rows from useHistory. */
  executions: PersistedExecution[];
  /** Optional operator token passed through to useExecutionEvents. */
  token?: string;
  /**
   * Free-text keyword; only runs matching the flow id/display name, the
   * execution (request) id, the user name, or the user prompt are listed.
   */
  flowQuery?: string;
  /** Flow names by id, used to match `flowQuery` against display names. */
  flowNames?: ReadonlyMap<string, string>;
  includeFlows?: string[];
  excludeFlows?: string[];
  /**
   * When set (non-empty), only runs triggered by this user (display name,
   * matched case-insensitively) are listed — the Live Graph counterpart of
   * the History user filter.
   */
  userFilter?: string;
}

export interface UseExecutionScopingResult {
  /** Per-execution picker rows derived from the live SSE buffer. */
  liveExecutions: ExecutionPickerItem[];
  /** Merged live + durable history rows shown in ExecutionPicker. */
  pickerItems: ExecutionPickerItem[];
  /** Events scoped to the execution currently shown in the graph. */
  displayEvents: NodeExecutionEvent[];
  /**
   * Full debug trace of the execution currently shown, or null when it is
   * unavailable (evicted from the runtime's bounded in-memory buffer, still
   * loading, or fetch failed). Backs the node detail panel's full error
   * recording (error type/details, diagnostics timeline, tool results).
   */
  debugTrace: DebugTrace | null;
  /** The execution_id currently displayed (may be null when nothing is tracked). */
  effectiveExecutionId: string | null;
  /** True when "Follow Live" mode is active. */
  following: boolean;
  /** The user-selected execution_id (only set when not following). */
  selectedExecutionId: string | null;
  /** Select a specific execution and stop following live. */
  handleSelectExecution: (id: string) => void;
  /** Resume following the newest live execution. */
  handleFollowLive: () => void;
}

/**
 * Reads `?execution=<id>` from the current URL, if present. Read once at
 * mount time (not reactive) — the Live Graph deep-link is a one-shot initial
 * selection, not a controlled binding, so navigating the picker afterwards
 * does not fight with the URL.
 */
function readExecutionIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("execution");
  return raw !== null && raw.trim() !== "" ? raw : null;
}

export function useExecutionScoping({
  events,
  executions,
  token,
  flowQuery = "",
  flowNames,
  includeFlows = [],
  excludeFlows = [],
  userFilter = "",
}: UseExecutionScopingOptions): UseExecutionScopingResult {
  // A `?execution=<id>` deep link (e.g. the History "View" button) selects
  // that run up front instead of the default Follow Live mode — otherwise the
  // picker always jumps back to whatever is newest, ignoring the link.
  const deepLinkExecutionId = useRef(readExecutionIdFromUrl()).current;
  const [following, setFollowing] = useState(deepLinkExecutionId === null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(
    deepLinkExecutionId,
  );
  const historicEvents = useExecutionEvents(
    token !== undefined ? { token } : undefined,
  );
  // Full debug trace of the effective execution — the structured error
  // recording (type, details, diagnostics, tool results) the SSE event
  // stream does not carry. Best-effort: traces live in a bounded in-memory
  // buffer on the runtime, so older runs legitimately have none.
  const debugTraceState = useExecutionDebugTrace(
    token !== undefined ? { token } : undefined,
  );

  // Keep the address bar in sync with the selected execution so the URL stays
  // shareable/bookmarkable and a reload reopens the same run. Following mode
  // (no explicit selection) clears the param.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (following || selectedExecutionId === null) {
      if (!url.searchParams.has("execution")) return;
      url.searchParams.delete("execution");
    } else {
      if (url.searchParams.get("execution") === selectedExecutionId) return;
      url.searchParams.set("execution", selectedExecutionId);
    }
    window.history.replaceState(null, "", url.toString());
  }, [following, selectedExecutionId]);

  // -------------------------------------------------------------------------
  // Build per-execution picker rows from the live SSE buffer (newest first).
  // -------------------------------------------------------------------------
  const liveExecutions = useMemo<ExecutionPickerItem[]>(() => {
    const byExec = new Map<string, typeof events>();
    for (const e of events) {
      const list = byExec.get(e.execution_id) ?? [];
      list.push(e);
      byExec.set(e.execution_id, list);
    }
    const items: ExecutionPickerItem[] = [];
    for (const [id, evs] of byExec) {
      const latestByNode = new Map<string, (typeof evs)[number]>();
      for (const e of evs) {
        // The engine's terminal rollup marker is not a node: counting it
        // would double the error count of a failed run.
        if (e.node_id === FLOW_END_NODE_ID) continue;
        latestByNode.set(e.node_id, e);
      }
      let errorCount = 0;
      let running = 0;
      let startedAt = Number.POSITIVE_INFINITY;
      let lastAt = 0;
      let cost = 0;
      let user: string | undefined;
      let prompt: string | undefined;
      let flowId: string | undefined;
      for (const e of latestByNode.values()) {
        if (e.status === "error") errorCount++;
        else if (e.status === "running") running++;
        if (e.cost) cost += e.cost;
        const t = new Date(e.start_time).getTime();
        if (!Number.isNaN(t)) startedAt = Math.min(startedAt, t);
        const end = e.end_time ? new Date(e.end_time).getTime() : t;
        if (!Number.isNaN(end)) lastAt = Math.max(lastAt, end);
        if (e.user_name && user === undefined) user = e.user_name;
        if (e.user_prompt && prompt === undefined) prompt = e.user_prompt;
        if (e.flow_id && flowId === undefined) flowId = e.flow_id;
      }
      const start = Number.isFinite(startedAt) ? startedAt : 0;
      const durationMs =
        running > 0
          ? start > 0
            ? Date.now() - start
            : undefined
          : start > 0 && lastAt >= start
            ? lastAt - start
            : undefined;
      items.push({
        executionId: id,
        startedAt: start,
        status:
          running > 0 ? "running" : errorCount > 0 ? "error" : "completed",
        nodeCount: latestByNode.size,
        errorCount,
        live: true,
        ...(flowId !== undefined ? { flowId } : {}),
        ...(user !== undefined ? { user } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(cost > 0 ? { cost } : {}),
      });
    }
    return items.sort((a, b) => b.startedAt - a.startedAt);
  }, [events]);

  const liveIds = useMemo(
    () => new Set(liveExecutions.map((e) => e.executionId)),
    [liveExecutions],
  );

  // -------------------------------------------------------------------------
  // Merge live runs with durable history (exclude rows already in live buffer).
  // -------------------------------------------------------------------------
  const pickerItems = useMemo<ExecutionPickerItem[]>(() => {
    // Backfill identity fields on live rows from the durable history. A live
    // row can be built solely from events that arrived after the dashboard
    // joined a run in progress (e.g. only synthetic tool-node events, when
    // the `__request__` boundary was missed); until the parent node's
    // terminal event lands, such a row has no user/prompt. The durable
    // `executions` row carries both immediately — the runtime persists them
    // from the `__request__` boundary event — so use them as a fallback.
    // Values already seen live always win.
    const durableById = new Map<string, PersistedExecution>();
    for (const e of executions) durableById.set(e.execution_id, e);
    const live = liveExecutions.map((item) => {
      const needsUser = item.user === undefined;
      const needsPrompt = item.prompt === undefined;
      const needsFlow = item.flowId === undefined;
      if (!needsUser && !needsPrompt && !needsFlow) return item;
      const durable = durableById.get(item.executionId);
      if (durable === undefined) return item;
      const user = item.user ?? durable.user_name ?? undefined;
      const prompt = item.prompt ?? durable.user_prompt ?? undefined;
      const flowId = item.flowId ?? durable.flow_id ?? undefined;
      return {
        ...item,
        ...(user !== undefined ? { user } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        ...(flowId !== undefined ? { flowId } : {}),
      };
    });
    const persisted: ExecutionPickerItem[] = executions
      .filter((e) => !liveIds.has(e.execution_id))
      .map((e) => {
        const start = e.started_at ? new Date(e.started_at).getTime() : 0;
        const end = e.finished_at ? new Date(e.finished_at).getTime() : 0;
        const wall = start > 0 && end >= start ? end - start : undefined;
        const durationMs =
          wall ??
          (e.total_latency_ms !== null ? e.total_latency_ms : undefined);
        return {
          executionId: e.execution_id,
          startedAt: start,
          status: e.status,
          nodeCount: e.node_count,
          errorCount: e.error_count,
          ...(e.flow_id !== null ? { flowId: e.flow_id } : {}),
          live: false,
          ...(e.user_name != null ? { user: e.user_name } : {}),
          ...(e.user_prompt != null ? { prompt: e.user_prompt } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(e.total_cost != null && e.total_cost > 0
            ? { cost: e.total_cost }
            : {}),
        };
      });
    return [...live, ...persisted]
      .filter((item) => {
        const flowId = item.flowId ?? "";
        if (excludeFlows.includes(flowId)) return false;
        if (includeFlows.length > 0 && !includeFlows.includes(flowId))
          return false;
        // User filter (Live Graph parity with History): exact display-name
        // match, case-insensitive. Rows whose user is not yet known (live
        // runs whose identity has not been backfilled) are hidden while a
        // user filter is active.
        const user = userFilter.trim().toLowerCase();
        if (user !== "" && (item.user ?? "").trim().toLowerCase() !== user)
          return false;
        const q = flowQuery.trim().toLowerCase();
        if (q !== "") {
          // Free-text keyword across the row's identifying fields: flow
          // id/display name, execution (request) id, user name, and the user
          // prompt — matching any one of them keeps the row visible.
          const name = flowNames?.get(flowId) ?? flowId;
          const haystack = [
            flowId,
            name,
            item.executionId,
            item.user ?? "",
            item.prompt ?? "",
          ]
            .join("\n")
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [
    liveExecutions,
    executions,
    liveIds,
    flowQuery,
    flowNames,
    includeFlows,
    excludeFlows,
    userFilter,
  ]);

  // -------------------------------------------------------------------------
  // Resolve the effective execution to display.
  // -------------------------------------------------------------------------
  const latestExecutionId = pickerItems[0]?.executionId ?? null;
  const effectiveExecutionId = following
    ? latestExecutionId
    : selectedExecutionId;

  // Fetch durable events for the effective execution. Always load — even for
  // a run still present in the live SSE buffer — because the live buffer may
  // be missing early events (e.g. the `__request__` boundary emitted before
  // this browser tab's SSE connection was established, or replayed out of
  // order after a reconnect). The durable audit log is the source of truth;
  // the live buffer only fills in events that haven't landed there yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loaders are the trigger targets; only a new execution id re-fetches
  useEffect(() => {
    if (effectiveExecutionId === null) return;
    void historicEvents.load(effectiveExecutionId);
    void debugTraceState.load(effectiveExecutionId);
  }, [effectiveExecutionId]);

  // Re-fetch the durable log for a still-live execution once it completes, so
  // events recorded after the initial fetch (the run was still in progress)
  // are picked up without requiring a manual reselect.
  const effectiveStatus = useMemo(() => {
    if (effectiveExecutionId === null) return undefined;
    return pickerItems.find((p) => p.executionId === effectiveExecutionId)
      ?.status;
  }, [effectiveExecutionId, pickerItems]);
  const prevStatusRef = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch only on the running -> finished transition, not when the loaders change
  useEffect(() => {
    if (
      effectiveExecutionId !== null &&
      prevStatusRef.current === "running" &&
      effectiveStatus !== "running"
    ) {
      void historicEvents.load(effectiveExecutionId, true);
      // The trace only gains node detail as nodes complete — a run fetched
      // while running has an incomplete (or absent) error record.
      void debugTraceState.load(effectiveExecutionId, true);
    }
    prevStatusRef.current = effectiveStatus;
  }, [effectiveExecutionId, effectiveStatus]);

  // Events scoped to the execution currently shown in the graph: the durable
  // (persisted) events merged with any live events not yet reflected there —
  // e.g. a node that started after the last durable fetch. Persisted events
  // come first so `deriveNodeStates` processes them before newer live ones.
  const displayEvents = useMemo<NodeExecutionEvent[]>(() => {
    if (effectiveExecutionId === null) return [];
    const persisted =
      historicEvents.executionId === effectiveExecutionId
        ? historicEvents.events
        : [];
    if (!liveIds.has(effectiveExecutionId)) return persisted;
    const live = events.filter((e) => e.execution_id === effectiveExecutionId);
    if (persisted.length === 0) return live;
    // Drop live events already represented in the persisted set (same node +
    // same start_time), then append the rest so newly-arrived live events
    // (a still-running node) still show up immediately.
    const seen = new Set(persisted.map((e) => `${e.node_id}::${e.start_time}`));
    const extra = live.filter(
      (e) => !seen.has(`${e.node_id}::${e.start_time}`),
    );
    return [...persisted, ...extra];
  }, [
    effectiveExecutionId,
    liveIds,
    events,
    historicEvents.executionId,
    historicEvents.events,
  ]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  const handleSelectExecution = (id: string): void => {
    setFollowing(false);
    setSelectedExecutionId(id);
  };

  const handleFollowLive = (): void => {
    setFollowing(true);
    setSelectedExecutionId(null);
  };

  return {
    liveExecutions,
    pickerItems,
    displayEvents,
    debugTrace:
      debugTraceState.executionId === effectiveExecutionId
        ? debugTraceState.trace
        : null,
    effectiveExecutionId,
    following,
    selectedExecutionId,
    handleSelectExecution,
    handleFollowLive,
  };
}

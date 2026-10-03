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
 * Requirements: 11.1, 11.3
 */

import { useState, useEffect, useMemo, useRef } from "react";
import type { NodeExecutionEvent } from "../types/monitoring";
import type { ExecutionPickerItem } from "../components/ExecutionPicker";
import type { PersistedExecution } from "../types/history";
import { useExecutionEvents } from "./useExecutionEvents";
import { FLOW_END_NODE_ID } from "../components/graph/graphUtils";

export interface UseExecutionScopingOptions {
  /** Accumulated live SSE events from useMonitoringEvents. */
  events: NodeExecutionEvent[];
  /** Durable history rows from useHistory. */
  executions: PersistedExecution[];
  /** Optional operator token passed through to useExecutionEvents. */
  token?: string;
  includeFlows?: string[];
  excludeFlows?: string[];
}

export interface UseExecutionScopingResult {
  /** Per-execution picker rows derived from the live SSE buffer. */
  liveExecutions: ExecutionPickerItem[];
  /** Merged live + durable history rows shown in ExecutionPicker. */
  pickerItems: ExecutionPickerItem[];
  /** Events scoped to the execution currently shown in the graph. */
  displayEvents: NodeExecutionEvent[];
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
  includeFlows = [],
  excludeFlows = [],
}: UseExecutionScopingOptions): UseExecutionScopingResult {
  // A `?execution=<id>` deep link (e.g. the History "View" button) selects
  // that run up front instead of the default Follow Live mode — otherwise the
  // picker always jumps back to whatever is newest, ignoring the link.
  const deepLinkExecutionId = useRef(readExecutionIdFromUrl()).current;
  const [following, setFollowing] = useState(deepLinkExecutionId === null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<
    string | null
  >(deepLinkExecutionId);
  const historicEvents = useExecutionEvents(
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
    return [...liveExecutions, ...persisted]
      .filter((item) => {
        const flowId = item.flowId ?? "";
        if (excludeFlows.includes(flowId)) return false;
        return includeFlows.length === 0 || includeFlows.includes(flowId);
      })
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [
    liveExecutions,
    executions,
    liveIds,
    includeFlows,
    excludeFlows,
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
  useEffect(() => {
    if (effectiveExecutionId === null) return;
    void historicEvents.load(effectiveExecutionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(() => {
    if (
      effectiveExecutionId !== null &&
      prevStatusRef.current === "running" &&
      effectiveStatus !== "running"
    ) {
      void historicEvents.load(effectiveExecutionId, true);
    }
    prevStatusRef.current = effectiveStatus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    effectiveExecutionId,
    following,
    selectedExecutionId,
    handleSelectExecution,
    handleFollowLive,
  };
}

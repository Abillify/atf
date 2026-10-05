"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

/** Per-flow run statistics over a time window (mirrors the runtime's FlowStats). */
export interface FlowStats {
  flow_id: string;
  runs: number;
  avg_latency_ms: number | null;
  avg_cost: number | null;
  total_cost: number | null;
}

export interface UseFlowStatsResult {
  /** Stats keyed by flow id — flows without runs in the window are absent. */
  stats: Map<string, FlowStats>;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches per-flow run statistics (runs, avg runtime, avg/total cost) for the
 * given window from `GET /monitoring/flow-stats?since=…`. Refetches whenever
 * `sinceIso` changes; paused while the tab is hidden, like the history poll.
 */
export function useFlowStats(
  sinceIso: string,
  options?: { enabled?: boolean; token?: string },
): UseFlowStatsResult {
  const enabled = options?.enabled ?? true;
  const token = options?.token;
  const isVisible = useDocumentVisibility();
  const [stats, setStats] = useState<Map<string, FlowStats>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    setIsLoading(true);
    const url = `${backendUrl("/monitoring/flow-stats")}?since=${encodeURIComponent(sinceIso)}`;
    authFetch(url, token, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as { stats?: FlowStats[] };
      })
      .then((data) => {
        if (cancelled) return;
        const map = new Map<string, FlowStats>();
        for (const row of data.stats ?? []) map.set(row.flow_id, row);
        setStats(map);
        setError(null);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sinceIso, enabled, isVisible, token]);

  return { stats, isLoading, error };
}

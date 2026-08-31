"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect } from "react";
import { EMPTY_SUMMARY, type MetricsSummary } from "../types/metrics";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseMetricsOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL + /monitoring/metrics */
  url?: string;
  /** Poll interval in ms. Default 5000. */
  intervalMs?: number;
  /** Default true */
  enabled?: boolean;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseMetricsResult {
  summary: MetricsSummary;
  isLoading: boolean;
  error: string | null;
}

function defaultUrl(): string {
  return backendUrl("/monitoring/metrics");
}

/**
 * Polls the backend's JSON metrics summary endpoint on an interval and exposes
 * the latest snapshot. Designed for the dashboard's aggregate panels (tokens,
 * cost, throughput) which complement the live SSE node-event stream.
 */
export function useMetrics(options?: UseMetricsOptions): UseMetricsResult {
  const url = options?.url ?? defaultUrl();
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;
  const token = options?.token;

  const [summary, setSummary] = useState<MetricsSummary>(EMPTY_SUMMARY);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isVisible = useDocumentVisibility();

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as MetricsSummary;
        if (!cancelled) {
          setSummary({ ...EMPTY_SUMMARY, ...data });
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        const aborted =
          err instanceof Error && err.name === "AbortError";
        if (!cancelled && !aborted) {
          setError(err instanceof Error ? err.message : "metrics fetch failed");
          setIsLoading(false);
        }
      } finally {
        if (!cancelled) {
          timeout = setTimeout(() => void tick(), intervalMs);
        }
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    };
  }, [url, intervalMs, enabled, isVisible, token]);

  return { summary, isLoading, error };
}

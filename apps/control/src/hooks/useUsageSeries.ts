"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect } from "react";
import type {
  UsageSeriesPoint,
  UsageBucket,
  LimitScopeType,
} from "../types/limits";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseUsageSeriesOptions {
  /** Inclusive range start (ISO or epoch ms). */
  fromIso: string;
  /** Exclusive range end (ISO or epoch ms). */
  toIso: string;
  bucket: UsageBucket;
  /** Optional scope/model filter. */
  scopeType?: LimitScopeType;
  scopeId?: string;
  model?: string;
  enabled?: boolean;
  token?: string;
  /** Poll interval in ms. Default 30000. */
  intervalMs?: number;
}

export interface UseUsageSeriesResult {
  series: UsageSeriesPoint[];
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the bucketed token/cost time-series for a free [from, to) range and
 * optional scope/model filter. Re-fetches whenever any input changes.
 */
export function useUsageSeries(
  options: UseUsageSeriesOptions,
): UseUsageSeriesResult {
  const {
    fromIso,
    toIso,
    bucket,
    scopeType,
    scopeId,
    model,
    enabled = true,
    token,
    intervalMs = 30000,
  } = options;

  const [series, setSeries] = useState<UsageSeriesPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isVisible = useDocumentVisibility();

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;

    const params = new URLSearchParams({ from: fromIso, to: toIso, bucket });
    if (scopeType !== undefined && scopeType !== "global") {
      params.set("scopeType", scopeType);
      if (scopeId) params.set("scopeId", scopeId);
    }
    if (model) params.set("model", model);
    const url = `${backendUrl("/monitoring/usage/timeseries")}?${params.toString()}`;

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { series?: UsageSeriesPoint[] };
        if (!cancelled) {
          setSeries(data.series ?? []);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "usage fetch failed");
          setIsLoading(false);
        }
      }
    };

    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // The flagged "error"/"series" below are `body.error` (from the
    // `as { error?: ... }` cast) and `data.series` (from the
    // `as { series?: ... }` cast) above, not the `error`/`series` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the casts' property names apart from the
    // same-named outer bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    isVisible,
    fromIso,
    toIso,
    bucket,
    scopeType,
    scopeId,
    model,
    token,
    intervalMs,
  ]);

  return { series, isLoading, error };
}

/** One-shot fetch of the distinct model names seen in the ledger. */
export function useUsageModels(
  enabled: boolean,
  token?: string,
): { models: string[] } {
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const url = backendUrl("/monitoring/usage/models");
    void authFetch(url, token, { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : { models: [] }))
      .then((data: { models?: string[] }) => {
        if (!cancelled) setModels(data.models ?? []);
      })
      .catch(() => {
        /* non-critical */
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, token]);
  return { models };
}

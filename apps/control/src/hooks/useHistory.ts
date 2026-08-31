"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback } from "react";
import type { PersistedExecution } from "../types/history";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseHistoryOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL + /monitoring/history */
  url?: string;
  /** Poll interval in ms. Default 10000. */
  intervalMs?: number;
  /** Default true */
  enabled?: boolean;
  /** Max rows to request (page size). Default 50. */
  limit?: number;
  /** Rows to skip from the newest end (for pagination). Default 0. */
  offset?: number;
  /** Included flow ids. Empty/undefined includes every flow. */
  includeFlows?: string[];
  /** Excluded flow ids. Exclusion takes precedence. */
  excludeFlows?: string[];
  /** When set, only executions triggered by this user (display name). */
  userName?: string;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseHistoryResult {
  executions: PersistedExecution[];
  /** Total number of rows matching the current filters (ignoring pagination). */
  total: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  /**
   * Clears the durable execution history on the backend, then refreshes.
   * Requires operator access; resolves to the number of runs removed.
   */
  clearHistory: () => Promise<number>;
}

function defaultUrl(): string {
  return backendUrl("/monitoring/history");
}

/**
 * Polls the backend's durable execution audit log. Unlike the live SSE stream
 * (which only shows events since the page was opened), this survives reloads
 * and shows historical runs persisted in Postgres.
 */
export function useHistory(options?: UseHistoryOptions): UseHistoryResult {
  const baseUrl = options?.url ?? defaultUrl();
  const intervalMs = options?.intervalMs ?? 10000;
  const enabled = options?.enabled ?? true;
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const includeFlows = options?.includeFlows;
  const excludeFlows = options?.excludeFlows;
  const includeFlowsKey = includeFlows?.join(",") ?? "";
  const excludeFlowsKey = excludeFlows?.join(",") ?? "";
  const userName = options?.userName;
  const token = options?.token;

  const [executions, setExecutions] = useState<PersistedExecution[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Pausing the poll while the tab is hidden avoids hammering the backend
  // with a fixed-interval history fetch nobody is viewing; the effect below
  // re-fetches immediately once the tab becomes visible again.
  const isVisible = useDocumentVisibility();

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const clearHistory = useCallback(async (): Promise<number> => {
    const res = await authFetch(baseUrl, token, {
      method: "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { cleared?: number };
    setExecutions([]);
    setNonce((n) => n + 1);
    return data.cleared ?? 0;
    // The flagged "error" below is `body.error` (from the
    // `as { error?: ... }` cast earlier in this callback), not the `error`
    // state. @babel/eslint-parser has no TypeScript type info, so
    // exhaustive-deps' scope analysis can't tell the cast's property name
    // apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token]);

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (includeFlowsKey) params.set("includeFlows", includeFlowsKey);
    if (excludeFlowsKey) params.set("excludeFlows", excludeFlowsKey);
    if (userName) params.set("user", userName);
    const fetchUrl = `${baseUrl}?${params.toString()}`;

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(fetchUrl, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          executions?: PersistedExecution[];
          total?: number;
        };
        if (!cancelled) {
          setExecutions(data.executions ?? []);
          setTotal(data.total ?? data.executions?.length ?? 0);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "history fetch failed");
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
    // The flagged "executions"/"total" below are `data.executions`/
    // `data.total` (from the cast above), not the `executions`/`total`
    // state. @babel/eslint-parser has no TypeScript type info, so
    // exhaustive-deps' scope analysis can't tell the cast's property names
    // apart from the same-named outer bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    baseUrl,
    intervalMs,
    enabled,
    isVisible,
    limit,
    offset,
    includeFlowsKey,
    excludeFlowsKey,
    userName,
    token,
    nonce,
  ]);

  return { executions, total, isLoading, error, refresh, clearHistory };
}

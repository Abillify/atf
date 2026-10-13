"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface HistoryFacets {
  /** Distinct flow ids present in the history, sorted. */
  flows: string[];
  /** Distinct user display names present in the history, sorted. */
  users: string[];
}

export interface UseHistoryFacetsOptions {
  /** Default true */
  enabled?: boolean;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
  /** Refetch trigger — change this value to force a reload (e.g. on refresh). */
  nonce?: number;
}

export interface UseHistoryFacetsResult {
  facets: HistoryFacets;
  isLoading: boolean;
  error: string | null;
}

/**
 * Loads the distinct flow ids and user names available for the History view's
 * filter dropdowns. Fetched once (and on `nonce` change) rather than polled.
 */
export function useHistoryFacets(
  options?: UseHistoryFacetsOptions,
): UseHistoryFacetsResult {
  const enabled = options?.enabled ?? true;
  const token = options?.token;
  const nonce = options?.nonce ?? 0;

  const [facets, setFacets] = useState<HistoryFacets>({ flows: [], users: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh trigger; the effect body intentionally does not read it
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const url = backendUrl("/monitoring/history/facets");

    void (async () => {
      try {
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Partial<HistoryFacets>;
        if (!cancelled) {
          setFacets({ flows: data.flows ?? [], users: data.users ?? [] });
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "facets fetch failed");
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, token, nonce]);

  return { facets, isLoading, error };
}

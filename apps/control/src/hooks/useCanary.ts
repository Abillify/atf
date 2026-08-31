"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect } from "react";
import type { CanaryStatusEntry } from "../types/control";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseCanaryOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL + /monitoring/canary */
  url?: string;
  /** Poll interval in ms. Default 5000. */
  intervalMs?: number;
  /** Default true */
  enabled?: boolean;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseCanaryResult {
  deployments: CanaryStatusEntry[];
  isLoading: boolean;
  error: string | null;
}

function defaultUrl(): string {
  return backendUrl("/monitoring/canary");
}

/** Polls the canary rollout status (traffic split, stats, rollback state). */
export function useCanary(options?: UseCanaryOptions): UseCanaryResult {
  const url = options?.url ?? defaultUrl();
  const intervalMs = options?.intervalMs ?? 5000;
  const enabled = options?.enabled ?? true;
  const token = options?.token;

  const [deployments, setDeployments] = useState<CanaryStatusEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isVisible = useDocumentVisibility();

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          deployments?: CanaryStatusEntry[];
        };
        if (!cancelled) {
          setDeployments(data.deployments ?? []);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "canary fetch failed");
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
    // The flagged "deployments" below is `data.deployments` (from the
    // `as { deployments?: ... }` cast above), not the `deployments` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs, enabled, isVisible, token]);

  return { deployments, isLoading, error };
}

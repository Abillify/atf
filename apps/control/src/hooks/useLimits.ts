"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback } from "react";
import type { LimitConsumption, TokenLimitInput } from "../types/limits";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseLimitsOptions {
  /** Poll interval in ms. Default 15000. */
  intervalMs?: number;
  /** Default true */
  enabled?: boolean;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseLimitsResult {
  limits: LimitConsumption[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  /** Create or update a limit (upsert by scope/model/period combo). */
  saveLimit: (input: TokenLimitInput) => Promise<void>;
  /** Update a specific limit by id. */
  updateLimit: (id: string, input: TokenLimitInput) => Promise<void>;
  /** Delete a limit by id. */
  deleteLimit: (id: string) => Promise<void>;
}

function limitUrl(path: string): string {
  return backendUrl(path);
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  throw new Error(body.error?.message ?? `HTTP ${res.status}`);
}

/**
 * Polls the configured token limits with their live consumption and exposes
 * mutation helpers (upsert / update / delete). Mutations refresh the list.
 */
export function useLimits(options?: UseLimitsOptions): UseLimitsResult {
  const intervalMs = options?.intervalMs ?? 15000;
  const enabled = options?.enabled ?? true;
  const token = options?.token;

  const [limits, setLimits] = useState<LimitConsumption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const isVisible = useDocumentVisibility();

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const saveLimit = useCallback(
    async (input: TokenLimitInput): Promise<void> => {
      const res = await authFetch(limitUrl("/monitoring/limits"), token, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
      });
      await throwIfNotOk(res);
      setNonce((n) => n + 1);
    },
    [token],
  );

  const updateLimit = useCallback(
    async (id: string, input: TokenLimitInput): Promise<void> => {
      const res = await authFetch(limitUrl(`/monitoring/limits/${id}`), token, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input),
      });
      await throwIfNotOk(res);
      setNonce((n) => n + 1);
    },
    [token],
  );

  const deleteLimit = useCallback(
    async (id: string): Promise<void> => {
      const res = await authFetch(limitUrl(`/monitoring/limits/${id}`), token, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      });
      await throwIfNotOk(res);
      setNonce((n) => n + 1);
    },
    [token],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh trigger; the effect body intentionally does not read it
  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    const url = limitUrl("/monitoring/limits");

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { limits?: LimitConsumption[] };
        if (!cancelled) {
          setLimits(data.limits ?? []);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "limits fetch failed");
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
    // The flagged "limits" below is `data.limits` (from the
    // `as { limits?: ... }` cast above), not the `limits` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, isVisible, token, nonce]);

  return {
    limits,
    isLoading,
    error,
    refresh,
    saveLimit,
    updateLimit,
    deleteLimit,
  };
}

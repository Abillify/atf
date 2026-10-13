"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback, useRef } from "react";
import type { OptimizationRun, OptimizerRunOptions } from "../types/optimizer";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseOptimizerOptions {
  /** Flow id whose optimization runs to poll. When undefined, no polling. */
  flowId?: string;
  /** Poll interval in ms. Default 3000 (runs progress in near-real-time). */
  intervalMs?: number;
  /** Default true */
  enabled?: boolean;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseOptimizerResult {
  /** Optimization runs for the selected flow, newest first. */
  runs: OptimizationRun[];
  isLoading: boolean;
  error: string | null;
  /** Manually refresh the run list now. */
  refresh: () => void;
  /**
   * Starts an optimization cycle (always async → returns fast, then polls).
   * Resolves to the initial run record, or null on failure.
   */
  run: (
    flowId: string,
    options?: OptimizerRunOptions,
  ) => Promise<OptimizationRun | null>;
  /** Promotes a variant from a completed run. Resolves true on success. */
  promote: (runId: string, variantLabel: string) => Promise<boolean>;
  /** True while a run is being triggered. */
  isTriggering: boolean;
}

/**
 * Polls the optimization runs for a flow and exposes run() / promote() actions.
 * A short poll interval keeps a running cycle's progress fresh (variants appear
 * one-by-one as they finish); triggering a run or promoting refreshes at once.
 */
export function useOptimizer(
  options?: UseOptimizerOptions,
): UseOptimizerResult {
  const flowId = options?.flowId;
  const intervalMs = options?.intervalMs ?? 3000;
  const enabled =
    (options?.enabled ?? true) && flowId !== undefined && flowId !== "";
  const token = options?.token;

  const [runs, setRuns] = useState<OptimizationRun[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const isVisible = useDocumentVisibility();

  const tokenRef = useRef(token);
  tokenRef.current = token;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh trigger; the effect body intentionally does not read it
  useEffect(() => {
    if (!enabled || !isVisible || flowId === undefined) {
      setRuns([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    const url = backendUrl(`/optimizer/${encodeURIComponent(flowId)}/runs`);

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(url, tokenRef.current, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { runs?: OptimizationRun[] };
        if (!cancelled) {
          setRuns(data.runs ?? []);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "optimizer fetch failed",
          );
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
    // The flagged "runs" below is `data.runs` (from the `as { runs?: ... }`
    // cast above), not the `runs` state. @babel/eslint-parser has no
    // TypeScript type info, so exhaustive-deps' scope analysis can't tell the
    // cast's property name apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, intervalMs, enabled, isVisible, nonce]);

  const run = useCallback(
    async (
      targetFlowId: string,
      opts?: OptimizerRunOptions,
    ): Promise<OptimizationRun | null> => {
      setIsTriggering(true);
      try {
        const url = backendUrl(
          `/optimizer/${encodeURIComponent(targetFlowId)}/run`,
        );
        const res = await authFetch(url, tokenRef.current, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Always async so a long cycle never blocks the UI; poll shows progress.
          body: JSON.stringify({ ...opts, async: true }),
        });
        setNonce((n) => n + 1); // start polling the new run immediately
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(detail?.error?.message ?? `HTTP ${res.status}`);
          return null;
        }
        return (await res.json()) as OptimizationRun;
      } catch (err) {
        setError(err instanceof Error ? err.message : "optimizer run failed");
        return null;
      } finally {
        setIsTriggering(false);
      }
    },
    // The flagged "error" below is `detail?.error` (from the
    // `as { error?: ... } | null` cast above), not the `error` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const promote = useCallback(
    async (runId: string, variantLabel: string): Promise<boolean> => {
      try {
        const url = backendUrl(
          `/optimizer/runs/${encodeURIComponent(runId)}/promote`,
        );
        const res = await authFetch(url, tokenRef.current, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantLabel }),
        });
        setNonce((n) => n + 1);
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(detail?.error?.message ?? `HTTP ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "promote failed");
        return false;
      }
    },
    // The flagged "error" below is `detail?.error` (from the
    // `as { error?: ... } | null` cast above), not the `error` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return { runs, isLoading, error, refresh, run, promote, isTriggering };
}

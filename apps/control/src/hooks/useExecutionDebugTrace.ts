"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useRef, useState } from "react";
import type { DebugTrace } from "../types/debug-trace";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface UseExecutionDebugTraceOptions {
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseExecutionDebugTraceResult {
  /** Trace for the most recently fetched execution, or null. */
  trace: DebugTrace | null;
  /** execution_id currently held in `trace`, or null. */
  executionId: string | null;
  isLoading: boolean;
  /**
   * True when the last fetch answered 404 — the trace was evicted from the
   * runtime's bounded in-memory ring buffer (or lost to a restart). This is
   * an expected outcome for older runs, not an error: the UI falls back to
   * the plain event `error_message`.
   */
  unavailable: boolean;
  error: string | null;
  /**
   * Fetch the debug trace for one execution. Set `force` for a run that was
   * still in progress at the last fetch — the trace only gains node detail
   * as nodes complete, so a completed run's trace is richer than the one
   * captured while it was still running.
   */
  load: (executionId: string, force?: boolean) => Promise<DebugTrace | null>;
}

/**
 * Fetches the full debug trace for one execution from
 * `GET /monitoring/debug/:executionId`. The trace carries the structured
 * error recording (error_type, error_details, the in-node diagnostics
 * timeline, and full tool-call result payloads) that the monitoring event
 * stream only reports as a bare `error_message`.
 *
 * Traces live in a bounded in-memory ring buffer on the runtime (last 200
 * executions, never persisted), so a 404 is handled as "trace unavailable"
 * rather than an error — the graph keeps working with event-level info.
 */
export function useExecutionDebugTrace(
  options?: UseExecutionDebugTraceOptions,
): UseExecutionDebugTraceResult {
  const token = options?.token;
  const [trace, setTrace] = useState<DebugTrace | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null value in the cache = "fetched, answered 404" — do not re-fetch.
  const cache = useRef<Map<string, DebugTrace | null>>(new Map());

  const load = useCallback(
    async (id: string, force = false): Promise<DebugTrace | null> => {
      if (!force && cache.current.has(id)) {
        const cached = cache.current.get(id) ?? null;
        setTrace(cached);
        setExecutionId(id);
        setUnavailable(cached === null);
        setError(null);
        return cached;
      }
      setIsLoading(true);
      try {
        const url = backendUrl(
          `/monitoring/debug/${encodeURIComponent(id)}`,
        );
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (res.status === 404) {
          // Evicted from the ring buffer (or runtime restarted): expected
          // for older runs — degrade to event-level error info, no error spam.
          cache.current.set(id, null);
          setTrace(null);
          setExecutionId(id);
          setUnavailable(true);
          setError(null);
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as DebugTrace;
        cache.current.set(id, data);
        setTrace(data);
        setExecutionId(id);
        setUnavailable(false);
        setError(null);
        return data;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "failed to load debug trace",
        );
        setTrace(null);
        setExecutionId(id);
        setUnavailable(false);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [token],
  );

  return { trace, executionId, isLoading, unavailable, error, load };
}

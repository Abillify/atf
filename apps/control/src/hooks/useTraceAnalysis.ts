"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useRef, useState } from "react";
import type {
  TraceAnalysis,
  TraceAnalysisOptions,
} from "../types/trace-analysis";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface UseTraceAnalysisOptions {
  /** Operator token, sent as an Authorization header (needs `flows:write`). */
  token?: string;
}

export interface UseTraceAnalysisResult {
  /** The most recent successful analysis, or null. */
  analysis: TraceAnalysis | null;
  /** Execution id currently being analysed (disables its row button). */
  analyzingId: string | null;
  /** Human-readable error / notice for the last attempt, or null. */
  error: string | null;
  /**
   * Runs the LLM post-mortem for `executionId` via
   * `POST /optimizer/analyze/:executionId`. Optional scope / goal.
   */
  analyze: (
    executionId: string,
    options?: TraceAnalysisOptions,
  ) => Promise<void>;
  /** Dismisses the current result / error. */
  clear: () => void;
}

/**
 * Client for the backend trace analyzer (`POST /optimizer/analyze/:executionId`).
 *
 * Maps the endpoint's status codes to actionable messages so the History UI can
 * explain WHY an analysis didn't run:
 *   - 501 → analyzer not configured (OPTIMIZER_ENABLED + a judge/analyzer model)
 *   - 404 → the debug trace aged out of the in-memory ring buffer
 *   - 401 → operator token required (`flows:write`)
 */
export function useTraceAnalysis(
  options?: UseTraceAnalysisOptions,
): UseTraceAnalysisResult {
  const [analysis, setAnalysis] = useState<TraceAnalysis | null>(null);
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokenRef = useRef(options?.token);
  tokenRef.current = options?.token;

  const analyze = useCallback(
    async (
      executionId: string,
      opts?: TraceAnalysisOptions,
    ): Promise<void> => {
      setAnalyzingId(executionId);
      setError(null);
      setAnalysis(null);

      const body: TraceAnalysisOptions = {
        ...(opts?.scopeNodeIds !== undefined &&
        opts.scopeNodeIds.length > 0
          ? { scopeNodeIds: opts.scopeNodeIds }
          : {}),
        ...(opts?.goal !== undefined && opts.goal !== ""
          ? { goal: opts.goal }
          : {}),
      };

      try {
        const url = backendUrl(
          `/optimizer/analyze/${encodeURIComponent(executionId)}`,
        );
        const res = await authFetch(url, tokenRef.current, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          const serverMsg = detail?.error?.message;
          let message: string;
          switch (res.status) {
            case 501:
              message =
                serverMsg ??
                "Trace analysis is not enabled (set OPTIMIZER_ENABLED and configure an analyzer/judge model on the backend).";
              break;
            case 404:
              message =
                serverMsg ??
                "No debug trace found for this execution — it may have aged out of the in-memory buffer. Analyse a more recent run.";
              break;
            case 401:
              message =
                "Unauthorized — an operator token (flows:write) is required to analyse traces.";
              break;
            default:
              message = serverMsg ?? `Analysis failed (HTTP ${res.status}).`;
          }
          setError(message);
          return;
        }

        const data = (await res.json()) as { analysis?: TraceAnalysis };
        if (data.analysis === undefined) {
          setError("Analysis returned no result.");
          return;
        }
        setAnalysis(data.analysis);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "trace analysis request failed",
        );
      } finally {
        setAnalyzingId(null);
      }
    },
    // The flagged "analysis"/"error" below are `data.analysis` (from the
    // `as { analysis?: ... }` cast) and `detail?.error` (from the
    // `as { error?: ... } | null` cast) above, not the `analysis`/`error`
    // state. @babel/eslint-parser has no TypeScript type info, so
    // exhaustive-deps' scope analysis can't tell the casts' property names
    // apart from the same-named outer bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const clear = useCallback(() => {
    setAnalysis(null);
    setError(null);
  }, []);

  return { analysis, analyzingId, error, analyze, clear };
}

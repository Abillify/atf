"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useRef, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface UseCreateVariantOptions {
  /** Operator token, sent as an Authorization header (needs `flows:write`). */
  token?: string;
}

export interface CreateVariantParams {
  /** Flow the suggestion belongs to (from the analysis). */
  flowId: string;
  /** Suggestion id — tracked so the triggering row can show a spinner. */
  suggestionId: string;
  /** The suggestion's structural edit (opaque here; validated server-side). */
  edit: unknown;
  /** Node the edit targets — used for the baseline diff (best-effort). */
  targetNodeId?: string;
  /** Restrict the run to a sub-section of the flow (from a scoped analysis). */
  scopeNodeIds?: string[];
}

export interface UseCreateVariantResult {
  /**
   * Starts a seed-only optimizer run for a single suggestion edit
   * (`POST /optimizer/:flowId/run` with `{ seedEdits:[edit], variantCount:0 }`).
   * Resolves to the flow id on success (so the caller can deep-link to the
   * Optimizer), or null on failure.
   */
  create: (params: CreateVariantParams) => Promise<string | null>;
  /** Suggestion id whose variant run is currently being started. */
  creatingId: string | null;
  /** Human-readable error from the last attempt, or null. */
  error: string | null;
  /** Clears the error. */
  clear: () => void;
}

/**
 * Turns a trace-analysis suggestion into an evaluated optimizer variant with a
 * single call. The optimizer applies the edit, validates it, evaluates it
 * against mined production cases and (if it wins) can promote it — the same
 * pipeline generated variants go through.
 */
export function useCreateVariant(
  options?: UseCreateVariantOptions,
): UseCreateVariantResult {
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokenRef = useRef(options?.token);
  tokenRef.current = options?.token;

  const create = useCallback(
    async (params: CreateVariantParams): Promise<string | null> => {
      setCreatingId(params.suggestionId);
      setError(null);
      try {
        const url = backendUrl(
          `/optimizer/${encodeURIComponent(params.flowId)}/run`,
        );
        const res = await authFetch(url, tokenRef.current, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seedEdits: [params.edit],
            // Seed-only: evaluate just this suggestion, no LLM generation.
            variantCount: 0,
            allowStructural: true,
            async: true,
            ...(params.targetNodeId !== undefined
              ? { targetNodeId: params.targetNodeId }
              : {}),
            ...(params.scopeNodeIds !== undefined &&
            params.scopeNodeIds.length > 0
              ? { scopeNodeIds: params.scopeNodeIds }
              : {}),
          }),
        });

        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          let message: string;
          if (res.status === 404 || res.status === 501) {
            message =
              "The optimizer is not enabled on the backend (set OPTIMIZER_ENABLED and configure a generator/judge model).";
          } else if (res.status === 401) {
            message =
              "Unauthorized — an operator token (flows:write) is required.";
          } else {
            message =
              detail?.error?.message ??
              `Failed to start the variant run (HTTP ${res.status}).`;
          }
          setError(message);
          return null;
        }

        return params.flowId;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "failed to start variant run",
        );
        return null;
      } finally {
        setCreatingId(null);
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

  const clear = useCallback(() => setError(null), []);

  return { create, creatingId, error, clear };
}

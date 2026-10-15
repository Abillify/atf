"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback, useRef } from "react";
import type { PendingApproval, ResolvedApproval } from "../types/control";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseApprovalsOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL + /monitoring/approvals */
  baseUrl?: string;
  /** Poll interval in ms. Default 3000 (approvals are time-sensitive). */
  intervalMs?: number;
  /** Default true */
  enabled?: boolean;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

/** Outcome of a decision POST; `status` is the HTTP status when one arrived. */
export interface ApprovalDecisionResult {
  ok: boolean;
  status?: number;
}
export interface UseApprovalsResult {
  pending: PendingApproval[];
  /** Recently-resolved decisions (newest first) for the current backend. */
  resolved: ResolvedApproval[];
  isLoading: boolean;
  error: string | null;
  /** Approve or deny a pending request. `ok` is true on success; a 403 carries `status: 403`. */
  resolve: (
    id: string,
    approved: boolean,
    opts?: { reason?: string; by?: string },
  ) => Promise<ApprovalDecisionResult>;
  refresh: () => void;
}

function backendBase(): string {
  return backendUrl("");
}

/**
 * Polls the pending tool-approval queue and exposes a resolve() action. The
 * short poll interval keeps a reviewer's inbox fresh; a resolve() triggers an
 * immediate refresh so the row disappears at once.
 */
export function useApprovals(
  options?: UseApprovalsOptions,
): UseApprovalsResult {
  const base = options?.baseUrl ?? `${backendBase()}/monitoring/approvals`;
  const intervalMs = options?.intervalMs ?? 3000;
  const enabled = options?.enabled ?? true;
  const token = options?.token;

  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [resolved, setResolved] = useState<ResolvedApproval[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  // Pause the fast approvals poll while the tab is backgrounded; resumes (and
  // re-fetches immediately) once it becomes visible again.
  const isVisible = useDocumentVisibility();

  const tokenRef = useRef(token);
  tokenRef.current = token;

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh trigger; the effect body intentionally does not read it
  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(base, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          pending?: PendingApproval[];
          resolved?: ResolvedApproval[];
        };
        if (!cancelled) {
          setPending(data.pending ?? []);
          setResolved(data.resolved ?? []);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "approvals fetch failed",
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
    // The flagged "pending"/"resolved" below are `data.pending`/`data.resolved`
    // (from the `as { pending?: ...; resolved?: ... }` cast above), not the
    // `pending`/`resolved` state. @babel/eslint-parser has no TypeScript type
    // info, so exhaustive-deps' scope analysis can't tell the cast's property
    // names apart from the same-named outer bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, intervalMs, enabled, isVisible, token, nonce]);

  const resolve = useCallback(
    async (
      id: string,
      approved: boolean,
      opts?: { reason?: string; by?: string },
    ): Promise<ApprovalDecisionResult> => {
      const t = tokenRef.current;
      const url = `${base}/${encodeURIComponent(id)}`;
      try {
        const res = await authFetch(url, t, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved, ...opts }),
        });
        setNonce((n) => n + 1); // refresh immediately
        return { ok: res.ok, status: res.status };
      } catch {
        return { ok: false };
      }
    },
    [base],
  );

  return { pending, resolved, isLoading, error, resolve, refresh };
}

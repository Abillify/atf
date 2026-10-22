"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

/** Latest recorded eval run for a flow (mirrors the runtime's flow-health entry). */
export interface FlowHealthLastEval {
  runId: string;
  at: string;
  passed: number;
  failed: number;
}

/** One served flow: origin (file vs. DB), version, digest and last eval. */
export interface FlowHealthEntry {
  id: string;
  source: "file" | "db";
  file?: string;
  version?: string;
  digest?: string;
  /** True when a DB flow with this id shadows a same-id flow file. */
  shadowsFile: boolean;
  lastEval?: FlowHealthLastEval;
}

/** A flow file that failed to load and has been in the failure ledger since. */
export interface FlowLoadFailure {
  file: string;
  reason: string;
  since: string;
}

export interface UseFlowHealthResult {
  flows: FlowHealthEntry[];
  loadFailures: FlowLoadFailure[];
  generatedAt: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the flow-health snapshot from `GET /monitoring/flow-health`: every
 * served flow with source, version, digest and last eval result, plus every
 * flow file that failed to load. Paused while the tab is hidden, like the
 * other monitoring hooks.
 */
export function useFlowHealth(
  options?: { enabled?: boolean; token?: string },
): UseFlowHealthResult {
  const enabled = options?.enabled ?? true;
  const token = options?.token;
  const isVisible = useDocumentVisibility();
  const [flows, setFlows] = useState<FlowHealthEntry[]>([]);
  const [loadFailures, setLoadFailures] = useState<FlowLoadFailure[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    setIsLoading(true);
    authFetch(backendUrl("/monitoring/flow-health"), token, {
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        return (await res.json()) as {
          generatedAt?: string;
          flows?: FlowHealthEntry[];
          loadFailures?: FlowLoadFailure[];
        };
      })
      .then((data) => {
        if (cancelled) return;
        setFlows(data.flows ?? []);
        setLoadFailures(data.loadFailures ?? []);
        setGeneratedAt(data.generatedAt ?? null);
        setError(null);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, isVisible, token]);

  return { flows, loadFailures, generatedAt, isLoading, error };
}

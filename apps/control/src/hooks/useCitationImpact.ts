"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useMemo, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";
import type {
  CitationImpactAffected,
  CitationImpactReport,
} from "../types/citation-impact";

export type { CitationImpactAffected, CitationImpactReport };

/** The report re-checks citations against Search — 60 s is fresh enough. */
const POLL_INTERVAL_MS = 60_000;

/** Selectable reporting windows, in days. */
export const CITATION_IMPACT_DAY_OPTIONS = [30, 90, 365] as const;
export type CitationImpactDays = (typeof CITATION_IMPACT_DAY_OPTIONS)[number];

export interface UseCitationImpactResult {
  report: CitationImpactReport | null;
  affected: CitationImpactAffected[];
  signed: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface UseCitationImpactOptions {
  /** Reporting window in days — `since` is derived from it. Default 90. */
  days?: CitationImpactDays;
  /** Optional `base_ref` filter: only answers citing this knowledge base. */
  baseRef?: string;
  enabled?: boolean;
  token?: string;
}

/**
 * Fetches the citation impact report from
 * `GET /monitoring/citation-impact?since=…[&base_ref=…]`: answers whose cited
 * chunks changed or disappeared since the start of the selected window.
 * Polled every 60 s and paused while the tab is hidden, like the other
 * monitoring hooks.
 */
export function useCitationImpact(
  options?: UseCitationImpactOptions,
): UseCitationImpactResult {
  const enabled = options?.enabled ?? true;
  const days = options?.days ?? 90;
  const baseRef = options?.baseRef?.trim() ?? "";
  const token = options?.token;
  const isVisible = useDocumentVisibility();
  const [report, setReport] = useState<CitationImpactReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stable `since` per window so the polling tick does not shift the window.
  const since = useMemo(
    () => new Date(Date.now() - days * 86_400_000).toISOString(),
    [days],
  );

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    setIsLoading(true);

    const tick = async (): Promise<void> => {
      try {
        const params = new URLSearchParams({ since });
        if (baseRef !== "") params.set("base_ref", baseRef);
        const res = await authFetch(
          `${backendUrl("/monitoring/citation-impact")}?${params.toString()}`,
          token,
          { headers: { Accept: "application/json" } },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as CitationImpactReport;
        if (cancelled) return;
        setReport(data);
        setError(null);
        setIsLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, isVisible, token, since, baseRef]);

  return {
    report,
    affected: report?.affected ?? [],
    signed: report?.signature !== undefined,
    isLoading,
    error,
  };
}

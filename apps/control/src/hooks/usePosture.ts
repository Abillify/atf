"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";
import type { PostureCheck, PostureReport, PostureStatus } from "../types/posture";

export type { PostureCheck, PostureReport, PostureStatus };

/** Posture changes only when the config or a runtime fact changes — 60 s. */
const POLL_INTERVAL_MS = 60_000;

export interface UsePostureResult {
  report: PostureReport | null;
  checks: PostureCheck[];
  status: PostureStatus | null;
  generatedAt: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Fetches the governance posture report from `GET /monitoring/posture`: which
 * governance controls are active right now, each judged ok/warn/fail. Polled
 * every 60 s — the report only moves when the config or a runtime fact does.
 * Paused while the tab is hidden, like the other monitoring hooks.
 */
export function usePosture(
  options?: { enabled?: boolean; token?: string },
): UsePostureResult {
  const enabled = options?.enabled ?? true;
  const token = options?.token;
  const isVisible = useDocumentVisibility();
  const [report, setReport] = useState<PostureReport | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    setIsLoading(true);

    const tick = async (): Promise<void> => {
      try {
        const res = await authFetch(backendUrl("/monitoring/posture"), token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as PostureReport;
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
  }, [enabled, isVisible, token]);

  return {
    report,
    checks: report?.checks ?? [],
    status: report?.status ?? null,
    generatedAt: report?.generatedAt ?? null,
    isLoading,
    error,
  };
}

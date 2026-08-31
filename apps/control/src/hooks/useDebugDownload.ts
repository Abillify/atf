"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useCallback } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface UseDebugDownloadOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL + /monitoring/debug */
  baseUrl?: string;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseDebugDownloadResult {
  /** Execution id currently being downloaded, or null when idle. */
  downloadingId: string | null;
  /** Last download error, or null. */
  error: string | null;
  /**
   * Fetches the full debug trace for one execution and triggers a browser
   * download as `debug-trace-<executionId>.json`.
   */
  download: (executionId: string) => Promise<void>;
}

function defaultBase(): string {
  return backendUrl("/monitoring/debug");
}

/**
 * Downloads the full, untruncated debug trace for an execution from
 * `GET /monitoring/debug/:executionId` and saves it as a JSON file. The trace
 * contains every system/user prompt, every LLM response, the full reasoning /
 * chain-of-thought, every MCP/RAG tool call with its full arguments and result
 * payload, the semantic tool-selection decision, and the session metadata.
 */
export function useDebugDownload(
  options?: UseDebugDownloadOptions,
): UseDebugDownloadResult {
  const base = options?.baseUrl ?? defaultBase();
  const token = options?.token;

  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = useCallback(
    async (executionId: string): Promise<void> => {
      setDownloadingId(executionId);
      setError(null);
      try {
        const url = `${base}/${encodeURIComponent(executionId)}`;
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        const trace = (await res.json()) as unknown;
        const blob = new Blob([JSON.stringify(trace, null, 2)], {
          type: "application/json",
        });
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = `debug-trace-${executionId}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      } catch (err) {
        setError(err instanceof Error ? err.message : "debug download failed");
      } finally {
        setDownloadingId(null);
      }
    },
    // The flagged "error" below is `body.error` (from the
    // `as { error?: ... }` cast above), not the `error` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, token],
  );

  return { downloadingId, error, download };
}

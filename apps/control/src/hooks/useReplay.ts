"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useCallback } from "react";
import type { ReplayResult } from "../types/control";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface UseReplayOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL + /monitoring/replay */
  url?: string;
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface ReplayInput {
  executionId: string;
  /** Optional: re-run against a different flow version. */
  flowId?: string;
  /** Optional: edit-and-replay with new messages. */
  messages?: {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
  }[];
}

export interface UseReplayResult {
  result: ReplayResult | null;
  isRunning: boolean;
  error: string | null;
  run: (input: ReplayInput) => Promise<void>;
  clear: () => void;
}

function defaultUrl(): string {
  return backendUrl("/monitoring/replay");
}

/** Triggers a time-travel replay of a past execution and exposes the diff. */
export function useReplay(options?: UseReplayOptions): UseReplayResult {
  const url = options?.url ?? defaultUrl();
  const token = options?.token;

  const [result, setResult] = useState<ReplayResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (input: ReplayInput): Promise<void> => {
      setIsRunning(true);
      setError(null);
      try {
        const res = await authFetch(url, token, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            execution_id: input.executionId,
            ...(input.flowId ? { flow_id: input.flowId } : {}),
            ...(input.messages ? { messages: input.messages } : {}),
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        }
        setResult((await res.json()) as ReplayResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : "replay failed");
        setResult(null);
      } finally {
        setIsRunning(false);
      }
    },
    // The flagged "error" below is `body.error` (from the
    // `as { error?: ... }` cast above), not the `error` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url, token],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, isRunning, error, run, clear };
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useRef, useState } from "react";
import type { NodeExecutionEvent } from "../types/monitoring";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";

export interface UseExecutionEventsOptions {
  /** Optional operator token, sent as an Authorization header when set. */
  token?: string;
}

export interface UseExecutionEventsResult {
  /** Events for the most recently fetched execution (empty until fetched). */
  events: NodeExecutionEvent[];
  /** execution_id currently held in `events`, or null. */
  executionId: string | null;
  isLoading: boolean;
  error: string | null;
  /**
   * Fetch the durable events for one execution from the backend audit log.
   * Set `force` for an active live execution whose persisted event set may have
   * grown since it was cached.
   */
  load: (
    executionId: string,
    force?: boolean,
  ) => Promise<NodeExecutionEvent[]>;
}

/**
 * Fetches the durable per-execution event list from `/monitoring/history/:id`.
 * Used by the Live Graph view to render a past run retroactively when its
 * events are no longer in the live SSE buffer (e.g. after a page reload, or for
 * a run that started before the dashboard connected).
 */
export function useExecutionEvents(
  options?: UseExecutionEventsOptions,
): UseExecutionEventsResult {
  const token = options?.token;
  const [events, setEvents] = useState<NodeExecutionEvent[]>([]);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<Map<string, NodeExecutionEvent[]>>(new Map());

  const load = useCallback(
    async (id: string, force = false): Promise<NodeExecutionEvent[]> => {
      const cached = cache.current.get(id);
      if (!force && cached !== undefined) {
        setEvents(cached);
        setExecutionId(id);
        setError(null);
        return cached;
      }
      setIsLoading(true);
      try {
        const url = backendUrl(`/monitoring/history/${encodeURIComponent(id)}`);
        const res = await authFetch(url, token, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { events?: NodeExecutionEvent[] };
        const evs = data.events ?? [];
        cache.current.set(id, evs);
        setEvents(evs);
        setExecutionId(id);
        setError(null);
        return evs;
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "failed to load execution",
        );
        setEvents([]);
        setExecutionId(id);
        return [];
      } finally {
        setIsLoading(false);
      }
    },
    // The flagged "events" below is `data.events` (from the
    // `as { events?: ... }` cast above), not the `events` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  return { events, executionId, isLoading, error, load };
}

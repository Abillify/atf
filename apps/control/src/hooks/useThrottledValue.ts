"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useRef, useState } from "react";

/**
 * Throttles how often a fast-changing value propagates to the caller.
 *
 * The Live Graph re-derives its whole layout (Dagre positions, edges, node
 * states) from `displayEvents` via `useMemo` on every change — see
 * `GraphVisualizer.tsx`. During a token-by-token LLM stream, the underlying
 * SSE buffer can emit many events per second (one per token/chunk), which
 * without throttling re-ran that layout computation and a full React Flow
 * re-render on every single one — visibly janky on a large graph and wasted
 * work between visually-identical intermediate states.
 *
 * Behaviour: the FIRST value is returned immediately (so the graph appears
 * without delay on initial load / a fresh execution). After that, updates are
 * coalesced to at most once per `intervalMs` — a trailing update always fires
 * so the final value is never stale, even if updates stop arriving mid-window.
 *
 * Not used by `useMonitoringEvents` itself: that hook's `events` buffer is a
 * shared source consumed by other panels (execution picker, metrics) that
 * want every event as it arrives (e.g. an event counter). Throttling is
 * applied at the point of use (the graph's derived `displayEvents`) rather
 * than at the source, so the cost/latency trade-off is scoped to the
 * consumer that actually needs it.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdateRef = useRef(0);
  // Boxed so `T` itself being `null`/`undefined` never causes a pending
  // update to be mistaken for "nothing pending".
  const pendingRef = useRef<{ value: T } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (intervalMs <= 0) {
      setThrottled(value);
      return;
    }
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;

    if (elapsed >= intervalMs) {
      lastUpdateRef.current = now;
      setThrottled(value);
      return;
    }

    // Within the window — remember the latest value and schedule a trailing
    // flush so it is never lost, replacing any previously scheduled one.
    pendingRef.current = { value };
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastUpdateRef.current = Date.now();
      if (pendingRef.current !== null) setThrottled(pendingRef.current.value);
      pendingRef.current = null;
      timerRef.current = null;
    }, intervalMs - elapsed);

    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [value, intervalMs]);

  return throttled;
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useRef, useSyncExternalStore, useCallback } from "react";
import type { NodeExecutionEvent } from "../types/monitoring";
import { backendUrl } from "../lib/backend-url";
import { request } from "../lib/control-api";
import { MonitoringEventStore } from "../lib/monitoring-event-store";
import { useDocumentVisibility } from "./useDocumentVisibility";

export type TransportType = "sse" | "websocket";

export interface UseMonitoringEventsOptions {
  /** Default: derived from NEXT_PUBLIC_BACKEND_URL or relative "/monitoring/events" */
  url?: string;
  /** Default: "sse" */
  transport?: TransportType;
  /** Default: true */
  enabled?: boolean;
  /** Operator session token. Exchanged for a short-lived stream ticket (below). */
  token?: string;
  /**
   * Endpoint that exchanges the operator token (sent as a normal POST header)
   * for a short-lived ticket carried in the stream URL, so the reusable token
   * never lands in access/proxy logs. Default `/monitoring/ticket`. Over plain
   * HTTP the hook falls back to the legacy token-in-URL path when the endpoint
   * is unavailable; over HTTPS it never does (Req. 8.3) and surfaces a
   * connection error instead.
   */
  ticketUrl?: string;
  /**
   * Called when the operator token is rejected (401) while obtaining a ticket —
   * i.e. the session expired. Should attempt a silent renew and resolve to the
   * NEW token, or null when renewal is impossible. Returning a new token lets
   * the parent update its token state (which reconnects the stream); returning
   * null stops the reconnect loop and surfaces an "expired" error instead of
   * hammering the backend with a dead token.
   */
  onSessionExpired?: () => Promise<string | null>;
  /**
   * Initial delay (ms) before the first reconnect attempt. Doubles on each
   * failure up to maxReconnectDelayMs. Default 2000.
   */
  reconnectDelayMs?: number;
  /** Cap on the backoff delay. Default 30000 (30 s). */
  maxReconnectDelayMs?: number;
  /**
   * Maximum number of events retained in state. Older events are dropped once
   * the cap is exceeded, so a long-lived dashboard tab cannot grow memory
   * without bound. Default 2000.
   */
  maxEvents?: number;
}

export interface UseMonitoringEventsResult {
  events: NodeExecutionEvent[];
  isConnected: boolean;
  error: string | null;
  clearEvents: () => void;
}

/** True when the page itself is served over TLS — the switch for the
 *  no-token-in-URL rule (Req. 8.3). SSR-safe: without a window there is no
 *  browser log to protect, and the effect only runs client-side anyway. */
function isHttpsPage(): boolean {
  return (
    typeof window !== "undefined" &&
    window.location.protocol === "https:"
  );
}

/**
 * React hook that opens an SSE or WebSocket connection to the backend
 * /monitoring/events endpoint, accumulates incoming NodeExecutionEvents in
 * state, and cleans up the connection on unmount or page unload.
 *
 * Reconnects automatically with exponential backoff after a connection error.
 * A reconnect resumes from the last seen event id (`Last-Event-ID`) so a brief
 * drop does not lose events. When the session token has expired, the hook asks
 * the parent to renew it via `onSessionExpired` instead of retrying forever with
 * a dead token.
 *
 * Performance (Req. 9.1): incoming events are NOT pushed into React state per
 * message. They are written into a {@link MonitoringEventStore} backed by a
 * ring buffer and handed to React at most once per 200 ms via
 * `useSyncExternalStore`, so a token-by-token stream cannot re-render the
 * dashboard on every single chunk. The snapshot reference is stable between
 * flushes; `events` is always the last `maxEvents` events in input order.
 *
 * Requirements: 9.1, 9.7
 */
export function useMonitoringEvents(
  options?: UseMonitoringEventsOptions,
): UseMonitoringEventsResult {
  const url = options?.url ?? backendUrl("/monitoring/events");
  const transport = options?.transport ?? "sse";
  const enabled = options?.enabled ?? true;
  const token = options?.token;
  const ticketUrl = options?.ticketUrl ?? backendUrl("/monitoring/ticket");
  const onSessionExpired = options?.onSessionExpired;
  const baseReconnectDelay = options?.reconnectDelayMs ?? 2_000;
  const maxReconnectDelay = options?.maxReconnectDelayMs ?? 30_000;
  const maxEvents = options?.maxEvents ?? 2_000;

  // External event store (Req. 9.1): ring buffer + throttled flush. Created
  // lazily in a ref (not useMemo, which React may discard) so buffered events
  // survive effect restarts (reconnect, visibility change, token renew). A
  // changed maxEvents capacity rebuilds the store — the cap is a hard memory
  // bound, so shrinking it must take effect immediately.
  const storeRef = useRef<MonitoringEventStore<NodeExecutionEvent> | null>(
    null,
  );
  if (storeRef.current === null || storeRef.current.capacity !== maxEvents) {
    storeRef.current?.destroy();
    storeRef.current = new MonitoringEventStore<NodeExecutionEvent>(maxEvents);
  }
  const store = storeRef.current;

  // React only ever sees the store's cached snapshot, updated at most every
  // flush interval (200 ms) — never one render per stream message.
  const events = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  // Detach subscribers / cancel a pending flush on unmount.
  useEffect(() => () => store.destroy(), [store]);

  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the replay cursor across visibility changes and effect restarts. A
  // dashboard tab can be hidden while requests finish; reconnecting without
  // this cursor would silently drop all events emitted in that interval.
  const lastEventIdRef = useRef<string | null>(null);

  // Keep a ref to the live connection so the beforeunload handler can close it
  const connectionRef = useRef<EventSource | WebSocket | null>(null);

  // Pause the stream while the tab is backgrounded (Req: DX — avoid burning
  // server connections/CPU for a dashboard tab nobody is looking at) and
  // reconnect the instant it becomes visible again. The effect below already
  // tears down and rebuilds the connection on any dependency change, so
  // folding `isVisible` into that same dependency array reuses the existing
  // connect/cleanup logic instead of adding a second connection lifecycle.
  const isVisible = useDocumentVisibility();

  useEffect(() => {
    if (!enabled || !isVisible) return;

    let destroyed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = baseReconnectDelay;

    const scheduleReconnect = (): void => {
      if (destroyed) return;
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        void connect();
      }, reconnectDelay);
    };

    /**
     * Resolves the credential to put in the stream URL. Returns `{ stop: true }`
     * when the caller must NOT (re)connect — either because a renewal is in
     * flight (the token change will restart this effect) or the session is dead.
     */
    async function resolveStreamToken(): Promise<{
      streamToken?: string;
      stop?: boolean;
    }> {
      if (!token) return {}; // auth disabled — connect without a credential
      try {
        const res = await request(ticketUrl, {
          target: "same-origin",
          token,
          method: "POST",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          const data = (await res.json()) as { ticket?: string };
          if (typeof data.ticket === "string" && data.ticket !== "") {
            return { streamToken: data.ticket };
          }
          // Unexpected body — treat like an unavailable ticket endpoint.
        } else if (res.status === 401) {
          // Operator token expired. Try a silent renew; on success the parent
          // updates the token and this effect re-runs, so stop here. On failure
          // stop reconnecting and surface the expiry (no dead-token loop).
          const renewed = onSessionExpired ? await onSessionExpired() : null;
          if (renewed === null) {
            setIsConnected(false);
            setError("Session expired — please sign in again");
          }
          return { stop: true };
        }
        // Ticketing not enabled (404) or a transient server error.
        // SECURITY: putting the token in the URL means it appears in proxy/access
        // logs and browser history. Over HTTPS the hook refuses the fallback
        // outright (Req. 8.3): surface a connection error and retry with backoff
        // instead of leaking the reusable operator token. Over plain HTTP the
        // fallback stays (development only) with a console warning.
        if (isHttpsPage()) {
          setIsConnected(false);
          setError(
            "Monitoring ticket unavailable — refusing token-in-URL over HTTPS",
          );
          scheduleReconnect();
          return { stop: true };
        }
        console.warn(
          "[aiperator] Monitoring ticket endpoint unavailable — falling back to token-in-URL. " +
            "This exposes the operator token in proxy/access logs. " +
            "Configure MONITORING_TICKET_SECRET on the backend to enable secure ticket exchange.",
        );
        return { streamToken: token };
      } catch {
        // Network error reaching the ticket endpoint. Same policy as the 404
        // path: no token-in-URL over HTTPS (Req. 8.3), warn + fall back on HTTP.
        if (isHttpsPage()) {
          setIsConnected(false);
          setError(
            "Monitoring ticket unavailable — refusing token-in-URL over HTTPS",
          );
          scheduleReconnect();
          return { stop: true };
        }
        console.warn(
          "[aiperator] Could not reach monitoring ticket endpoint — falling back to token-in-URL. " +
            "This exposes the operator token in proxy/access logs.",
        );
        return { streamToken: token };
      }
    }

    /** Builds the connection URL with the resolved credential + resume cursor. */
    const buildUrl = (streamToken: string | undefined): string => {
      const params: string[] = [];
      if (streamToken) params.push(`token=${encodeURIComponent(streamToken)}`);
      if (lastEventIdRef.current)
        params.push(
          `lastEventId=${encodeURIComponent(lastEventIdRef.current)}`,
        );
      if (params.length === 0) return url;
      return `${url}${url.includes("?") ? "&" : "?"}${params.join("&")}`;
    };

    function openSse(streamToken: string | undefined): void {
      if (destroyed) return;
      const es = new EventSource(buildUrl(streamToken));
      connectionRef.current = es;

      es.onopen = () => {
        if (destroyed) {
          es.close();
          return;
        }
        reconnectDelay = baseReconnectDelay; // reset backoff on success
        setIsConnected(true);
        setError(null);
      };

      es.onmessage = (ev: MessageEvent) => {
        if (destroyed) return;
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const parsed = JSON.parse(ev.data as string) as NodeExecutionEvent;
          // Buffered, not setState: the store flushes to React at most every
          // 200 ms (Req. 9.1), coalescing bursts into a single re-render.
          store.push(parsed);
        } catch {
          // Malformed JSON from the stream — ignore silently
        }
      };

      es.onerror = () => {
        if (destroyed) return;
        es.close();
        connectionRef.current = null;
        setIsConnected(false);
        setError("SSE connection error");
        scheduleReconnect();
      };
    }

    function openWebSocket(streamToken: string | undefined): void {
      if (destroyed) return;
      const wsUrl = buildUrl(streamToken)
        .replace(/^http:\/\//i, "ws://")
        .replace(/^https:\/\//i, "wss://")
        // Relative paths need the current origin for WebSocket
        .replace(
          /^\/(?!\/)/,
          `${typeof window !== "undefined" ? (window.location.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location.host : "ws://localhost"}/`,
        );

      const ws = new WebSocket(wsUrl);
      connectionRef.current = ws;

      ws.onopen = () => {
        if (destroyed) {
          ws.close();
          return;
        }
        reconnectDelay = baseReconnectDelay;
        setIsConnected(true);
        setError(null);
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (destroyed) return;
        try {
          const parsed = JSON.parse(ev.data as string) as NodeExecutionEvent;
          store.push(parsed);
        } catch {
          // Malformed JSON — ignore silently
        }
      };

      ws.onclose = () => {
        if (destroyed) return;
        connectionRef.current = null;
        setIsConnected(false);
        scheduleReconnect();
      };

      ws.onerror = () => {
        if (destroyed) return;
        setError("WebSocket connection error");
        // ws.onclose fires immediately after onerror, so the reconnect is
        // handled there to avoid double-scheduling.
      };
    }

    function connect(): void {
      if (destroyed) return;
      const open = transport === "sse" ? openSse : openWebSocket;
      if (!token) {
        // No auth → open synchronously (keeps the no-credential path simple and
        // lets tests observe the connection immediately).
        open(undefined);
        return;
      }
      // With a token we first exchange it for a short-lived ticket.
      void resolveStreamToken().then(({ streamToken, stop }) => {
        if (destroyed || stop) return;
        open(streamToken);
      });
    }

    connect();

    // Close connection cleanly on page unload (Requirement 9.7)
    const handleBeforeUnload = () => {
      connectionRef.current?.close();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    // Cleanup on unmount / option changes
    return () => {
      destroyed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      connectionRef.current?.close();
      connectionRef.current = null;
      setIsConnected(false);
    };
  }, [
    url,
    transport,
    enabled,
    isVisible,
    token,
    ticketUrl,
    onSessionExpired,
    baseReconnectDelay,
    maxReconnectDelay,
    // `maxEvents` is not read inside the effect — a changed capacity rebuilds
    // `store` above, and the store dependency restarts this effect by itself.
    store,
  ]);

  const clearEvents = useCallback(() => {
    store.clear();
  }, [store]);

  return { events, isConnected, error, clearEvents };
}

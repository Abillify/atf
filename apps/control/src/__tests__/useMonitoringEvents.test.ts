// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useMonitoringEvents } from "../hooks/useMonitoringEvents";
import type { NodeExecutionEvent } from "../types/monitoring";

/** Overrides `document.visibilityState` for the duration of a test. */
function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

const sampleEvent = (nodeId: string): NodeExecutionEvent => ({
  execution_id: "exec-1",
  node_id: nodeId,
  status: "completed",
  start_time: "2025-01-01T00:00:00Z",
  end_time: "2025-01-01T00:00:01Z",
  latency_ms: 42,
});

/** Controllable fake EventSource capturing the last instance for the test. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.last = this;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  close(): void {
    this.closed = true;
  }
}

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
  }
  close(): void {
    this.closed = true;
  }
}

describe("useMonitoringEvents (SSE)", () => {
  beforeEach(() => {
    FakeEventSource.last = null;
    vi.stubGlobal(
      "EventSource",
      FakeEventSource as unknown as typeof EventSource,
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("connects, accumulates events, and reports connected", async () => {
    const { result } = renderHook(() =>
      useMonitoringEvents({ url: "http://x/monitoring/events" }),
    );
    const es = FakeEventSource.last!;
    expect(es.url).toBe("http://x/monitoring/events");

    act(() => es.onopen?.());
    await waitFor(() => expect(result.current.isConnected).toBe(true));

    act(() => es.emit(sampleEvent("n1")));
    act(() => es.emit(sampleEvent("n2")));
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    expect(result.current.events[0]?.node_id).toBe("n1");
  });

  test("ignores malformed JSON frames", async () => {
    const { result } = renderHook(() =>
      useMonitoringEvents({ url: "http://x/monitoring/events" }),
    );
    const es = FakeEventSource.last!;
    act(() => es.onmessage?.({ data: "not-json{" } as MessageEvent));
    expect(result.current.events).toHaveLength(0);
  });

  test("sets an error on connection error", async () => {
    const { result } = renderHook(() =>
      useMonitoringEvents({ url: "http://x/monitoring/events" }),
    );
    act(() => FakeEventSource.last!.onerror?.());
    await waitFor(() =>
      expect(result.current.error).toBe("SSE connection error"),
    );
    expect(result.current.isConnected).toBe(false);
  });

  test("clearEvents empties the buffer", async () => {
    const { result } = renderHook(() =>
      useMonitoringEvents({ url: "http://x/monitoring/events" }),
    );
    act(() => FakeEventSource.last!.emit(sampleEvent("n1")));
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    act(() => result.current.clearEvents());
    expect(result.current.events).toHaveLength(0);
  });

  test("does not connect when disabled", () => {
    renderHook(() =>
      useMonitoringEvents({
        url: "http://x/monitoring/events",
        enabled: false,
      }),
    );
    expect(FakeEventSource.last).toBeNull();
  });

  test("closes the connection on unmount", () => {
    const { unmount } = renderHook(() =>
      useMonitoringEvents({ url: "http://x/monitoring/events" }),
    );
    const es = FakeEventSource.last!;
    unmount();
    expect(es.closed).toBe(true);
  });

  test("pauses the stream while the tab is hidden and reconnects when visible again", () => {
    setVisibilityState("hidden");
    try {
      renderHook(() => useMonitoringEvents({ url: "http://x/monitoring/events" }));
      // Hidden at mount time — no connection is opened.
      expect(FakeEventSource.last).toBeNull();

      setVisibilityState("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Becoming visible re-runs the connect effect.
      expect(FakeEventSource.last).not.toBeNull();
    } finally {
      setVisibilityState("visible");
    }
  });

  test("exchanges the operator token for a stream ticket via the API layer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ ticket: "short-lived" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useMonitoringEvents({
        url: "http://x/monitoring/events",
        ticketUrl: "http://x/monitoring/ticket",
        token: "operator-token",
      }),
    );

    await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    expect(FakeEventSource.last?.url).toBe(
      "http://x/monitoring/events?token=short-lived",
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://x/monitoring/ticket");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer operator-token",
    );
  });

  test("tearing down while hidden closes the existing connection", () => {
    setVisibilityState("visible");
    const { unmount } = renderHook(() =>
      useMonitoringEvents({ url: "http://x/monitoring/events" }),
    );
    const es = FakeEventSource.last!;
    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(es.closed).toBe(true);
    unmount();
    setVisibilityState("visible");
  });
});

describe("useMonitoringEvents (WebSocket)", () => {
  beforeEach(() => {
    FakeWebSocket.last = null;
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("rewrites http(s) to ws(s) and connects", async () => {
    const { result } = renderHook(() =>
      useMonitoringEvents({
        url: "https://x/monitoring/events",
        transport: "websocket",
      }),
    );
    const ws = FakeWebSocket.last!;
    expect(ws.url).toBe("wss://x/monitoring/events");
    act(() => ws.onopen?.());
    await waitFor(() => expect(result.current.isConnected).toBe(true));
    act(() => ws.onclose?.());
    await waitFor(() => expect(result.current.isConnected).toBe(false));
  });
});

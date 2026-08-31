// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useMetrics } from "../hooks/useMetrics";
import { EMPTY_SUMMARY } from "../types/metrics";

describe("useMetrics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fetches and exposes the metrics summary", async () => {
    const payload = { ...EMPTY_SUMMARY, requestsTotal: 42, llmCallsTotal: 7 };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useMetrics({ url: "http://x/metrics", intervalMs: 100000 }),
    );

    await waitFor(() => expect(result.current.summary.requestsTotal).toBe(42));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  test("sends the token as an Authorization header when provided", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => EMPTY_SUMMARY });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useMetrics({ url: "http://x/metrics", token: "a b", intervalMs: 100000 }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calledWith = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledWith).not.toContain("token=");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer a b");
  });

  test("surfaces an error on non-ok response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useMetrics({ url: "http://x/metrics", intervalMs: 100000 }),
    );

    await waitFor(() => expect(result.current.error).toBe("HTTP 503"));
  });

  test("does not overlap requests and aborts the active request on cleanup", async () => {
    vi.useFakeTimers();
    const pending = new Promise<Response>(() => {});
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = renderHook(() =>
      useMetrics({ url: "http://x/metrics", intervalMs: 100 }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const signal = init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    vi.useRealTimers();
  });

  test("does not fetch when disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useMetrics({ url: "http://x/metrics", enabled: false }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useExecutionDebugTrace } from "../hooks/useExecutionDebugTrace";
import type { DebugTrace } from "../types/debug-trace";

const sampleTrace = (id: string): DebugTrace => ({
  execution_id: id,
  flow_id: "example-flow",
  status: "error",
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:00:02Z",
  nodes: [
    {
      node_id: "llm-1",
      status: "error",
      error_message: "boom",
      error_type: "provider_error",
    },
  ],
});

describe("useExecutionDebugTrace", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("fetches and exposes the trace", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleTrace("e1"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    const loaded = await result.current.load("e1");

    expect(loaded?.execution_id).toBe("e1");
    await waitFor(() => expect(result.current.trace?.execution_id).toBe("e1"));
    expect(result.current.executionId).toBe("e1");
    expect(result.current.unavailable).toBe(false);
    expect(result.current.error).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/monitoring/debug/e1",
    );
  });

  test("sends the token as an Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleTrace("e1"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useExecutionDebugTrace({ token: "tok" }),
    );
    await result.current.load("e1");

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });

  test("URL-encodes the execution id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleTrace("a/b"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    await result.current.load("a/b");

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/monitoring/debug/a%2Fb");
  });

  test("a 404 marks the trace unavailable without an error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    let loaded: DebugTrace | null = null;
    await act(async () => {
      loaded = await result.current.load("gone");
    });

    expect(loaded).toBeNull();
    expect(result.current.trace).toBeNull();
    expect(result.current.unavailable).toBe(true);
    expect(result.current.error).toBeNull();
  });

  test("caches results — a second load does not re-fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleTrace("e1"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    await result.current.load("e1");
    const again = await result.current.load("e1");

    expect(again?.execution_id).toBe("e1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a 404 is cached too — no refetch spam for evicted traces", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    await act(async () => {
      await result.current.load("gone");
      await result.current.load("gone");
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.unavailable).toBe(true);
  });

  test("force bypasses the cache (running → completed refresh)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => sampleTrace("e1"),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ...sampleTrace("e1"),
          nodes: [
            {
              node_id: "llm-1",
              status: "error",
              error_type: "provider_error",
              diagnostics: [{ at: "t", level: "error", code: "c", message: "m" }],
            },
          ],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    await result.current.load("e1");
    const refreshed = await result.current.load("e1", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed?.nodes[0]?.diagnostics).toHaveLength(1);
    await waitFor(() =>
      expect(result.current.trace?.nodes[0]?.diagnostics).toHaveLength(1),
    );
  });

  test("a server error surfaces as error state, not unavailable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    await act(async () => {
      await result.current.load("e1");
    });

    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.trace).toBeNull();
    expect(result.current.unavailable).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  test("a network failure surfaces as error state", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useExecutionDebugTrace());
    await act(async () => {
      await result.current.load("e1");
    });

    expect(result.current.error).toBe("network down");
    expect(result.current.trace).toBeNull();
  });
});

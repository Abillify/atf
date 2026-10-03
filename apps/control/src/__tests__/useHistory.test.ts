// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useHistory } from "../hooks/useHistory";
import type { PersistedExecution } from "../types/history";

const sampleExecution = (id: string): PersistedExecution =>
  ({
    execution_id: id,
    flow_id: "example-flow",
    status: "completed",
    node_count: 3,
    error_count: 0,
    total_latency_ms: 412,
    started_at: "2025-01-01T00:00:00Z",
    finished_at: "2025-01-01T00:00:01Z",
  }) as PersistedExecution;

describe("useHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("fetches and exposes persisted executions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        executions: [sampleExecution("e1"), sampleExecution("e2")],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useHistory({ url: "http://x/monitoring/history", intervalMs: 100000 }),
    );

    await waitFor(() => expect(result.current.executions).toHaveLength(2));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  test("requests the configured limit and sends the token as a header", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ executions: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useHistory({
        url: "http://x/monitoring/history",
        limit: 25,
        token: "tok",
        intervalMs: 100000,
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calledWith = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledWith).toContain("limit=25");
    expect(calledWith).not.toContain("token=");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });

  test("surfaces an error on non-ok response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useHistory({ url: "http://x/monitoring/history", intervalMs: 100000 }),
    );

    await waitFor(() => expect(result.current.error).toBe("HTTP 401"));
  });

  test("does not fetch when disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useHistory({ url: "http://x/monitoring/history", enabled: false }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("sends sortBy and sortDir as query params", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ executions: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useHistory({
        url: "http://x/monitoring/history",
        sortBy: "total_cost",
        sortDir: "asc",
        intervalMs: 100000,
      }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calledWith = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledWith).toContain("sortBy=total_cost");
    expect(calledWith).toContain("sortDir=asc");
  });

  test("omits sort params when not configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ executions: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() =>
      useHistory({ url: "http://x/monitoring/history", intervalMs: 100000 }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calledWith = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledWith).not.toContain("sortBy=");
    expect(calledWith).not.toContain("sortDir=");
  });
});

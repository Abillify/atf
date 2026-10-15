// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useApprovals } from "../hooks/useApprovals";

describe("useApprovals", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  test("fetches the pending queue", async () => {
    const pending = [
      {
        id: "a",
        executionId: "e",
        nodeId: "n",
        tool: "x/y",
        args: {},
        requestedAt: "now",
      },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ pending }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useApprovals({
        baseUrl: "http://x/monitoring/approvals",
        intervalMs: 100000,
      }),
    );

    await waitFor(() => expect(result.current.pending).toHaveLength(1));
    expect(result.current.pending[0]!.tool).toBe("x/y");
  });

  test("resolve POSTs the decision to the right url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pending: [] }) }) // initial poll
      .mockResolvedValue({ ok: true, json: async () => ({}) }); // resolve + refresh
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useApprovals({
        baseUrl: "http://x/monitoring/approvals",
        intervalMs: 100000,
      }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const ok = await result.current.resolve("ap-1", true, { by: "alice" });
    expect(ok.ok).toBe(true);

    const postCall = fetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(postCall![0]).toContain("/monitoring/approvals/ap-1");
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      approved: true,
      by: "alice",
    });
  });

  test("surfaces fetch errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    );
    const { result } = renderHook(() =>
      useApprovals({
        baseUrl: "http://x/monitoring/approvals",
        intervalMs: 100000,
      }),
    );
    await waitFor(() => expect(result.current.error).toBe("HTTP 401"));
  });
});

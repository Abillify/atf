// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useFlows } from "../hooks/useFlows";
import type { FlowDefinition } from "../types/flow";

const def: FlowDefinition = {
  id: "f",
  name: "F",
  nodes: [{ id: "n", type: "llm" }],
  edges: [],
};

describe("useFlows", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  test("lists flows and onlineEditing flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        flows: [{ id: "f", name: "F", source: "online", editable: true }],
        onlineEditing: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useFlows({ baseUrl: "http://x/flows", intervalMs: 100000 }),
    );
    await waitFor(() => expect(result.current.flows).toHaveLength(1));
    expect(result.current.onlineEditing).toBe(true);
  });

  test("validate POSTs to /validate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ flows: [], onlineEditing: true }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ valid: true, errors: [], warnings: [], meta: {} }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useFlows({ baseUrl: "http://x/flows", intervalMs: 100000 }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const report = await result.current.validate(def);
    expect(report.valid).toBe(true);
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/validate"),
    );
    expect(call).toBeDefined();
    expect((call![1] as RequestInit).method).toBe("POST");
  });

  test("saveDraft uses PUT to /:id/draft", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ flows: [], onlineEditing: true }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ validation: { valid: true } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useFlows({ baseUrl: "http://x/flows", intervalMs: 100000 }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await act(async () => {
      await result.current.saveDraft("f", def);
    });
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/f/draft"),
    );
    expect((call![1] as RequestInit).method).toBe("PUT");
  });

  test("publish returns an error object on non-ok", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ flows: [], onlineEditing: true }),
      })
      .mockResolvedValue({
        ok: false,
        json: async () => ({
          error: { message: "invalid" },
          validation: { valid: false },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useFlows({ baseUrl: "http://x/flows", intervalMs: 100000 }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    let res: unknown;
    await act(async () => {
      res = await result.current.publish("f");
    });
    expect((res as { error?: string }).error).toBe("invalid");
  });
});

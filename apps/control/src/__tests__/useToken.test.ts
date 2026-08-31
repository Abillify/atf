// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, test, expect, beforeEach } from "vitest";
import { useToken } from "../hooks/useToken";

const KEY = "aiperator_monitoring_token";

describe("useToken", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("hydrates from localStorage on mount", async () => {
    window.localStorage.setItem(KEY, "stored-token");
    const { result } = renderHook(() => useToken());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.token).toBe("stored-token");
  });

  test("setToken persists and trims", async () => {
    const { result } = renderHook(() => useToken());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setToken("  abc.def.ghi  "));
    expect(result.current.token).toBe("abc.def.ghi");
    expect(window.localStorage.getItem(KEY)).toBe("abc.def.ghi");
  });

  test("clearToken removes the stored value", async () => {
    window.localStorage.setItem(KEY, "x");
    const { result } = renderHook(() => useToken());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.clearToken());
    expect(result.current.token).toBe("");
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test("setToken('') clears storage", async () => {
    const { result } = renderHook(() => useToken());
    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.setToken("y"));
    act(() => result.current.setToken(""));
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

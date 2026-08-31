// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, act } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { useThrottledValue } from "../hooks/useThrottledValue";

describe("useThrottledValue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns the first value immediately", () => {
    const { result } = renderHook(() => useThrottledValue("a", 100));
    expect(result.current).toBe("a");
  });

  test("collapses rapid updates within the window to a single trailing flush", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 100),
      { initialProps: { value: "v0" } },
    );
    expect(result.current).toBe("v0");

    // Several rapid updates within the same 100ms window.
    rerender({ value: "v1" });
    act(() => vi.advanceTimersByTime(30));
    rerender({ value: "v2" });
    act(() => vi.advanceTimersByTime(30));
    rerender({ value: "v3" });

    // None of the intermediate values have propagated yet — still v0.
    expect(result.current).toBe("v0");

    // Trailing flush fires once the window elapses, carrying the LATEST value.
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("v3");
  });

  test("propagates immediately once a full window has elapsed since the last flush", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 100),
      { initialProps: { value: "v0" } },
    );
    rerender({ value: "v1" });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe("v1");

    // A fresh update after the window has fully elapsed flushes right away.
    act(() => vi.advanceTimersByTime(200));
    rerender({ value: "v2" });
    expect(result.current).toBe("v2");
  });

  test("intervalMs <= 0 disables throttling (every update propagates immediately)", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 0),
      { initialProps: { value: "v0" } },
    );
    rerender({ value: "v1" });
    expect(result.current).toBe("v1");
    rerender({ value: "v2" });
    expect(result.current).toBe("v2");
  });

  test("never loses the final value even if updates stop mid-window", () => {
    const { result, rerender } = renderHook(
      ({ value }) => useThrottledValue(value, 100),
      { initialProps: { value: "v0" } },
    );
    rerender({ value: "v1" });
    act(() => vi.advanceTimersByTime(50));
    // No further updates arrive — the trailing timer must still flush v1.
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe("v1");
  });
});

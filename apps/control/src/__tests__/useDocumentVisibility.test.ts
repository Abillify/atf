// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { renderHook, act } from "@testing-library/react";
import { describe, test, expect, afterEach, vi } from "vitest";
import { useDocumentVisibility } from "../hooks/useDocumentVisibility";

/** Overrides `document.visibilityState` for the duration of a test. */
function setVisibilityState(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

describe("useDocumentVisibility", () => {
  afterEach(() => {
    setVisibilityState("visible");
  });

  test("reports true when the document starts visible", () => {
    setVisibilityState("visible");
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);
  });

  test("reports false when the document starts hidden", () => {
    setVisibilityState("hidden");
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(false);
  });

  test("updates on a visibilitychange event", () => {
    setVisibilityState("visible");
    const { result } = renderHook(() => useDocumentVisibility());
    expect(result.current).toBe(true);

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(false);

    act(() => {
      setVisibilityState("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe(true);
  });

  test("removes the listener on unmount", () => {
    setVisibilityState("visible");
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useDocumentVisibility());
    expect(addSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    unmount();
    expect(removeSpy).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});

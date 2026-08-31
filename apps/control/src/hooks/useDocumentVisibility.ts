"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useState } from "react";

/**
 * Tracks `document.visibilityState`, so a hook that polls or holds a
 * long-lived connection (SSE, WebSocket, an interval timer) can pause while
 * the tab is backgrounded instead of burning server load and client CPU for a
 * tab nobody is looking at. Resumes automatically when the tab becomes visible
 * again — callers typically re-run their fetch/reconnect logic on the
 * `isVisible` transition from `false` to `true`.
 *
 * Returns `true` during server-side rendering / when the Page Visibility API
 * is unavailable (e.g. non-browser test environments), so consumers default
 * to their normal (always-active) behaviour rather than staying paused
 * forever.
 */
export function useDocumentVisibility(): boolean {
  const [isVisible, setIsVisible] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState === "visible";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleChange = (): void => {
      setIsVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleChange);
    // Catch the case where visibility changed between the initial state
    // computation and this effect running (rare, but cheap to guard).
    handleChange();

    return () => {
      document.removeEventListener("visibilitychange", handleChange);
    };
  }, []);

  return isVisible;
}

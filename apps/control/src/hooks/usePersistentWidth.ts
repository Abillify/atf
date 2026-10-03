"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useEffect, useState } from "react";

/**
 * Pixel-width UI preference (resizable panel), remembered per browser and
 * clamped to [min, max]. Storage is best-effort: private mode or blocked site
 * data simply falls back to `initial` on every load. Read after mount so
 * server and first client render agree (the SSR render always uses `initial`).
 */
export function usePersistentWidth(
  key: string,
  initial: number,
  min: number,
  max: number,
): [number, (next: number) => void] {
  const storageKey = `atf.ui.${key}`;
  const clamp = useCallback(
    (w: number) => Math.max(min, Math.min(max, Math.round(w))),
    [min, max],
  );
  const [width, setWidthState] = useState(initial);

  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(storageKey));
      if (Number.isFinite(stored) && stored > 0) setWidthState(clamp(stored));
    } catch {
      /* storage unavailable — keep the default */
    }
  }, [storageKey, clamp]);

  const setWidth = useCallback(
    (next: number) => {
      setWidthState((prev) => {
        const resolved = clamp(next);
        if (resolved === prev) return prev;
        try {
          window.localStorage.setItem(storageKey, String(resolved));
        } catch {
          /* storage unavailable — state still applies for this session */
        }
        return resolved;
      });
    },
    [storageKey, clamp],
  );

  return [width, setWidth];
}

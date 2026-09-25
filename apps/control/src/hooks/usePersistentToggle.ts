"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useEffect, useState } from "react";

/**
 * Boolean UI preference (collapsed panel, focus mode, …) remembered per
 * browser. Storage is best-effort: private mode or blocked site data simply
 * falls back to `initial` on every load.
 */
export function usePersistentToggle(
  key: string,
  initial: boolean,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const storageKey = `atf.ui.${key}`;
  const [value, setValue] = useState(initial);

  // Read after mount so server and first client render agree.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === "1" || stored === "0") setValue(stored === "1");
    } catch {
      /* storage unavailable — keep the default */
    }
  }, [storageKey]);

  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        try {
          window.localStorage.setItem(storageKey, resolved ? "1" : "0");
        } catch {
          /* storage unavailable — state still applies for this session */
        }
        return resolved;
      });
    },
    [storageKey],
  );

  return [value, set];
}

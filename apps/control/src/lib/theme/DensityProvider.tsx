"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * DensityProvider — UI density preference (UI-STYLE-GUIDE.md §11).
 *
 * Sets `data-density="comfortable" | "compact"` on <html>; the density CSS
 * tokens in globals.css (`--ui-card-p`, `--ui-cell-py`, `--ui-cell-h`) flip
 * accordingly, so `Card`/`Table` tighten in compact mode without per-component
 * changes. Persisted to localStorage; applied pre-paint by the root layout
 * script (kept in sync via STORAGE_KEY) to avoid a flash.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Density = "comfortable" | "compact";

export interface DensityContextValue {
  density: Density;
  toggle: () => void;
  setDensity: (d: Density) => void;
}

const STORAGE_KEY = "aiperator_density";
const DensityContext = createContext<DensityContextValue | null>(null);

function apply(d: Density): void {
  try {
    document.documentElement.dataset.density = d;
  } catch {
    /* SSR */
  }
}

export function DensityProvider({
  children,
  defaultDensity = "comfortable",
}: {
  children: React.ReactNode;
  defaultDensity?: Density;
}) {
  const [density, setDensityState] = useState<Density>(defaultDensity);

  // Hydrate from localStorage on mount (client only).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "compact" || stored === "comfortable") {
        setDensityState(stored);
      }
    } catch {
      /* private mode */
    }
  }, []);

  useEffect(() => {
    apply(density);
  }, [density]);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    try {
      window.localStorage.setItem(STORAGE_KEY, d);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => {
    setDensityState((prev) => {
      const next: Density = prev === "compact" ? "comfortable" : "compact";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ density, toggle, setDensity }),
    [density, toggle, setDensity],
  );

  return (
    <DensityContext.Provider value={value}>{children}</DensityContext.Provider>
  );
}

export function useDensity(): DensityContextValue {
  const ctx = useContext(DensityContext);
  if (ctx === null) {
    throw new Error("useDensity must be used within a <DensityProvider>.");
  }
  return ctx;
}

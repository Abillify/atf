"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ThemeProvider — simple dark/light mode context (Req. 10.1).
 *
 * Toggles the `dark` class on `<html>` so Tailwind dark-mode variants
 * (`dark:bg-gray-900`, etc.) work across the entire app without prop drilling.
 * The preference is persisted to localStorage under `aiperator_theme`.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ColorScheme = "light" | "dark";

export interface ThemeContextValue {
  colorScheme: ColorScheme;
  toggle: () => void;
  setScheme: (scheme: ColorScheme) => void;
}

const STORAGE_KEY = "aiperator_theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** Initial scheme — useful for SSR / storybook. Defaults to "light". */
  defaultScheme?: ColorScheme;
}

export function ThemeProvider({
  children,
  defaultScheme = "light",
}: ThemeProviderProps) {
  const [colorScheme, setColorSchemeState] =
    useState<ColorScheme>(defaultScheme);

  // Hydrate from localStorage on mount (client only); fall back to the OS
  // preference when no explicit choice has been saved yet.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "dark" || stored === "light") {
        setColorSchemeState(stored);
        return;
      }
    } catch {
      /* private mode / SSR */
    }
    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        setColorSchemeState("dark");
      }
    } catch {
      /* matchMedia unavailable */
    }
  }, []);

  // Apply / remove the "dark" class on <html> whenever the scheme changes
  useEffect(() => {
    const root = document.documentElement;
    if (colorScheme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [colorScheme]);

  const setScheme = useCallback((scheme: ColorScheme) => {
    setColorSchemeState(scheme);
    try {
      window.localStorage.setItem(STORAGE_KEY, scheme);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => {
    setColorSchemeState((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ colorScheme, toggle, setScheme }),
    [colorScheme, toggle, setScheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error(
      "useTheme must be used within a <ThemeProvider>. " +
        "Ensure your root layout wraps children with <ThemeProvider>.",
    );
  }
  return ctx;
}

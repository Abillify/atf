"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback } from "react";

/** localStorage key under which the operator/monitoring token is persisted. */
export const TOKEN_STORAGE_KEY = "aiperator_monitoring_token";
const STORAGE_KEY = TOKEN_STORAGE_KEY;

export interface UseTokenResult {
  /** The current monitoring token, or "" when none is set. */
  token: string;
  /** True once the value has been hydrated from localStorage (avoids SSR flash). */
  ready: boolean;
  /** Persist a new token (empty string clears it). */
  setToken: (value: string) => void;
  /** Remove the stored token. */
  clearToken: () => void;
}

/**
 * Persists the operator's monitoring token in localStorage so the dashboard can
 * authenticate against `/monitoring/*` (and the control plane) when
 * `MONITORING_AUTH=true` — without an env rebuild. The token is read once on
 * mount and written through on every change.
 *
 * The token is sent as the `?token=` query param (EventSource cannot set an
 * Authorization header), which the backend accepts alongside the Bearer header.
 */
export function useToken(): UseTokenResult {
  const [token, setTokenState] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setTokenState(stored);
    } catch {
      /* localStorage unavailable (private mode / SSR) — fall back to in-memory */
    }
    setReady(true);
  }, []);

  const setToken = useCallback((value: string): void => {
    const trimmed = value.trim();
    setTokenState(trimmed);
    try {
      if (trimmed === "") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* ignore persistence failure */
    }
  }, []);

  const clearToken = useCallback((): void => setToken(""), [setToken]);

  return { token, ready, setToken, clearToken };
}

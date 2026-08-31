"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AuthProvider — centralized auth context (Req. 10.2).
 *
 * Consolidates `useToken` + `useSessionRenew` into a single provider that:
 * 1. Reads the operator session token from sessionStorage (or OIDC handoff).
 * 2. Parses the JWT to extract the `role` claim.
 * 3. Schedules silent token renewal before expiry.
 *
 * Consumers access the token via `useAuth()` (and pass it to `authFetch`) —
 * no prop-drilling required.
 */

import React, {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  consumeSessionFromUrl,
  decodeTokenExpSeconds,
  getAuthConfig,
  refreshSession,
} from "../oidc";

import type { AuthContextValue, AuthRole } from "./types";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Session-scoped storage key (kept compatible with legacy token migration). */
export const TOKEN_STORAGE_KEY = "aiperator_monitoring_token";

/** Seconds before `exp` to initiate silent renewal. */
const RENEW_SKEW_SECONDS = 60;

/**
 * Decodes the role claim from a JWT payload without verifying the signature.
 * Returns `undefined` when the claim is absent or not one of the known roles.
 */
export function extractRoleFromToken(token: string): AuthRole | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payloadPart = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? atob(payloadPart)
        : Buffer.from(payloadPart, "base64").toString("binary");
    const payload = JSON.parse(json) as { role?: unknown };
    const role = payload.role;
    if (role === "viewer" || role === "operator" || role === "admin") {
      return role;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [token, setTokenState] = useState<string | undefined>(undefined);
  const [tokenReady, setTokenReady] = useState(false);
  const [authConfigReady, setAuthConfigReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(true);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [authError, setAuthError] = useState<string | undefined>(undefined);

  // Keep a stable ref so the token accessor always returns the latest value
  // without causing re-renders in the API client.
  const tokenRef = useRef<string | undefined>(undefined);

  // --- Token persistence helpers ---

  const persistToken = useCallback((value: string | undefined) => {
    setTokenState(value);
    tokenRef.current = value;
    try {
      if (!value) {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      } else {
        // Keep access tokens only for the current browser tab/session. Refresh
        // remains in the HttpOnly backend cookie and tokens never survive a
        // browser restart as they did in localStorage.
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, value);
      }
      // Remove tokens written by versions before session-scoped storage.
      window.localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      /* Web Storage unavailable — fall back to in-memory */
    }
  }, []);

  const clearToken = useCallback(() => {
    persistToken(undefined);
  }, [persistToken]);

  const clearAuthError = useCallback(() => {
    setAuthError(undefined);
  }, []);

  // --- Hydrate token on mount ---

  useEffect(() => {
    // 1. Check for OIDC session handoff (URL fragment from backend callback)
    const handoff = consumeSessionFromUrl();
    if (handoff.error) {
      setAuthError(handoff.error);
    }
    if (handoff.token) {
      persistToken(handoff.token);
      setTokenReady(true);
      return;
    }

    // 2. Fall back to this tab's session token; deliberately do not restore
    // legacy localStorage credentials across browser restarts.
    try {
      const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (stored) {
        persistToken(stored);
      }
    } catch {
      /* private mode or SSR — proceed without stored token */
    }
    setTokenReady(true);
  }, [persistToken]);

  // --- Detect effective operator authentication mode ---

  useEffect(() => {
    let active = true;
    void getAuthConfig().then((cfg) => {
      if (!active) return;
      setSsoEnabled(cfg.enabled);
      // Missing `required` in a mocked/older response remains fail-closed.
      setAuthRequired(cfg.required !== false);
      setAuthConfigReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // --- Silent renewal scheduler ---

  const renewNow = useCallback(async (): Promise<string | null> => {
    const next = await refreshSession();
    if (next !== null) {
      persistToken(next);
    }
    return next;
  }, [persistToken]);

  useEffect(() => {
    if (!ssoEnabled || !token) return;
    const exp = decodeTokenExpSeconds(token);
    if (exp === null) return;

    const nowSec = Date.now() / 1000;
    const delayMs = Math.max(0, (exp - nowSec - RENEW_SKEW_SECONDS) * 1000);
    // Cap below the 32-bit setTimeout ceiling; a fresh token reschedules.
    const capped = Math.min(delayMs, 2_147_483_000);
    const timer = setTimeout(() => {
      void renewNow();
    }, capped);
    return () => clearTimeout(timer);
  }, [token, ssoEnabled, renewNow]);

  // --- Derived auth state and role ---

  const ready = tokenReady && authConfigReady;
  const role: AuthRole | undefined = useMemo(
    () => (token ? extractRoleFromToken(token) : authRequired ? undefined : "admin"),
    [token, authRequired],
  );

  // --- Context value (stable identity unless values change) ---

  const value: AuthContextValue = useMemo(
    () => ({
      token,
      role,
      isAuthenticated: !authRequired || !!token,
      ready,
      ssoEnabled,
      authError,
      setToken: persistToken,
      clearToken,
      clearAuthError,
      renewNow,
    }),
    [
      token,
      role,
      authRequired,
      ready,
      ssoEnabled,
      authError,
      persistToken,
      clearToken,
      clearAuthError,
      renewNow,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

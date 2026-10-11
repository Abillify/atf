"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AuthProvider — centralized auth context (Req. 10.2).
 *
 * The single auth provider (the legacy `useToken` hook is removed, Req 8.6)
 * that:
 * 1. Reads the operator session token from sessionStorage (or OIDC handoff).
 * 2. Parses the JWT to extract the `role` claim.
 * 3. Schedules silent token renewal before expiry.
 *
 * Consumers access the token via `useAuth()` (and pass it to `authFetch`) —
 * no prop-drilling required.
 *
 * BFF mode (Req 8.7, `CONTROL_SESSION_MODE=bff`): on mount the provider probes
 * `/api/session`. When the server reports BFF mode, the raw token from an OIDC
 * handoff (or a manual paste via `setToken`) is exchanged for the encrypted
 * HttpOnly session cookie and NEVER stored in JS-readable state — the context
 * carries the non-credential sentinel `BFF_TOKEN_SENTINEL` instead, so the
 * many `!!token` gates keep working while nothing usable leaks to the browser.
 * The role comes from the server-side session status; silent renewal is not
 * available (the backend refresh cookie lives on the Runtime origin), so an
 * expired BFF session falls back to an interactive SSO login.
 */

import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type React from "react";

import { base64UrlDecodeToString } from "@atf/security-kit/browser";

import {
  consumeSessionFromUrl,
  decodeTokenExpSeconds,
  getAuthConfig,
  refreshSession,
} from "../oidc";
import {
  bffClearSession,
  bffExchangeToken,
  bffSessionStatus,
} from "../bff-client";
import { isBffMode } from "../client-session-mode";

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
 * Placeholder the context exposes in BFF mode in place of the real token
 * (Req 8.7). It is NOT a credential — the actual bearer token is injected
 * server-side by the `/api/backend` proxy from the HttpOnly cookie. Its only
 * job is to keep the existing `!!token` authentication gates working.
 */
export const BFF_TOKEN_SENTINEL = "bff-session";

/**
 * Decodes the role claim from a JWT payload without verifying the signature.
 * Returns `undefined` when the claim is absent or not one of the known roles.
 *
 * Uses the shared padding-correct base64url codec from
 * `@atf/security-kit/browser` (Req 8.5) instead of a local atob/Buffer path.
 */
export function extractRoleFromToken(token: string): AuthRole | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payloadB64 = parts[1];
  if (payloadB64 === undefined) return undefined;
  try {
    const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as {
      role?: unknown;
    };
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
  // BFF mode (Req 8.7): token lives only in the HttpOnly cookie; the context
  // carries the sentinel and this server-reported role instead. The mode
  // itself is known synchronously from the server-rendered flag (see
  // `client-session-mode.ts`) — no probe round-trip needed to learn it.
  const bffMode = isBffMode();
  const [bffRole, setBffRole] = useState<string | null>(null);

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

  const clearAuthError = useCallback(() => {
    setAuthError(undefined);
  }, []);

  // --- Hydrate token on mount (token mode) / establish BFF session ---

  useEffect(() => {
    // 1. Check for OIDC session handoff (URL fragment from backend callback)
    const handoff = consumeSessionFromUrl();
    if (handoff.error) {
      setAuthError(handoff.error);
    }

    // 2. BFF mode (Req 8.7): the server holds the token. A handoff token is
    // EXCHANGED for the HttpOnly cookie — it must never enter sessionStorage
    // in this mode. Otherwise the existing cookie decides the auth state.
    if (bffMode) {
      void bffSessionStatus().then(async (status) => {
        setSsoEnabled(status?.config.enabled ?? false);
        // Fail closed when the status probe failed: require authentication.
        setAuthRequired(status?.config.required ?? true);
        setAuthConfigReady(true);
        if (handoff.token) {
          const exchanged = await bffExchangeToken(handoff.token);
          if (exchanged !== null) {
            setBffRole(exchanged.role);
            setTokenState(BFF_TOKEN_SENTINEL);
            tokenRef.current = BFF_TOKEN_SENTINEL;
          }
        } else if (status?.authenticated === true) {
          setBffRole(status.role);
          setTokenState(BFF_TOKEN_SENTINEL);
          tokenRef.current = BFF_TOKEN_SENTINEL;
        }
        setTokenReady(true);
      });
      return;
    }

    function hydrateTokenMode(handoffToken: string | null): void {
      if (handoffToken) {
        persistToken(handoffToken);
        setTokenReady(true);
        return;
      }
      // Fall back to this tab's session token; deliberately do not restore
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
    }

    // 3. Token mode (default): the legacy hydration path, unchanged.
    hydrateTokenMode(handoff.token);
  }, [persistToken, bffMode]);

  // --- Detect effective operator authentication mode (token mode) ---

  useEffect(() => {
    let active = true;
    // In BFF mode the config arrives with the /api/session status; the direct
    // backend probe would target the wrong origin there.
    if (bffMode) return;
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
  }, [bffMode]);

  // --- Silent renewal scheduler ---

  const renewNow = useCallback(async (): Promise<string | null> => {
    // BFF mode: the backend refresh session is a cookie on the Runtime origin
    // and unreachable cross-site; the operator re-authenticates via SSO when
    // the sealed session expires (Req 8.7 keeps the token server-side only).
    if (bffMode) return null;
    const next = await refreshSession();
    if (next !== null) {
      persistToken(next);
    }
    return next;
  }, [persistToken, bffMode]);

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
  // When operator authentication is disabled the deployment grants full
  // access regardless of any (possibly stale) session token — otherwise a
  // leftover token without a valid `role` claim would resolve to `undefined`
  // and grey out the whole UI via `RequireRole`.
  const role: AuthRole | undefined = useMemo(() => {
    if (!authRequired) return "admin";
    // In BFF mode the token is a sentinel — the role comes from the server,
    // which decoded it from the real token when sealing the session.
    if (bffMode) {
      return bffRole === "viewer" || bffRole === "operator" || bffRole === "admin"
        ? bffRole
        : undefined;
    }
    return token ? extractRoleFromToken(token) : undefined;
  }, [token, authRequired, bffMode, bffRole]);

  // --- Token mutation entry points (BFF-aware) ---

  // Manual token input (TokenSettings) or any programmatic setToken: in BFF
  // mode the raw token is handed to the server for sealing and dropped
  // immediately (Req 8.7); in token mode it follows the sessionStorage path.
  const setToken = useCallback(
    (value: string | undefined) => {
      if (!bffMode) {
        persistToken(value);
        return;
      }
      if (value === undefined || value === "") {
        setTokenState(undefined);
        tokenRef.current = undefined;
        setBffRole(null);
        void bffClearSession();
        return;
      }
      void bffExchangeToken(value).then((exchanged) => {
        if (exchanged === null) return; // exchange failed — stay unauthenticated
        setBffRole(exchanged.role);
        setTokenState(BFF_TOKEN_SENTINEL);
        tokenRef.current = BFF_TOKEN_SENTINEL;
      });
    },
    [persistToken, bffMode],
  );

  const clearToken = useCallback(() => {
    if (bffMode) {
      setTokenState(undefined);
      tokenRef.current = undefined;
      setBffRole(null);
      void bffClearSession();
      return;
    }
    persistToken(undefined);
  }, [persistToken, bffMode]);

  // --- Context value (stable identity unless values change) ---

  const value: AuthContextValue = useMemo(
    () => ({
      token,
      role,
      isAuthenticated: !authRequired || !!token,
      ready,
      ssoEnabled,
      authError,
      setToken,
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
      setToken,
      clearToken,
      clearAuthError,
      renewNow,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useCallback, useEffect } from "react";
import { refreshSession, decodeTokenExpSeconds } from "../lib/oidc";

export interface UseSessionRenewOptions {
  /** The current operator session token ("" when none). */
  token: string;
  /**
   * Whether silent renewal is possible — typically `ssoEnabled`. When false the
   * hook is inert (a manually-pasted token has no refresh session to renew).
   */
  enabled: boolean;
  /** Persists the freshly minted token (from `useAuth`). */
  setToken: (value: string) => void;
  /** Renew this many seconds BEFORE the token's exp. Default 60. */
  skewSeconds?: number;
}

export interface UseSessionRenewResult {
  /**
   * Renews the session now via the backend refresh endpoint, persisting and
   * returning the new token — or null when renewal failed (caller should fall
   * back to an interactive login). Stable identity, safe to pass as a callback.
   */
  renewNow: () => Promise<string | null>;
}

/**
 * Keeps the operator session token fresh by silently renewing it shortly before
 * it expires (backend-driven refresh via an HttpOnly cookie — see
 * `lib/oidc.refreshSession`). This is what removes the "log out / log back in to
 * see history or live requests" friction: the token no longer silently dies.
 *
 * Renewal reschedules itself off each new token's `exp`, so an operator with a
 * live IdP session stays authenticated indefinitely without interaction.
 */
export function useSessionRenew(
  options: UseSessionRenewOptions,
): UseSessionRenewResult {
  const { token, enabled, setToken, skewSeconds = 60 } = options;

  const renewNow = useCallback(async (): Promise<string | null> => {
    const next = await refreshSession();
    if (next !== null) setToken(next);
    return next;
  }, [setToken]);

  useEffect(() => {
    if (!enabled || token === "") return;
    const exp = decodeTokenExpSeconds(token);
    if (exp === null) return;

    const nowSec = Date.now() / 1000;
    const delayMs = Math.max(0, (exp - nowSec - skewSeconds) * 1000);
    // Cap below the 32-bit setTimeout ceiling; a new token reschedules anyway.
    const capped = Math.min(delayMs, 2_147_483_000);
    const timer = setTimeout(() => {
      void renewNow();
    }, capped);
    return () => clearTimeout(timer);
  }, [token, enabled, skewSeconds, renewNow]);

  return { renewNow };
}

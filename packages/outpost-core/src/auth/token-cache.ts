// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Access-token cache with proactive renewal (requirements 4.2).
 *
 * A token is considered expiring when it is valid for at most 60 more
 * seconds; the provider then refreshes before the next request instead of
 * letting the API reject it.
 */

/** Refresh window: renew when the token expires within 60 seconds. */
export const REFRESH_WINDOW_MS = 60_000;

/** True when `expiresAt` (epoch ms) is within the refresh window of `now`. */
export const needsRefresh = (expiresAt: number, now: number): boolean =>
  expiresAt - now <= REFRESH_WINDOW_MS;

export interface CachedToken {
  accessToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * Tiny holder for the current access token. The Auth_Manager owns it; the
 * HTTP client only reads through `getAccessToken`.
 */
export class TokenCache {
  private token: CachedToken | null = null;

  get current(): CachedToken | null {
    return this.token;
  }

  set(token: CachedToken): void {
    this.token = token;
  }

  clear(): void {
    this.token = null;
  }

  /** True when no token is cached or it expires within the window (4.2). */
  isExpiring(now: number): boolean {
    return this.token === null || needsRefresh(this.token.expiresAt, now);
  }
}

/** Convert an OAuth `expires_in` (seconds) into an absolute expiry. */
export const expiresAtFromNow = (now: number, expiresInSec: number): number =>
  now + expiresInSec * 1000;

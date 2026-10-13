// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Static service-token matching with rotation support (requirement 11.8).
 *
 * A service accepts its configured `API_TOKEN` plus, during a rotation window,
 * a second token (`API_TOKEN_NEXT`). Both are valid simultaneously so the
 * caller side can be switched over without a downtime window; once every
 * caller presents the new token, the old one is removed from the config and
 * the service is reloaded.
 *
 * Every comparison goes through {@link safeEqual}, so neither token leaks
 * content or length through timing.
 */

import { safeEqual } from "../compare.ts";

/**
 * Build a matcher that accepts a candidate token when it equals any of the
 * provided tokens. `null`/empty entries are ignored, so callers can pass
 * optional tokens directly. A matcher without any configured token rejects
 * everything — the caller must not install it in that case (the auth mode is
 * `disabled` or OIDC-only instead).
 */
export function createStaticTokenMatcher(
  tokens: ReadonlyArray<string | null | undefined>,
): (candidate: string) => boolean {
  const configured = tokens.filter((token): token is string =>
    token !== null && token !== undefined && token.length > 0,
  );
  return (candidate: string): boolean =>
    configured.some((token) => safeEqual(candidate, token));
}

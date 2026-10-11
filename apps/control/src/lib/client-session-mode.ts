// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Client-side view of the Control session mode (Req 8.7).
 *
 * The authoritative mode is the SERVER environment variable
 * `CONTROL_SESSION_MODE` (see `session-mode.ts`). The browser learns it from a
 * server-rendered inline script in `app/layout.tsx` (carrying the CSP nonce),
 * which sets `window.__ATF_CONTROL_SESSION_MODE__` before hydration — so
 * `backendUrl()` can rewrite API paths synchronously without an extra probe
 * round-trip.
 *
 * Absent the flag (token mode, tests, or a page rendered outside the root
 * layout) everything behaves exactly like the pre-BFF token mode.
 */

/** Global set by the root layout when the server runs in BFF mode. */
export const CONTROL_SESSION_MODE_GLOBAL = "__ATF_CONTROL_SESSION_MODE__";

/** True when the server told the browser it runs `CONTROL_SESSION_MODE=bff`. */
export function isBffMode(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>)[
      CONTROL_SESSION_MODE_GLOBAL
    ] === "bff"
  );
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Control session mode (Req 8.7).
 *
 * `token` (default): the operator session token lives in the browser
 * (sessionStorage) and is sent as `Authorization: Bearer …` — the behaviour
 * every deployment used before 0.15.
 *
 * `bff`: the token is held ONLY server-side (encrypted HttpOnly cookie, see
 * `session-crypto.ts`); API calls go through the Next.js route handlers,
 * which inject the bearer token. The browser never sees it.
 *
 * An invalid value fails every request (fail closed), matching the
 * `CONTROL_CSP_MODE` handling in `src/proxy.ts` — a typo must never silently
 * downgrade a deployment that intended the hardened mode.
 */

export type ControlSessionMode = "token" | "bff";

export function parseControlSessionMode(
  raw: string | undefined,
): ControlSessionMode {
  if (raw === undefined || raw === "" || raw === "token") return "token";
  if (raw === "bff") return "bff";
  throw new Error(
    `Invalid CONTROL_SESSION_MODE "${raw}" — expected "token" or "bff"`,
  );
}

/** Reads the mode from the server environment (never bundled to the client). */
export function controlSessionMode(): ControlSessionMode {
  return parseControlSessionMode(process.env["CONTROL_SESSION_MODE"]);
}

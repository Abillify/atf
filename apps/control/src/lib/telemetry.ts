// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Error telemetry (Req 9.6, Task 13.5).
 *
 * Reports render/runtime errors to the configurable telemetry endpoint.
 * The browser always POSTs same-origin to `/api/telemetry` (CSP safe, no
 * token in the client); the route handler forwards to `CONTROL_TELEMETRY_URL`
 * when set and otherwise logs on the server.
 *
 * Fire and forget: telemetry must never block the user path or throw errors
 * itself. Identical messages are deduplicated for a short window so a broken
 * render loop does not flood the endpoint.
 */

import { json } from "./control-api";

export interface TelemetryEvent {
  /** Short description of the error (error.message). */
  message: string;
  /** Stack trace, if available. */
  stack?: string;
  /** Server-side error identifier (Next.js `error.digest`). */
  digest?: string;
  /** Route/path in which the error occurred. */
  page?: string;
  /** Source of the report, e.g. "error-boundary" or "global". */
  source?: string;
}

/** Time window in ms within which identical messages are reported only once. */
const DEDUPE_WINDOW_MS = 30_000;

const recentlySent = new Map<string, number>();

/**
 * Reports an error on a best-effort basis: never rejects and never throws.
 * Returns a promise for testability; callers may ignore it.
 */
export function reportClientError(event: TelemetryEvent): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const key = `${event.source ?? ""}|${event.message}`;
  const now = Date.now();
  const last = recentlySent.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
    return Promise.resolve();
  }
  recentlySent.set(key, now);
  // Bound the map so a long session does not grow without limit.
  if (recentlySent.size > 200) {
    for (const [k, t] of recentlySent) {
      if (now - t >= DEDUPE_WINDOW_MS) recentlySent.delete(k);
    }
  }
  const page =
    event.page ??
    `${window.location.pathname}${window.location.search}`;
  return json("/api/telemetry", {
    method: "POST",
    jsonBody: { ...event, page },
  })
    .then(() => undefined)
    .catch(() => {
      // Telemetry is best effort; an error here stays silent.
    });
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Authenticated fetch helper (`src/lib/auth-fetch.ts`).
 *
 * The operator token used to be appended to every request URL as `?token=…`,
 * where it leaks into browser history, access logs and proxy logs. For normal
 * REST calls that is unnecessary: unlike `EventSource`/`WebSocket`, `fetch` CAN
 * set request headers — so we send the token as `Authorization: Bearer …`
 * instead. The backend's operator auth already accepts the header (it checks the
 * `Authorization` header before the `?token=` query param), so this is a drop-in
 * change with no server-side migration.
 *
 * The short-lived-ticket mechanism remains only for the SSE/WebSocket stream,
 * which genuinely cannot send a header.
 */
import { request } from "./control-api";

export function authFetch(
  input: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<Response> {
  return request(input, { ...init, token, target: "same-origin" });
}

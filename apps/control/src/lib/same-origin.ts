// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Same-origin guard for state-changing Control route handlers
 * (`/api/session`, `/api/telemetry`).
 *
 * Browsers attach `Sec-Fetch-Site` and `Origin` to cross-site requests; a
 * request is rejected when either header proves a foreign origin. Requests
 * without both headers (non-browser clients, older browsers) pass: they cannot
 * carry a victim's cookies through a cross-site form post anyway, because the
 * session cookie is `SameSite=Strict`. This blocks login CSRF and cross-site
 * log injection without changing same-origin behaviour.
 *
 * Set `CONTROL_PUBLIC_ORIGIN` (for example `https://control.example.com`) to
 * pin the accepted host instead of trusting request headers.
 */

const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

/**
 * Host of `CONTROL_PUBLIC_ORIGIN` when it is set: `undefined` when unset,
 * `null` when it is set but not a valid http(s) origin (fail closed).
 */
function pinnedHost(): string | null | undefined {
  const raw = process.env["CONTROL_PUBLIC_ORIGIN"]?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Hosts under which this request may legitimately have been addressed.
 *
 * With `CONTROL_PUBLIC_ORIGIN` set, only that host counts and
 * `X-Forwarded-Host` is ignored, so a client-supplied header cannot widen the
 * allow-list. Without it the legacy behaviour applies (forwarded host, `Host`,
 * request URL), which is only safe when the reverse proxy overwrites
 * `X-Forwarded-Host`. An invalid value yields an empty set: every request that
 * carries an `Origin` header is rejected.
 */
function requestHosts(request: Request): Set<string> {
  const pinned = pinnedHost();
  if (pinned !== undefined) return new Set(pinned === null ? [] : [pinned]);
  const hosts = new Set<string>();
  const forwarded = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded) hosts.add(forwarded);
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (host) hosts.add(host);
  try {
    hosts.add(new URL(request.url).host.toLowerCase());
  } catch {
    // An unparsable request URL contributes no host.
  }
  return hosts;
}

/** `true` unless `Sec-Fetch-Site` or `Origin` identify a cross-site sender. */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) return false;
  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      // Includes the opaque `Origin: null` sent from sandboxed contexts.
      return false;
    }
    if (!requestHosts(request).has(originHost)) return false;
  }
  return true;
}

/** `true` when the request declares a JSON body (`application/json[; …]`). */
export function hasJsonContentType(request: Request): boolean {
  const type = request.headers.get("content-type");
  if (!type) return false;
  return type.split(";")[0]?.trim().toLowerCase() === "application/json";
}

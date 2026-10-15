// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Path allowlist for the optional BFF proxy (Req 8.7).
 *
 * The catch-all route handler forwards `/{prefix}/…` requests to the Runtime.
 * Without a allowlist the Next server would become an open proxy (SSRF):
 * any external caller could reach arbitrary backend paths — including
 * unauthenticated or admin-only ones — through it. Only the prefixes below,
 * which mirror exactly what the dashboard UI itself calls (see
 * `src/lib/backend-url.ts` consumers), are forwarded; everything else is
 * rejected with 404 before any request leaves the server.
 *
 * `/v1/chat/completions` carries Studio test runs (`lib/studio-run.ts`);
 * `/v1/receipts` and the receipt JWKS back the receipt verification panel
 * (`lib/receipt-verify.ts`).
 *
 * Matching is done on the URL *pathname* (query strings are irrelevant here)
 * and is deliberately prefix-based: `/admin/tenants` also covers
 * `/admin/tenants/{id}/keys`. A prefix only matches at a path-segment
 * boundary, so `/flowsXYZ` is not matched by `/flows`.
 */

/** Backend path prefixes the BFF may forward to. */
export const BFF_ALLOWED_PREFIXES: readonly string[] = [
  "/admin/",
  "/autopilot/",
  "/eval/",
  "/flows",
  "/mcp/servers",
  "/monitoring/",
  "/optimizer/",
  "/security/",
  "/triggers",
  "/v1/chat/completions",
  "/v1/jobs/",
  "/v1/models",
  "/v1/receipts",
  "/.well-known/atf-receipt-jwks.json",
];

/**
 * Paths under an allowed prefix that must NEVER be proxied. The OIDC login
 * dance (login/callback/logout/refresh) is a top-level browser navigation
 * handled directly against the Runtime — proxying it through Next would break
 * the IdP redirect contract and the backend's own HttpOnly session cookie.
 */
export const BFF_DENIED_PREFIXES: readonly string[] = [
  "/monitoring/auth/",
];

/**
 * Normalises `pathname` (dot segments, backslashes) the way the upstream URL
 * parser will and returns the normalised path when it may be forwarded
 * (segment-boundary prefix match), else `null`. Callers must forward exactly
 * the returned path so the validated and the requested path never diverge.
 */
export function normalizeBffPath(pathname: string): string | null {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  // Query/fragment delimiters belong in the search part, never in the path.
  if (pathname.includes("?") || pathname.includes("#")) return null;
  let path: string;
  try {
    // Absolute base + raw path: `URL` resolves `.`/`..` segments and treats
    // `\` as `/`, exactly as `fetch` will when building the upstream request.
    path = new URL(`http://localhost${pathname}`).pathname;
  } catch {
    return null;
  }
  if (path.startsWith("//")) return null;
  for (const denied of BFF_DENIED_PREFIXES) {
    if (path.startsWith(denied)) return null;
  }
  const allowed = BFF_ALLOWED_PREFIXES.some((prefix) => {
    if (prefix.endsWith("/")) return path.startsWith(prefix);
    return path === prefix || path.startsWith(`${prefix}/`);
  });
  return allowed ? path : null;
}
/** True when `pathname` may be forwarded (segment-boundary prefix match). */
export function isBffPathAllowed(pathname: string): boolean {
  return normalizeBffPath(pathname) !== null;
}

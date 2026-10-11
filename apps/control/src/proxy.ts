// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Control request proxy (Next.js 16 — the renamed middleware), Req. 8.1/8.2.
 *
 * Emits the CSP (nonce-based enforce, report-only, or nothing for legacy) and
 * the baseline security headers per request. The nonce is generated here and
 *
 * 1. set on the response CSP header (`script-src 'self' 'nonce-…'`),
 * 2. forwarded to the renderer in the request's `content-security-policy`
 *    header — Next extracts the nonce from there and applies it to its own
 *    inline scripts (RSC flight data, bootstrap), and
 * 3. forwarded as `x-control-csp-nonce` so the root layout can nonce the
 *    blocking theme-init script.
 *
 * An invalid CONTROL_CSP_MODE throws on every request (fail closed), matching
 * the previous build-time behaviour in next.config.ts.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  CSP_NONCE_REQUEST_HEADER,
  controlCspHeaders,
  controlSecurityHeaders,
  generateControlCspNonce,
  parseControlCspMode,
} from "./lib/csp-policy";

/** True when the browser-facing request arrived over TLS, honouring the
 *  reverse proxy (`x-forwarded-proto`) used in every production deployment. */
export function isSecureRequest(request: NextRequest): boolean {
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded === "https";
  return request.nextUrl.protocol === "https:";
}

export default function proxy(request: NextRequest): NextResponse {
  const mode = parseControlCspMode(process.env["CONTROL_CSP_MODE"]);
  const nonce = mode === "legacy" ? undefined : generateControlCspNonce();

  const cspHeaders = controlCspHeaders({
    mode,
    development: process.env.NODE_ENV === "development",
    backendUrl: process.env["NEXT_PUBLIC_BACKEND_URL"],
    nonce,
  });

  // Build the forwarded request headers first so the renderer can extract the
  // nonce for its own inline scripts, and the root layout can read it via
  // `x-control-csp-nonce`. The response must be created WITH these headers:
  // a second NextResponse.next() would drop any headers set on the first one.
  let init: { request?: { headers: Headers } } | undefined;
  if (nonce) {
    const requestHeaders = new Headers(request.headers);
    const policy = cspHeaders[0]?.value;
    if (policy) requestHeaders.set("content-security-policy", policy);
    requestHeaders.set(CSP_NONCE_REQUEST_HEADER, nonce);
    init = { request: { headers: requestHeaders } };
  }

  const response = NextResponse.next(init);
  for (const header of cspHeaders) {
    response.headers.set(header.key, header.value);
  }
  for (const header of controlSecurityHeaders({
    secure: isSecureRequest(request),
  })) {
    response.headers.set(header.key, header.value);
  }

  return response;
}

// Skip Next-internal assets; everything else (pages, RSC navigations, API
// routes) receives the headers. Mirrors the default middleware matcher, which
// already excludes files with an extension.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

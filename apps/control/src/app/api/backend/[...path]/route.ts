// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * BFF backend proxy (`app/api/backend/[...path]/route.ts`, Req 8.7).
 *
 * Active only when `CONTROL_SESSION_MODE=bff`. Forwards allowlisted Runtime
 * paths (`bff-allowlist.ts` — no SSRF) with the access token from the
 * encrypted session cookie injected as `Authorization: Bearer …`. The browser
 * talks to `/api/backend/*` same-origin only: no token in JS, no token in
 * EventSource URLs (Req 8.3 holds structurally — the SSE stream is
 * authenticated by the HttpOnly cookie alone).
 *
 * Without a valid session every request answers 401; paths outside the
 * allowlist answer 404 without ever contacting the backend.
 */

import { normalizeBffPath } from "../../../../lib/bff-allowlist";
import {
  backendOrigin,
  resolveSession,
} from "../../../../lib/bff-session";
import { isSameOriginRequest } from "../../../../lib/same-origin";
import { controlSessionMode } from "../../../../lib/session-mode";

export const dynamic = "force-dynamic";

/** Response headers that must not be forwarded between hops. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  // fetch() transparently decompresses; forwarding these would double-decode.
  "content-encoding",
  "content-length",
  // The Control's own session cookie must never be overwritten by the backend.
  "set-cookie",
]);

/** Client request headers that are safe (and useful) to forward. */
const FORWARD_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "last-event-id",
];

type RouteParams = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, routeParams: RouteParams): Promise<Response> {
  if (controlSessionMode() !== "bff") {
    return new Response("Not found", { status: 404 });
  }
  const origin = backendOrigin();
  if (origin === null) {
    return new Response("Backend not configured", { status: 503 });
  }

  const { path } = await routeParams.params;
  const segments = (path ?? []).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const search = new URL(request.url).search;
  // Re-encode every decoded segment so encoded separators (`%2F`, `%5C`) and
  // delimiters stay inside their segment, then forward exactly the path the
  // allowlist validated (dot segments already resolved).
  const targetPath = normalizeBffPath(
    `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`,
  );
  if (targetPath === null) {
    return new Response("Not found", { status: 404 });
  }

  // CSRF / cross-site read guard: the session cookie authenticates every
  // request it rides on, so only this origin may use it. SameSite=Strict is
  // the first line; this check is the second, and it also covers browsers or
  // proxies that relax cookie attributes. Non-browser callers send neither
  // header and cannot hold the operator's cookie in the first place.
  if (!isSameOriginRequest(request)) {
    return new Response(JSON.stringify({ error: "cross_site_request" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const session = await resolveSession(request);
  if (session === null) {
    return new Response(
      JSON.stringify({ error: "unauthenticated" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${session.token}`);

  const hasBody =
    request.method !== "GET" && request.method !== "HEAD";

  let upstream: Response;
  try {
    // `duplex: "half"` is required by undici for streaming request bodies but
    // missing from the DOM RequestInit types — hence the cast.
    upstream = await fetch(`${origin}${targetPath}${search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      duplex: hasBody ? "half" : undefined,
      redirect: "manual",
    } as RequestInit);
  } catch {
    return new Response(
      JSON.stringify({ error: "backend_unreachable" }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;

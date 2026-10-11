// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * BFF session route (`app/api/session/route.ts`, Req 8.7).
 *
 * Only active when `CONTROL_SESSION_MODE=bff`; every other mode answers 404 so
 * token-mode deployments behave exactly as before. The browser exchanges a raw
 * operator token (OIDC handoff fragment or manual paste) for an encrypted
 * HttpOnly/Secure/SameSite=Strict cookie and can read its own session status —
 * the access token itself never crosses back into JS-readable state.
 *
 *   GET    → { mode, authenticated, role, config }
 *   POST   → body { token } — seal into the session cookie
 *   DELETE → clear the session cookie
 *
 * POST and DELETE reject cross-site requests (403, login-CSRF guard) and POST
 * requires `Content-Type: application/json` (415).
 */

import {
  clearSessionCookieHeader,
  fetchBackendAuthConfig,
  readSessionCookie,
  requestIsSecure,
  resolveSession,
  sealTokenForCookie,
  sessionCookieHeader,
} from "../../../lib/bff-session";
import {
  hasJsonContentType,
  isSameOriginRequest,
} from "../../../lib/same-origin";
import { controlSessionMode } from "../../../lib/session-mode";

export const dynamic = "force-dynamic";

function notBff(): Response {
  return new Response("Not found", { status: 404 });
}

function crossSite(): Response {
  return json({ error: "cross_site_request" }, { status: 403 });
}
function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  if (controlSessionMode() !== "bff") return notBff();
  const session = await resolveSession(request);
  const config = await fetchBackendAuthConfig();
  return json({
    mode: "bff",
    authenticated: session !== null,
    role: session?.role ?? null,
    config,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (controlSessionMode() !== "bff") return notBff();
  if (!isSameOriginRequest(request)) return crossSite();
  if (!hasJsonContentType(request)) {
    return json({ error: "unsupported_media_type" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }
  const token = (body as { token?: unknown })?.token;
  if (typeof token !== "string" || token === "") {
    return json({ error: "token_required" }, { status: 400 });
  }
  const sealed = await sealTokenForCookie(token);
  if (sealed === null) {
    // CONTROL_SESSION_SECRET missing/too short — refuse rather than store the
    // session with a weak or absent key (fail closed).
    return json(
      { error: "session_secret_unconfigured" },
      { status: 503 },
    );
  }
  return json(
    { ok: true, role: sealed.role, expiresAt: sealed.expiresAt },
    {
      headers: {
        "Set-Cookie": sessionCookieHeader(
          sealed.sealed,
          requestIsSecure(request),
          sealed.expiresAt,
        ),
      },
    },
  );
}

export async function DELETE(request: Request): Promise<Response> {
  if (controlSessionMode() !== "bff") return notBff();
  if (!isSameOriginRequest(request)) return crossSite();
  const hadSession = readSessionCookie(request) !== null;
  return json(
    { ok: true, cleared: hadSession },
    { headers: { "Set-Cookie": clearSessionCookieHeader(requestIsSecure(request)) } },
  );
}

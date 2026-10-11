// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
import { NextResponse } from "next/server";
import {
  hasJsonContentType,
  isSameOriginRequest,
} from "../../../lib/same-origin";
/**
 * Error telemetry endpoint (Req 9.6, Task 13.5).
 *
 * Accepts client-reported errors (same-origin POST, so the CSP
 * `connect-src 'self'` suffices) and forwards them to the configurable
 * endpoint `CONTROL_TELEMETRY_URL` when set. Without configuration the error
 * is only logged server-side. Accepted events always get a 204 so a failed
 * forward never provokes client retries.
 *
 * The endpoint is unauthenticated, so it only accepts same-origin JSON posts
 * (cross-site → 403, non-JSON → 415) and strips control characters before
 * anything reaches the server log or the forward target.
 */
export const dynamic = "force-dynamic";
/** Maximum body size in bytes; telemetry is always small. */
const MAX_BODY_BYTES = 16_384;
/** Maximum field lengths so a misbehaving client cannot bloat anything. */
const MAX_MESSAGE_CHARS = 2_000;
const MAX_STACK_CHARS = 8_000;
interface IncomingEvent {
  message?: unknown;
  stack?: unknown;
  digest?: unknown;
  page?: unknown;
  source?: unknown;
}
// ASCII control characters (incl. DEL); the multi-line variant keeps `\n`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
function clamp(
  value: unknown,
  maxChars: number,
  allowNewlines = false,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(
    allowNewlines ? CONTROL_CHARS_EXCEPT_NEWLINE : CONTROL_CHARS,
    "",
  );
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}
export async function POST(request: Request): Promise<NextResponse> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "cross-site request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json(
      { error: "unsupported media type" },
      { status: 415 },
    );
  }
  let event: IncomingEvent | null = null;
  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "payload too large" }, { status: 413 });
    }
    event = JSON.parse(raw) as IncomingEvent;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const message = clamp(event?.message, MAX_MESSAGE_CHARS);
  if (!message) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }
  const payload = {
    message,
    stack: clamp(event?.stack, MAX_STACK_CHARS, true),
    digest: clamp(event?.digest, 200),
    page: clamp(event?.page, 2_000),
    source: clamp(event?.source, 200),
    receivedAt: new Date().toISOString(),
  };
  const endpoint = process.env["CONTROL_TELEMETRY_URL"];
  if (endpoint) {
    try {
      await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Forwarding is best effort; log and still answer 204.
      console.error("[telemetry] forwarding failed", {
        digest: payload.digest,
        message: payload.message,
      });
    }
  } else {
    console.error("[telemetry]", payload);
  }
  return new NextResponse(null, { status: 204 });
}

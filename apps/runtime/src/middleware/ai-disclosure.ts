// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Machine-readable AI disclosure (EU AI Act Art. 50).
 *
 * Opt-in via `AI_DISCLOSURE`; off by default so existing clients see no change.
 *
 *   header — every successful completion carries `X-AI-Generated: true`.
 *   field  — a non-streaming JSON completion carries `metadata.ai_generated:
 *            true` in its body. A stream has no single body to put a field
 *            in, so a streamed completion carries the header instead: the
 *            marker is never silently missing.
 *
 * Only 2xx responses of the two completion endpoints are marked. An error body
 * is not generated content, and the marker must not appear on responses that
 * contain none.
 */
import type { MiddlewareHandler } from "hono";

export type AiDisclosureMode = "off" | "header" | "field";

export const AI_GENERATED_HEADER = "X-AI-Generated";

export function aiDisclosureMiddleware(mode: AiDisclosureMode): MiddlewareHandler {
  return async (ctx, next) => {
    await next();
    if (mode === "off") return;
    const response = ctx.res;
    if (response.status < 200 || response.status >= 300) return;
    const contentType = response.headers.get("Content-Type") ?? "";
    const isJson = contentType.includes("application/json");
    if (mode === "field" && isJson) {
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        body = undefined;
      }
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        const existing =
          record.metadata !== null && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? (record.metadata as Record<string, unknown>)
            : {};
        const headers = new Headers(response.headers);
        headers.delete("Content-Length");
        ctx.res = new Response(JSON.stringify({ ...record, metadata: { ...existing, ai_generated: true } }), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        return;
      }
    }
    // `header` mode, a stream in `field` mode, or a body we could not extend.
    ctx.res.headers.set(AI_GENERATED_HEADER, "true");
  };
}

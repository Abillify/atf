// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Anthropic Messages API — `POST /v1/messages` (ADR 0038, §2).
 *
 * The trust-proxy entry point for clients that speak the Anthropic API. It
 * does not run a pipeline of its own: the request is translated into a Chat
 * Completions request and handed to the chat router in-process, so guardrails,
 * routing (flows first, then `PROXY_MODELS`), authorization, compliance,
 * budgets, admission, the PII vault, metering, audit and decision receipts are
 * exactly the ones `/v1/chat/completions` applies. The result is translated
 * back into an Anthropic `message` or its SSE event sequence.
 *
 * Registered under `/v1/*`, so the standard auth (which also reads
 * `x-api-key` for this path) and rate-limit middleware run first; the
 * identity they established is handed to the inner request unchanged.
 *
 * No `any` at module boundaries.
 */

import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { AuthContext } from "../middleware/auth.js";
import {
  API_KEY_IDENTITY_KEY,
  AUTH_PRINCIPAL_KEY,
  TOKEN_KEY,
  TRACE_CONTEXT_KEY,
} from "../middleware/auth.js";
import {
  chatResponseToMessage,
  errorEnvelope,
  MessagesRequestError,
  translateMessagesRequest,
} from "./messages/translate.js";
import { MessagesStreamTranslator } from "./messages/streaming.js";

/** The request variables the inner chat request must see unchanged. */
type ForwardedVars = Partial<AuthContext["Variables"]>;

/** Response headers worth passing through to the Anthropic client. */
const FORWARDED_RESPONSE_HEADERS = [
  "x-execution-id",
  "x-atf-receipt",
  "x-ai-generated",
  "retry-after",
  "idempotent-replayed",
];

/**
 * Builds the router. `chat` is the mounted chat router; it is invoked
 * in-process for every request.
 */
export function createMessagesRouter(chat: Hono<AuthContext>): Hono<AuthContext> {
  // Inner app: restores the outer request's verified identity, then lets the
  // chat router handle the translated request.
  const inner = new Hono<AuthContext & { Bindings: { vars: ForwardedVars } }>();
  inner.use("*", async (c, next) => {
    const vars = c.env.vars;
    if (vars[TOKEN_KEY] !== undefined) c.set(TOKEN_KEY, vars[TOKEN_KEY]);
    if (vars[AUTH_PRINCIPAL_KEY] !== undefined) {
      c.set(AUTH_PRINCIPAL_KEY, vars[AUTH_PRINCIPAL_KEY]);
    }
    if (vars[TRACE_CONTEXT_KEY] !== undefined) {
      c.set(TRACE_CONTEXT_KEY, vars[TRACE_CONTEXT_KEY]);
    }
    if (vars[API_KEY_IDENTITY_KEY] !== undefined) {
      c.set(API_KEY_IDENTITY_KEY, vars[API_KEY_IDENTITY_KEY]);
    }
    await next();
  });
  inner.route("/", chat as unknown as Hono);

  const router = new Hono<AuthContext>();

  router.post("/v1/messages", async (ctx) => {
    let body: unknown;
    try {
      body = await ctx.req.json();
    } catch {
      return ctx.json(
        errorEnvelope(400, { error: { message: "Request body must be valid JSON." } }),
        400,
      );
    }
    let translated: ReturnType<typeof translateMessagesRequest>;
    try {
      translated = translateMessagesRequest(body);
    } catch (err) {
      if (err instanceof MessagesRequestError) {
        return ctx.json(errorEnvelope(400, { error: { message: err.message } }), 400);
      }
      throw err;
    }

    // Same headers as the client sent (identity headers, idempotency keys,
    // tracing), but a JSON body of the new shape.
    const headers = new Headers(ctx.req.raw.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    const url = new URL(ctx.req.url);
    url.pathname = "/v1/chat/completions";
    const innerRequest = new Request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(translated),
      signal: ctx.req.raw.signal,
    });
    const vars: ForwardedVars = {
      [TOKEN_KEY]: ctx.get(TOKEN_KEY),
      [AUTH_PRINCIPAL_KEY]: ctx.get(AUTH_PRINCIPAL_KEY),
      [TRACE_CONTEXT_KEY]: ctx.get(TRACE_CONTEXT_KEY),
      [API_KEY_IDENTITY_KEY]: ctx.get(API_KEY_IDENTITY_KEY),
    };
    const response = await inner.fetch(innerRequest, { vars });

    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) ctx.header(name, value);
    }

    if (!response.ok) {
      const status = response.status;
      let errBody: unknown;
      try {
        errBody = await response.json();
      } catch {
        errBody = undefined;
      }
      return ctx.json(
        errorEnvelope(status, errBody),
        status as Parameters<typeof ctx.json>[1],
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!translated.stream || !contentType.includes("text/event-stream")) {
      const chat = await response.json();
      return ctx.json(chatResponseToMessage(chat, translated.model));
    }

    const upstream = response.body;
    ctx.header("Content-Type", "text/event-stream");
    ctx.header("Cache-Control", "no-cache");
    return stream(ctx, async (s) => {
      const translator = new MessagesStreamTranslator(translated.model);
      if (upstream === null) {
        await s.write(translator.end());
        return;
      }
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      // A client that goes away cancels the inner stream, which aborts the
      // execution through the chat route's own disconnect handling.
      s.onAbort(() => {
        void reader.cancel().catch(() => {});
      });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const out = translator.push(decoder.decode(value, { stream: true }));
          if (out !== "") await s.write(out);
        }
        await s.write(translator.end());
      } catch (err) {
        await s.write(
          translator.fail(err instanceof Error ? err.message : "Stream failed."),
        );
      }
    });
  });

  return router;
}

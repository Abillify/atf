// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Webhook trigger routes (`src/routes/triggers.ts`)
 *
 * POST /triggers/:flowId
 *
 * Fires a flow that contains a `trigger` node with `config.mode === "webhook"`.
 * These routes are mounted at the TOP LEVEL (not under `/v1/*`), so they do NOT
 * pass through the JWT auth middleware — webhooks authenticate purely via a
 * per-flow HMAC-SHA256 signature. This matches the standard webhook model used
 * by GitHub, Stripe, etc. where a third-party service signs the payload with a
 * shared secret and cannot present a JWT.
 *
 * Authentication:
 *   Per-flow HMAC-SHA256 signature — the ONLY authentication this route has.
 *   The trigger node's `config.webhookSecret` must be set; the caller then sends
 *   `X-Trigger-Signature: sha256=<hex>` where the hex is HMAC-SHA256 of the raw
 *   request body with that secret. Requests without a valid signature are
 *   rejected 401.
 *
 *   Optional replay protection: a sender that also sets `X-Trigger-Timestamp`
 *   (epoch millis) and `X-Trigger-Nonce` (any unique string) must sign
 *   `timestamp.nonce.body` instead of the bare body — the signature then
 *   authenticates the timestamp and nonce too, not just the payload. The
 *   timestamp must be within `TRIGGER_TIMESTAMP_TOLERANCE_MS` (5 minutes) of
 *   the server clock, and the nonce must not have been seen before for this
 *   flow within that window; either failure is a 401. Senders that omit both
 *   headers keep working exactly as before (body-only signature, no replay
 *   protection) — this is additive, not a breaking change.
 *
 *   A trigger node with NO secret is rejected 401 as well (fail-closed): since
 *   this route bypasses the /v1/* auth middleware, skipping the check would make
 *   the flow a fully unauthenticated execution endpoint — arbitrary LLM/tool runs
 *   billed to the operator, reachable by anyone who can guess a flow id. Set
 *   `TRIGGERS_REQUIRE_SIGNATURE=false` to consciously restore the open-webhook
 *   behaviour.
 *
 *   A `system` turn in a caller-supplied `messages` array is always dropped: the
 *   flow's own `systemPrompt` is the intended source of system instructions, and
 *   accepting one from a webhook caller is prompt injection with the operator's
 *   credentials.
 *
 * Because these routes bypass the standard auth middleware, the raw request body
 * is read directly here (not consumed upstream), so the HMAC is computed over
 * the exact bytes the client signed.
 *
 * Payload handling:
 *   - JSON body: if it looks like a chat-completions request (has `messages`),
 *     it is used directly. Otherwise, the body is serialised to a user message.
 *   - Non-JSON / raw body: treated as plain-text user message.
 *   - `config.messageTemplate` in the trigger node config may override the
 *     automatic message with a `{{body.*}}` template.
 *
 * Execution modes:
 *   - synchronous (`config.synchronous: true` or query ?sync=true): waits for
 *     the full flow response and returns it as a chat completion JSON.
 *   - async (default): fires the flow in the background, returns 202 with
 *     `{ execution_id }`.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import { Hono } from "hono";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { ChatMessage, ChatCompletionChunk } from "../types/openai.js";
import type { RequestContext } from "../types/monitoring.js";
import { decideRequiredScopes } from "../graph/flow-authorizer.js";
import { isTimestampFresh, NonceCache } from "../util/replay-guard.js";
import type { ExecutionAdmissionService } from "../graph/execution-admission.js";

// ---------------------------------------------------------------------------
// HMAC signature verification (+ replay protection)
// ---------------------------------------------------------------------------

/**
 * Tolerance window (ms) for `X-Trigger-Timestamp`. Generous enough to absorb
 * real-world clock skew and network latency between a webhook sender and this
 * server, tight enough that a captured request is unusable for long. Matched
 * by {@link REPLAY_NONCE_TTL_MS} so a nonce is remembered for at least as long
 * as its timestamp could still pass the freshness check.
 */
export const TRIGGER_TIMESTAMP_TOLERANCE_MS = 5 * 60_000; // 5 minutes
const REPLAY_NONCE_TTL_MS = TRIGGER_TIMESTAMP_TOLERANCE_MS;

/**
 * Computes the HMAC-SHA256 digest over `signedMaterial` and compares it
 * (constant-time) against an `X-Trigger-Signature: sha256=<hex>` header.
 */
function verifyHmac(
  secret: string,
  signedMaterial: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedMaterial)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(provided, "hex"),
      Buffer.from(expected, "hex"),
    );
  } catch {
    return false;
  }
}

export type SignatureVerification =
  | { ok: true; replayProtected: boolean }
  | { ok: false; reason: "signature" | "stale-timestamp" | "replayed-nonce" };

/**
 * Verifies a webhook request's signature, with OPTIONAL replay protection.
 *
 * Two signing modes, tried in order:
 *
 *   1. **Replay-protected** — when the caller sends BOTH `X-Trigger-Timestamp`
 *      and `X-Trigger-Nonce`, the signature must cover `timestamp.nonce.body`
 *      (not the body alone). Binding them INTO the signed material is what
 *      makes them meaningful: a header the signature does not cover is a
 *      header an attacker can freely rewrite — e.g. replaying an old captured
 *      request with a freshly-forged current timestamp. On a valid signature,
 *      the timestamp must additionally be fresh (see
 *      {@link TRIGGER_TIMESTAMP_TOLERANCE_MS}) and the nonce must not have
 *      been consumed before ({@link NonceCache}).
 *
 *   2. **Legacy (body-only)** — when either header is absent, falls back to
 *      the original scheme (signature over the raw body alone). This keeps
 *      every existing webhook sender working unchanged; it is simply not
 *      replay-protected, exactly as before this feature existed. A future
 *      hardening step can make the replay-protected headers mandatory per
 *      flow once senders have migrated.
 */
function verifyTriggerSignature(params: {
  secret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  nonceHeader: string | undefined;
  nonceCache: NonceCache;
  nonceNamespace: string;
  now: number;
}): SignatureVerification {
  const {
    secret,
    rawBody,
    signatureHeader,
    timestampHeader,
    nonceHeader,
    nonceCache,
    nonceNamespace,
    now,
  } = params;

  if (timestampHeader !== undefined && nonceHeader !== undefined) {
    const signedMaterial = Buffer.concat([
      Buffer.from(`${timestampHeader}.${nonceHeader}.`, "utf8"),
      rawBody,
    ]);
    if (!verifyHmac(secret, signedMaterial, signatureHeader)) {
      return { ok: false, reason: "signature" };
    }
    const timestampMs = Number(timestampHeader);
    if (!isTimestampFresh(timestampMs, now, TRIGGER_TIMESTAMP_TOLERANCE_MS)) {
      return { ok: false, reason: "stale-timestamp" };
    }
    // Nonce check LAST: only a request that already cleared the signature
    // and freshness checks can consume (and thus burn) a nonce slot — an
    // unauthenticated caller spamming random nonces must not be able to fill
    // the cache or pre-consume nonces a legitimate sender might reuse.
    if (!nonceCache.consume(nonceNamespace, nonceHeader)) {
      return { ok: false, reason: "replayed-nonce" };
    }
    return { ok: true, replayProtected: true };
  }

  // Legacy body-only signature — no replay protection.
  if (!verifyHmac(secret, rawBody, signatureHeader)) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, replayProtected: false };
}

/** Human-readable 401 message for each {@link SignatureVerification} failure reason. */
function signatureFailureMessage(
  reason: "signature" | "stale-timestamp" | "replayed-nonce",
): string {
  switch (reason) {
    case "signature":
      return "Webhook signature verification failed. Provide a valid X-Trigger-Signature header.";
    case "stale-timestamp":
      return "Webhook X-Trigger-Timestamp is outside the accepted freshness window. Resend with a current timestamp.";
    case "replayed-nonce":
      return "Webhook X-Trigger-Nonce has already been used. Each request must use a fresh, unique nonce.";
  }
}

// ---------------------------------------------------------------------------
// Template resolution for messageTemplate
// ---------------------------------------------------------------------------

function resolveTemplate(
  template: string,
  body: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*body\.([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const parts = path.split(".");
    let cur: unknown = body;
    for (const p of parts) {
      if (cur === null || typeof cur !== "object") return "";
      cur = (cur as Record<string, unknown>)[p];
    }
    return cur === undefined || cur === null ? "" : String(cur);
  });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface TriggersRouterOptions {
  flowRegistry: FlowRegistry;
  graphEngine: GraphEngineService;
  monitoring?: MonitoringServiceInterface;
  /**
   * Refuse a webhook trigger whose node declares no `config.webhookSecret`
   * (mirrors `TRIGGERS_REQUIRE_SIGNATURE`, default true).
   *
   * `POST /triggers/:flowId` is mounted OUTSIDE the `/v1/*` auth middleware so
   * third-party services can call it, and the per-flow HMAC secret is therefore
   * the route's only authentication. Treating an absent secret as "no
   * verification needed" made an unsigned webhook flow a fully unauthenticated
   * flow-execution endpoint: arbitrary LLM/tool runs charged to the operator,
   * reachable by anyone who can guess a flow id. Fail-closed instead — an
   * author who wants the old behaviour must say so explicitly.
   */
  requireSignature?: boolean;
  /** Global business-authorization switch; HMAC/replay checks remain active. */
  authorizationEnabled?: boolean;
  /** JWT claim names used for FlowDefinition.requiredScopes. Webhooks have none. */
  flowScopeClaims?: readonly string[];
  /** Shared admission gate run before both synchronous and asynchronous execution. */
  admission?: ExecutionAdmissionService;
}

export function createTriggersRouter(opts: TriggersRouterOptions): Hono {
  const router = new Hono();
  const { flowRegistry, graphEngine, monitoring } = opts;
  const flowScopeClaims = opts.flowScopeClaims;
  const requireSignature = opts.requireSignature ?? true;
  // One nonce cache per router instance (i.e. per process) — scoped per flow
  // id via `nonceNamespace` below, so a nonce for one flow's webhook cannot
  // collide with another's.
  const nonceCache = new NonceCache({ ttlMs: REPLAY_NONCE_TTL_MS });

  router.post("/triggers/:flowId", async (ctx) => {
    const flowId = ctx.req.param("flowId");

    // ── Body-size guard ────────────────────────────────────────────────────
    // These routes bypass the /v1/* bodyLimit middleware, so enforce a bound
    // here to prevent an unauthenticated caller from sending a huge payload.
    const contentLength = Number(ctx.req.header("Content-Length") ?? "0");
    const MAX_WEBHOOK_BODY = 1_048_576; // 1 MB
    if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY) {
      return ctx.json(
        {
          error: {
            message: `Webhook payload too large (max ${MAX_WEBHOOK_BODY} bytes).`,
            type: "invalid_request_error",
          },
        },
        413,
      );
    }

    // ── Resolve the flow ──────────────────────────────────────────────────────
    const flow = flowRegistry.get(flowId);
    if (flow === undefined) {
      return ctx.json(
        { error: { message: `Flow '${flowId}' not found.`, type: "not_found_error" } },
        404,
      );
    }

    // Find the trigger node
    const triggerNode = flow.nodes.find((n) => n.type === "trigger");
    if (triggerNode === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${flowId}' has no trigger node. Add a node with type "trigger" to enable webhook execution.`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const triggerCfg = (triggerNode.config ?? {}) as Record<string, unknown>;
    if (triggerCfg.mode !== "webhook") {
      return ctx.json(
        {
          error: {
            message: `Trigger node in flow '${flowId}' is not a webhook trigger (mode: ${String(triggerCfg.mode)}).`,
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    // ── Read raw body for signature verification ──────────────────────────────
    const rawBodyBuffer = Buffer.from(await ctx.req.arrayBuffer());

    // Enforce the size bound against the ACTUAL bytes read (Content-Length may
    // be absent or spoofed).
    if (rawBodyBuffer.length > MAX_WEBHOOK_BODY) {
      return ctx.json(
        {
          error: {
            message: `Webhook payload too large (max ${MAX_WEBHOOK_BODY} bytes).`,
            type: "invalid_request_error",
          },
        },
        413,
      );
    }

    // ── HMAC signature verification ───────────────────────────────────────────
    const webhookSecret =
      typeof triggerCfg.webhookSecret === "string"
        ? (triggerCfg.webhookSecret as string)
        : undefined;

    if (webhookSecret === undefined) {
      // Fail-closed: no secret means there is nothing authenticating this call.
      // Returning 401 (not 500) because the request genuinely lacks credentials
      // the route requires; the message names the fix without leaking whether
      // the flow exists beyond what the earlier 400s already reveal.
      if (requireSignature) {
        return ctx.json(
          {
            error: {
              message:
                `Webhook trigger for flow '${flowId}' has no 'config.webhookSecret', so the request cannot be ` +
                "authenticated. Set a secret on the trigger node and sign the body with " +
                "X-Trigger-Signature: sha256=<hmac>. To consciously allow unsigned webhooks " +
                "(not recommended — the endpoint is public), set TRIGGERS_REQUIRE_SIGNATURE=false.",
              type: "authentication_error",
            },
          },
          401,
        );
      }
    } else {
      const verification = verifyTriggerSignature({
        secret: webhookSecret,
        rawBody: rawBodyBuffer,
        signatureHeader: ctx.req.header("X-Trigger-Signature"),
        timestampHeader: ctx.req.header("X-Trigger-Timestamp"),
        nonceHeader: ctx.req.header("X-Trigger-Nonce"),
        nonceCache,
        nonceNamespace: flowId,
        now: Date.now(),
      });
      if (!verification.ok) {
        return ctx.json(
          {
            error: {
              message: signatureFailureMessage(verification.reason),
              type: "authentication_error",
            },
          },
          401,
        );
      }
    }

    // ── Parse body into a user message ────────────────────────────────────────
    let messages: ChatMessage[];
    const bodyText = rawBodyBuffer.toString("utf-8");

    let parsedBody: unknown = null;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      /* not JSON */
    }

    const messageTemplate =
      typeof triggerCfg.messageTemplate === "string"
        ? (triggerCfg.messageTemplate as string)
        : undefined;

    if (
      parsedBody !== null &&
      typeof parsedBody === "object" &&
      Array.isArray((parsedBody as Record<string, unknown>).messages)
    ) {
      // Caller sent a chat-completions-compatible body — use it, but never let
      // it carry a `system` turn. The flow's own `systemPrompt` is the intended
      // source of system instructions; a webhook caller supplying one is
      // prompt injection with the operator's credentials and budget, and a
      // leading system message survives `sanitizeSystemMessages` untouched.
      // Dropped rather than rejected so a well-meaning integration that mirrors
      // an OpenAI payload keeps working.
      messages = (parsedBody as { messages: ChatMessage[] }).messages.filter(
        (m) => m.role !== "system",
      );
      if (messages.length === 0) {
        return ctx.json(
          {
            error: {
              message:
                "Webhook body contained no usable messages (system turns are not accepted from webhook callers).",
              type: "invalid_request_error",
            },
          },
          400,
        );
      }
    } else if (messageTemplate !== undefined) {
      const body =
        parsedBody !== null && typeof parsedBody === "object"
          ? (parsedBody as Record<string, unknown>)
          : { raw: bodyText };
      messages = [{ role: "user", content: resolveTemplate(messageTemplate, body) }];
    } else if (parsedBody !== null && typeof parsedBody === "object") {
      // JSON object but not chat format — stringify as user message
      messages = [{ role: "user", content: JSON.stringify(parsedBody) }];
    } else {
      // Raw text body
      messages = [{ role: "user", content: bodyText || "trigger" }];
    }

    // ── Build execution context ───────────────────────────────────────────────
    const executionId = crypto.randomUUID();
    const tenantId =
      typeof triggerCfg.tenantId === "string"
        ? (triggerCfg.tenantId as string)
        : undefined;

    const ctx_req: RequestContext = {
      ssoToken: `webhook:${executionId}`,
      executionId,
      ...(tenantId !== undefined ? { clientId: tenantId } : {}),
    };

    const scopeDecision = opts.authorizationEnabled === false
      ? { allowed: true }
      : decideRequiredScopes(
      flow.requiredScopes,
      ctx_req,
      flowScopeClaims,
    );
    if (!scopeDecision.allowed) {
      return ctx.json(
        {
          error: {
            message: "You are not permitted to use this flow.",
            type: "permission_error",
          },
        },
        403,
      );
    }

    const synchronous =
      triggerCfg.synchronous === true ||
      ctx.req.query("sync") === "true";

    if (opts.admission !== undefined) {
      const admitted = await opts.admission.admit(flowId, ctx_req);
      if (!admitted.allowed) {
        return ctx.json({ error: { message: admitted.failure.message, type: "permission_error" } }, admitted.failure.status);
      }
    }

    // ── Async mode (default) — fire-and-forget ────────────────────────────────
    if (!synchronous) {
      void (async () => {
        try {
          await graphEngine.executeFlow(
            flowId,
            messages,
            ctx_req,
            async () => {},
            async () => {},
            monitoring,
          );
        } catch {
          /* async failures are logged by the engine */
        }
      })();

      return ctx.json(
        {
          execution_id: executionId,
          flow_id: flowId,
          status: "accepted",
          message: "Flow execution started. Use the execution_id to poll /monitoring/history.",
        },
        202,
      );
    }

    // ── Synchronous mode — wait for completion ────────────────────────────────
    const responseChunks: string[] = [];
    let hadError = false;

    try {
      await graphEngine.executeFlow(
        flowId,
        messages,
        ctx_req,
        async (chunk: ChatCompletionChunk): Promise<void> => {
          const choice = chunk.choices[0];
          if (choice?.finish_reason === "error") {
            hadError = true;
          } else if (typeof choice?.delta?.content === "string" && choice.delta.content !== "") {
            responseChunks.push(choice.delta.content);
          }
        },
        async () => {},
        monitoring,
      );
    } catch (err) {
      hadError = true;
      return ctx.json(
        {
          error: {
            message: `Flow execution failed: ${err instanceof Error ? err.message : String(err)}`,
            type: "execution_error",
          },
          execution_id: executionId,
        },
        500,
      );
    }

    const responseText = responseChunks.join("");
    return ctx.json({
      id: `trig-${executionId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: flowId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: responseText },
          finish_reason: hadError ? "error" : "stop",
        },
      ],
      execution_id: executionId,
    });
  });

  // ── GET /triggers — list all webhook-triggerable flows ─────────────────
  router.get("/triggers", (ctx) => {
    const triggers: Array<{
      flow_id: string;
      node_id: string;
      mode: string;
      url: string;
      signature_required: boolean;
      synchronous: boolean;
    }> = [];

    for (const flow of flowRegistry.list()) {
      for (const node of flow.nodes) {
        if (node.type !== "trigger") continue;
        const cfg = (node.config ?? {}) as Record<string, unknown>;
        if (cfg.mode !== "webhook") continue;
        triggers.push({
          flow_id: flow.id,
          node_id: node.id,
          mode: "webhook",
          url: `/triggers/${flow.id}`,
          signature_required: typeof cfg.webhookSecret === "string",
          synchronous: cfg.synchronous === true,
        });
      }
    }

    return ctx.json({ triggers });
  });

  return router;
}

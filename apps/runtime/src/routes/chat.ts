// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Chat Completions Route — Facade (`src/routes/chat.ts`)
 *
 * Registers the OpenAI-compatible POST /v1/chat/completions endpoint.
 * Delegates to submodules:
 *   chat/handler.ts   — Request parsing, OpenAI compatibility, RequestContext
 *   chat/streaming.ts — SSE streaming, replay, non-streaming assembly
 *   chat/metering.ts  — Budget/rate-limit/auth/guardrail admission, finalize
 *
 * External consumers continue importing from "./routes/chat.js" unchanged.
 *
 */

import { Hono } from "hono";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { FlowDispatcher } from "../graph/flow-dispatcher.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { AuthContext } from "../middleware/auth.js";
import {
  TOKEN_KEY,
  AUTH_PRINCIPAL_KEY,
  TRACE_CONTEXT_KEY,
  API_KEY_IDENTITY_KEY,
} from "../middleware/auth.js";
import type { JwtVerifier } from "../middleware/jwt-verifier.js";
import type { ChatCompletionRequest, TokenUsage } from "../types/openai.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import crypto from "node:crypto";

// Submodule imports
import {
  REQUEST_NODE_ID,
  RESPONSE_NODE_ID,
  buildRequestNodeText,
  buildVariableOverview,
  buildRequestContext,
  logIdentityTrustWarning,
  emitBoundaryNode,
  extractUserPromptPreview,
} from "./chat/handler.js";
import { QueueOverflowError } from "../graph/graph-engine/error-strategy.js";
import { resolveFlowRecovery } from "../graph/flow-recovery.js";
import { decideFlowAccess } from "../graph/flow-authorizer.js";

import {
  renderIdempotentReplay,
  executeStreaming,
  executeNonStreaming,
} from "./chat/streaming.js";
import { harnessProgressRequested } from "../graph/agent-harness/progress-event.js";

import {
  evaluateInputGuardrail,
  checkBudget,
  checkTokenLimit,
  checkCompliancePolicy,
  resolveFlowRouting,
  createFinalize,
  dispatchAsyncJob,
} from "./chat/metering.js";

import type { ChatRouterOptions } from "./chat/metering.js";

// ---------------------------------------------------------------------------
// Public re-exports (preserve existing API surface)
// ---------------------------------------------------------------------------

export {
  REQUEST_NODE_ID,
  RESPONSE_NODE_ID,
  buildRequestNodeText,
  buildVariableOverview,
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createChatRouter(
  flowRegistry: FlowRegistry,
  graphEngine: GraphEngineService,
  monitoring?: MonitoringServiceInterface,
  _jwtVerifier?: JwtVerifier,
  flowDispatcher?: FlowDispatcher,
  options?: ChatRouterOptions,
): Hono<AuthContext> {
  const router = new Hono<AuthContext>();
  const costTracker = options?.costTracker;
  const limitEnforcer = options?.limitEnforcer;
  const metrics = options?.metrics;
  const budgetCap = options?.budgetDailyPerTenant ?? 0;
  const authorizer = options?.authorizer;
  const authzEnabled = options?.authzEnabled ?? true;
  const flowScopeClaims = options?.flowScopeClaims;
  const canaryManager = options?.canaryManager;
  const replayService = options?.replayService;
  const canaryJudge = options?.canaryJudge;
  const inputGuardrail = options?.inputGuardrail;
  const inputGuardrailMode = options?.inputGuardrailMode ?? "flag";
  const inputGuardrailClassify = options?.inputGuardrailClassify;
  const inputGuardrailModelMinScore =
    options?.inputGuardrailModelMinScore ?? 0.3;
  const guardrailPolicy = options?.guardrailPolicy;
  const flowGuardrailResolver = options?.flowGuardrailResolver;
  const clientToolsEnabled = options?.clientToolsEnabled ?? true;
  // Fail-closed default: client-supplied role/clientId/plan are ignored unless
  // a trusted reverse proxy is explicitly declared (TRUSTED_IDENTITY_HEADERS).
  const trustedIdentityHeaders = options?.trustedIdentityHeaders ?? false;
  // Backward-compatible default: strict profile identity is opt-in.
  const strictIdentityHeaders = options?.strictIdentityHeaders ?? false;
  const memoryStore = options?.memoryStore;
  const memoryAutoCapture = options?.memoryAutoCapture ?? false;
  const memoryExtractor = options?.memoryExtractor;
  const modelQuality = options?.modelQuality;
  const sloRegistry = options?.sloRegistry;
  const byokResolver = options?.byokResolver;
  const admission = options?.admission;
  const idempotencyStore = options?.idempotencyStore;
  const jobStore = options?.jobStore;
  const jobRecovery = options?.jobRecovery;
  const executionContextSecret = options?.executionContextSecret;
  const abManager = options?.abManager;
  const captureRequestTokens = options?.captureRequestTokens ?? false;
  const shadowModeService = options?.shadowModeService;
  const compliancePolicyLoader = options?.compliancePolicyLoader;
  const auditLog = options?.auditLog;
  const sseHeartbeatMs = options?.sseHeartbeatMs;
  const decisionReceiptsEnabled = options?.decisionReceiptsEnabled === true;

  router.post("/v1/chat/completions", async (ctx) => {
    const requestStart = Date.now();
    // -----------------------------------------------------------------------
    // Step 1: Request validation — Requirement 1.4
    // -----------------------------------------------------------------------
    let request: ChatCompletionRequest;
    try {
      request = await ctx.req.json<ChatCompletionRequest>();
    } catch {
      return ctx.json(
        {
          error: {
            message: "Request body must be valid JSON.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    if (!request.model || request.model.trim() === "") {
      return ctx.json(
        {
          error: {
            message: "Field 'model' is required.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    if (
      !request.messages ||
      !Array.isArray(request.messages) ||
      request.messages.length === 0
    ) {
      return ctx.json(
        {
          error: {
            message: "Field 'messages' must be a non-empty array.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    const messages = request.messages;
    // OpenAI-compatible default: streaming is opt-in. Only stream when the
    // client explicitly requests `stream: true`. A client that omits `stream`
    // (or sets it false) gets a single non-streamed JSON chat.completion — the
    // behaviour standard OpenAI SDKs / litellm (non-streaming path) expect.
    // Returning SSE to a non-streaming request makes litellm reject the body
    // with "Empty or invalid response from LLM endpoint" (e.g. Qodo Merge).
    const streamMode = request.stream === true;

    // -----------------------------------------------------------------------
    // Step 2: Build enriched RequestContext
    // -----------------------------------------------------------------------
    const ssoToken = ctx.get(TOKEN_KEY);
    // Present when the caller authenticated with a managed `aip-…` API key; it
    // is the authoritative tenant identity (hash lookup, not a client claim).
    const apiKeyIdentity = ctx.get(API_KEY_IDENTITY_KEY);
    const principal = ctx.get(AUTH_PRINCIPAL_KEY);
    const claims = principal?.claims ?? null;
    const rawMetadata = request.metadata ?? {};
    const { token: _ignored, ...metadata } = rawMetadata;
    void _ignored;

    const requestCtx = buildRequestContext({
      ssoToken,
      claims,
      metadata,
      acceptLanguage: ctx.req.header("Accept-Language"),
      owui: {
        id: ctx.req.header("X-OpenWebUI-User-Id"),
        name: ctx.req.header("X-OpenWebUI-User-Name"),
        email: ctx.req.header("X-OpenWebUI-User-Email"),
        role: ctx.req.header("X-OpenWebUI-User-Role"),
      },
      ...(principal?.tenantId !== undefined
        ? { verifiedTenantId: principal.tenantId }
        : {}),
      ...(apiKeyIdentity !== undefined ? { apiKeyIdentity } : {}),
      trustClientIdentity: trustedIdentityHeaders,
      strictIdentityHeaders,
      identityClaimsVerified: principal?.verified === true,
      onIdentityWarning: logIdentityTrustWarning,
    });

    // Attach the distributed-trace context
    const traceCtx = ctx.get(TRACE_CONTEXT_KEY);
    if (traceCtx !== undefined) {
      requestCtx.traceContext = traceCtx;
    }

    // Per-request flow variable overrides
    const metaVariables =
      typeof metadata.variables === "object" &&
      metadata.variables !== null &&
      !Array.isArray(metadata.variables)
        ? (metadata.variables as Record<string, unknown>)
        : undefined;
    const topVariables =
      typeof request.variables === "object" &&
      request.variables !== null &&
      !Array.isArray(request.variables)
        ? request.variables
        : undefined;
    if (metaVariables !== undefined || topVariables !== undefined) {
      requestCtx.variableOverrides = { ...metaVariables, ...topVariables };
    }

    // Function-calling passthrough. Skipped entirely when client tools are
    // disabled (CLIENT_TOOLS_ENABLED=false), so caller-supplied tools such as
    // Open WebUI's per-user Knowledge tools never reach the model.
    if (
      clientToolsEnabled &&
      Array.isArray(request.tools) &&
      request.tools.length > 0
    ) {
      requestCtx.clientTools = request.tools;
      if (request.tool_choice !== undefined) {
        requestCtx.clientToolChoice = request.tool_choice;
      }
    }

    // -----------------------------------------------------------------------
    // Step 2a: Input guardrail
    // -----------------------------------------------------------------------
    const guardrailResult = await evaluateInputGuardrail({
      messages,
      flowId: request.model,
      requestCtx,
      ctx,
      inputGuardrail,
      inputGuardrailMode,
      inputGuardrailClassify,
      inputGuardrailModelMinScore,
      guardrailPolicy,
      metrics,
    });
    if (guardrailResult.blocked) {
      return guardrailResult.response;
    }
    if (guardrailResult.requestCtxPatch?.requestParams) {
      requestCtx.requestParams = {
        ...(requestCtx.requestParams ?? {}),
        ...guardrailResult.requestCtxPatch.requestParams,
      };
    }

    // -----------------------------------------------------------------------
    // Step 2b: Expose last message text for dispatch rules
    // -----------------------------------------------------------------------
    const lastMessage = messages[messages.length - 1];
    if (lastMessage !== undefined) {
      const text =
        typeof lastMessage.content === "string"
          ? lastMessage.content
          : Array.isArray(lastMessage.content)
            ? lastMessage.content
                .filter(
                  (b): b is { type: "text"; text: string } =>
                    typeof b === "object" &&
                    b !== null &&
                    (b as { type?: unknown }).type === "text" &&
                    typeof (b as { text?: unknown }).text === "string",
                )
                .map((b) => b.text)
                .join("\n")
            : "";
      if (text !== "") {
        requestCtx.requestParams = {
          ...(requestCtx.requestParams ?? {}),
          lastUserMessageText: text.slice(0, 512),
        };
      }
    }

    // -----------------------------------------------------------------------
    // Step 2c: Expose the model the CLIENT asked for
    // -----------------------------------------------------------------------
    // Dispatch rewrites the model into a flow id, so after Step 3 the original
    // choice is no longer recoverable from `resolvedModel`. Nodes that let a user
    // select a variant through the model picker need it — a picker entry is the
    // only per-request selector a plain OpenAI client such as Open WebUI has.
    //
    // Written AFTER the metadata-derived params so a client cannot pre-set this key
    // and have a node trust it: the authoritative value always overwrites.
    requestCtx.requestParams = {
      ...(requestCtx.requestParams ?? {}),
      requestedModel: request.model,
    };

    // -----------------------------------------------------------------------
    // Step 3: Flow dispatch & routing
    // -----------------------------------------------------------------------
    const routing = resolveFlowRouting({
      requestModel: request.model,
      requestCtx,
      flowDispatcher,
      canaryManager,
      abManager,
      flowGuardrailResolver,
    });
    const {
      flowToRun,
      resolvedModel,
      canaryVariant,
      abVariant,
      runtimeGuardrailOverride,
    } = routing;

    const flow = flowRegistry.get(flowToRun);
    if (flow === undefined) {
      return ctx.json(
        {
          error: {
            message: `Flow '${flowToRun}' not found.`,
            type: "not_found_error",
          },
        },
        404,
      );
    }

    // The HTTP, streaming, and first async attempt all cross the same
    // transport-neutral gate before any execution or job persistence occurs.
    if (admission !== undefined) {
      const admitted = await admission.admit(flowToRun, requestCtx);
      if (!admitted.allowed) {
        const rejectionReason =
          admitted.failure.code === "budget"
            ? "budget_exceeded"
            : admitted.failure.code === "token_limit"
              ? "token_limit_exceeded"
              : admitted.failure.code === "capacity"
                ? "queue_full"
                : admitted.failure.code === "compliance"
                  ? "compliance_policy"
                  : "forbidden";
        metrics?.recordRejected(rejectionReason);
        if (admitted.failure.status === 503) ctx.header("Retry-After", "5");
        return ctx.json(
          {
            error: {
              message: admitted.failure.message,
              type:
                admitted.failure.status === 404
                  ? "not_found_error"
                  : admitted.failure.status === 402
                    ? "insufficient_quota"
                    : admitted.failure.status === 503
                      ? "overloaded_error"
                      : "permission_error",
            },
          },
          admitted.failure.status,
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 3a: Authorization
    // -----------------------------------------------------------------------
    const decision = decideFlowAccess(
      flow,
      requestCtx,
      authorizer,
      flowScopeClaims,
      authzEnabled,
    );
    if (!decision.allowed) {
      metrics?.recordRejected("forbidden");
      return ctx.json(
        {
          error: {
            message:
              decision.reason ?? "You are not permitted to use this flow.",
            type: "permission_error",
          },
        },
        403,
      );
    }

    // -----------------------------------------------------------------------
    // Step 3a2: Compliance policy (data/model rules — ADR-0009)
    // -----------------------------------------------------------------------
    const policyCheck = await checkCompliancePolicy({
      authorizationEnabled: authzEnabled,
      compliancePolicyLoader,
      flow,
      flowId: flowToRun,
      requestCtx,
      auditLog,
      metrics,
      ctx,
    });
    if (policyCheck.rejected) return policyCheck.response;

    // -----------------------------------------------------------------------
    // Step 3a: Backpressure
    // -----------------------------------------------------------------------
    if (!graphEngine.hasCapacity()) {
      metrics?.recordRejected("queue_full");
      ctx.header("Retry-After", "5");
      return ctx.json(
        {
          error: {
            message: "Server is at capacity. Please retry shortly.",
            type: "overloaded_error",
          },
        },
        503,
      );
    }

    // -----------------------------------------------------------------------
    // Step 3b: Budget enforcement
    // -----------------------------------------------------------------------
    const budgetCheck = await checkBudget({
      costTracker,
      budgetCap,
      clientId: requestCtx.clientId,
      metrics,
      ctx,
    });
    if (budgetCheck.rejected) return budgetCheck.response;

    // -----------------------------------------------------------------------
    // Step 3c: Token-limit enforcement
    // -----------------------------------------------------------------------
    const limitCheck = await checkTokenLimit({
      limitEnforcer,
      flowRegistry,
      flowToRun,
      userId: requestCtx.userId,
      metrics,
      ctx,
    });
    if (limitCheck.rejected) return limitCheck.response;

    // -----------------------------------------------------------------------
    // BYOK resolution
    // -----------------------------------------------------------------------
    if (
      admission === undefined &&
      byokResolver !== undefined &&
      requestCtx.clientId !== undefined
    ) {
      try {
        const overrides = await byokResolver.resolve(requestCtx.clientId);
        if (Object.keys(overrides).length > 0) {
          requestCtx.providerKeyOverrides = overrides;
        }
      } catch {
        /* Legacy optional-BYOK path: platform fallback remains intentional. */
      }
    }

    // -----------------------------------------------------------------------
    // Idempotency
    // -----------------------------------------------------------------------
    const idempotencyKey =
      idempotencyStore !== undefined
        ? (ctx.req.header("Idempotency-Key") ??
          (typeof metadata.idempotency_key === "string"
            ? (metadata.idempotency_key as string)
            : undefined))
        : undefined;
    const idempotencyFingerprint =
      idempotencyKey !== undefined
        ? crypto
            .createHash("sha256")
            .update(JSON.stringify({ model: request.model, messages }))
            .digest("hex")
        : "";
    if (idempotencyStore !== undefined && idempotencyKey !== undefined) {
      const outcome = await idempotencyStore.claim(
        idempotencyKey,
        idempotencyFingerprint,
      );
      if (outcome.status === "mismatch") {
        return ctx.json(
          {
            error: {
              message:
                "This Idempotency-Key was already used with a different request body.",
              type: "invalid_request_error",
            },
          },
          422,
        );
      }
      if (outcome.status === "inflight") {
        ctx.header("Retry-After", "2");
        return ctx.json(
          {
            error: {
              message:
                "A request with this Idempotency-Key is still being processed. Retry shortly.",
              type: "conflict_error",
            },
          },
          409,
        );
      }
      if (outcome.status === "replay") {
        return renderIdempotentReplay(ctx, outcome.record, streamMode);
      }
    }

    // Correlation id for this run, echoed on every path (SSE, JSON, async).
    // Without it a user reporting "I got the same answer three times" cannot
    // name the executions involved, and the debug traces — a bounded in-memory
    // ring buffer — are gone before anyone can look. The id is also the
    // `chatcmpl-…` response id, so either one is enough to fetch
    // `GET /monitoring/debug/:executionId` while the trace is still resident.
    ctx.header("X-Execution-Id", requestCtx.executionId);

    // Decision_Receipts (Req 15.4): pre-generate the parent receipt id so the
    // client can fetch `GET /v1/receipts/{id}` as soon as the run finishes.
    // The receipt decorator consumes the same id from the request context.
    if (decisionReceiptsEnabled) {
      const receiptId = crypto.randomUUID();
      requestCtx.decisionReceiptId = receiptId;
      ctx.header("X-ATF-Receipt", receiptId);
    }

    /** Token usage of the run, captured for the idempotency record. */
    let runUsage: TokenUsage | undefined;

    // Emit the synthetic request boundary node
    const boundaryMeta = {
      flowId: flowToRun,
      ...(requestCtx.clientId !== undefined
        ? { tenantId: requestCtx.clientId }
        : {}),
    };
    emitBoundaryNode(monitoring, requestCtx.executionId, boundaryMeta, {
      nodeId: REQUEST_NODE_ID,
      sequence: 0,
      ...((requestCtx.userName ?? requestCtx.userEmail ?? requestCtx.userId)
        ? {
            userName:
              requestCtx.userName ?? requestCtx.userEmail ?? requestCtx.userId,
          }
        : {}),
      ...((): { userPrompt?: string } => {
        const p = extractUserPromptPreview(messages);
        return p !== undefined ? { userPrompt: p } : {};
      })(),
      ...(requestCtx.userId !== undefined ? { userId: requestCtx.userId } : {}),
      prompt: buildRequestNodeText({
        payload: request,
        headers: ctx.req.raw.headers,
        rawToken: ssoToken,
        claims,
        variablesOverview: buildVariableOverview({
          claims,
          metadata,
          owui: {
            id: ctx.req.header("X-OpenWebUI-User-Id"),
            name: ctx.req.header("X-OpenWebUI-User-Name"),
            email: ctx.req.header("X-OpenWebUI-User-Email"),
            role: ctx.req.header("X-OpenWebUI-User-Role"),
          },
          acceptLanguage: ctx.req.header("Accept-Language"),
          ...(requestCtx.requestParams !== undefined
            ? { requestParams: requestCtx.requestParams }
            : {}),
        }),
        captureSecrets: captureRequestTokens,
      }),
    });

    // Build finalize closure
    const finalize = createFinalize({
      ...(sloRegistry !== undefined ? { sloRegistry } : {}),
      requestCtx,
      messages,
      metadata,
      resolvedModel,
      streamMode,
      requestStart,
      monitoring,
      canaryManager,
      canaryVariant,
      abManager,
      abVariant,
      replayService,
      canaryJudge,
      modelQuality,
      memoryStore,
      memoryAutoCapture,
      memoryExtractor,
      idempotencyStore,
      idempotencyKey,
      flowToRun,
      getRunUsage: () => runUsage,
      shadowModeService,
      ...(executionContextSecret !== undefined
        ? { executionContextSecret }
        : {}),
    });

    // -----------------------------------------------------------------------
    // Step 3.5: Async / batch mode
    // -----------------------------------------------------------------------
    const asyncRequested =
      metadata.async === true || ctx.req.header("X-Async") === "true";
    const resolvedJobRecovery = resolveFlowRecovery(jobRecovery, flow);
    if (jobStore !== undefined && asyncRequested) {
      return dispatchAsyncJob({
        ctx,
        jobStore,
        graphEngine,
        flowToRun,
        messages,
        requestCtx,
        resolvedModel,
        monitoring,
        runtimeGuardrailOverride,
        finalize,
        setRunUsage: (u) => {
          runUsage = u;
        },
        // Crash recovery is resolved per flow, not just per deployment: the
        // retry re-runs the flow from the beginning, so whether that is safe
        // depends on this flow's tools. See src/graph/flow-recovery.ts.
        ...(resolvedJobRecovery !== undefined
          ? { jobRecovery: resolvedJobRecovery }
          : {}),
      });
    }

    // -----------------------------------------------------------------------
    // Step 4: SSE streaming path (stream: true or default)
    // -----------------------------------------------------------------------
    if (streamMode) {
      return executeStreaming(
        {
          graphEngine,
          monitoring,
          runtimeGuardrailOverride,
          ...(sseHeartbeatMs !== undefined ? { sseHeartbeatMs } : {}),
        },
        {
          ctx,
          flowToRun,
          messages,
          requestCtx,
          resolvedModel,
          finalize,
          setRunUsage: (u) => {
            runUsage = u;
          },
          progressEvents: harnessProgressRequested(
            ctx.req.header("X-ATF-Progress"),
            metadata,
          ),
        },
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Non-streaming path (stream: false)
    // -----------------------------------------------------------------------
    let response: Awaited<ReturnType<typeof executeNonStreaming>>;
    try {
      response = await executeNonStreaming(
        {
          graphEngine,
          monitoring,
          runtimeGuardrailOverride,
          metrics,
          llmStreamFallbackPolicy: options?.llmStreamFallbackPolicy,
        },
        {
          flowToRun,
          messages,
          requestCtx,
          resolvedModel,
          finalize,
          setRunUsage: (u) => {
            runUsage = u;
          },
        },
      );
    } catch (err) {
      // The Step-3a `hasCapacity()` pre-check is advisory: between it and the
      // engine's own acquire, other requests can take the last slot, or this one
      // can exhaust its deadline while queued. Report that as saturation (503 +
      // Retry-After) rather than as a 500 or a fabricated error message.
      if (err instanceof QueueOverflowError) {
        metrics?.recordRejected("queue_full");
        ctx.header("Retry-After", String(err.retryAfterSeconds));
        return ctx.json(
          {
            error: {
              message: "Server is at capacity. Please retry shortly.",
              type: "overloaded_error",
            },
          },
          503,
        );
      }
      throw err;
    }
    return ctx.json(response);
  });

  return router;
}

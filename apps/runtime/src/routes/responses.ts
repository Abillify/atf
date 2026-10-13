// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Responses API Route — `POST /v1/responses`
 *
 * OpenAI Responses API surface. Clients such as n8n's OpenAI node call this
 * endpoint (rather than `/v1/chat/completions`) with an `input` item list.
 *
 * Rather than reimplement the admission/execution pipeline, this router
 * translates the Responses request into aiperator's internal Chat Completions
 * shape, reuses the exact same building blocks the chat route composes
 * (guardrail → routing → authorization → compliance → budget → token-limit →
 * BYOK → finalize), then translates the result back into the Responses API
 * `response` object (non-streaming) or its typed SSE events (streaming).
 *
 * Registered under `/v1/*`, so the standard auth + rate-limit middleware apply.
 *
 * No `any` at module boundaries.
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
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { TokenUsage } from "../types/openai.js";
import type { ResponsesRequest } from "../types/responses.js";

import {
  REQUEST_NODE_ID,
  buildRequestContext,
  logIdentityTrustWarning,
  buildRequestNodeText,
  buildVariableOverview,
  emitBoundaryNode,
  extractUserPromptPreview,
} from "./chat/handler.js";
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
import { executeNonStreaming } from "./chat/streaming.js";
import { decideFlowAccess } from "../graph/flow-authorizer.js";

import {
  translateInputToMessages,
  translateTools,
  translateToolChoice,
  chatResponseToResponses,
  newResponseId,
} from "./responses/translate.js";
import { executeResponsesStreaming } from "./responses/streaming.js";

/**
 * Constructs the `/v1/responses` router. Accepts the identical dependency set
 * as {@link createChatRouter} so it wires into the same services.
 */
export function createResponsesRouter(
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
  // See the same flag in createChatRouter — fail-closed by default.
  const trustedIdentityHeaders = options?.trustedIdentityHeaders ?? false;
  const strictIdentityHeaders = options?.strictIdentityHeaders ?? false;
  const memoryStore = options?.memoryStore;
  const memoryAutoCapture = options?.memoryAutoCapture ?? false;
  const memoryExtractor = options?.memoryExtractor;
  const modelQuality = options?.modelQuality;
  const abManager = options?.abManager;
  const sloRegistry = options?.sloRegistry;
  const byokResolver = options?.byokResolver;
  const admission = options?.admission;
  const jobStore = options?.jobStore;
  const jobRecovery = options?.jobRecovery;
  const executionContextSecret = options?.executionContextSecret;
  const captureRequestTokens = options?.captureRequestTokens ?? false;
  const shadowModeService = options?.shadowModeService;
  const compliancePolicyLoader = options?.compliancePolicyLoader;
  const auditLog = options?.auditLog;
  const decisionReceiptsEnabled = options?.decisionReceiptsEnabled === true;

  router.post("/v1/responses", async (ctx) => {
    const requestStart = Date.now();

    // -----------------------------------------------------------------------
    // Step 1: Parse & validate
    // -----------------------------------------------------------------------
    let request: ResponsesRequest;
    try {
      request = await ctx.req.json<ResponsesRequest>();
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

    const hasStringInput =
      typeof request.input === "string" && request.input.trim() !== "";
    const hasArrayInput =
      Array.isArray(request.input) && request.input.length > 0;
    if (!hasStringInput && !hasArrayInput) {
      return ctx.json(
        {
          error: {
            message: "Field 'input' must be a non-empty string or item array.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    // Responses API is non-streaming by default (unlike chat completions).
    const streamMode = request.stream === true;

    // Translate the Responses input into internal chat messages.
    const messages = translateInputToMessages(request);
    if (messages.length === 0) {
      return ctx.json(
        {
          error: {
            message: "Field 'input' produced no usable messages.",
            type: "invalid_request_error",
          },
        },
        400,
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Build enriched RequestContext (identical to chat route)
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

    const traceCtx = ctx.get(TRACE_CONTEXT_KEY);
    if (traceCtx !== undefined) {
      requestCtx.traceContext = traceCtx;
    }

    // Decision_Receipts (Req 15.4): pre-generate the parent receipt id so the
    // client can fetch `GET /v1/receipts/{id}` as soon as the run finishes.
    // The receipt decorator consumes the same id from the request context.
    if (decisionReceiptsEnabled) {
      const receiptId = crypto.randomUUID();
      requestCtx.decisionReceiptId = receiptId;
      ctx.header("X-ATF-Receipt", receiptId);
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

    // Function-calling passthrough (translate Responses tool shape → chat shape).
    // Skipped when client tools are disabled (CLIENT_TOOLS_ENABLED=false).
    const clientTools = clientToolsEnabled
      ? translateTools(request.tools)
      : undefined;
    if (clientTools !== undefined) {
      requestCtx.clientTools = clientTools;
      const choice = translateToolChoice(request.tool_choice);
      if (choice !== undefined) {
        requestCtx.clientToolChoice = choice;
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

    // Use the same admission gate as chat, async submission, and recovery.
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
    // Step 3b: Compliance policy (ADR-0009)
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
    // Step 3c: Backpressure
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
    // Step 3d: Budget enforcement
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
    // Step 3e: Token-limit enforcement
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

    /** Token usage of the run. */
    let runUsage: TokenUsage | undefined;
    const responseId = newResponseId();

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

    // Build finalize closure (idempotency omitted — the Responses API has no
    // idempotency-key contract on this endpoint).
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
      flowToRun,
      getRunUsage: () => runUsage,
      shadowModeService,
      ...(executionContextSecret !== undefined
        ? { executionContextSecret }
        : {}),
    });

    // -----------------------------------------------------------------------
    // Step 3.5: Background / async mode
    // -----------------------------------------------------------------------
    const asyncRequested =
      request.background === true ||
      metadata.async === true ||
      ctx.req.header("X-Async") === "true";
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
        ...(jobRecovery !== undefined ? { jobRecovery } : {}),
      });
    }

    // -----------------------------------------------------------------------
    // Step 4: Streaming path (stream: true)
    // -----------------------------------------------------------------------
    if (streamMode) {
      return executeResponsesStreaming(
        { graphEngine, monitoring, runtimeGuardrailOverride },
        {
          ctx,
          req: request,
          responseId,
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
    }

    // -----------------------------------------------------------------------
    // Step 5: Non-streaming path — reuse the chat assembler, then translate
    // -----------------------------------------------------------------------
    const chatResponse = await executeNonStreaming(
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

    const responsesBody = chatResponseToResponses(
      chatResponse,
      request,
      responseId,
    );
    const status = responsesBody.status === "failed" ? 500 : 200;
    return ctx.json(responsesBody, status);
  });

  return router;
}

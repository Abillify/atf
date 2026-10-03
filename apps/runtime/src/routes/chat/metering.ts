// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Chat Route — Metering, Budget, Rate-Limit & Authorization
 *
 * Contains admission checks (budget, token-limit, authorization, backpressure),
 * input guardrail evaluation, BYOK resolution, idempotency management,
 * canary/AB routing, async job dispatch, and the post-execution finalize logic.
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 18.1, 20.1
 */

import { isStudioTestModel } from "../../graph/flow-registry-studio.js";
import type { Context } from "hono";
import {
  AUTH_PRINCIPAL_KEY,
  deriveAuthenticatedOwner,
  type AuthContext,
} from "../../middleware/auth.js";
import type {
  ChatCompletionRequest,
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  TokenUsage,
} from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { FlowRegistry } from "../../graph/flow-parser.js";
import type { FlowDispatcher } from "../../graph/flow-dispatcher.js";
import type { FlowAuthorizer } from "../../graph/flow-authorizer.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import type { BudgetService } from "../../observability/cost.js";
import { estimateCost } from "../../observability/cost.js";
import type { TokenLimitEnforcer } from "../../observability/token-limits.js";
import { describeLimit } from "../../observability/token-limits.js";
import type { Metrics } from "../../observability/metrics.js";
import { formatCostWithCurrency } from "../../util/currency.js";
import type { CanaryManager, Variant } from "../../graph/canary.js";
import type { ReplayService } from "../../graph/replay.js";
import type { Judge } from "../../eval/eval-runner.js";
import type { ModelQualityRegistry } from "../../graph/model-quality.js";
import type { ByokResolver } from "../../graph/tenant-provider-keys.js";
import type { IdempotencyStore } from "../../graph/idempotency-store.js";
import type { JobStore } from "../../graph/job-store.js";
import type { LlmConfig } from "../../types/flow.js";
import {
  contextRequiresAttestation,
  createVerifiedExecutionContext,
  verifyExecutionContext,
} from "../../graph/verified-execution-context.js";
import { InputGuardrail } from "../../graph/input-guardrails.js";
import type { ModelInputClassify } from "../../graph/input-guardrail-model.js";
import type { GuardrailPolicyService } from "../../graph/guardrail-policy.js";
import type {
  FlowGuardrailResolver,
  FlowGuardrailOverride,
} from "../../graph/flow-guardrail-resolver.js";
import type { MemoryStore } from "../../graph/memory-store.js";
import { resolveMemoryScope } from "../../graph/memory-store.js";
import type { MemoryExtract } from "../../graph/memory-extractor.js";
import type { AbManager } from "../../graph/flow-ab.js";
import type { FlowDefinition } from "../../types/flow.js";
import type { CompliancePolicyLoader } from "../../compliance/policy-loader.js";
import { evaluatePolicyForModels } from "../../compliance/policy-evaluator.js";
import type { AuditLog } from "../../observability/audit-log.js";
import {
  requireExecutionAdmission,
  type ExecutionAdmissionService,
} from "../../graph/execution-admission.js";
import {
  collectFlowModels,
  collectFlowLlmConfigs,
  emitBoundaryNode,
  buildResponseNodeText,
  RESPONSE_NODE_ID,
} from "./handler.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Options type for createChatRouter (shared with facade)
// ---------------------------------------------------------------------------

export interface ChatRouterOptions {
  costTracker?: BudgetService;
  metrics?: Metrics;
  /** Semantic LLM response fallback policy; defaults to legacy. */
  llmStreamFallbackPolicy?: import("../../llm-stream-fallback-policy.js").LlmStreamFallbackPolicy;
  budgetDailyPerTenant?: number;
  limitEnforcer?: TokenLimitEnforcer;
  authorizer?: FlowAuthorizer;
  /** Global business-authorization switch; integrity and input checks are unaffected. */
  authzEnabled?: boolean;
  /** JWT claim names used to resolve declarative FlowDefinition.requiredScopes. */
  flowScopeClaims?: readonly string[];
  canaryManager?: CanaryManager;
  replayService?: ReplayService;
  canaryJudge?: Judge;
  inputGuardrail?: InputGuardrail;
  inputGuardrailMode?: "flag" | "block";
  inputGuardrailClassify?: ModelInputClassify;
  inputGuardrailModelMinScore?: number;
  guardrailPolicy?: GuardrailPolicyService;
  flowGuardrailResolver?: FlowGuardrailResolver;
  /**
   * Forward caller-supplied (OpenAI function-calling) tools from the request
   * `tools` field to the model. When false, aiperator ignores client-supplied
   * tools (e.g. Open WebUI's per-user Knowledge tools). Defaults to true.
   */
  clientToolsEnabled?: boolean;
  /**
   * Allow the `X-OpenWebUI-User-*` headers / body metadata to supply
   * `role`/`clientId`/`plan` when the verified token carries no such claim.
   * Defaults to false. A verified claim always wins regardless of this flag.
   */
  trustedIdentityHeaders?: boolean;
  /**
   * Restrict email/userId/userName to verified principal claims. OWUI and
   * metadata profile fallbacks remain available when false (the default).
   */
  strictIdentityHeaders?: boolean;
  memoryStore?: MemoryStore;
  memoryAutoCapture?: boolean;
  memoryExtractor?: MemoryExtract;
  abManager?: AbManager;
  modelQuality?: ModelQualityRegistry;
  /** Declarative cost/quality SLO registry (records quality + cost per flow). */
  sloRegistry?: import("../../graph/slo.js").SloRegistry;
  byokResolver?: ByokResolver;
  /** Shared transport-neutral gate used by HTTP, async submission, and recovery. */
  admission?: Pick<ExecutionAdmissionService, "admit">;
  idempotencyStore?: IdempotencyStore;
  jobStore?: JobStore;
  /** Durable Agent Runtime opt-in for async/batch jobs — see `dispatchAsyncJob`. */
  jobRecovery?: { maxAttempts: number; leaseMs: number; contextSecret?: string };
  /** Existing transaction HMAC secret used to attest persisted authorization context. */
  executionContextSecret?: string;
  captureRequestTokens?: boolean;
  /** Optional shadow mode service for continuous quality monitoring. */
  shadowModeService?: import("../../graph/shadow-mode.js").ShadowModeService;
  /** Optional declarative compliance policy (data/model rules) — see ADR-0009. */
  compliancePolicyLoader?: Pick<CompliancePolicyLoader, "policy">;
  /** Optional audit log — records `compliance.policy.deny` when a request is rejected by policy. */
  auditLog?: AuditLog;
  /**
   * Interval (ms) between SSE keepalive frames on a streaming response. When no
   * chunk has been written for this long, the streaming path emits a
   * lightweight SSE comment frame so proxies/clients keep the connection open
   * during long silent LLM phases. 0 disables the heartbeat. Default 15000.
   */
  sseHeartbeatMs?: number;
}

// ---------------------------------------------------------------------------
// Input guardrail evaluation
// ---------------------------------------------------------------------------

type GuardrailRequestCtxPatch = Partial<Pick<RequestContext, "requestParams">>;

export type GuardrailResult =
  | { blocked: false; requestCtxPatch?: GuardrailRequestCtxPatch }
  | { blocked: true; response: Response };

/**
 * Evaluates the input guardrail for the given messages and flow. Returns
 * whether the request should be blocked and any requestCtx patches.
 */
export async function evaluateInputGuardrail(opts: {
  messages: ChatCompletionRequest["messages"];
  flowId: string;
  requestCtx: RequestContext;
  ctx: Context;
  inputGuardrail?: InputGuardrail;
  inputGuardrailMode: "flag" | "block";
  inputGuardrailClassify?: ModelInputClassify;
  inputGuardrailModelMinScore: number;
  guardrailPolicy?: GuardrailPolicyService;
  metrics?: Metrics;
}): Promise<GuardrailResult> {
  const {
    messages,
    flowId,
    ctx,
    inputGuardrail,
    inputGuardrailMode,
    inputGuardrailClassify,
    inputGuardrailModelMinScore,
    guardrailPolicy,
    metrics,
  } = opts;

  const flowGuardrailOverride = guardrailPolicy?.resolve(flowId);
  const inputOverride = flowGuardrailOverride?.input;
  const effectiveInputGuardrail: InputGuardrail | undefined = (() => {
    if (inputOverride === undefined) return inputGuardrail;
    if (inputOverride.enabled === false) return undefined;
    const enableForFlow =
      inputOverride.enabled === true || inputGuardrail !== undefined;
    if (!enableForFlow) return undefined;
    if (inputOverride.threshold !== undefined) {
      return new InputGuardrail({ threshold: inputOverride.threshold });
    }
    return inputGuardrail ?? new InputGuardrail();
  })();
  const effectiveInputMode = inputOverride?.mode ?? inputGuardrailMode;

  if (effectiveInputGuardrail === undefined) {
    return { blocked: false };
  }

  const scan = effectiveInputGuardrail.scan(messages);

  const blockThreshold = effectiveInputGuardrail.threshold;
  let combinedScore = scan.score;
  let modelMatched: string[] = [];
  if (
    inputGuardrailClassify !== undefined &&
    scan.score >= inputGuardrailModelMinScore
  ) {
    const userText = messages
      .filter((m) => m.role === "user")
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    const modelResult = await inputGuardrailClassify(userText);
    if (modelResult.score > combinedScore) combinedScore = modelResult.score;
    if (modelResult.isInjection || modelResult.score > 0) {
      modelMatched = ["model_classifier"];
    }
    metrics?.recordCounter("aiperator_input_guardrail_model_total", {
      result: modelResult.isInjection ? "injection" : "benign",
    });
  }
  const combinedFlagged = combinedScore >= blockThreshold;
  const combinedSignals = [...scan.matched, ...modelMatched];

  let requestCtxPatch: GuardrailRequestCtxPatch | undefined;
  if (combinedScore > 0) {
    metrics?.recordCounter("aiperator_input_guardrail_total", {
      result: combinedFlagged ? "flagged" : "scanned",
    });
    requestCtxPatch = {
      requestParams: {
        inputRiskScore: combinedScore,
        inputRiskSignals: combinedSignals,
      },
    };
  }

  if (effectiveInputMode === "block" && combinedFlagged) {
    metrics?.recordRejected("input_guardrail");
    return {
      blocked: true,
      response: ctx.json(
        {
          error: {
            message:
              "Request was blocked by the input guardrail (possible prompt injection or jailbreak attempt).",
            type: "invalid_request_error",
          },
        },
        422,
      ),
    };
  }

  return { blocked: false, requestCtxPatch };
}

// ---------------------------------------------------------------------------
// Admission checks (budget, token-limit, authorization, backpressure)
// ---------------------------------------------------------------------------

export type AdmissionResult =
  | { rejected: false }
  | { rejected: true; response: Response };

/** Budget enforcement — reject with 402 when the tenant has exhausted its cap. */
export async function checkBudget(opts: {
  costTracker?: BudgetService;
  budgetCap: number;
  clientId?: string;
  metrics?: Metrics;
  ctx: Context;
}): Promise<AdmissionResult> {
  const { costTracker, budgetCap, clientId, metrics, ctx } = opts;
  if (costTracker === undefined || budgetCap <= 0) {
    return { rejected: false };
  }
  const decision = await costTracker.check(clientId);
  if (!decision.allowed) {
    metrics?.recordRejected("budget_exceeded");
    return {
      rejected: true,
      response: ctx.json(
        {
          error: {
            message: `Daily budget of ${formatCostWithCurrency(
              decision.cap,
              2,
            )} exceeded (${formatCostWithCurrency(
              decision.spent,
              4,
            )} spent). Try again after the window resets.`,
            type: "insufficient_quota",
          },
        },
        402,
      ),
    };
  }
  return { rejected: false };
}

/** Token-limit enforcement — reject with 402 when a configured limit is exhausted. */
export async function checkTokenLimit(opts: {
  limitEnforcer?: TokenLimitEnforcer;
  flowRegistry: FlowRegistry;
  flowToRun: string;
  userId?: string;
  metrics?: Metrics;
  ctx: Context;
}): Promise<AdmissionResult> {
  const { limitEnforcer, flowRegistry, flowToRun, userId, metrics, ctx } = opts;
  if (limitEnforcer === undefined) {
    return { rejected: false };
  }
  try {
    const models = collectFlowModels(flowRegistry.get(flowToRun));
    const violation = await limitEnforcer.check({
      userId,
      flowId: flowToRun,
      models,
    });
    if (violation !== null) {
      metrics?.recordRejected("token_limit_exceeded");
      return {
        rejected: true,
        response: ctx.json(
          {
            error: {
              message: `Token limit reached (${describeLimit(violation.limit)}): ${violation.usedTokens.toLocaleString()} / ${violation.limitTokens.toLocaleString()} tokens used in the current window. Try again after it resets.`,
              type: "insufficient_quota",
            },
          },
          402,
        ),
      };
    }
  } catch {
    /* fail-open: a limit-check error never blocks a request */
  }
  return { rejected: false };
}

/**
 * Compliance policy enforcement — reject with 403 when the flow's declared
 * models violate a `dataRules`/`modelRules` entry in `compliance-policy.yaml`
 * (see ADR-0009). A no-op when no policy is loaded. Approval-rule violations
 * are not enforced here (see `evaluatePolicyForModels`'s doc comment).
 */
export async function checkCompliancePolicy(opts: {
  authorizationEnabled?: boolean;
  compliancePolicyLoader?: Pick<CompliancePolicyLoader, "policy">;
  flow: FlowDefinition | undefined;
  flowId: string;
  requestCtx: RequestContext;
  auditLog?: AuditLog;
  metrics?: Metrics;
  ctx: Context;
}): Promise<AdmissionResult> {
  const { compliancePolicyLoader, flow, flowId, requestCtx, auditLog, metrics, ctx } =
    opts;
  if (opts.authorizationEnabled === false) return { rejected: false };
  const policy = compliancePolicyLoader?.policy;
  if (policy === undefined) {
    return { rejected: false };
  }

  const result = evaluatePolicyForModels(policy, collectFlowLlmConfigs(flow), {
    ...(requestCtx.clientId !== undefined
      ? { tenantId: requestCtx.clientId }
      : {}),
    ...(requestCtx.role !== undefined ? { role: requestCtx.role } : {}),
    ...(flow?.dataClasses !== undefined
      ? { dataClasses: flow.dataClasses }
      : {}),
    flowId,
  });

  if (result.decision !== "deny") {
    return { rejected: false };
  }

  metrics?.recordRejected("compliance_policy");
  auditLog?.record({
    actor:
      requestCtx.userEmail ?? requestCtx.userId ?? requestCtx.clientId ?? "anonymous",
    action: "compliance.policy.deny",
    outcome: "denied",
    target: flowId,
    details: {
      violations: result.violations.map((v) => ({
        rule: v.rule,
        message: v.message,
      })),
    },
  });

  return {
    rejected: true,
    response: ctx.json(
      {
        error: {
          message: `Request denied by compliance policy: ${result.violations
            .map((v) => v.message)
            .join(" ")}`,
          type: "permission_error",
        },
      },
      403,
    ),
  };
}

// ---------------------------------------------------------------------------
// Flow dispatch & routing
// ---------------------------------------------------------------------------

export interface RoutingResult {
  flowToRun: string;
  resolvedModel: string;
  canaryVariant?: Variant;
  abVariant?: string;
  runtimeGuardrailOverride?: FlowGuardrailOverride;
}

/**
 * Resolves which flow to run (dispatch → canary → AB), performs authorization,
 * and resolves per-flow guardrail overrides.
 */
export function resolveFlowRouting(opts: {
  requestModel: string;
  requestCtx: RequestContext;
  flowDispatcher?: FlowDispatcher;
  canaryManager?: CanaryManager;
  abManager?: AbManager;
  flowGuardrailResolver?: FlowGuardrailResolver;
}): RoutingResult {
  const {
    requestModel,
    requestCtx,
    flowDispatcher,
    canaryManager,
    abManager,
    flowGuardrailResolver,
  } = opts;

  // A Studio test run names its throwaway definition explicitly; dispatch,
  // canary and A/B must not redirect it to some other flow/version.
  // It still counts as that flow for guardrail overrides (e.g. a PII vault)
  // and metering, so `resolvedModel` is the real flow id.
  if (isStudioTestModel(requestModel)) {
    const baseFlowId = requestModel.slice(0, requestModel.indexOf("@"));
    const override = flowGuardrailResolver?.resolve(baseFlowId);
    return {
      flowToRun: requestModel,
      resolvedModel: baseFlowId,
      ...(override !== undefined ? { runtimeGuardrailOverride: override } : {}),
    };
  }

  const resolvedModel = flowDispatcher
    ? flowDispatcher.resolveFlow(requestModel, requestCtx)
    : requestModel;

  // Canary routing
  const routingKey =
    (typeof requestCtx.requestParams?.conversation_id === "string"
      ? (requestCtx.requestParams.conversation_id as string)
      : undefined) ?? requestCtx.executionId;
  const canarySel = canaryManager?.select(resolvedModel, routingKey);
  let flowToRun = canarySel?.flowId ?? resolvedModel;
  const canaryVariant: Variant | undefined = canarySel?.active
    ? canarySel.variant
    : undefined;

  // A/B experiment routing
  let abVariant: string | undefined;
  if (abManager !== undefined && flowToRun === resolvedModel) {
    const abSel = abManager.select(resolvedModel, routingKey);
    if (abSel !== undefined) {
      flowToRun = abSel.versionedId;
      abVariant = abSel.variant;
    }
  }

  // Per-flow runtime guardrail override
  const runtimeGuardrailOverride =
    flowGuardrailResolver?.resolve(resolvedModel);

  return {
    flowToRun,
    resolvedModel,
    canaryVariant,
    abVariant,
    runtimeGuardrailOverride,
  };
}

// ---------------------------------------------------------------------------
// Finalize (post-execution side-effects)
// ---------------------------------------------------------------------------

export interface FinalizeOpts {
  requestCtx: RequestContext;
  messages: ChatCompletionRequest["messages"];
  metadata: Record<string, unknown>;
  resolvedModel: string;
  streamMode: boolean;
  requestStart: number;
  monitoring?: MonitoringServiceInterface;
  canaryManager?: CanaryManager;
  canaryVariant?: Variant;
  abManager?: AbManager;
  abVariant?: string;
  replayService?: ReplayService;
  canaryJudge?: Judge;
  modelQuality?: ModelQualityRegistry;
  memoryStore?: MemoryStore;
  memoryAutoCapture: boolean;
  memoryExtractor?: MemoryExtract;
  idempotencyStore?: IdempotencyStore;
  idempotencyKey?: string;
  flowToRun: string;
  getRunUsage: () => TokenUsage | undefined;
  /** Optional shadow mode service — fires shadow comparison after production response. */
  shadowModeService?: import("../../graph/shadow-mode.js").ShadowModeService;
  /** Existing transaction HMAC secret used to attest persisted authorization context. */
  executionContextSecret?: string;
  /** Optional declarative cost/quality SLO registry (records quality + cost per flow). */
  sloRegistry?: import("../../graph/slo.js").SloRegistry;
}

/**
 * Creates the finalize function that runs post-execution side effects: canary
 * scoring, replay capture, memory extraction, idempotency completion, and
 * response boundary node emission.
 */
export function createFinalize(
  opts: FinalizeOpts,
): (responseText: string, hadError: boolean) => Promise<void> {
  const {
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
    getRunUsage,
    shadowModeService,
    executionContextSecret,
    sloRegistry,
  } = opts;

  return async (responseText: string, hadError: boolean): Promise<void> => {
    const runUsage = getRunUsage();

    const boundaryMeta = {
      flowId: flowToRun,
      ...(requestCtx.clientId !== undefined
        ? { tenantId: requestCtx.clientId }
        : {}),
    };

    emitBoundaryNode(monitoring, requestCtx.executionId, boundaryMeta, {
      nodeId: RESPONSE_NODE_ID,
      hadError,
      response: buildResponseNodeText({
        model: resolvedModel,
        streaming: streamMode,
        responseText,
        ...(runUsage !== undefined ? { usage: runUsage } : {}),
        hadError,
      }),
    });

    const needScore =
      canaryJudge !== undefined &&
      responseText.trim().length > 0 &&
      (canaryVariant !== undefined || abVariant !== undefined);
    let score: number | undefined;
    if (needScore) {
      try {
        const verdict = await canaryJudge({
          criteria:
            "Overall quality, correctness and helpfulness of the assistant response for the user's request.",
          response: responseText,
          messages,
        });
        score = verdict.score;
      } catch {
        /* judge failure must not break the request */
      }
    }

    // Feed the adaptive quality-aware router
    if (
      modelQuality !== undefined &&
      score !== undefined &&
      requestCtx.selectedModels !== undefined
    ) {
      for (const key of requestCtx.selectedModels) {
        const slash = key.indexOf("/");
        if (slash <= 0) continue;
        modelQuality.record(
          {
            provider: key.slice(0, slash) as LlmConfig["provider"],
            model: key.slice(slash + 1),
          },
          score,
        );
      }
    }

    // Declarative cost/quality SLO: record the judged quality (when available)
    // and an estimated cost per request, keyed by the requested flow. Attainment
    // is reported at GET /monitoring/slo.
    if (sloRegistry?.enabled) {
      const obs: import("../../graph/slo.js").SloObservation = {};
      if (score !== undefined) obs.qualityScore = score;
      // Prefer the EXACT per-run cost the engine summed across nodes (each
      // priced at its own provider/model rate). Fall back to a single-model
      // estimate only when the engine didn't report a cost (e.g. no priced model).
      if (runUsage?.cost_usd !== undefined && runUsage.cost_usd > 0) {
        obs.costUsd = runUsage.cost_usd;
      } else if (runUsage !== undefined && requestCtx.selectedModels !== undefined) {
        const keys = [...requestCtx.selectedModels];
        const key = keys[keys.length - 1];
        if (key !== undefined) {
          const slash = key.indexOf("/");
          if (slash > 0) {
            const cost = estimateCost(
              key.slice(0, slash),
              key.slice(slash + 1),
              {
                prompt_tokens: runUsage.prompt_tokens ?? 0,
                completion_tokens: runUsage.completion_tokens ?? 0,
              },
            );
            if (cost > 0) obs.costUsd = cost;
          }
        }
      }
      if (obs.qualityScore !== undefined || obs.costUsd !== undefined) {
        sloRegistry.record(resolvedModel, obs);
      }
    }

    if (canaryManager !== undefined && canaryVariant !== undefined) {
      canaryManager.record(resolvedModel, canaryVariant, {
        error: hadError,
        ...(score !== undefined ? { score } : {}),
      });
    }
    if (abManager !== undefined && abVariant !== undefined) {
      abManager.record(resolvedModel, abVariant, {
        error: hadError,
        latencyMs: Date.now() - requestStart,
        ...(score !== undefined ? { score } : {}),
      });
    }
    if (replayService !== undefined) {
      try {
        const verifiedContext = createVerifiedExecutionContext(requestCtx, executionContextSecret);
        const replayMetadata = { ...metadata };
        delete replayMetadata.__token;
        delete replayMetadata.__verifiedContext;
        if (verifiedContext !== undefined) replayMetadata.__verifiedContext = verifiedContext;
        await replayService.capture({
          executionId: requestCtx.executionId,
          flowId: flowToRun,
          messages,
          ...(Object.keys(replayMetadata).length > 0 ? { metadata: replayMetadata } : {}),
          responseText,
          createdAt: new Date().toISOString(),
          ...(requestCtx.clientId !== undefined
            ? { tenantId: requestCtx.clientId }
            : {}),
          ...(requestCtx.userEmail !== undefined
            ? { userId: requestCtx.userEmail }
            : {}),
        });
      } catch {
        /* snapshot capture is best-effort */
      }
    }

    // Long-term memory auto-capture
    if (
      memoryStore !== undefined &&
      memoryAutoCapture &&
      memoryExtractor !== undefined &&
      !hadError
    ) {
      const scope = resolveMemoryScope(requestCtx);
      if (scope !== undefined) {
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        const lastUserContent = lastUser?.content;
        const text =
          typeof lastUserContent === "string"
            ? lastUserContent
            : Array.isArray(lastUserContent)
              ? lastUserContent
                  .map((b) => {
                    const bb = b as { type?: string; text?: string };
                    return bb.type === "text" ? (bb.text ?? "") : "";
                  })
                  .join(" ")
              : "";
        if (text.trim().length > 0) {
          try {
            const facts = await memoryExtractor({
              userMessage: text,
              ...(responseText.trim().length > 0
                ? { assistantMessage: responseText }
                : {}),
            });
            for (const fact of facts) {
              const id = crypto
                .createHash("sha256")
                .update(fact.toLowerCase())
                .digest("hex");
              await memoryStore.remember(scope, fact, { kind: "fact", id });
            }
          } catch {
            /* memory capture is best-effort */
          }
        }
      }
    }

    // Idempotency: remember the outcome or free the reservation
    if (idempotencyStore !== undefined && idempotencyKey !== undefined) {
      if (hadError) {
        await idempotencyStore.release(idempotencyKey);
      } else {
        await idempotencyStore.complete(idempotencyKey, {
          model: resolvedModel,
          responseText,
          finishReason: "stop",
          ...(runUsage !== undefined ? { usage: runUsage } : {}),
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Shadow mode: fire-and-forget quality comparison AFTER production response
    // is committed. Never affects the production response path or latency.
    if (
      shadowModeService?.runner !== undefined &&
      !hadError &&
      responseText.trim().length > 0
    ) {
      const shadowConfigs = shadowModeService.configs();
      // Forward the caller's SSO token to the shadow run (via the replay
      // executor's __token channel) so shadow executions authenticate
      // identically to production — otherwise tool-calling flows would fail
      // auth in the shadow and produce false regression signals. The token is
      // used only for the transient shadow execution; the shadow runner
      // persists only scores + a query preview, never the token.
      const verifiedContext = createVerifiedExecutionContext(requestCtx, executionContextSecret);
      if (contextRequiresAttestation(requestCtx) && verifiedContext === undefined) return;
      const shadowMetadata: Record<string, unknown> = { ...metadata };
      delete shadowMetadata.__token;
      delete shadowMetadata.__verifiedContext;
      if (verifiedContext !== undefined) shadowMetadata.__verifiedContext = verifiedContext;
      if (requestCtx.ssoToken.length > 0) {
        shadowMetadata.__token = requestCtx.ssoToken;
      }
      shadowModeService.runner.maybeRunShadow(
        {
          productionFlow: flowToRun,
          productionResponse: responseText,
          messages: messages as import("../../types/openai.js").ChatMessage[],
          ...(Object.keys(shadowMetadata).length > 0
            ? { metadata: shadowMetadata }
            : {}),
        },
        shadowConfigs,
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Async job execution
// ---------------------------------------------------------------------------

/**
 * Runs one attempt of a flow execution and settles the job's outcome
 * (`complete`/`fail`) on the store. Shared by `dispatchAsyncJob`'s first
 * attempt and the Durable Agent Runtime's recovery-sweeper retries
 * (`job-recovery-sweeper.ts`'s `JobRetryRunner`), so both go through the
 * exact same execution/settlement path — a retry is not a second, subtly
 * different code path that could drift from the original.
 *
 * When `leaseMs` is given, a heartbeat is started for the duration of the
 * run (renewing the job's lease so a genuinely-still-running job is never
 * mistaken for orphaned mid-flight — see `job-store.ts`'s module doc
 * comment) and stopped once the run settles either way.
 */
async function runJobAttempt(opts: {
  jobId: string;
  jobStore: JobStore;
  graphEngine: GraphEngineService;
  flowToRun: string;
  messages: ChatCompletionRequest["messages"];
  requestCtx: RequestContext;
  resolvedModel: string;
  monitoring?: MonitoringServiceInterface;
  runtimeGuardrailOverride?: FlowGuardrailOverride;
  onUsage?: (usage: TokenUsage) => void;
  leaseMs?: number;
}): Promise<{ responseText: string; hadError: boolean }> {
  const {
    jobId,
    jobStore,
    graphEngine,
    flowToRun,
    messages,
    requestCtx,
    resolvedModel,
    monitoring,
    runtimeGuardrailOverride,
    onUsage,
    leaseMs,
  } = opts;

  await jobStore.markRunning(jobId, leaseMs);
  // Renews the lease well before it expires (a third of the lease window,
  // matching the same margin `distributed-semaphore.ts`'s heartbeat uses
  // relative to its own ttlMs) so a normal GC pause or a slow tick never
  // causes a live job to be swept as orphaned. `unref()`'d — a heartbeat
  // must never keep the process alive on its own.
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (leaseMs !== undefined) {
    heartbeat = setInterval(() => {
      void Promise.resolve(jobStore.heartbeat(jobId, leaseMs)).catch(() => {
        /* best-effort — a missed heartbeat is recovered by the next one */
      });
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    (heartbeat as unknown as { unref?: () => void }).unref?.();
  }

  const content: string[] = [];
  let jobError = false;
  let jobUsage: TokenUsage | undefined;
  try {
    await graphEngine.executeFlow(
      flowToRun,
      messages,
      requestCtx,
      async (chunk: ChatCompletionChunk): Promise<void> => {
        const choice = chunk.choices[0];
        if (choice?.finish_reason === "error") {
          jobError = true;
        } else if (choice?.delta?.content != null && choice.delta.content !== "") {
          content.push(choice.delta.content);
        }
      },
      async (usage): Promise<void> => {
        jobUsage = usage;
        onUsage?.(usage);
      },
      monitoring,
      runtimeGuardrailOverride,
    );
  } catch (err) {
    jobError = true;
    content.push(`[Error: ${err instanceof Error ? err.message : String(err)}]`);
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }

  const responseText = content.join("");
  const result: ChatCompletionResponse = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: responseText },
        finish_reason: jobError ? "error" : "stop",
      },
    ],
    ...(jobUsage !== undefined ? { usage: jobUsage } : {}),
  };
  if (jobError) {
    await jobStore.fail(jobId, responseText || "execution failed");
  } else {
    await jobStore.complete(jobId, result);
  }
  return { responseText, hadError: jobError };
}

/**
 * Dispatches a flow execution in the background (async/batch mode) and returns
 * an HTTP 202 response with the job ID.
 *
 * When `jobRecovery` is configured, the submission also records a
 * secret-free {@link JobResumePayload} and a lease, so a crash mid-execution
 * is detectable and bounded-retryable by the Durable Agent Runtime's recovery
 * sweeper (`job-recovery-sweeper.ts`) — see `job-store.ts`'s module doc
 * comment for exactly what that guarantees and what it does not.
 */
export async function dispatchAsyncJob(opts: {
  ctx: Context<AuthContext>;
  jobStore: JobStore;
  graphEngine: GraphEngineService;
  flowToRun: string;
  messages: ChatCompletionRequest["messages"];
  requestCtx: RequestContext;
  resolvedModel: string;
  monitoring?: MonitoringServiceInterface;
  runtimeGuardrailOverride?: FlowGuardrailOverride;
  finalize: (responseText: string, hadError: boolean) => Promise<void>;
  setRunUsage: (usage: TokenUsage) => void;
  /** Durable Agent Runtime opt-in. Omit to keep the pre-existing (non-recoverable) behaviour. */
  jobRecovery?: { maxAttempts: number; leaseMs: number; contextSecret?: string };
}): Promise<Response> {
  const {
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
    setRunUsage,
    jobRecovery,
  } = opts;

  const jobId = `job-${crypto.randomUUID()}`;
  const owner = deriveAuthenticatedOwner(
    ctx.get(AUTH_PRINCIPAL_KEY),
    requestCtx.ssoToken,
  );
  const verifiedContext = createVerifiedExecutionContext(requestCtx, jobRecovery?.contextSecret);
  const recoveryContextAvailable = !contextRequiresAttestation(requestCtx) || verifiedContext !== undefined;
  const routingContext = {
    ...(requestCtx.userName !== undefined ? { userName: requestCtx.userName } : {}),
    ...(requestCtx.chatId !== undefined ? { chatId: requestCtx.chatId } : {}),
    ...(requestCtx.sessionId !== undefined ? { sessionId: requestCtx.sessionId } : {}),
    ...(requestCtx.messageId !== undefined ? { messageId: requestCtx.messageId } : {}),
    ...(requestCtx.language !== undefined ? { language: requestCtx.language } : {}),
    ...(requestCtx.plan !== undefined ? { plan: requestCtx.plan } : {}),
    ...(requestCtx.requestParams !== undefined ? { requestParams: requestCtx.requestParams } : {}),
  };
  await jobStore.create({
    id: jobId,
    model: resolvedModel,
    ...(owner.length > 0 ? { owner } : {}),
    ...(jobRecovery !== undefined
      ? {
          maxAttempts: recoveryContextAvailable ? jobRecovery.maxAttempts : 1,
          ...(recoveryContextAvailable
            ? {
                resumePayload: {
                  flowId: flowToRun,
                  messages: messages as ChatMessage[],
                  ...(verifiedContext !== undefined ? { verifiedContext } : {}),
                  ...(Object.keys(routingContext).length > 0 ? { routingContext } : {}),
                },
              }
            : {}),
        }
      : {}),
  });

  // Detached execution — the FIRST attempt. A sweeper-driven retry (should
  // this attempt be orphaned by a crash) goes through `runJobAttempt`
  // directly via a separate `JobRetryRunner`, not through this function.
  void (async (): Promise<void> => {
    const { responseText, hadError } = await runJobAttempt({
      jobId,
      jobStore,
      graphEngine,
      flowToRun,
      messages,
      requestCtx,
      resolvedModel,
      ...(monitoring !== undefined ? { monitoring } : {}),
      ...(runtimeGuardrailOverride !== undefined ? { runtimeGuardrailOverride } : {}),
      onUsage: setRunUsage,
      ...(jobRecovery !== undefined ? { leaseMs: jobRecovery.leaseMs } : {}),
    });
    try {
      await finalize(responseText, hadError);
    } catch {
      /* finalize side effects must not fail the job result */
    }
  })();

  return ctx.json(
    {
      id: jobId,
      object: "chat.completion.job",
      status: "queued",
      model: resolvedModel,
      ...(jobRecovery !== undefined
        ? { max_attempts: recoveryContextAvailable ? jobRecovery.maxAttempts : 1 }
        : {}),
    },
    202,
  );
}

// ---------------------------------------------------------------------------
// Durable Agent Runtime — recovery retry runner
// ---------------------------------------------------------------------------

/**
 * Builds the `JobRetryRunner` the recovery sweeper (`job-recovery-sweeper.ts`)
 * calls for an orphaned, retry-eligible job. Reconstructs a `RequestContext`
 * from the job's `resumePayload` and re-runs the flow via {@link runJobAttempt}
 * — the SAME execution/settlement path the original submission used.
 *
 * Deliberately does NOT call the rich per-request `finalize` closure
 * (metrics/billing/canary/shadow-mode side effects) that `dispatchAsyncJob`
 * builds per HTTP request in `chat.ts`/`responses.ts` — reconstructing that
 * closure would need re-deriving canary/AB variant assignment, idempotency
 * keys, and other request-scoped state that legitimately does not exist for
 * a background retry. This is the stated scope boundary of "durable" in the
 * crash-RESILIENCE sense: the client reliably gets a result; a retried
 * attempt's cost/quality signal is a secondary concern the ADR documents
 * explicitly rather than silently dropping.
 */
export function createJobRetryRunner(deps: {
  graphEngine: GraphEngineService;
  jobStore: JobStore;
  admission: Pick<ExecutionAdmissionService, "admit">;
  leaseMs: number;
  contextSecret?: string;
  executionIdPrefix?: string;
}): (job: import("../../graph/job-store.js").JobRecord) => Promise<void> {
  return async (job): Promise<void> => {
    const payload = job.resumePayload;
    if (payload === undefined) {
      // Unreachable in practice — the sweeper already checks this before
      // requeuing — but a defensive fail is cheap and keeps this function
      // safe to call directly (e.g. from a test) without that precondition.
      await deps.jobStore.fail(job.id, "No resumable snapshot recorded for this job.");
      return;
    }
    const verified = payload.verifiedContext === undefined
      ? undefined
      : verifyExecutionContext(payload.verifiedContext, deps.contextSecret);
    if (payload.verifiedContext !== undefined && verified === undefined) {
      await deps.jobStore.fail(job.id, "Stored execution context attestation is invalid or unavailable.");
      return;
    }
    const routing = payload.routingContext;
    const requestCtx: RequestContext = {
      ssoToken: "",
      executionId: `${deps.executionIdPrefix ?? "job-retry"}-${crypto.randomUUID()}`,
      ...(verified?.claims !== undefined ? { claims: verified.claims } : {}),
      ...(verified?.clientId !== undefined ? { clientId: verified.clientId } : {}),
      ...(verified?.userId !== undefined ? { userId: verified.userId } : {}),
      ...(verified?.userEmail !== undefined ? { userEmail: verified.userEmail } : {}),
      ...(verified?.role !== undefined ? { role: verified.role } : {}),
      ...(verified?.groups !== undefined ? { groups: verified.groups } : {}),
      ...(typeof routing?.userName === "string" ? { userName: routing.userName } : {}),
      ...(typeof routing?.chatId === "string" ? { chatId: routing.chatId } : {}),
      ...(typeof routing?.sessionId === "string" ? { sessionId: routing.sessionId } : {}),
      ...(typeof routing?.messageId === "string" ? { messageId: routing.messageId } : {}),
      ...(typeof routing?.language === "string" ? { language: routing.language } : {}),
      ...(typeof routing?.plan === "string" ? { plan: routing.plan } : {}),
      ...(routing?.requestParams !== null && typeof routing?.requestParams === "object" && !Array.isArray(routing.requestParams)
        ? { requestParams: routing.requestParams }
        : {}),
    };
    try {
      await requireExecutionAdmission(deps.admission, payload.flowId, requestCtx);
    } catch (error) {
      await deps.jobStore.fail(
        job.id,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    await runJobAttempt({
      jobId: job.id,
      jobStore: deps.jobStore,
      graphEngine: deps.graphEngine,
      flowToRun: payload.flowId,
      messages: payload.messages,
      requestCtx,
      resolvedModel: job.model,
      leaseMs: deps.leaseMs,
    });
  };
}

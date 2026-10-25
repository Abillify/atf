// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Candidate/provider retry loop of the LLM node handler.
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged.
 */
import { stepCountIs, streamText } from "ai";
import { executionBudgetErrorOf } from "../execution-budget.js";
import type { ModelMessage, ToolSet } from "ai";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import type { AgentState } from "../graph-engine.js";
import {
  answerOnlyToolMode,
  toolHistoryAsText,
} from "../answer-only-tools.js";
import {
  applyAnthropicPromptCache,
  applyBedrockPromptCache,
  modelMessagesContainImages,
  sanitizeReasoningSentinelModelMessages,
  sanitizeToolCallModelMessages,
  sanitizeToolResultModelMessages,
} from "../message-mapping.js";
import { applyToolResultBudget } from "../tool-result-budget.js";
import {
  clampMaxOutputTokens,
  estimateMessagesTokens,
  resolveContextWindow,
  truncateMessagesToWindow,
} from "../context-window.js";
import {
  CONTEXT_RETRY_FACTOR,
  isContextLengthError,
} from "../context-length-retry.js";
import {
  combineAbortSignals,
  stripUnsignedGeminiToolHistory,
  type ExecRuntime,
} from "../exec-runtime.js";
import {
  buildCostAttribution,
  estimateCost,
  estimateTokensFromText,
} from "../../observability/cost.js";
import { getModelCapabilities } from "../model-capabilities.js";
import {
  hasFinalAnswerStreamingSubstance,
  longestMarkerPrefixSuffix,
  type FinalAnswerContractConfig,
} from "./llm-final-answer.js";
import { mapToolChoice } from "../agent-tools.js";
import { offloadInlineImages } from "../image-reference.js";
import { parseSourcesCheckConfig } from "../answer-sources-check.js";
import { resolveProviderProtocol } from "../../config/providers.js";
import type {
  LlmStreamFallbackNodeConfig,
  LlmStreamFallbackPolicy,
} from "../../llm-stream-fallback-policy.js";
import type { ToolSequenceContract } from "../tool-sequence-contract.js";
import type { CacheKeyInput, ResponseCache } from "../response-cache.js";
import type {
  SemanticCache,
  SemanticCacheKeyInput,
} from "../semantic-cache.js";
import { runAttemptStream } from "./llm-attempt-stream.js";
import {
  isolateToolsFromLlmTransportScope,
  type LlmTransportScope,
  runInLlmTransportScope,
} from "../llm-transport.js";
import { handleAttemptError, postprocessAttempt } from "./llm-attempt-postprocess.js";
import type {
  FinalAnswerStreamState,
  LlmAttemptState,
  LlmStreamResult,
} from "./llm-stream-types.js";

/** Result of the whole candidate/fallback loop: either the node completed
 * with `value`, or every candidate/attempt was exhausted. */
export type LoopResult =
  | { done: true; value: Partial<AgentState> }
  | {
      done: false;
      lastErrMsg: string;
      providerAttemptCount: number;
      policySuppressedToolFallback: boolean;
      circuitSkippedProviders: string[];
    };

interface CandidateLoopCtx {
  runtime: ExecRuntime;
  node: FlowNode;
  state: AgentState;
  aiTools: ToolSet | undefined;
  activeToolKeys: Set<string> | undefined;
  backoffMs: number;
  cacheKeyInput: CacheKeyInput | undefined;
  cacheable: boolean | undefined;
  candidates: LlmConfig[];
  clientToolKeys: Set<string>;
  effectiveToolArgsByCallId: Map<string, Record<string, unknown>>;
  exactCache: ResponseCache | undefined;
  finalAnswerContract: FinalAnswerContractConfig | undefined;
  hasTools: boolean;
  imageInspectionEnabled: boolean;
  imageInspectionToolName: string;
  maxAttempts: number;
  maxOutputChars: number;
  maxTokens: number | undefined;
  messagesWithSystemPrompt: ModelMessage[];
  reportStreamFallback: (
    reason:
      | "reasoning_salvage"
      | "empty_response_fallback"
      | "require_tool_use_released"
      | "require_tool_use_history_copy_fallback",
    details?: Record<string, unknown>,
  ) => void;
  requestTimeoutMs: number;
  requireToolUse: boolean;
  requireToolUseMandatory: boolean;
  semCache: SemanticCache | undefined;
  semKeyInput: SemanticCacheKeyInput | undefined;
  selectedBoundToolBestScore: number;
  selectedBoundToolKeys: string[];
  streamFallbackNodeConfig: LlmStreamFallbackNodeConfig | undefined;
  streamFallbackPolicy: LlmStreamFallbackPolicy;
  temperature: number | undefined;
  toolKeyByRef: Record<string, string>;
  toolResultBudget: { perResultChars: number; perTurnChars: number };
  toolSequenceContract: ToolSequenceContract | undefined;
}

/** Runs the candidate chain with per-candidate retries. The mutable state of
 * the original implementation lives in `st`; closures defined here are passed
 * into the stream/postprocess/error modules. */
export async function runCandidateLoop(
  ctx: CandidateLoopCtx,
): Promise<LoopResult> {
  const {
    runtime,
    node,
    state,
    aiTools,
    activeToolKeys,
    backoffMs,
    cacheKeyInput,
    cacheable,
    candidates,
    clientToolKeys,
    effectiveToolArgsByCallId,
    exactCache,
    finalAnswerContract,
    hasTools,
    imageInspectionEnabled,
    imageInspectionToolName,
    maxAttempts,
    maxOutputChars,
    maxTokens,
    messagesWithSystemPrompt,
    reportStreamFallback,
    requestTimeoutMs,
    requireToolUse,
    requireToolUseMandatory,
    semCache,
    semKeyInput,
    selectedBoundToolBestScore,
    selectedBoundToolKeys,
    streamFallbackNodeConfig,
    streamFallbackPolicy,
    temperature,
    toolKeyByRef,
    toolResultBudget,
    toolSequenceContract,
  } = ctx;
  const st: LlmAttemptState = {
    fullText: "",
    finalAnswerBuffer: "",
    reasoningText: "",
    emittedAny: false,
    forcedAnswer: false,
    emptyResponseFallbackUsed: false,
    textWithoutToolCall: false,
    thinkBuf: "",
    inThink: false,
    toolPhaseStarted: false,
    stepLookahead: undefined,
    visibleTextLengthAtLastToolResult: undefined,
    lastToolResultForRetry: undefined,
    preambleBuf: "",
    preambleResolved: false,
    preambleStartedAt: 0,
    loopAborted: false,
    outputAborted: false,
    repScanAt: 0,
    finalAnswerOnly: false,
    retryGuidance: undefined,
    retryContinuation: undefined,
    lastErrMsg: "LLM provider request failed.",
    policySuppressedToolFallback: false,
  };
  let providerAttemptCount = 0;
  const circuitSkippedProviders: string[] = [];
  // One context-length retry per handler invocation: a provider rejection
  // for an oversized prompt is deterministic, so it is retried exactly once
  // with a reduced context budget (see context-length-retry.ts). The scale
  // persists across candidates so a failover after such a rejection keeps
  // the smaller budget.
  let contextRetryUsed = false;
  let contextBudgetScale = 1;
  for (const [c, candidate] of candidates.entries()) {
    const isFallback = c > 0;
    const circuitState = runtime.providerCircuitBreaker?.getState(
      candidate.provider,
    );
    if (circuitState?.state === "open") {
      circuitSkippedProviders.push(
        `${candidate.provider}/${candidate.model}`,
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "llm_provider_circuit_open",
        message: `Skipping ${candidate.provider}/${candidate.model}: provider circuit is open for this flow.`,
        details: {
          phase: "provider-selection",
          candidate_index: c,
          provider: candidate.provider,
          model: candidate.model,
          ...circuitState,
        },
      });
      continue;
    }

    let model: ReturnType<typeof runtime.llmProviderFactory>;
    try {
      model = runtime.llmProviderFactory(candidate, runtime.appConfig, {
        ...(runtime.ctx.providerKeyOverrides !== undefined
          ? { providerKeyOverrides: runtime.ctx.providerKeyOverrides }
          : {}),
      });
    } catch {
      st.lastErrMsg = "LLM provider initialization failed.";
      runtime.metrics.recordLlmCall(
        candidate.provider,
        candidate.model,
        "error",
        0,
        0,
        0,
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "llm_provider_candidate_failed",
        message: `Could not initialize ${candidate.provider}/${candidate.model}.`,
        details: {
          phase: "provider-initialization",
          candidate_index: c,
          provider: candidate.provider,
          model: candidate.model,
        },
      });
      continue;
    }

    // Prompt-cache and multimodal capabilities come from the same registry.
    // A deployment can explicitly attest a local model with
    // `parameters.visionInput: true`; unknown models otherwise fail closed.
    const candidateCapabilities = getModelCapabilities(
      candidate.provider,
      candidate.model,
    );
    const cacheMode = candidateCapabilities.promptCache;
    const visionInput =
      candidateCapabilities.visionInput ||
      candidate.parameters?.visionInput === true;
    // Gemini 3 requires the opaque thought signature returned with every
    // historical function call. OpenAI-compatible clients cannot replay that
    // Google-only metadata, so remove only those unsigned call/result pairs;
    // otherwise Google rejects the entire request with INVALID_ARGUMENT.
    const providerSafeMessages = stripUnsignedGeminiToolHistory(
      messagesWithSystemPrompt,
      candidate,
    );
    if (modelMessagesContainImages(providerSafeMessages) && !visionInput) {
      st.lastErrMsg = `Model ${candidate.provider}/${candidate.model} does not declare vision input support`;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "vision_not_supported",
        message: st.lastErrMsg,
        details: { provider: candidate.provider, model: candidate.model },
      });
      continue;
    }
    const streamParams: Parameters<typeof streamText>[0] = {
      model,
      allowSystemInMessages: true,
      messages:
        runtime.appConfig.anthropicPromptCacheEnabled !== false
          ? cacheMode === "anthropic"
            ? applyAnthropicPromptCache(providerSafeMessages)
            : cacheMode === "bedrock"
              ? applyBedrockPromptCache(providerSafeMessages)
              : providerSafeMessages
          : providerSafeMessages,
    };
    if (temperature !== undefined) streamParams.temperature = temperature;
    if (maxTokens !== undefined) streamParams.maxOutputTokens = maxTokens;
    // While another candidate remains, disable the AI SDK's internal retries
    // (default 2, with 2 s + 4 s backoff). This handler's own attempt loop
    // already retries non-transport errors and fails over immediately on an
    // unreachable provider; nested SDK retries made every attempt against a
    // dead endpoint cost ~6 s (3 × 3 calls ≈ 18 s before the fallback). The
    // last candidate keeps the SDK default as its final line of resilience.
    if (c < candidates.length - 1) streamParams.maxRetries = 0;
    // Set once a retry must answer from an interrupted tool loop — from its
    // recorded tool calls/results or, as a fallback, a result excerpt
    // (post_tool_answer_missing, text_tool_call_rejected). Such a retry may
    // only answer: prepareStep offers no tools and the attempt is limited
    // to a single step. Sticky for this candidate.
    st.finalAnswerOnly = false;
    // How answer-only rounds keep tools out on this candidate's wire protocol
    // (strip / declare with NONE / tool history as text). See
    // answer-only-tools.ts for the per-SDK reasoning.
    const answerOnlyMode = answerOnlyToolMode(
      resolveProviderProtocol(candidate.provider),
    );
    // Attempt number visible to prepareStep diagnostics (assigned per attempt).
    let currentAttempt = 0;
    // Attempt bound for THIS candidate. Raised by one above maxAttempts only
    // when the context-length retry is triggered, so the retry also happens
    // when the rejection arrives on the last regular attempt.
    let maxAttemptsEffective = maxAttempts;
    if (aiTools !== undefined && Object.keys(aiTools).length > 0) {
      // Nested LLM requests from tool executions must not count as steps of
      // this attempt nor report connect-retries on this node.
      streamParams.tools = isolateToolsFromLlmTransportScope(aiTools);
      // A node may raise its tool-step budget above the global default via
      // `config.maxToolSteps` — needed for agentic flows (for example, a
      // coverage controller) that systematically read many documents in one
      // turn. Falls back to the global config; ignores invalid values.
      const nodeMaxToolSteps = (
        node.config as { maxToolSteps?: number } | undefined
      )?.maxToolSteps;
      const effectiveMaxToolSteps =
        typeof nodeMaxToolSteps === "number" &&
        Number.isFinite(nodeMaxToolSteps) &&
        nodeMaxToolSteps > 0
          ? Math.floor(nodeMaxToolSteps)
          : runtime.appConfig.maxToolSteps;
      // One step beyond the tool budget is reserved for the answer. Stopping
      // exactly at `maxToolSteps` ended the loop right after the last tool
      // result (local-model traces 01636a1d / f679dbe6): the model never got a
      // turn to phrase the answer, `post_tool_answer_missing` fired and the
      // retry restarted without the gathered evidence. prepareStep below
      // turns the reserved step into a tool-free final-answer round.
      streamParams.stopWhen = stepCountIs(effectiveMaxToolSteps + 1);
      const liveActive = activeToolKeys;
      if (liveActive !== undefined) {
        streamParams.activeTools = [...liveActive];
      }
      // `config.requireToolUse: true` forces the model to call a tool on the
      // FIRST step (toolChoice "required" on step 0, "auto" thereafter).
      // Prompt-only "you MUST read a document" instructions are routinely
      // ignored by small local models: in trace fbf8500d the researcher
      // answered from the injected summaries WITHOUT ever opening an original
      // (findings unsupported by any tool call) and leaked its plan narration
      // into the visible answer. Forcing a tool call on step 0 makes that
      // impossible — the finding must be grounded in a real retrieval, and
      // any pre-tool narration is routed to the reasoning channel (the
      // preamble path only flushes to `content` when NO tool call fires).
      // Opt-in per node; default behaviour (auto tool choice) is unchanged.
      // Sanitize the messages replayed to the model on every tool-loop step.
      // The LM Studio reasoning shim rewrites native reasoning into `content`
      // with a NUL sentinel (see REASONING_SENTINEL); the AI SDK accumulates
      // it into the assistant messages it feeds back on the next step. Left
      // intact the model is re-served its own NUL-byte chain-of-thought each
      // step — the driver of the degenerate repetition / empty-response loop
      // seen with local thinking models. Stripping it here keeps the replayed
      // history clean while preserving tool-call structure. Always installed
      // when tools are bound (merged with the semantic-tool activeTools set).
      streamParams.prepareStep = ({ messages, stepNumber, steps }) => {
        // Per-execution budget before EVERY model step of the tool loop, not
        // only before the attempt: the finished steps of this call are not
        // yet counted, so their usage is passed as pending.
        if (runtime.executionBudget !== undefined) {
          const pending = (Array.isArray(steps) ? steps : []).reduce(
            (sum: number, step: { usage?: { inputTokens?: number; outputTokens?: number } }) =>
              sum + (step.usage?.inputTokens ?? 0) + (step.usage?.outputTokens ?? 0),
            0,
          );
          runtime.executionBudget.check("tokens", pending);
          runtime.executionBudget.check("wallMs");
        }
        // First step: stepNumber 0 (or, defensively, an empty prior-steps
        // array on SDK versions that omit stepNumber).
        const firstStep =
          stepNumber === 0 || (Array.isArray(steps) && steps.length === 0);
        const reasoningSanitized =
          sanitizeReasoningSentinelModelMessages(messages);
        // Effective post-DLP arguments are exposed exactly once: to the
        // immediate step following their tool execution. Older calls are
        // blanked on subsequent steps and never reach durable history.
        const currentEffectiveArgs = new Map(effectiveToolArgsByCallId);
        effectiveToolArgsByCallId.clear();
        const argumentSanitized = sanitizeToolCallModelMessages(
          reasoningSanitized,
          currentEffectiveArgs,
        );
        const sanitized = sanitizeToolResultModelMessages(argumentSanitized);
        // Bound the tool output replayed on EVERY step. This is the highest-
        // leverage application point in the whole loop: without it, a large
        // result produced on step 2 is re-sent verbatim on steps 3…N (up to
        // `maxToolSteps`), so its cost is multiplied by the remaining step
        // count. Capping is deterministic, so a given result yields identical
        // bytes on each replay and the prompt prefix stays cacheable.
        const budgeted = applyToolResultBudget(sanitized, toolResultBudget);
        if (
          budgeted.stats.cappedByResult > 0 ||
          budgeted.stats.demotedByTurn > 0
        ) {
          runtime.metrics.recordCounter(
            "aiperator_tool_result_budget_total",
            { node: node.id, action: "capped" },
            budgeted.stats.cappedByResult,
          );
          runtime.metrics.recordCounter(
            "aiperator_tool_result_budget_total",
            { node: node.id, action: "demoted" },
            budgeted.stats.demotedByTurn,
          );
          runtime.metrics.recordCounter(
            "aiperator_tool_result_chars_saved_total",
            { node: node.id },
            budgeted.stats.charsSaved,
          );
        }
        let stepMessages = budgeted.messages;
        if (imageInspectionEnabled && runtime.imageRefs !== undefined) {
          const offloaded = offloadInlineImages(
            stepMessages,
            runtime.imageRefs,
            imageInspectionToolName,
          );
          if (offloaded.unresolved > 0) {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "error",
              code: "image_inspection_remote_image_unavailable",
              message:
                "A tool result contains a remote or undecodable image that cannot be safely offloaded.",
              details: { unresolved: offloaded.unresolved },
            });
            throw new Error("IMAGE_INSPECTION_REMOTE_IMAGE_UNAVAILABLE");
          }
          if (offloaded.offloaded > 0) {
            stepMessages = offloaded.messages;
            runtime.metrics.recordCounter(
              "aiperator_image_offload_total",
              { node: node.id },
              offloaded.offloaded,
            );
            runtime.metrics.recordCounter(
              "aiperator_image_offload_bytes_total",
              { node: node.id },
              offloaded.bytesRemoved,
            );
          }
        }
        if (modelMessagesContainImages(stepMessages) && !visionInput) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "error",
            code: "vision_not_supported",
            message: `Tool output contains an image, but ${candidate.provider}/${candidate.model} does not declare vision input support.`,
            details: { provider: candidate.provider, model: candidate.model },
          });
          throw new Error("VISION_INPUT_NOT_SUPPORTED");
        }
        // Final-answer round on the reserved step past the tool budget (see
        // stopWhen above). No tool can be called, and an explicit instruction
        // asks for the answer from the results gathered so far. How tools
        // are kept out depends on the provider (`answerOnlyMode`): OpenAI-
        // family requests drop the definitions (`toolChoice: "none"` alone
        // still sends the tool list with @ai-sdk/openai and local models
        // keep "calling" them as plain text), Google keeps them declared
        // with mode NONE, and all others get the tool history as text.
        const toolBudgetExhausted =
          !st.finalAnswerOnly &&
          typeof stepNumber === "number" &&
          stepNumber >= effectiveMaxToolSteps;
        if (toolBudgetExhausted) {
          stepMessages = [
            ...stepMessages,
            {
              role: "user",
              content:
                "The tool budget for this turn is exhausted. Answer the " +
                "user now using only the tool results above; cite sources " +
                "as instructed and name any evidence gaps. Do not call or " +
                "describe further tool calls.",
            },
          ];
          if (stepNumber === effectiveMaxToolSteps) {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "info",
              code: "tool_budget_final_answer_round",
              message:
                "Tool-step budget exhausted; running a final answer round " +
                "without tools.",
              details: {
                max_tool_steps: effectiveMaxToolSteps,
                attempt: currentAttempt,
              },
            });
          }
        }
        const answerOnlyStep = st.finalAnswerOnly || toolBudgetExhausted;
        if (answerOnlyStep && answerOnlyMode === "text") {
          // Runs after sanitization, DLP-effective arguments and the
          // tool-result budget above, so the text carries exactly what the
          // structured blocks would have carried.
          stepMessages = toolHistoryAsText(stepMessages);
        }
        const effectiveStepMaxTokens = clampMaxOutputTokens(
          stepMessages,
          candidate,
          maxTokens,
        );
        return {
          messages: stepMessages,
          ...(effectiveStepMaxTokens !== undefined
            ? { maxOutputTokens: effectiveStepMaxTokens }
            : {}),
          ...(answerOnlyStep
            ? answerOnlyMode === "declare-none"
              ? {
                  ...(liveActive !== undefined
                    ? { activeTools: [...liveActive] }
                    : {}),
                  toolChoice: "none" as const,
                }
              : { activeTools: [], toolChoice: "none" as const }
            : {
                ...(liveActive !== undefined
                  ? { activeTools: [...liveActive] }
                  : {}),
                ...(requireToolUse && firstStep
                  ? { toolChoice: "required" as const }
                  : {}),
              }),
        };
      };
      if (clientToolKeys.size > 0) {
        const tc = mapToolChoice(runtime.ctx.clientToolChoice);
        if (tc !== undefined) streamParams.toolChoice = tc;
      }
    }

    const providerOpts = candidate.parameters?.providerOptions;
    if (
      providerOpts !== undefined &&
      typeof providerOpts === "object" &&
      providerOpts !== null
    ) {
      streamParams.providerOptions = providerOpts as unknown as NonNullable<
        (typeof streamParams)["providerOptions"]
      >;
    }

    if (isFallback) {
      runtime.metrics.recordLlmFallback(candidate.provider, candidate.model);
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "fallback",
        message: `Falling back to ${candidate.provider}/${candidate.model} after the primary model failed.`,
        details: { provider: candidate.provider, model: candidate.model },
      });
    }
    // Span/debug model attribution must follow the candidate actually used,
    // not remain pinned to the primary configuration after fallback.
    runtime.setGenAiAttributes?.(node.id, {
      provider: candidate.provider,
      model: candidate.model,
      operation: "chat",
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
    });

    st.retryGuidance = undefined;
    // Tool calls/results of an interrupted tool loop (sanitized, budgeted),
    // replayed after the original prefix so an answer-only retry continues
    // from the gathered evidence instead of restarting with a truncated
    // result excerpt. Model-facing only: the successful attempt persists its
    // final-step response messages exactly as an uninterrupted loop does.
    st.retryContinuation = undefined;
    const omittedHistoricalAssistantIndexes = new Set<number>();
    const messagesForAttempt = (): ModelMessage[] => {
      const retryBaseMessages =
        omittedHistoricalAssistantIndexes.size === 0
          ? providerSafeMessages
          : providerSafeMessages.filter(
              (_message, index) =>
                !omittedHistoricalAssistantIndexes.has(index),
            );
      const attemptMessages =
        st.retryGuidance === undefined && st.retryContinuation === undefined
          ? retryBaseMessages
          : [
              ...retryBaseMessages,
              ...(st.retryContinuation ?? []),
              ...(st.retryGuidance !== undefined ? [st.retryGuidance] : []),
            ];
      return runtime.appConfig.anthropicPromptCacheEnabled !== false
        ? cacheMode === "anthropic"
          ? applyAnthropicPromptCache(attemptMessages)
          : cacheMode === "bedrock"
            ? applyBedrockPromptCache(attemptMessages)
            : attemptMessages
        : attemptMessages;
    };

    for (let attempt = 1; attempt <= maxAttemptsEffective; attempt++) {
      providerAttemptCount += 1;
      currentAttempt = attempt;
      // Every retry starts from the identical original prefix, optionally
      // followed by the recorded tool exchange of an interrupted loop, plus
      // at most one replacement guidance message. Invalid model output is
      // never appended cumulatively, preserving provider prompt-cache reuse.
      streamParams.messages = messagesForAttempt();
      if (st.finalAnswerOnly && streamParams.tools !== undefined) {
        // Answer-only continuation: one step, no tool calls (prepareStep
        // applies the provider-specific `answerOnlyMode` for that step).
        streamParams.stopWhen = stepCountIs(1);
        if (answerOnlyMode !== "declare-none") streamParams.activeTools = [];
      }
      const attemptStartedAt = Date.now();
      // Hard cap against the output-token clamp: deterministically shrink the
      // assembled prompt so it fits the usable input budget, BEFORE clamping
      // the output allowance. Without this a prompt larger than the window
      // floors maxOutputTokens at 1 (clampMaxOutputTokens), and the model can
      // emit no final-answer marker / verifier pass signal — the run ends with
      // no result despite valid findings. Truncating the input instead keeps
      // the output allowance intact and is recorded in the trace below.
      // After a context-length rejection the window is scaled down so the
      // retry truncates the prompt to the smaller budget. An unknown window
      // stays unknown (truncation is a no-op there, as before).
      const windowBeforeScale = resolveContextWindow(candidate);
      const truncationCandidate =
        contextBudgetScale === 1 || windowBeforeScale === undefined
          ? candidate
          : {
              ...candidate,
              parameters: {
                ...candidate.parameters,
                contextLength: Math.floor(windowBeforeScale * CONTEXT_RETRY_FACTOR),
              },
            };
      const truncation = truncateMessagesToWindow(
        streamParams.messages ?? [],
        truncationCandidate,
        maxTokens,
      );
      if (truncation.truncated) {
        streamParams.messages = truncation.messages;
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "context_truncated",
          message:
            "Deterministically shortened the prompt to fit the model context " +
            "window and preserve the configured output-token allowance.",
          details: {
            attempt,
            model: `${candidate.provider}/${candidate.model}`,
            context_length: resolveContextWindow(candidate),
            configured_max_output_tokens: maxTokens,
            removed_chars: truncation.removedChars,
            truncated_messages: truncation.truncatedMessages,
            estimated_prompt_tokens_before: truncation.estimatedTokensBefore,
            estimated_prompt_tokens_after: truncation.estimatedTokensAfter,
          },
        });
      }
      const attemptMessages = streamParams.messages ?? [];
      const effectiveAttemptMaxTokens = clampMaxOutputTokens(
        attemptMessages,
        candidate,
        maxTokens,
      );
      if (effectiveAttemptMaxTokens !== undefined) {
        streamParams.maxOutputTokens = effectiveAttemptMaxTokens;
      }
      const estimatedAttemptTokens = estimateMessagesTokens(attemptMessages);
      if (
        maxTokens !== undefined &&
        effectiveAttemptMaxTokens !== undefined &&
        effectiveAttemptMaxTokens < maxTokens
      ) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "info",
          code: "max_output_tokens_clamped",
          message:
            "Reduced the output-token allowance to keep the request within " +
            "the model context window.",
          details: {
            attempt,
            model: `${candidate.provider}/${candidate.model}`,
            configured_max_output_tokens: maxTokens,
            effective_max_output_tokens: effectiveAttemptMaxTokens,
            estimated_prompt_tokens: estimatedAttemptTokens,
            context_length: resolveContextWindow(candidate),
          },
        });
      }
      const attemptPromptChars = attemptMessages.reduce(
        (total, message) =>
          total +
          (typeof message.content === "string"
            ? message.content.length
            : JSON.stringify(message.content).length),
        0,
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "llm_provider_attempt_started",
        message: `Starting LLM provider attempt ${attempt}/${maxAttempts} on ${candidate.provider}/${candidate.model}.`,
        details: {
          phase: "provider-call",
          candidate_index: c,
          candidate_count: candidates.length,
          attempt,
          max_attempts: maxAttempts,
          provider: candidate.provider,
          model: candidate.model,
          fallback: isFallback,
          message_count: attemptMessages.length,
          prompt_chars: attemptPromptChars,
          estimated_prompt_tokens: estimatedAttemptTokens,
        },
      });
      const toolStartTimes = new Map<string, number>();
      const toolRefByKey = new Map(
        Object.entries(toolKeyByRef).map(([ref, key]) => [key, ref]),
      );
      const toolRefByCallId = new Map<string, string>();
      const successfulToolRefs: string[] = [];
      const isSuccessfulToolResult = (output: unknown): boolean => {
        if (output === null || output === undefined) return false;
        if (typeof output === "string") return output.trim().length > 0;
        if (Array.isArray(output)) return output.length > 0;
        if (typeof output === "object") {
          const result = output as Record<string, unknown>;
          return result.isError !== true && Object.keys(result).length > 0;
        }
        return true;
      };
      st.fullText = "";
      // Always retains the raw contract content for diagnostics, repetition
      // detection and strict-mode validation. In live mode a separate rolling
      // buffer releases answer text only after the start marker is complete.
      st.finalAnswerBuffer = "";
      // Streaming a contract answer before its end marker is unsafe: SSE
      // output cannot be retracted if the closing validation rejects it.
      // Keep this false until the protocol supports a reversible client
      // transaction; validated content is emitted at stream completion.
      const streamFinalAnswer = false;
      let finalAnswerStreamState: FinalAnswerStreamState = "seeking-start";
      const currentFinalAnswerStreamState = (): FinalAnswerStreamState =>
        finalAnswerStreamState;
      let finalAnswerPending = "";
      let liveAnswerStarted = false;
      st.reasoningText = "";
      st.emittedAny = false;
      // Set when the visible answer was synthesized by the engine rather than
      // streamed by the model (reasoning-salvage or the empty-response
      // fallback). In that case the model's own response messages are empty
      // or missing, so the success path must return `fullText` explicitly
      // instead of the (empty) provider response messages.
      st.forcedAnswer = false;
      // Distinguishes graceful empty-completion degradation from a real
      // model answer. Agent-harness aggregation must not treat this marker as
      // a factual research finding for a downstream synthesizer.
      st.emptyResponseFallbackUsed = false;
      // Tracks whether requireToolUse was active but the model produced text
      // without calling any tool (i.e. ignored the forced toolChoice). Detected
      // post-stream and triggers a retry with a nudge, analogous to the
      // reasoning-only retry path.
      st.textWithoutToolCall = false;
      const attemptUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        /**
         * Accumulated prompt-cache reads across this attempt's steps. Stays
         * `undefined` while NO step reported cache data, so "provider has no
         * cache" and "cache-capable provider, zero hits" stay
         * distinguishable — the second case is the prompt-stability
         * regression signal and must not be hidden behind a default 0.
         */
        cachedPromptTokens: undefined as number | undefined,
      };
      let attemptAccounted = false;
      const accountAttempt = (outcome: "ok" | "error"): void => {
        if (attemptAccounted) return;
        attemptAccounted = true;

        const attemptMessages = streamParams.messages ?? [];
        if (!(attemptUsage.totalTokens > 0)) {
          const promptText = attemptMessages
            .map((m) =>
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
            )
            .join("\n");
          const estimatedPrompt = estimateTokensFromText(promptText);
          const estimatedCompletion = estimateTokensFromText(
            st.fullText + st.reasoningText,
          );
          attemptUsage.promptTokens = estimatedPrompt;
          attemptUsage.completionTokens = estimatedCompletion;
          attemptUsage.totalTokens = estimatedPrompt + estimatedCompletion;
        }

        runtime.onNodeDiagnostic?.(node.id, {
          level: outcome === "ok" ? "info" : "warn",
          code: "llm_provider_attempt_completed",
          message:
            `LLM provider attempt ${attempt}/${maxAttempts} on ` +
            `${candidate.provider}/${candidate.model} completed with ${outcome}.`,
          details: {
            phase: "provider-call",
            candidate_index: c,
            candidate_count: candidates.length,
            attempt,
            max_attempts: maxAttempts,
            provider: candidate.provider,
            model: candidate.model,
            fallback: isFallback,
            outcome,
            latency_ms: Date.now() - attemptStartedAt,
            message_count: attemptMessages.length,
            prompt_chars: attemptPromptChars,
            input_tokens: attemptUsage.promptTokens,
            output_tokens: attemptUsage.completionTokens,
            ...(attemptUsage.cachedPromptTokens !== undefined
              ? { cached_input_tokens: attemptUsage.cachedPromptTokens }
              : {}),
          },
        });

        runtime.usage.promptTokens += attemptUsage.promptTokens;
        runtime.usage.completionTokens += attemptUsage.completionTokens;
        runtime.usage.totalTokens += attemptUsage.totalTokens;
        runtime.executionBudget?.addTokens(
          attemptUsage.promptTokens + attemptUsage.completionTokens,
        );
        if (attemptUsage.cachedPromptTokens !== undefined) {
          runtime.usage.cachedPromptTokens =
            (runtime.usage.cachedPromptTokens ?? 0) +
            attemptUsage.cachedPromptTokens;
        }
        runtime.setGenAiAttributes?.(node.id, undefined, {
          inputTokens: attemptUsage.promptTokens,
          outputTokens: attemptUsage.completionTokens,
          ...(attemptUsage.cachedPromptTokens !== undefined
            ? { cachedInputTokens: attemptUsage.cachedPromptTokens }
            : {}),
        });

        const attemptCost = estimateCost(
          candidate.provider,
          candidate.model,
          {
            prompt_tokens: attemptUsage.promptTokens,
            completion_tokens: attemptUsage.completionTokens,
          },
          runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
        );
        runtime.metrics.recordLlmCall(
          candidate.provider,
          candidate.model,
          outcome,
          attemptUsage.promptTokens,
          attemptUsage.completionTokens,
          attemptCost,
          attemptUsage.cachedPromptTokens,
        );
        if (attemptCost > 0) {
          runtime.usage.costUsd = (runtime.usage.costUsd ?? 0) + attemptCost;
          runtime.costTracker?.record(runtime.ctx.clientId, attemptCost, {
            provider: candidate.provider,
            model: candidate.model,
            promptTokens: attemptUsage.promptTokens,
            completionTokens: attemptUsage.completionTokens,
            ...buildCostAttribution(runtime.ctx, runtime.flowId),
          });
        }
      };
      st.thinkBuf = "";
      st.inThink = false;
      st.toolPhaseStarted = false;
      // Per-step lookahead for the non-suppressed live path after the tool
      // phase began. Re-armed after every tool result/error; holds the next
      // step's text only while it may still become a text-template tool
      // call (`looksLikeTextToolCallPrefix`), then streams it live. Without
      // it a tool call written as text in a later step — e.g. the reserved
      // final-answer round — reached `content` before the stream-end guard
      // could reject it. `undefined` = disarmed.
      st.stepLookahead = undefined;
      // A tool call itself is not a user-facing completion. Remember the
      // visible-text boundary at the latest result so an empty post-tool
      // model step cannot silently complete the node with a stale preamble.
      st.visibleTextLengthAtLastToolResult = undefined;
      st.lastToolResultForRetry = undefined;
      st.preambleBuf = "";
      // Bounded lookahead for the preamble: text before a tool call is
      // ambiguous (narration vs. the direct answer), so we hold it back
      // from `content` only briefly — up to PREAMBLE_MAX_MS after the
      // first preamble delta, or PREAMBLE_MAX_CHARS, or a sentence
      // boundary, whichever comes first. If a tool call hasn't fired by
      // then, we resolve it as the real answer and stream everything from
      // that point on live, instead of withholding the whole response
      // until the stream ends (which made direct answers on tool-enabled
      // nodes appear to never stream).
      st.preambleResolved = false;
      st.preambleStartedAt = 0;
      // Tool-capable end nodes can opt into buffering possible narration
      // until it is known whether a tool call follows. If one does, the
      // narration is discarded; if no tool is called, the buffered text is
      // emitted as the direct answer at stream completion. This prevents
      // internal action/research plans from becoming visible client content.
      // With suppression the buffer stays armed for the WHOLE multi-step
      // tool loop, not just before the first tool call: local models also
      // emit first-person planning sentences between tool steps (after a
      // tool result, before the next call), and those leaked into the
      // user-visible answer when only the pre-first-call window was
      // buffered. Each tool-call/result/error discards the current buffer
      // and re-arms it for the next step; whatever remains when the stream
      // ends is the real answer and is released below.
      const suppressToolPreamble =
        (node.config as { suppressToolPreamble?: boolean } | undefined)
          ?.suppressToolPreamble === true;
      // Opt-in post-answer sources check (default off; see
      // answer-sources-check.ts). Markers removed from this attempt's
      // released answer are reported in the `answer_sources_check`
      // diagnostic.
      const sourcesCheck = parseSourcesCheckConfig(
        (node.config as { sourcesCheck?: unknown } | undefined)?.sourcesCheck,
      );
      const removedRuleMarkers: string[] = [];
      // Tool-call metadata is emitted immediately by onToolCall. Nodes whose
      // workers are private can suppress the later result detail block while
      // retaining monitoring, duration, cost and error accounting.
      const streamToolResultDetails =
        (node.config as { streamToolResultDetails?: boolean } | undefined)
          ?.streamToolResultDetails !== false;
      // Repetition guard (per attempt): abort the upstream generation and
      // truncate output when the model falls into a degenerate loop. Without
      // this, a stuck local model can emit tens of thousands of duplicate
      // tokens (burning tokens/time and — via the harness carryForward —
      // exploding the shared context until the next node overflows its
      // context window).
      st.loopAborted = false;
      st.outputAborted = false;
      st.repScanAt = 0;
      const repAbort = new AbortController();

      const flushThinkBuf = async (): Promise<void> => {
        if (st.thinkBuf.length === 0) return;
        if (st.inThink) {
          st.reasoningText += st.thinkBuf;
          try {
            await runtime.onReasoning(node.id, st.thinkBuf);
          } catch {
            /* disconnect */
          }
        } else {
          st.fullText += st.thinkBuf;
          st.emittedAny = true;
          try {
            await runtime.onToken(node.id, st.thinkBuf);
          } catch {
            /* disconnect */
          }
        }
        st.thinkBuf = "";
      };

      const routeDelta = async (delta: string): Promise<void> => {
        if (delta.startsWith("\x00r")) {
          const reasoning = delta.slice(2);
          if (reasoning.length > 0) {
            // Accumulate native reasoning-channel deltas as well, so the
            // reasoning-only salvage (see the `!emittedAny` block below) can
            // recover an answer regardless of whether the model channelled
            // its thinking through inline <think> tags or the provider's
            // dedicated reasoning stream.
            st.reasoningText += reasoning;
            try {
              await runtime.onReasoning(node.id, reasoning);
            } catch {
              /* disconnect */
            }
          }
          return;
        }
        st.thinkBuf += delta;
        while (true) {
          if (!st.inThink) {
            const openIdx = st.thinkBuf.indexOf("<think>");
            if (openIdx === -1) {
              const ltIdx = st.thinkBuf.lastIndexOf("<");
              const safeLen = ltIdx !== -1 ? ltIdx : st.thinkBuf.length;
              if (safeLen > 0) {
                const safe = st.thinkBuf.slice(0, safeLen);
                st.fullText += safe;
                st.emittedAny = true;
                try {
                  await runtime.onToken(node.id, safe);
                } catch {
                  /* disconnect */
                }
                st.thinkBuf = st.thinkBuf.slice(safeLen);
              }
              break;
            }
            if (openIdx > 0) {
              const before = st.thinkBuf.slice(0, openIdx);
              st.fullText += before;
              st.emittedAny = true;
              try {
                await runtime.onToken(node.id, before);
              } catch {
                /* disconnect */
              }
            }
            st.inThink = true;
            st.thinkBuf = st.thinkBuf.slice(openIdx + 7);
          } else {
            const closeIdx = st.thinkBuf.indexOf("</think>");
            if (closeIdx === -1) {
              const ltIdx = st.thinkBuf.lastIndexOf("<");
              const safeLen = ltIdx !== -1 ? ltIdx : st.thinkBuf.length;
              if (safeLen > 0) {
                const safe = st.thinkBuf.slice(0, safeLen);
                st.reasoningText += safe;
                try {
                  await runtime.onReasoning(node.id, safe);
                } catch {
                  /* disconnect */
                }
                st.thinkBuf = st.thinkBuf.slice(safeLen);
              }
              break;
            }
            if (closeIdx > 0) {
              const thinking = st.thinkBuf.slice(0, closeIdx);
              st.reasoningText += thinking;
              try {
                await runtime.onReasoning(node.id, thinking);
              } catch {
                /* disconnect */
              }
            }
            st.inThink = false;
            st.thinkBuf = st.thinkBuf.slice(closeIdx + 8);
          }
        }
      };

      const emitLiveFinalChunk = async (
        text: string,
        finalChunk = false,
      ): Promise<void> => {
        let visible = text;
        if (!liveAnswerStarted) visible = visible.trimStart();
        if (finalChunk) visible = visible.trimEnd();
        if (visible.length === 0) return;
        st.fullText += visible;
        st.emittedAny = true;
        st.forcedAnswer = true;
        liveAnswerStarted = true;
        try {
          await runtime.onToken(node.id, visible);
        } catch {
          /* disconnect */
        }
      };

      const routeFinalAnswerDelta = async (delta: string): Promise<void> => {
        st.finalAnswerBuffer += delta;
        if (!streamFinalAnswer || finalAnswerContract === undefined) return;
        if (
          finalAnswerStreamState === "ended" ||
          finalAnswerStreamState === "interrupted"
        ) {
          return;
        }

        finalAnswerPending += delta;
        if (finalAnswerStreamState === "seeking-start") {
          const rawStart = st.finalAnswerBuffer.indexOf(
            finalAnswerContract.startMarker,
          );
          const rawEnd = st.finalAnswerBuffer.indexOf(
            finalAnswerContract.endMarker,
          );
          if (rawEnd !== -1 && (rawStart === -1 || rawEnd < rawStart)) {
            finalAnswerStreamState = "interrupted";
            finalAnswerPending = "";
            return;
          }

          const start = finalAnswerPending.indexOf(
            finalAnswerContract.startMarker,
          );
          if (start === -1) {
            const keep = Math.max(
              0,
              finalAnswerContract.startMarker.length - 1,
            );
            if (finalAnswerPending.length > keep) {
              finalAnswerPending = finalAnswerPending.slice(-keep);
            }
            return;
          }
          finalAnswerPending = finalAnswerPending.slice(
            start + finalAnswerContract.startMarker.length,
          );
          finalAnswerStreamState = "streaming";
          // The provider's response message contains the hidden preamble and
          // markers, so persistence must use the clean engine-owned text.
          st.forcedAnswer = true;
        }

        const duplicateStart = finalAnswerPending.indexOf(
          finalAnswerContract.startMarker,
        );
        const end = finalAnswerPending.indexOf(finalAnswerContract.endMarker);
        if (duplicateStart !== -1 && (end === -1 || duplicateStart < end)) {
          const candidate = finalAnswerPending.slice(0, duplicateStart);
          if (
            liveAnswerStarted ||
            hasFinalAnswerStreamingSubstance(candidate)
          ) {
            await emitLiveFinalChunk(candidate, true);
          }
          finalAnswerPending = "";
          finalAnswerStreamState = "interrupted";
          return;
        }
        if (end !== -1) {
          const candidate = finalAnswerPending.slice(0, end);
          if (
            liveAnswerStarted ||
            hasFinalAnswerStreamingSubstance(candidate)
          ) {
            await emitLiveFinalChunk(candidate, true);
          }
          finalAnswerPending = "";
          finalAnswerStreamState = "ended";
          return;
        }

        // Until the response contains a letter or digit, it could still be a
        // punctuation-only placeholder. Hold it back because live output
        // cannot be retracted once the complete contract rejects it.
        if (
          !liveAnswerStarted &&
          !hasFinalAnswerStreamingSubstance(finalAnswerPending)
        ) {
          return;
        }

        const lookbehind =
          Math.max(
            finalAnswerContract.startMarker.length,
            finalAnswerContract.endMarker.length,
          ) - 1;
        const safeLength = Math.max(
          0,
          finalAnswerPending.length - lookbehind,
        );
        if (safeLength === 0) return;

        let safe = finalAnswerPending.slice(0, safeLength);
        const remainder = finalAnswerPending.slice(safeLength);
        if (!liveAnswerStarted) safe = safe.trimStart();
        const trailingWhitespace = safe.match(/\s+$/)?.[0] ?? "";
        const visible = safe.slice(
          0,
          safe.length - trailingWhitespace.length,
        );
        finalAnswerPending = trailingWhitespace + remainder;
        await emitLiveFinalChunk(visible);
      };

      const flushIncompleteLiveAnswer = async (): Promise<void> => {
        if (
          !streamFinalAnswer ||
          finalAnswerContract === undefined ||
          finalAnswerStreamState !== "streaming"
        ) {
          return;
        }
        const protectedSuffix = longestMarkerPrefixSuffix(
          finalAnswerPending,
          [finalAnswerContract.startMarker, finalAnswerContract.endMarker],
        );
        const safe = finalAnswerPending.slice(
          0,
          finalAnswerPending.length - protectedSuffix,
        );
        finalAnswerPending = "";
        if (liveAnswerStarted || hasFinalAnswerStreamingSubstance(safe)) {
          await emitLiveFinalChunk(safe, true);
        }
      };

      const requestDeadline = AbortSignal.timeout(requestTimeoutMs);
      try {
        // Bind this attempt's abort signal so the repetition guard can stop
        // the server-side generation (not just ignore further tokens) — AND
        // the flow's execution deadline, so EXECUTION_TIMEOUT_MS actually
        // cancels the provider call.
        //
        // Assigning only `repAbort.signal` here (as this line used to) meant
        // the flow signal never reached the provider: the timeout aborted
        // `graph.stream()`, the engine released the concurrency slot and sent
        // `[DONE]`, while this stream kept running — emitting chunks after
        // `[DONE]` and adding tokens to an already-reported usage total. The
        // two signals must be COMBINED, not chosen between.
        streamParams.abortSignal = combineAbortSignals(
          runtime.signal,
          repAbort.signal,
          requestDeadline,
        );
        // Provider requests of this attempt (one per tool-loop step) report
        // their single connect-retry here. Stream pulls run in the consumer's
        // async context, so the scope wraps streamText AND runAttemptStream.
        const transportScope: LlmTransportScope = {
          requestCount: 0,
          onConnectRetry: (event) => {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "llm_step_connect_retry",
              message: `Provider ${event.provider}/${event.model}: connection failed before the step's response (${event.errorCode}); retrying once on a fresh connection.`,
              details: {
                provider: event.provider,
                model: event.model,
                attempt,
                request_index: event.requestIndex,
                error_code: event.errorCode,
                retry_delay_ms: event.retryDelayMs,
                keep_alive: event.keepAlive,
              },
            });
          },
          onConnectRetryFailed: (event) => {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "llm_step_connect_retry_failed",
              message: `Provider ${event.provider}/${event.model}: connect-retry of the step failed as well.`,
              details: {
                provider: event.provider,
                model: event.model,
                attempt,
                request_index: event.requestIndex,
                error_code: event.errorCode,
                retry_error_code: event.retryErrorCode ?? null,
              },
            });
          },
        };
        // Per-execution budget: checked before each attempt's model
        // call; a call already in flight is never aborted.
        runtime.executionBudget?.check("tokens");
        runtime.executionBudget?.check("wallMs");
        // Without `experimental_lowMemory` the full StreamTextResult is
        // returned; the union member ai@7.0.143 adds for the low-memory
        // variant cannot occur here (see LlmStreamResult).
        const result = runInLlmTransportScope(transportScope, () =>
          streamText(streamParams),
        ) as LlmStreamResult;
        // Records this attempt's tool exchange as the continuation of the
        // next (answer-only) attempt. The trailing text-only assistant turn
        // is the rejected output and is dropped. Returns false when the
        // provider response is unavailable or holds no tool exchange.
        const captureRetryContinuation = async (): Promise<boolean> => {
          // `responseMessages` accumulates every step of the call; with
          // ai@7 `result.response.messages` holds only the final step.
          let providerMessages: unknown;
          try {
            providerMessages = await result.responseMessages;
          } catch {
            return false;
          }
          if (!Array.isArray(providerMessages)) return false;
          const exchange = [...(providerMessages as ModelMessage[])];
          while (exchange.length > 0) {
            const last = exchange[exchange.length - 1];
            if (last === undefined || last.role !== "assistant") break;
            const callsTool =
              Array.isArray(last.content) &&
              last.content.some(
                (part) => (part as { type?: string }).type === "tool-call",
              );
            if (callsTool) break;
            exchange.pop();
          }
          if (exchange.length === 0) return false;
          const modelFacing = applyToolResultBudget(
            sanitizeToolResultModelMessages(
              sanitizeToolCallModelMessages(
                sanitizeReasoningSentinelModelMessages(exchange),
              ),
            ),
            toolResultBudget,
          ).messages;
          st.retryContinuation = [...(st.retryContinuation ?? []), ...modelFacing];
          return true;
        };

        await runInLlmTransportScope(transportScope, () => runAttemptStream({
          attempt,
          attemptUsage,
          candidate,
          clientToolKeys,
          finalAnswerContract,
          flushThinkBuf,
          hasTools,
          isSuccessfulToolResult,
          maxOutputChars,
          node,
          repAbort,
          requireToolUse,
          result,
          routeDelta,
          routeFinalAnswerDelta,
          runtime,
          streamToolResultDetails,
          successfulToolRefs,
          suppressToolPreamble,
          toolRefByCallId,
          toolRefByKey,
          toolStartTimes,
          st,
        }));
        const post = await postprocessAttempt({
          accountAttempt,
          attempt,
          attemptUsage,
          backoffMs,
          c,
          cacheKeyInput,
          cacheable,
          candidate,
          candidates,
          captureRetryContinuation,
          currentFinalAnswerStreamState,
          exactCache,
          finalAnswerContract,
          flushIncompleteLiveAnswer,
          flushThinkBuf,
          hasTools,
          maxAttempts,
          node,
          omittedHistoricalAssistantIndexes,
          providerSafeMessages,
          removedRuleMarkers,
          reportStreamFallback,
          requireToolUse,
          requireToolUseMandatory,
          result,
          routeDelta,
          runtime,
          selectedBoundToolBestScore,
          selectedBoundToolKeys,
          semCache,
          semKeyInput,
          sourcesCheck,
          state,
          streamFallbackNodeConfig,
          streamFallbackPolicy,
          streamFinalAnswer,
          streamParams,
          successfulToolRefs,
          suppressToolPreamble,
          toolResultBudget,
          toolSequenceContract,
          st,
        });
        if (post.action === "return") return { done: true, value: post.value };
        if (post.action === "continue") continue;
      } catch (err) {
        // The execution budget is not a provider failure: no retry, no
        // fallback candidate — it ends the execution (engine: finishReason
        // `budget_exceeded`).
        const budgetError = executionBudgetErrorOf(err);
        if (budgetError !== undefined) throw budgetError;
        // A provider rejection for exceeding the context length is
        // deterministic — resending the same prompt fails identically. Give
        // it exactly one retry with a 25 % smaller context budget, which
        // re-runs the deterministic truncation above against the reduced
        // window. Skipped once anything reached the client (a second answer
        // must not be appended to partial output) and while the request or
        // flow is already aborted. A second rejection takes the normal
        // error path below.
        if (
          !contextRetryUsed &&
          !st.emittedAny &&
          runtime.signal?.aborted !== true &&
          !requestDeadline.aborted &&
          isContextLengthError(err)
        ) {
          contextRetryUsed = true;
          contextBudgetScale = CONTEXT_RETRY_FACTOR;
          accountAttempt("error");
          const windowBefore = windowBeforeScale;
          const windowAfter =
            windowBefore === undefined
              ? undefined
              : Math.floor(windowBefore * CONTEXT_RETRY_FACTOR);
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "context_length_retry",
            message:
              "The provider rejected the request for exceeding the context " +
              "length; retrying once with a smaller context budget.",
            details: {
              attempt,
              provider: candidate.provider,
              model: candidate.model,
              ...(windowBefore !== undefined
                ? { context_length_before: windowBefore }
                : {}),
              ...(windowAfter !== undefined
                ? { context_length_after: windowAfter }
                : {}),
            },
          });
          maxAttemptsEffective = Math.max(maxAttemptsEffective, attempt + 1);
          continue;
        }
        const handled = await handleAttemptError(
          {
            accountAttempt,
            attempt,
            backoffMs,
            c,
            candidate,
            candidates,
            maxAttempts,
            node,
            requestDeadline,
            requestTimeoutMs,
            runtime,
            st,
          },
          err,
        );
        if (handled.action === "return")
          return { done: true, value: handled.value };
        if (handled.action === "break") break;
        if (handled.action === "continue") continue;
      }
    }
  }
  return {
    done: false,
    lastErrMsg: st.lastErrMsg,
    providerAttemptCount,
    policySuppressedToolFallback: st.policySuppressedToolFallback,
    circuitSkippedProviders,
  };
}

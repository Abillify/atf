// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Post-stream processing and error handling of one LLM attempt (task 18.1).
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged.
 */
import { AIMessage } from "@langchain/core/messages";
import type { ModelMessage, streamText } from "ai";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import {
  describePromptSchemaIssues,
  describeProviderError,
  formatPromptSchemaIssue,
  providerTransportErrorCode,
} from "../provider-circuit-breaker.js";
import { isBudgetExceededError } from "../../transaction/budget.js";
import type { AgentState } from "../graph-engine.js";
import type {
  CacheKeyInput,
  ResponseCache,
  CachedResponse,
} from "../response-cache.js";
import type {
  SemanticCache,
  SemanticCacheKeyInput,
} from "../semantic-cache.js";
import {
  allowsEmptyResponseFallback,
  allowsInferredToolUseFallback,
  allowsReasoningSalvage,
  type LlmStreamFallbackNodeConfig,
  type LlmStreamFallbackPolicy,
} from "../../llm-stream-fallback-policy.js";
import { stripLeakedContextEcho } from "../../assistants/context-frame.js";
import {
  aiResponseMessagesToBaseMessages,
  stripReasoningSentinelMarkers,
} from "../message-mapping.js";
import { applyToolResultBudgetToHistory } from "../tool-result-budget.js";
import {
  completeSourcesSection,
  findRuleMarkers,
  stripRuleMarkers,
  type SourcesCheckConfig,
} from "../answer-sources-check.js";
import { detectTextToolCall } from "../text-tool-call.js";
import { findCopiedAssistantHistoryIndex } from "./llm-history-copy.js";
import {
  DEFAULT_EMPTY_RESPONSE_FALLBACK,
  extractFinalAnswer,
  type FinalAnswerContractConfig,
} from "./llm-final-answer.js";
import { fullJitter, sleep, type ExecRuntime } from "../exec-runtime.js";
import type { ToolSequenceContract } from "../tool-sequence-contract.js";
import {
  StreamErrorSignal,
  type FinalAnswerStreamState,
  type LlmAttemptState,
  type LlmAttemptUsage,
  type LlmStreamResult,
} from "./llm-stream-types.js";

/** Outcome of the post-stream processing of one attempt. `continue` retries
 * the attempt loop, `return` completes the node. */
export type PostAttemptResult =
  | { action: "continue" }
  | { action: "return"; value: Partial<AgentState> };

/** Outcome of the catch block of one attempt. */
export type AttemptErrorResult =
  | { action: "continue" }
  | { action: "break" }
  | { action: "return"; value: Partial<AgentState> };

interface PostprocessCtx {
  accountAttempt: (outcome: "ok" | "error") => void;
  attempt: number;
  attemptUsage: LlmAttemptUsage;
  backoffMs: number;
  c: number;
  cacheKeyInput: CacheKeyInput | undefined;
  cacheable: boolean | undefined;
  candidate: LlmConfig;
  candidates: LlmConfig[];
  captureRetryContinuation: () => Promise<boolean>;
  currentFinalAnswerStreamState: () => FinalAnswerStreamState;
  exactCache: ResponseCache | undefined;
  finalAnswerContract: FinalAnswerContractConfig | undefined;
  flushIncompleteLiveAnswer: () => Promise<void>;
  flushThinkBuf: () => Promise<void>;
  hasTools: boolean;
  maxAttempts: number;
  node: FlowNode;
  omittedHistoricalAssistantIndexes: Set<number>;
  providerSafeMessages: ModelMessage[];
  removedRuleMarkers: string[];
  reportStreamFallback: (
    reason:
      | "reasoning_salvage"
      | "empty_response_fallback"
      | "require_tool_use_released"
      | "require_tool_use_history_copy_fallback",
    details?: Record<string, unknown>,
  ) => void;
  requireToolUse: boolean;
  requireToolUseMandatory: boolean;
  result: LlmStreamResult;
  routeDelta: (delta: string) => Promise<void>;
  runtime: ExecRuntime;
  selectedBoundToolBestScore: number;
  selectedBoundToolKeys: string[];
  semCache: SemanticCache | undefined;
  semKeyInput: SemanticCacheKeyInput | undefined;
  sourcesCheck: SourcesCheckConfig | undefined;
  state: AgentState;
  streamFallbackNodeConfig: LlmStreamFallbackNodeConfig | undefined;
  streamFallbackPolicy: LlmStreamFallbackPolicy;
  streamFinalAnswer: boolean;
  streamParams: Parameters<typeof streamText>[0];
  successfulToolRefs: string[];
  suppressToolPreamble: boolean;
  toolResultBudget: { perResultChars: number; perTurnChars: number };
  toolSequenceContract: ToolSequenceContract | undefined;
  st: LlmAttemptState;
}

/** Runs after the provider stream of an attempt completed without throwing. */
export async function postprocessAttempt(
  ctx: PostprocessCtx,
): Promise<PostAttemptResult> {
  const {
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
  } = ctx;
  // Step text still held by the per-step lookahead is released unless
  // it is a text tool call, which stays withheld for the guard below.
  let heldStepText = st.stepLookahead ?? "";
  st.stepLookahead = undefined;
  if (
    heldStepText.length > 0 &&
    !(hasTools && detectTextToolCall(heldStepText).detected)
  ) {
    await routeDelta(heldStepText);
    heldStepText = "";
  }
  await flushThinkBuf();

  // Text tool-call guard. A tool call written as template text
  // (`<tool_call><function=…>` / Hermes JSON) is never an answer: the
  // local-model responder in trace 01636a1d "answered" with an
  // unexecuted inspect_image call. Reject it before any release or
  // success accounting, keep it in the reasoning trail only, and retry
  // as an answer-only continuation of this attempt's tool exchange.
  const textToolCall = hasTools
    ? detectTextToolCall(st.fullText + st.preambleBuf + heldStepText)
    : { detected: false as const };
  if (textToolCall.detected) {
    const rejectedChars =
      st.fullText.length + st.preambleBuf.length + heldStepText.length;
    // `preambleBuf` was already streamed live on the reasoning channel;
    // text in `fullText` already reached `content` (non-suppressed live
    // path, e.g. narration before an inline call) and cannot be
    // retracted. `heldStepText` never left the handler. None of it is
    // emitted again.
    st.reasoningText += st.fullText + st.preambleBuf + heldStepText;
    st.fullText = "";
    st.preambleBuf = "";
    st.emittedAny = false;
    st.forcedAnswer = true;
    if (attempt < maxAttempts) {
      // Answer-only continuation only once there is evidence to answer
      // from (a recorded tool exchange) or as the last chance before
      // the final attempt. A text call on the very first step usually
      // means the provider parser missed a real call; taking all tools
      // away then forced an answer without any tool evidence.
      // requireToolUse / toolSequence contracts are judged per attempt
      // and demand a real tool call, so an answer-only continuation
      // would always be rejected there.
      const continued =
        !requireToolUse && st.toolPhaseStarted
          ? await captureRetryContinuation()
          : false;
      const answerOnly =
        !requireToolUse && (continued || attempt === maxAttempts - 1);
      if (!answerOnly) {
        // Retry the loop with tools and ask for a native call instead.
        st.retryGuidance = {
          role: "user",
          content:
            "Your last reply was a tool call written as plain text, " +
            "which is never executed. Call the tool through the " +
            "native tool-calling interface, or answer the user " +
            "directly in prose.",
        };
      } else {
        st.retryGuidance = {
          role: "user",
          content:
            "Your last reply was a tool call written as plain text. " +
            "Tools are not available now. Answer the user directly " +
            "in prose.",
        };
        st.finalAnswerOnly = true;
        streamParams.toolChoice = "none" as const;
      }
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "text_tool_call_rejected",
        message:
          "Model wrote a tool call as plain text instead of an " +
          "answer; the output was suppressed and the attempt is " +
          `retried (attempt ${attempt}/${maxAttempts}).`,
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          format: textToolCall.format,
          chars: rejectedChars,
          final_answer_only: st.finalAnswerOnly,
          continuation_messages: st.retryContinuation?.length ?? 0,
        },
      });
      accountAttempt("error");
      runtime.metrics.recordLlmRetry(
        candidate.provider,
        candidate.model,
      );
      await sleep(fullJitter(backoffMs));
      return { action: "continue" };
    }
    runtime.onNodeDiagnostic?.(node.id, {
      level: "error",
      code: "text_tool_call_unrecoverable",
      message:
        "Model kept writing tool calls as plain text instead of an " +
        "answer on every attempt; the output was suppressed.",
      details: {
        attempt,
        model: `${candidate.provider}/${candidate.model}`,
        format: textToolCall.format,
        chars: rejectedChars,
      },
    });
    throw new StreamErrorSignal(
      "model emitted an unparsed text tool call instead of an answer",
    );
  }

  // A held-back preamble is normally released here as the direct answer.
  // Keep it held for every requireToolUse attempt, including the final
  // one: the post-stream guard must first determine whether the model
  // merely copied a historical assistant error. A legitimate inferred
  // text answer is emitted explicitly by the release branch below.
  const holdPreambleForToolUse = requireToolUse && !st.toolPhaseStarted;
  // With suppression the buffer also collects text emitted AFTER the
  // first tool call (per-step narration lookahead). Whatever is still
  // buffered when the stream ends follows the last tool result, so it
  // is the real answer and must be released here — this also keeps the
  // `post_tool_answer_missing` guard below from firing on a correct
  // answer that only ever lived in the buffer.
  if (
    st.preambleBuf.length > 0 &&
    !holdPreambleForToolUse &&
    (!st.toolPhaseStarted || suppressToolPreamble)
  ) {
    // Opt-in `sourcesCheck.stripRuleMarkers`: the held answer has not
    // reached the client yet, so the observed `[Regel: …]` pseudo
    // marker can still be removed before release.
    if (sourcesCheck?.stripRuleMarkers === true) {
      const stripped = stripRuleMarkers(st.preambleBuf);
      st.preambleBuf = stripped.text;
      removedRuleMarkers.push(...stripped.removed);
    }
    st.fullText += st.preambleBuf;
    st.emittedAny = true;
    try {
      await runtime.onToken(node.id, st.preambleBuf);
    } catch {
      /* disconnect */
    }
    st.preambleBuf = "";
  }

  let liveFinalAnswerAccepted = false;
  if (streamFinalAnswer && finalAnswerContract !== undefined) {
    await flushIncompleteLiveAnswer();
    liveFinalAnswerAccepted =
      currentFinalAnswerStreamState() === "ended" &&
      extractFinalAnswer(st.finalAnswerBuffer, finalAnswerContract).ok;
  }

  if (finalAnswerContract !== undefined && !liveFinalAnswerAccepted) {
    const extracted = extractFinalAnswer(
      st.finalAnswerBuffer,
      finalAnswerContract,
    );
    if (extracted.ok) {
      st.fullText = extracted.answer;
      st.emittedAny = true;
      // The provider response still contains the rejected planning
      // around the markers. Persist a clean engine-owned AIMessage.
      st.forcedAnswer = true;
      const SSE_CHUNK_SIZE = 60_000;
      try {
        for (
          let offset = 0;
          offset < st.fullText.length;
          offset += SSE_CHUNK_SIZE
        ) {
          await runtime.onToken(
            node.id,
            st.fullText.slice(offset, offset + SSE_CHUNK_SIZE),
          );
        }
      } catch {
        /* disconnect */
      }
    } else {
      // Tool/file events must not turn a rejected textual answer into a
      // successful provider-message persistence path.
      st.fullText = "";
      st.emittedAny = false;
      st.forcedAnswer = true;
      st.lastErrMsg = `final-answer contract rejected model output (${extracted.reason})`;
      runtime.onNodeDiagnostic?.(node.id, {
        level: attempt < maxAttempts ? "warn" : "error",
        code:
          attempt < maxAttempts
            ? "final_answer_contract_retry"
            : "final_answer_contract_rejected",
        message:
          "Model output did not satisfy the final-answer marker " +
          `contract (${extracted.reason}); raw content was suppressed.`,
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          raw_chars: st.finalAnswerBuffer.length,
          reason: extracted.reason,
        },
      });

      if (attempt < maxAttempts) {
        const rawExcerpt = st.finalAnswerBuffer.slice(-800);
        st.retryGuidance = {
          role: "user",
          content:
            "Your last output violated the mandatory " +
            "final-answer contract" +
            (rawExcerpt.length > 0
              ? ` (end of the discarded attempt: ${rawExcerpt})`
              : "") +
            ". Emit now exclusively a non-empty answer " +
            `between ${finalAnswerContract.startMarker} and ` +
            `${finalAnswerContract.endMarker}. Use each ` +
            "marker pair exactly once.",
        };
        accountAttempt("error");
        runtime.metrics.recordLlmRetry(
          candidate.provider,
          candidate.model,
        );
        await sleep(fullJitter(backoffMs));
        return { action: "continue" };
      }
    }
  }

  if (toolSequenceContract !== undefined) {
    let nextRequiredTool = 0;
    for (const toolRef of successfulToolRefs) {
      if (toolRef === toolSequenceContract.sequence[nextRequiredTool]) {
        nextRequiredTool += 1;
      }
    }
    const sequenceSatisfied =
      nextRequiredTool === toolSequenceContract.sequence.length;
    if (!sequenceSatisfied) {
      st.fullText = "";
      st.preambleBuf = "";
      st.emittedAny = false;
      st.forcedAnswer = true;
      const requiredTools = toolSequenceContract.sequence.join(" -> ");
      const completedTools = successfulToolRefs.join(", ") || "none";
      runtime.onNodeDiagnostic?.(node.id, {
        level: attempt < maxAttempts ? "warn" : "error",
        code: "tool_sequence_rejected",
        message:
          "Response rejected: required successful tool sequence was not completed.",
        details: {
          attempt,
          required_tools: toolSequenceContract.sequence,
          completed_tools: successfulToolRefs,
        },
      });
      if (attempt < maxAttempts) {
        st.retryGuidance = {
          role: "user",
          content:
            "The requested action is NOT confirmed yet. " +
            "Execute these tools in this exact order in this turn: " +
            `${requiredTools}. Report success only after all tools ` +
            "returned a non-empty, error-free result. " +
            `Successful tools so far: ${completedTools}.`,
        };
        accountAttempt("error");
        runtime.metrics.recordLlmRetry(
          candidate.provider,
          candidate.model,
        );
        await sleep(fullJitter(backoffMs));
        return { action: "continue" };
      }
      throw new StreamErrorSignal(
        `required successful tool sequence missing: ${requiredTools}`,
      );
    }
  }

  // requireToolUse violation: the model produced visible text on the
  // first step but never called a tool, despite toolChoice "required"
  // being set via prepareStep. Small local models (and some remote
  // ones) silently ignore toolChoice constraints and instead narrate
  // their plan or copy an earlier assistant error as plain text. A copied
  // historical answer is removed from subsequent model-facing retries
  // and is never released as if it were a fresh tool result.
  if (
    requireToolUse &&
    !st.toolPhaseStarted &&
    (st.emittedAny || st.preambleBuf.length > 0)
  ) {
    const textOnly = st.fullText + st.preambleBuf;
    const textOnlyChars = textOnly.length;
    const copiedHistoryIndex = findCopiedAssistantHistoryIndex(
      textOnly,
      providerSafeMessages,
    );
    const copiedHistoricalAnswer = copiedHistoryIndex !== undefined;
    const inferredToolUseFallbackAllowed =
      allowsInferredToolUseFallback(
        streamFallbackPolicy,
        streamFallbackNodeConfig,
      );
    if (copiedHistoryIndex !== undefined) {
      omittedHistoricalAssistantIndexes.add(copiedHistoryIndex);
    }

    const rejectOutput =
      attempt < maxAttempts ||
      requireToolUseMandatory ||
      copiedHistoricalAnswer ||
      !inferredToolUseFallbackAllowed;
    if (rejectOutput) {
      st.textWithoutToolCall = true;
      // Rejected retry attempts and mandatory failures are accounted as
      // errors here. A final engine-owned history-copy fallback falls
      // through to the normal success accounting below, exactly once.
      if (attempt < maxAttempts || requireToolUseMandatory) {
        accountAttempt("error");
      }
      st.fullText = "";
      st.preambleBuf = "";
      st.emittedAny = false;
      st.forcedAnswer = true;
    }

    if (attempt < maxAttempts) {
      const selectedToolHint =
        selectedBoundToolKeys.length > 0
          ? ` Use one of these active tools: ${selectedBoundToolKeys.join(", ")}.`
          : "";
      st.retryGuidance = {
        role: "user",
        content:
          "Your last attempt produced text but did NOT call a tool. " +
          "Earlier assistant errors are not current results and must " +
          "not be repeated." +
          selectedToolHint +
          " Call the appropriate tool right now — with no further text.",
      };
      streamParams.toolChoice = "required" as const;
      runtime.metrics.recordLlmRetry(
        candidate.provider,
        candidate.model,
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "require_tool_use_retry",
        message:
          "requireToolUse: model produced text without a tool call " +
          `on step 0; retrying with nudge (attempt ${attempt}/${maxAttempts}).`,
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          text_chars: textOnlyChars,
          copied_historical_answer: copiedHistoricalAnswer,
          omitted_history_messages:
            omittedHistoricalAssistantIndexes.size,
          selected_tool_keys: selectedBoundToolKeys,
        },
      });
      await sleep(fullJitter(backoffMs));
      return { action: "continue" };
    }

    if (requireToolUseMandatory) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "require_tool_use_exhausted",
        message:
          "requireToolUse remained unsatisfied after all attempts; " +
          "the text-only output was rejected.",
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          text_chars: textOnlyChars,
        },
      });
      throw new StreamErrorSignal(
        "requireToolUse exhausted: model never produced a tool call",
      );
    }

    if (!inferredToolUseFallbackAllowed) {
      st.policySuppressedToolFallback = true;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "require_tool_use_fallback_suppressed",
        message:
          "Inferred requireToolUse remained unsatisfied and the active " +
          "stream fallback policy forbids releasing replacement text.",
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          policy: streamFallbackPolicy,
          copied_historical_answer: copiedHistoricalAnswer,
        },
      });
      throw new StreamErrorSignal(
        "inferred requireToolUse exhausted: semantic fallback disabled",
      );
    }

    if (copiedHistoricalAnswer) {
      st.fullText =
        "I could not re-query the live status because no tool call was " +
        "executed. The previously reported error is therefore not a " +
        "new result.";
      st.emittedAny = true;
      st.forcedAnswer = true;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "require_tool_use_history_copy_rejected",
        message:
          "The model repeated a historical assistant answer instead " +
          "of calling the selected tool; emitted an engine-owned " +
          "no-live-result fallback.",
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          text_chars: textOnlyChars,
          selection_best_score: Number.isFinite(
            selectedBoundToolBestScore,
          )
            ? selectedBoundToolBestScore
            : null,
        },
      });
      runtime.metrics.recordCounter(
        "aiperator_require_tool_use_total",
        { node: node.id, outcome: "history_copy_rejected" },
      );
      reportStreamFallback("require_tool_use_history_copy_fallback", {
        copied_historical_answer: true,
      });
      try {
        await runtime.onToken(node.id, st.fullText);
      } catch {
        /* disconnect */
      }
    } else {
      // The requirement was inferred from semantic selection, not an
      // authored contract. Preserve the existing fail-open behaviour for
      // an independent text answer, but emit its held preamble only now.
      if (st.preambleBuf.length > 0) {
        st.fullText += st.preambleBuf;
        st.emittedAny = true;
        try {
          await runtime.onToken(node.id, st.preambleBuf);
        } catch {
          /* disconnect */
        }
        st.preambleBuf = "";
      }
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "require_tool_use_released",
        message:
          "Tool use was required only because semantic selection found a " +
          "relevant tool; the model produced independent text instead " +
          "on every attempt. Releasing the answer rather than failing " +
          "the turn.",
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          text_chars: textOnlyChars,
          selection_best_score: Number.isFinite(
            selectedBoundToolBestScore,
          )
            ? selectedBoundToolBestScore
            : null,
        },
      });
      runtime.metrics.recordCounter(
        "aiperator_require_tool_use_total",
        { node: node.id, outcome: "released" },
      );
      reportStreamFallback("require_tool_use_released");
    }
  }

  // A tool event is progress, not a final response. Some local models
  // terminate immediately after an otherwise successful tool result;
  // without this guard the earlier preamble marks `emittedAny` and the
  // node is falsely persisted as complete. Retry once per attempt with
  // the bounded result injected as context and disable tools, which
  // prevents a duplicate consequential tool call during synthesis.
  const missingPostToolAnswer =
    st.visibleTextLengthAtLastToolResult !== undefined &&
    st.fullText.slice(st.visibleTextLengthAtLastToolResult).trim().length ===
      0;
  if (missingPostToolAnswer) {
    const retryPostToolAnswer =
      attempt < maxAttempts && !requireToolUse;
    // Continue from this attempt's complete tool exchange (all calls
    // and results) rather than restarting from the original prefix
    // with an excerpt of only the last result.
    const continued = retryPostToolAnswer
      ? await captureRetryContinuation()
      : false;
    st.fullText = "";
    st.preambleBuf = "";
    st.emittedAny = false;
    st.forcedAnswer = true;
    runtime.onNodeDiagnostic?.(node.id, {
      level: attempt < maxAttempts ? "warn" : "error",
      code: "post_tool_answer_missing",
      message:
        "Tool result was received but the model produced no visible " +
        "answer afterwards.",
      details: {
        attempt,
        model: `${candidate.provider}/${candidate.model}`,
        continuation_messages: continued
          ? (st.retryContinuation?.length ?? 0)
          : 0,
      },
    });
    if (retryPostToolAnswer) {
      if (continued) {
        st.retryGuidance = {
          role: "user",
          content:
            "You received the tool results above but produced no " +
            "visible answer. Answer the user now from these " +
            "results. Do not call another tool.",
        };
      } else {
        // Fallback when the provider response is unavailable: inject
        // a bounded excerpt of the last result as before. The retry is
        // answer-only as well (see `finalAnswerOnly` below).
        const serializedResult = (() => {
          try {
            const text = JSON.stringify(st.lastToolResultForRetry);
            return text.length > 6_000
              ? `${text.slice(0, 6_000)}…`
              : text;
          } catch {
            return "[Tool result could not be serialized]";
          }
        })();
        st.retryGuidance = {
          role: "user",
          content:
            "You received a tool result but did not phrase a visible " +
            "answer for the user. Produce a short, correct answer from " +
            "this result now. Do not call another tool. " +
            "Tool result: " +
            serializedResult,
        };
      }
      // Both variants run without tools: `toolChoice: "none"` alone
      // still sends the tool list with @ai-sdk/openai, which is how
      // the original text tool call arose (trace 01636a1d).
      st.finalAnswerOnly = true;
      streamParams.toolChoice = "none" as const;
      accountAttempt("error");
      runtime.metrics.recordLlmRetry(
        candidate.provider,
        candidate.model,
      );
      await sleep(fullJitter(backoffMs));
      return { action: "continue" };
    }
  }

  if (!st.emittedAny) {
    // Detect "reasoning-only" response: the model produced <think> content
    // but no visible text and no tool call.  This happens when maxTokens
    // is tight relative to the prompt size — the model exhausts its budget
    // inside the <think> block and emits nothing afterwards.
    //
    // Mitigation: on attempts before the last one inject a short nudge
    // user-message asking the model to stop reasoning and produce output.
    // We append it to messagesWithSystemPrompt so the next streaming call
    // sees it, then pop it so the outer message list stays clean.
    if (st.reasoningText.length > 0 && attempt < maxAttempts) {
      st.retryGuidance = {
        role: "user",
        content:
          "So far you have only reasoned internally and produced no " +
          "answer. Emit your answer or the next tool call now — no " +
          "further thinking.",
      };
      accountAttempt("error");
      runtime.metrics.recordLlmRetry(
        candidate.provider,
        candidate.model,
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "reasoning_only_retry",
        message:
          "Model produced reasoning but no visible answer or tool " +
          `call; retrying with a nudge (attempt ${attempt}/${maxAttempts}).`,
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          reasoning_chars: st.reasoningText.length,
        },
      });
      // Full jitter — see the requireToolUse retry above.
      await sleep(fullJitter(backoffMs));
      return { action: "continue" };
    }
    // Reasoning-only salvage (last resort, on the final attempt).
    //
    // Some thinking-model builds (observed with Qwen3 on LM Studio)
    // stream a complete, coherent answer through the reasoning channel
    // but leave the visible `content` empty and never emit a tool call.
    // The nudge above fixes the transient case, but when *every* attempt
    // comes back reasoning-only we would otherwise hard-fail the whole
    // flow ("empty LLM response") and discard a finished answer.
    //
    // Instead of throwing, promote the accumulated reasoning as the
    // visible answer. This preserves the model's work (no quality or
    // completeness loss) and is model-agnostic — it recovers reasoning
    // from both the inline <think> path and the native reasoning stream
    // (both feed `reasoningText`). Any residual think tags are stripped.
    const salvaged = stripReasoningSentinelMarkers(st.reasoningText)
      .replace(/<\/?think>/gi, "")
      .trim();
    const reasoningSalvageEnabled =
      finalAnswerContract === undefined &&
      (!requireToolUse || st.toolPhaseStarted) &&
      allowsReasoningSalvage(
        streamFallbackPolicy,
        streamFallbackNodeConfig,
      );
    if (salvaged.length > 0 && reasoningSalvageEnabled) {
      st.fullText = salvaged;
      st.emittedAny = true;
      st.forcedAnswer = true;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "reasoning_salvage",
        message:
          "Every attempt was reasoning-only; promoted the model's " +
          "reasoning to the visible answer to avoid discarding a " +
          "finished response.",
        details: {
          model: `${candidate.provider}/${candidate.model}`,
          answer_chars: salvaged.length,
        },
      });
      reportStreamFallback("reasoning_salvage", {
        answer_chars: salvaged.length,
      });
      const SSE_CHUNK_SIZE = 60_000;
      try {
        for (
          let offset = 0;
          offset < salvaged.length;
          offset += SSE_CHUNK_SIZE
        ) {
          await runtime.onToken(
            node.id,
            salvaged.slice(offset, offset + SSE_CHUNK_SIZE),
          );
        }
      } catch {
        /* disconnect */
      }
      // fall through to the success path below
    } else {
      if (salvaged.length > 0 && !reasoningSalvageEnabled) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "reasoning_salvage_suppressed",
          message:
            "Every attempt was reasoning-only; the node configuration " +
            "forbids promoting reasoning to visible answer content.",
          details: {
            model: `${candidate.provider}/${candidate.model}`,
            reasoning_chars: salvaged.length,
          },
        });
      }
      // Opt-in graceful degradation (config.emptyResponseFallback):
      // on the LAST attempt of the LAST candidate — i.e. retries and
      // any fallback model are exhausted — do NOT hard-fail the node.
      // A hard failure here propagates out of an agent-harness worker
      // and aborts the whole run (trace 7c8b7dc5: the researcher's
      // empty final turn errored the orchestrator and skipped the
      // synthesizer, discarding everything collected). Instead, emit a
      // short, honest fallback answer so the delegation counts as
      // completed and the downstream synthesizer can still assemble a
      // best-effort result from the findings gathered so far. Non-opted
      // nodes keep the strict behaviour (throw) so genuine provider
      // failures still surface.
      const emptyCfg = node.config as
        | {
            emptyResponseFallback?: boolean;
            emptyResponseFallbackText?: string;
          }
        | undefined;
      const lastResort =
        c === candidates.length - 1 && attempt >= maxAttempts;
      if (
        allowsEmptyResponseFallback(streamFallbackPolicy, emptyCfg) &&
        lastResort
      ) {
        const fallbackText =
          typeof emptyCfg?.emptyResponseFallbackText === "string" &&
          emptyCfg.emptyResponseFallbackText.trim().length > 0
            ? emptyCfg.emptyResponseFallbackText
            : DEFAULT_EMPTY_RESPONSE_FALLBACK;
        st.fullText = fallbackText;
        st.emittedAny = true;
        st.forcedAnswer = true;
        st.emptyResponseFallbackUsed = true;
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "empty_response_fallback",
          message:
            "Every attempt (and fallback) returned an empty " +
            "completion; emitting the configured fallback answer " +
            "instead of failing the node.",
          details: {
            model: `${candidate.provider}/${candidate.model}`,
          },
        });
        reportStreamFallback("empty_response_fallback", {
          phase: "clean-completion",
        });
        try {
          await runtime.onToken(node.id, st.fullText);
        } catch {
          /* disconnect */
        }
        // fall through to the success path below
      } else {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "empty_response",
          message:
            "Model returned no visible text, no reasoning to salvage " +
            "and no tool call.",
          details: {
            attempt,
            model: `${candidate.provider}/${candidate.model}`,
            ...(st.textWithoutToolCall
              ? { require_tool_use_ignored: true }
              : {}),
          },
        });
        throw new StreamErrorSignal(
          st.textWithoutToolCall
            ? "empty LLM response after requireToolUse retries (model kept ignoring tool call requirement)"
            : "empty LLM response (no visible text and no tool call)",
        );
      }
    }
  }

  // Keep prompt-internal assistant context out of the engine-owned
  // response, cache and debug trace even if a weak model still echoes it.
  // The provider response-message boundary below applies the same
  // idempotent cleanup before LangGraph persists the turn.
  st.fullText = stripLeakedContextEcho(st.fullText);

  // Ref-handle indirection (config.refHandles): the model wrote short
  // handles where a long document reference belongs, and the SSE layer
  // already mapped them back for the live stream. `fullText` is the
  // engine-owned copy that feeds the response cache, the debug trace
  // and the persisted turn — every one of those is a USER/OPERATOR
  // surface, and a follow-up turn reads the persisted history with a
  // FRESH (empty) registry, where a lingering handle would no longer
  // resolve. Map them back to real references once, here, so nothing
  // downstream ever stores or replays a handle. No-op without refHandles.
  if (runtime.refHandles !== undefined) {
    st.fullText = runtime.refHandles.unmapText(st.fullText);
  }

  // Opt-in post-answer sources check (`config.sourcesCheck`, default
  // off). Inline-cited `[n]` missing from the sources section are
  // appended from the sources registered in THIS execution only and
  // streamed as a trailing chunk; unregistered numbers are reported,
  // never invented. Skipped for the engine's empty-response fallback.
  if (sourcesCheck !== undefined && !st.emptyResponseFallbackUsed) {
    const completion =
      sourcesCheck.completeSection &&
      runtime.lookupCitation !== undefined
        ? completeSourcesSection(
            st.fullText,
            runtime.lookupCitation,
            sourcesCheck.heading,
          )
        : undefined;
    if (completion !== undefined && completion.appendix.length > 0) {
      st.fullText += completion.appendix;
      // Persist exactly what the client received.
      st.forcedAnswer = true;
      try {
        await runtime.onToken(node.id, completion.appendix);
      } catch {
        /* disconnect */
      }
    }
    if (removedRuleMarkers.length > 0) st.forcedAnswer = true;
    // Markers that reached the client live (non-buffered path) cannot
    // be removed any more; they are reported instead.
    const retainedMarkers = sourcesCheck.stripRuleMarkers
      ? findRuleMarkers(st.fullText)
      : [];
    const unresolved = completion?.unresolved ?? [];
    if (
      (completion?.appended.length ?? 0) > 0 ||
      unresolved.length > 0 ||
      removedRuleMarkers.length > 0 ||
      retainedMarkers.length > 0
    ) {
      runtime.onNodeDiagnostic?.(node.id, {
        level:
          unresolved.length > 0 || retainedMarkers.length > 0
            ? "warn"
            : "info",
        code: "answer_sources_check",
        message:
          "Post-answer sources check: completed the sources section " +
          "from registered sources and/or removed pseudo markers.",
        details: {
          appended_sources: completion?.appended ?? [],
          unresolved_markers: unresolved,
          created_section: completion?.createdSection ?? false,
          removed_markers: [...removedRuleMarkers],
          retained_markers: retainedMarkers,
        },
      });
    }
  }

  // ---- success: fold usage, record cost + metrics ----
  accountAttempt("ok");

  let responseMessages:
    | import("@langchain/core/messages").BaseMessage[]
    | undefined;
  try {
    const response = (await result.response) as { messages?: unknown };
    if (Array.isArray(response.messages)) {
      // Ref-handle indirection (config.refHandles): the tool results
      // the model saw during THIS loop carry short handles. These
      // messages are persisted to the checkpointer and replayed on the
      // NEXT turn, where the run-scoped registry is fresh/empty and a
      // lingering handle would no longer resolve (a dangling reference
      // the model could copy). Map handles back to real references
      // before persisting — `unmapContent` is pure (deep copy), so the
      // SDK's own message array is left untouched. Real references
      // resolve unconditionally, so the next turn stays correct whether
      // or not the same documents are re-retrieved.
      const persistedSource =
        runtime.refHandles !== undefined
          ? runtime.refHandles.unmapContent(response.messages)
          : response.messages;
      responseMessages = aiResponseMessagesToBaseMessages(
        persistedSource as unknown[],
      );
      // Persist the SAME capped tool output the model was shown during
      // the loop. The AI SDK hands back its own untruncated copies, so
      // without this the checkpointed history would grow by the full
      // payload — and next turn would replay a LONGER version of a
      // message the model already processed in capped form, which both
      // breaks the cacheable prefix and re-inflates the context this
      // budget exists to bound.
      if (responseMessages !== undefined) {
        const persisted = applyToolResultBudgetToHistory(
          responseMessages,
          toolResultBudget,
        );
        responseMessages = persisted.messages;
        if (persisted.stats.charsSaved > 0) {
          runtime.metrics.recordCounter(
            "aiperator_tool_result_chars_saved_total",
            { node: node.id, stage: "history" },
            persisted.stats.charsSaved,
          );
        }
      }
    }
  } catch {
    responseMessages = undefined;
  }

  // Reasoning-echo guard: the LM Studio reasoning shim rewrites native
  // chain-of-thought into `content` with a sentinel prefix (see
  // REASONING_SENTINEL); on a plain answer turn
  // aiResponseMessagesToBaseMessages keeps that text minus the markers.
  // A model that echoes its thinking — or a retry instruction such as
  // "Answer the user now" — into the visible channel therefore leaks a
  // chain-of-thought preamble into the persisted/replayed final answer
  // even though the STREAMED answer (fullText, sentinel-routed) was
  // clean. When the SDK's final assistant message is exactly the
  // streamed answer plus a prefix, trust the streamed text and drop
  // the prefix. The prefix can only be sentinel-routed reasoning (the
  // streamed channel saw everything else), so this is lossless for
  // genuine answers.
  if (responseMessages !== undefined && st.fullText.length > 0) {
    for (let i = responseMessages.length - 1; i >= 0; i--) {
      const m = responseMessages[i];
      if (m?._getType() !== "ai") continue;
      const ai = m as AIMessage;
      if ((ai.tool_calls?.length ?? 0) > 0) break;
      if (typeof ai.content !== "string") break;
      if (
        ai.content.length > st.fullText.length &&
        ai.content.endsWith(st.fullText)
      ) {
        const strippedChars = ai.content.length - st.fullText.length;
        responseMessages[i] = new AIMessage({
          content: st.fullText,
          additional_kwargs: ai.additional_kwargs,
          response_metadata: ai.response_metadata,
          id: ai.id,
        });
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "reasoning_prefix_stripped",
          message:
            "The final assistant message carried a reasoning preamble " +
            "before the streamed answer; the preamble was removed " +
            "from the persisted response.",
          details: { stripped_chars: strippedChars },
        });
      }
      break;
    }
  }

  // Never cache a response the repetition guard had to truncate: it is
  // a degenerate/looped output, and persisting it would replay the
  // corrupted answer on every future cache hit.
  if (cacheable && !st.loopAborted && !st.outputAborted) {
    const cachedValue: CachedResponse = {
      text: st.fullText,
      usage: {
        promptTokens: attemptUsage.promptTokens,
        completionTokens: attemptUsage.completionTokens,
        totalTokens: attemptUsage.totalTokens,
      },
    };
    if (exactCache !== undefined && cacheKeyInput !== undefined) {
      await exactCache.set(cacheKeyInput, cachedValue);
    }
    if (semCache !== undefined && semKeyInput !== undefined) {
      await semCache.set(semKeyInput, cachedValue);
    }
  }

  // Groundedness gate
  let groundedFooter = "";
  if (runtime.groundednessGate !== undefined) {
    const sources: string[] = [];
    for (const tr of state.toolResults ?? []) {
      sources.push(
        typeof tr.result === "string"
          ? tr.result
          : JSON.stringify(tr.result),
      );
    }
    for (const m of state.messages) {
      if (m._getType() === "tool" && typeof m.content === "string") {
        sources.push(m.content);
      }
    }
    if (st.fullText.trim().length > 0) {
      const report = await runtime.groundednessGate.evaluate(
        st.fullText,
        sources,
        runtime.signal,
      );
      if (!report.noSources) {
        runtime.metrics.recordCounter("aiperator_groundedness_total", {
          result: report.passed ? "passed" : "failed",
        });
      }
      try {
        await runtime.onGroundedness?.(node.id, report);
      } catch {
        /* disconnect */
      }
      if (report.warningFooter !== undefined) {
        groundedFooter = report.warningFooter;
        try {
          await runtime.onToken(node.id, groundedFooter);
        } catch {
          /* disconnect */
        }
      }
    }
  }

  runtime.onNodeIo?.(node.id, {
    response: st.fullText + groundedFooter,
    ...(st.reasoningText.length > 0 ? { reasoning: st.reasoningText } : {}),
  });
  runtime.providerCircuitBreaker?.recordReachable(candidate.provider);

  return { action: "return", value: {
    currentNodeId: node.id,
    // When the answer was synthesized by the engine (reasoning-salvage
    // or the empty-response fallback), the provider's response messages
    // are empty/missing — return the forced `fullText` explicitly so
    // the salvaged/fallback answer is not silently dropped.
    messages: st.forcedAnswer
      ? [
          new AIMessage({
            content: st.fullText + groundedFooter,
            ...(st.emptyResponseFallbackUsed
              ? {
                  additional_kwargs: {
                    aiperator_empty_response_fallback: true,
                  },
                }
              : {}),
          }),
        ]
      : (responseMessages ?? [
          new AIMessage(st.fullText + groundedFooter),
        ]),
  } };
}

interface AttemptErrorCtx {
  accountAttempt: (outcome: "ok" | "error") => void;
  attempt: number;
  backoffMs: number;
  c: number;
  candidate: LlmConfig;
  candidates: LlmConfig[];
  maxAttempts: number;
  node: FlowNode;
  requestDeadline: AbortSignal;
  requestTimeoutMs: number;
  runtime: ExecRuntime;
  st: LlmAttemptState;
}

/** Handles a thrown provider/stream error of one attempt (original catch). */
export async function handleAttemptError(
  ctx: AttemptErrorCtx,
  err: unknown,
): Promise<AttemptErrorResult> {
  const {
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
  } = ctx;
  accountAttempt("error");
  const requestTimedOut =
    !runtime.signal?.aborted && requestDeadline.aborted;
  const errorCause = err instanceof Error ? err.cause : undefined;
  const transactionBudgetExceeded =
    isBudgetExceededError(err) || isBudgetExceededError(errorCause);
  st.lastErrMsg = transactionBudgetExceeded
    ? "Transaction budget exceeded."
    : requestTimedOut
      ? "LLM request timed out."
      : runtime.signal?.aborted === true
        ? "Flow execution aborted."
        : "LLM provider request failed.";
  if (requestTimedOut) {
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "llm_request_timeout",
      message: `LLM request attempt exceeded ${requestTimeoutMs}ms and was aborted.`,
      details: {
        attempt,
        model: `${candidate.provider}/${candidate.model}`,
        timeout_ms: requestTimeoutMs,
      },
    });
  }
  const transportErrorCode = providerTransportErrorCode(err, {
    requestTimedOut,
    flowAborted: runtime.signal?.aborted === true,
  });
  const transportFailure = transportErrorCode !== undefined;
  const circuitState = transportFailure
    ? runtime.providerCircuitBreaker?.recordTransportFailure(
        candidate.provider,
        transportErrorCode,
      )
    : undefined;
  const circuitOpened = circuitState?.state === "open";
  if (!transportFailure && runtime.signal?.aborted !== true) {
    runtime.providerCircuitBreaker?.recordReachable(candidate.provider);
  }
  // The model-facing message above is deliberately generic. Record the
  // raw provider cause once, server-side only, so an operator can tell a
  // dead endpoint from a rejected request (4xx) or a mid-loop failure.
  if (runtime.signal?.aborted !== true) {
    const promptSchemaIssues = describePromptSchemaIssues(err);
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "llm_provider_error_detail",
      message: `LLM provider ${candidate.provider}/${candidate.model} attempt ${attempt} failed: ${describeProviderError(err)}`,
      details: {
        attempt,
        provider: candidate.provider,
        model: candidate.model,
        after_partial_output: st.emittedAny,
        ...(transportErrorCode !== undefined
          ? { transport_error_code: transportErrorCode }
          : {}),
        // Structural prompt-schema violations (message index, role,
        // path) — no prompt content. Present only for AI SDK
        // InvalidPromptError/TypeValidationError.
        ...(promptSchemaIssues !== undefined
          ? {
              prompt_schema_issues: promptSchemaIssues.map(
                formatPromptSchemaIssue,
              ),
            }
          : {}),
      },
    });
    if (promptSchemaIssues !== undefined) {
      // A prompt the SDK rejects is a runtime message-mapping bug,
      // never a provider outage — give it its own error-level code so
      // it is not lost among transient provider warnings.
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "llm_prompt_schema_invalid",
        message:
          "The step prompt failed AI SDK ModelMessage validation before reaching the provider.",
        details: {
          provider: candidate.provider,
          model: candidate.model,
          attempt,
          after_partial_output: st.emittedAny,
          issues: promptSchemaIssues.map(formatPromptSchemaIssue),
        },
      });
    }
  }
  if (st.emittedAny) {
    if (st.fullText.length > 0 || st.reasoningText.length > 0)
      runtime.onNodeIo?.(node.id, {
        ...(st.fullText.length > 0 ? { response: st.fullText } : {}),
        ...(st.reasoningText.length > 0
          ? { reasoning: st.reasoningText }
          : {}),
      });
    return { action: "return", value: {
      currentNodeId: node.id,
      errors: [
        {
          message: `Node "${node.id}": LLM stream error after partial output — ${st.lastErrMsg}`,
          type: "execution_error",
          details: { node_id: node.id },
        },
      ],
    } };
  }

  if (circuitOpened) {
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "llm_provider_circuit_opened",
      message:
        `Provider circuit opened for ${candidate.provider} after consecutive ` +
        `transport failures; moving to the next configured candidate.`,
      details: {
        phase: "provider-call",
        attempt,
        provider: candidate.provider,
        model: candidate.model,
        ...circuitState,
      },
    });
    return { action: "break" };
  }

  // Immediate in-request failover on an UNREACHABLE provider.
  //
  // A transport failure (connection refused, DNS failure, connect
  // timeout, 5xx/408 — see providerTransportErrorCode) means THIS
  // endpoint could not serve the request at all. Retrying the SAME dead
  // endpoint (with backoff) only to fail again and wait for the circuit
  // breaker to cross its threshold wastes the request's time budget. As
  // long as another candidate remains in the chain (a pool member or a
  // deployment fallback), skip the remaining retries and move to it NOW.
  // Nothing has streamed yet here (the `emittedAny` return above already
  // handled a mid-stream failure), so switching candidates is safe. The
  // recorded transport failure still counts toward the circuit breaker,
  // so a provider that is down across requests is quarantined as before.
  // Only the LAST candidate keeps the retry path, so a lone endpoint
  // with no alternative still gets a chance to recover from a transient
  // network hiccup.
  if (transportFailure && c < candidates.length - 1) {
    runtime.metrics.recordLlmFallback(
      candidate.provider,
      candidate.model,
    );
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "llm_provider_unreachable_failover",
      message:
        `Provider ${candidate.provider} was unreachable ` +
        `(${transportErrorCode}); switching to the next candidate ` +
        "without exhausting retries on the dead endpoint.",
      details: {
        phase: "provider-call",
        attempt,
        provider: candidate.provider,
        model: candidate.model,
        transport_error_code: transportErrorCode,
        remaining_candidates: candidates.length - 1 - c,
      },
    });
    return { action: "break" };
  }

  if (attempt < maxAttempts) {
    runtime.metrics.recordLlmRetry(candidate.provider, candidate.model);
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "retry",
      message: `LLM stream error; retrying (attempt ${attempt}/${maxAttempts}): ${st.lastErrMsg}`,
      details: {
        attempt,
        model: `${candidate.provider}/${candidate.model}`,
      },
    });
    // Full jitter over the exponential schedule: every request that
    // hit the same provider 429/5xx around the same time must not
    // retry in the same window (that recreates the load spike). See
    // fullJitter() for the reasoning.
    await sleep(fullJitter(backoffMs * 2 ** (attempt - 1)));
    return { action: "continue" };
  }
  return { action: "break" };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Consumes the provider full stream of one attempt (task 18.1).
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged.
 */
import crypto from "node:crypto";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import {
  isToolErrorOutput,
  sanitizeToolResultOutput,
  toolErrorExcerpt,
} from "../message-mapping.js";
import { isBudgetExceededError } from "../../transaction/budget.js";
import {
  detectRepeatedTail,
  REPETITION_CHECK_INTERVAL,
} from "../repetition-guard.js";
import { looksLikeTextToolCallPrefix } from "../text-tool-call.js";
import type { ExecRuntime } from "../exec-runtime.js";
import {
  PREAMBLE_MAX_CHARS,
  PREAMBLE_MAX_MS,
  PREAMBLE_SENTENCE_BOUNDARY_RE,
  type FinalAnswerContractConfig,
} from "./llm-final-answer.js";
import {
  StreamErrorSignal,
  type LlmAttemptState,
  type LlmAttemptUsage,
  type LlmStreamResult,
  type StreamPart,
} from "./llm-stream-types.js";

interface AttemptStreamCtx {
  attempt: number;
  attemptUsage: LlmAttemptUsage;
  candidate: LlmConfig;
  clientToolKeys: Set<string>;
  finalAnswerContract: FinalAnswerContractConfig | undefined;
  flushThinkBuf: () => Promise<void>;
  hasTools: boolean;
  isSuccessfulToolResult: (output: unknown) => boolean;
  maxOutputChars: number;
  node: FlowNode;
  repAbort: AbortController;
  requireToolUse: boolean;
  result: LlmStreamResult;
  routeDelta: (delta: string) => Promise<void>;
  routeFinalAnswerDelta: (delta: string) => Promise<void>;
  runtime: ExecRuntime;
  streamToolResultDetails: boolean;
  successfulToolRefs: string[];
  suppressToolPreamble: boolean;
  toolRefByCallId: Map<string, string>;
  toolRefByKey: Map<string, string>;
  toolStartTimes: Map<string, number>;
  st: LlmAttemptState;
}

/** Streams one provider attempt. A `break` of the original for-await loop is
 * a plain `return` here; thrown StreamErrorSignals propagate to the caller. */
export async function runAttemptStream(ctx: AttemptStreamCtx): Promise<void> {
  const {
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
  } = ctx;
  for await (const rawPart of result.fullStream) {
    const part = rawPart as StreamPart;

    const generatedChars =
      (finalAnswerContract !== undefined
        ? st.finalAnswerBuffer.length
        : st.fullText.length +
          st.preambleBuf.length +
          st.thinkBuf.length +
          (st.stepLookahead?.length ?? 0)) + st.reasoningText.length;
    let abortAfterPart = false;
    if (
      (part.type === "text-delta" || part.type === "reasoning-delta") &&
      typeof part.text === "string"
    ) {
      const remainingChars = Math.max(
        0,
        maxOutputChars - generatedChars,
      );
      if (part.text.length > remainingChars) {
        part.text = part.text.slice(0, remainingChars);
        abortAfterPart = true;
      }
    }
    if (generatedChars >= maxOutputChars) {
      st.outputAborted = true;
      st.thinkBuf = "";
      st.preambleBuf = "";
      st.stepLookahead = undefined;
      repAbort.abort(
        new Error(
          `LLM output exceeded the ${maxOutputChars}-character ceiling`,
        ),
      );
      runtime.metrics.recordCounter(
        "aiperator_llm_output_limit_aborted_total",
        { node: node.id, model: candidate.model },
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "output_limit_aborted",
        message:
          `Generated output reached the ${maxOutputChars}-character ` +
          "ceiling; the provider stream was aborted.",
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          generated_chars: generatedChars,
          max_output_chars: maxOutputChars,
        },
      });
      return;
    }

    // Repetition guard — throttled scan of what has been generated so
    // far. Placed at the top of the loop so it observes the text/
    // reasoning appended by previous parts. On a detected loop we
    // truncate to the first (non-repeated) block, abort the upstream
    // generation, and break — treating the truncated text as the
    // answer (see the post-loop success path).
    const candidateText =
      finalAnswerContract !== undefined ? st.finalAnswerBuffer : st.fullText;
    const grown = candidateText.length + st.reasoningText.length;
    if (grown - st.repScanAt >= REPETITION_CHECK_INTERVAL) {
      st.repScanAt = grown;
      const repFull = detectRepeatedTail(candidateText);
      const repReason = repFull.loop
        ? { loop: false, safeLen: st.reasoningText.length }
        : detectRepeatedTail(st.reasoningText);
      if (repFull.loop || repReason.loop) {
        if (repFull.loop && finalAnswerContract === undefined) {
          st.fullText = st.fullText.slice(0, repFull.safeLen);
        }
        if (repReason.loop)
          st.reasoningText = st.reasoningText.slice(0, repReason.safeLen);
        st.loopAborted = true;
        st.thinkBuf = "";
        st.preambleBuf = "";
        st.stepLookahead = undefined;
        runtime.metrics.recordCounter(
          "aiperator_llm_repetition_aborted_total",
          { node: node.id, model: candidate.model },
        );
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "repetition_aborted",
          message:
            finalAnswerContract !== undefined
              ? "Repetition loop detected; aborted generation and " +
                "retained the raw buffer so the final-answer contract " +
                "can reject duplicate marker pairs."
              : "Repetition loop detected; aborted generation and " +
                "truncated the output to the first non-repeated block.",
          details: {
            model: `${candidate.provider}/${candidate.model}`,
            kept_chars:
              (finalAnswerContract !== undefined
                ? st.finalAnswerBuffer.length
                : st.fullText.length) + st.reasoningText.length,
          },
        });
        runtime
          .onReasoning(
            node.id,
            "\n[Repetition loop detected — generation aborted and output truncated.]",
          )
          .catch(() => {});
        try {
          repAbort.abort();
        } catch {
          /* ignore */
        }
        return;
      }
    }

    if (part.type === "text-delta") {
      const delta = (part as { text?: string }).text ?? "";
      if (
        finalAnswerContract !== undefined &&
        !delta.startsWith("\x00r")
      ) {
        await routeFinalAnswerDelta(delta);
      } else if (
        hasTools &&
        !st.preambleResolved &&
        (!st.toolPhaseStarted || suppressToolPreamble) &&
        !delta.startsWith("\x00r")
      ) {
        if (st.preambleBuf.length === 0) st.preambleStartedAt = Date.now();
        st.preambleBuf += delta;
        // The buffer only withholds text from `content` — the
        // reasoning channel still shows it LIVE, so a user following
        // the Thinking block can watch the model plan in real time
        // even when a later tool call proves the text was narration
        // rather than the answer.
        try {
          await runtime.onReasoning(node.id, delta);
        } catch {
          /* disconnect */
        }
        const elapsedMs = Date.now() - st.preambleStartedAt;
        // A buffer that is (or may still become) a text-template tool
        // call must never be resolved as the live answer; the
        // stream-end guard rejects it (detectTextToolCall).
        if (
          !suppressToolPreamble &&
          !requireToolUse &&
          !looksLikeTextToolCallPrefix(st.preambleBuf) &&
          (elapsedMs >= PREAMBLE_MAX_MS ||
            st.preambleBuf.length >= PREAMBLE_MAX_CHARS ||
            PREAMBLE_SENTENCE_BOUNDARY_RE.test(st.preambleBuf))
        ) {
          st.preambleResolved = true;
          st.fullText += st.preambleBuf;
          st.emittedAny = true;
          try {
            await runtime.onToken(node.id, st.preambleBuf);
          } catch {
            /* disconnect */
          }
          st.preambleBuf = "";
        }
      } else if (
        st.stepLookahead !== undefined &&
        !st.inThink &&
        !delta.startsWith("\x00r")
      ) {
        // Non-suppressed step after the tool phase: hold the step's
        // text while it may still be a text tool call; the stream-end
        // guard rejects it. Anything else is released at once.
        st.stepLookahead += delta;
        if (!looksLikeTextToolCallPrefix(st.stepLookahead)) {
          const released = st.stepLookahead;
          st.stepLookahead = undefined;
          await routeDelta(released);
        }
      } else {
        await routeDelta(delta);
      }
    } else if (part.type === "reasoning-delta") {
      await flushThinkBuf();
      const reasoning = (part as { text?: string }).text ?? "";
      if (reasoning.length > 0) {
        st.reasoningText += reasoning;
        try {
          await runtime.onReasoning(node.id, reasoning);
        } catch {
          /* disconnect */
        }
      }
    } else if (part.type === "tool-call") {
      await flushThinkBuf();
      if (!st.toolPhaseStarted) {
        st.toolPhaseStarted = true;
        // The narration was already streamed live on the reasoning
        // channel; fold it into the persisted reasoning too, so the
        // debug trace and history match what the client saw.
        st.reasoningText += st.preambleBuf;
        st.preambleBuf = "";
      } else if (suppressToolPreamble && st.preambleBuf.length > 0) {
        // Planning narration between tool steps: a subsequent call
        // proves it was not the answer, so drop it from `content`
        // (keeping it in the reasoning trail) and re-arm the buffer
        // for the next step.
        st.reasoningText += st.preambleBuf;
        st.preambleBuf = "";
      }
      if (st.stepLookahead !== undefined) {
        // Held step text followed by a native call was not the answer.
        st.reasoningText += st.stepLookahead;
        st.stepLookahead = undefined;
      }
      const id = part.toolCallId ?? crypto.randomUUID();
      const toolName = part.toolName ?? "unknown";
      const toolRef = toolRefByKey.get(toolName);
      if (toolRef !== undefined) toolRefByCallId.set(id, toolRef);
      st.emittedAny = true;
      if (
        clientToolKeys.has(toolName) &&
        runtime.onClientToolCall !== undefined
      ) {
        try {
          await runtime.onClientToolCall(
            id,
            toolName,
            JSON.stringify((part as { input?: unknown }).input ?? {}),
          );
        } catch {
          /* disconnect */
        }
      } else {
        toolStartTimes.set(id, Date.now());
        try {
          await runtime.onToolCall(
            id,
            toolName,
            JSON.stringify((part as { input?: unknown }).input ?? {}),
          );
        } catch {
          /* disconnect */
        }
      }
    } else if (part.type === "tool-result") {
      await flushThinkBuf();
      if (!st.toolPhaseStarted) {
        st.toolPhaseStarted = true;
        st.reasoningText += st.preambleBuf;
        st.preambleBuf = "";
      } else if (suppressToolPreamble && st.preambleBuf.length > 0) {
        // Same as the tool-call branch: narration preceding a later
        // tool result is planning text, not the answer — kept in the
        // reasoning trail, dropped from `content`.
        st.reasoningText += st.preambleBuf;
        st.preambleBuf = "";
      }
      const id = part.toolCallId ?? crypto.randomUUID();
      const startedAt = toolStartTimes.get(id) ?? Date.now();
      toolStartTimes.delete(id);
      const toolRef = toolRefByCallId.get(id);
      const rawOutput = (part as { output?: unknown }).output;
      const output = sanitizeToolResultOutput(rawOutput);
      if (isToolErrorOutput(rawOutput)) {
        // Same rationale as the `tool-error` branch below: the model
        // only sees the anonymized envelope, so without this an MCP
        // `isError` result (e.g. a gate rejecting the transaction
        // token) is indistinguishable from any other failure.
        const excerpt = toolErrorExcerpt(rawOutput);
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "tool_result_error",
          message:
            `Tool ${toolRef ?? part.toolName ?? "unknown"} returned an error result. ` +
            "The model-facing result is anonymized; this diagnostic carries the raw cause for operators.",
          details: {
            tool_call_id: id,
            ...(toolRef !== undefined ? { tool_ref: toolRef } : {}),
            ...(excerpt !== undefined
              ? { error_excerpt: excerpt }
              : {}),
          },
        });
      }
      st.visibleTextLengthAtLastToolResult = st.fullText.length;
      st.lastToolResultForRetry = output;
      // Re-arm the per-step text-tool-call lookahead (non-suppressed
      // path; the suppressed path buffers every step anyway).
      if (!suppressToolPreamble) st.stepLookahead ??= "";
      if (toolRef !== undefined && isSuccessfulToolResult(output)) {
        successfulToolRefs.push(toolRef);
      }
      const execTimeSec = (Date.now() - startedAt) / 1000;
      try {
        await runtime.onToolResult(id, output, execTimeSec, {
          streamDetails: streamToolResultDetails,
        });
      } catch {
        /* disconnect */
      }
    } else if (part.type === "tool-error") {
      // AI SDK emits thrown tool implementations as `tool-error`, not
      // `tool-result`. Without handling this branch, onToolCall's debug
      // placeholder remains `result: null, is_error: false`, even though
      // the tool failed. MCP `isError` results normally take the branch
      // above; this covers transport/adapter exceptions as well.
      await flushThinkBuf();
      if (!st.toolPhaseStarted) {
        st.toolPhaseStarted = true;
        st.reasoningText += st.preambleBuf;
        st.preambleBuf = "";
      } else if (suppressToolPreamble && st.preambleBuf.length > 0) {
        // Same as the tool-call branch: narration preceding a later
        // tool error is planning text, not the answer — kept in the
        // reasoning trail, dropped from `content`.
        st.reasoningText += st.preambleBuf;
        st.preambleBuf = "";
      }
      const id = part.toolCallId ?? crypto.randomUUID();
      const startedAt = toolStartTimes.get(id) ?? Date.now();
      toolStartTimes.delete(id);
      const error = part.error;
      const detail = {
        name: "ToolExecutionError",
        message: "Tool execution failed.",
      };
      // The client/model-facing envelope is intentionally anonymized
      // ("Tool execution failed.") so untrusted tool/transport output
      // never reaches the reasoning stream. But that anonymization also
      // erased the ONLY signal an operator has: without the raw cause a
      // failed adapter/transport call is indistinguishable from a
      // budget/identity/evidence guard, and the vectorsearch server logs
      // stay empty when the throw happens before its network call. Emit
      // the raw name+message once through the server-side diagnostic
      // pipeline (never the model stream) so the debug trace can name
      // the actual failure class. Deliberately excludes tool arguments
      // to avoid leaking a `reference`/query payload into diagnostics.
      const rawToolError =
        error instanceof Error
          ? error
          : typeof error === "object" && error !== null
            ? (error as { name?: unknown; message?: unknown })
            : undefined;
      const rawToolErrorName =
        typeof rawToolError?.name === "string"
          ? rawToolError.name
          : undefined;
      const rawToolErrorMessage =
        typeof rawToolError?.message === "string"
          ? rawToolError.message
          : typeof error === "string"
            ? error
            : undefined;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "tool_execution_failed",
        message:
          "A delegated tool call threw before returning a result. " +
          "The model-facing result is anonymized; this diagnostic " +
          "carries the raw failure class for operators.",
        details: {
          tool_call_id: id,
          ...(rawToolErrorName !== undefined
            ? { error_name: rawToolErrorName }
            : {}),
          ...(rawToolErrorMessage !== undefined
            ? { error_message: rawToolErrorMessage }
            : {}),
        },
      });
      st.visibleTextLengthAtLastToolResult = st.fullText.length;
      st.lastToolResultForRetry = {
        isError: true,
        error: detail,
      };
      if (!suppressToolPreamble) st.stepLookahead ??= "";
      try {
        await runtime.onToolResult(
          id,
          { isError: true, error: detail },
          (Date.now() - startedAt) / 1000,
          { streamDetails: streamToolResultDetails },
        );
      } catch {
        /* disconnect */
      }
      // A shared transaction budget cannot recover inside this model
      // turn or in a later harness delegation. Do not replay it as an
      // ordinary tool result: that made the model format the runtime
      // failure as a domain finding and caused repeated paid passes.
      if (isBudgetExceededError(error)) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "transaction_budget_exceeded",
          message:
            "Agent tool execution stopped because the shared transaction budget is exhausted.",
          details: {
            dimension: error.dimension,
            tool_call_id: id,
          },
        });
        throw new StreamErrorSignal(error.message, error);
      }
    } else if (part.type === "finish-step") {
      const finite = (n: number | undefined): number =>
        typeof n === "number" && Number.isFinite(n) ? n : 0;
      const stepUsage = (
        part as {
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
          };
        }
      ).usage;
      attemptUsage.promptTokens += finite(stepUsage?.inputTokens);
      attemptUsage.completionTokens += finite(stepUsage?.outputTokens);
      attemptUsage.totalTokens += finite(stepUsage?.totalTokens);
      // Presence-gated: only start accumulating once a step actually
      // reports the field, so a provider that never reports it leaves
      // `cachedPromptTokens` undefined rather than a misleading 0.
      //
      // Two field shapes are accepted because they are not
      // interchangeable across versions: ai@7 reports
      // `usage.inputTokenDetails.cacheReadTokens`, while the older
      // provider-level usage type exposed a flat `cachedInputTokens`.
      // Reading only the latter (as this first did) silently returned
      // undefined against a Bedrock endpoint that WAS serving 99% of its
      // input from cache.
      const details = (
        stepUsage as
          | { inputTokenDetails?: { cacheReadTokens?: number } }
          | undefined
      )?.inputTokenDetails;
      const stepCached =
        typeof details?.cacheReadTokens === "number"
          ? details.cacheReadTokens
          : (stepUsage as { cachedInputTokens?: number } | undefined)
              ?.cachedInputTokens;
      if (
        typeof stepCached === "number" &&
        Number.isFinite(stepCached)
      ) {
        attemptUsage.cachedPromptTokens =
          (attemptUsage.cachedPromptTokens ?? 0) + stepCached;
      }
    } else if (part.type === "error") {
      throw new StreamErrorSignal(
        "LLM provider stream failed.",
        part.error,
      );
    } else if (part.type === "file") {
      await flushThinkBuf();
      const gf = (
        part as { file?: { base64?: string; mediaType?: string } }
      ).file;
      if (gf?.base64 && gf.mediaType?.startsWith("image/")) {
        const mediaUrl = runtime.publishMedia?.(
          gf.base64,
          gf.mediaType,
        );
        if (mediaUrl !== undefined) {
          const mdImage = `\n\n![](${mediaUrl})\n\n`;
          st.fullText += mdImage;
          st.emittedAny = true;
          try {
            await runtime.onToken(node.id, mdImage);
          } catch {
            /* disconnect */
          }
        } else {
          const mdImage = `\n\n![](data:${gf.mediaType};base64,${gf.base64})\n\n`;
          st.fullText += mdImage;
          st.emittedAny = true;
          const SSE_CHUNK_SIZE = 60_000;
          try {
            for (
              let offset = 0;
              offset < mdImage.length;
              offset += SSE_CHUNK_SIZE
            ) {
              await runtime.onToken(
                node.id,
                mdImage.slice(offset, offset + SSE_CHUNK_SIZE),
              );
            }
          } catch {
            /* disconnect */
          }
        }
      }
    }

    if (abortAfterPart) {
      st.outputAborted = true;
      st.thinkBuf = "";
      st.preambleBuf = "";
      st.stepLookahead = undefined;
      repAbort.abort(
        new Error(
          `LLM output exceeded the ${maxOutputChars}-character ceiling`,
        ),
      );
      runtime.metrics.recordCounter(
        "aiperator_llm_output_limit_aborted_total",
        { node: node.id, model: candidate.model },
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "output_limit_aborted",
        message:
          `Generated output reached the ${maxOutputChars}-character ` +
          "ceiling; the final delta was truncated and the provider " +
          "stream was aborted.",
        details: {
          attempt,
          model: `${candidate.provider}/${candidate.model}`,
          max_output_chars: maxOutputChars,
        },
      });
      return;
    }
  }
}

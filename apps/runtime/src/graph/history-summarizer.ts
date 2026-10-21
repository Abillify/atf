// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * History summariser (`src/graph/history-summarizer.ts`)
 *
 * Produces the summary text that {@link compressHistory} substitutes for the
 * middle of a long conversation. Split out from `history-compression.ts` so the
 * compaction policy stays pure and unit-testable while the model call, its
 * failure handling and its cost accounting live here.
 *
 * Runs on a SIDE model, not the responder: summarising is a mechanical
 * transformation, so it is the archetypal task for a cheap/fast model. The model
 * is chosen per node (`config.historyCompression.llm`), falling back to the
 * node's own model so the feature works without extra configuration.
 *
 * Fails open in every direction — on provider error, empty output, or an unknown
 * provider it returns `undefined`, and the caller keeps the uncompacted history
 * (and trips the anti-thrash breaker). Losing a conversation to a failed
 * summariser call would be a far worse outcome than an oversized prompt.
 *
 * No `any` at module boundaries.
 */

import { generateText } from "ai";
import type { ModelMessage } from "ai";
import type { LlmConfig } from "../types/flow.js";
import type { ExecRuntime } from "./exec-runtime.js";
import { UnknownProviderError, filterLlmParameters } from "./llm-factory.js";
import {
  estimateCost,
  estimateTokensFromText,
  buildCostAttribution,
} from "../observability/cost.js";

/**
 * Instruction for the summarising model.
 *
 * Written to preserve what an agent actually needs to continue work — decisions,
 * open threads, concrete identifiers — rather than to read well. The explicit
 * "no new work" framing exists because a summary that reads like a task list is
 * routinely picked up as an instruction by the responder model.
 */
const SUMMARY_SYSTEM_PROMPT = [
  "You compact the middle of a conversation so it fits a smaller context window.",
  "",
  "Write a dense factual summary of the exchange below. Preserve, in this order:",
  "1. What the user asked for and any constraints they stated.",
  "2. Decisions taken and conclusions reached, with the reasoning in one clause.",
  "3. Concrete identifiers that later turns may need verbatim: file paths, IDs,",
  "   names, numbers, URLs, error messages, tool names that were used.",
  "4. Questions that were RESOLVED (with the answer) and questions still OPEN.",
  "5. Work that was completed, and work that was started but not finished.",
  "",
  "Rules:",
  "- Be factual and terse. No preamble, no closing remarks, no markdown headings.",
  "- Do NOT invent anything that is not in the transcript.",
  "- Do NOT phrase anything as an instruction, task list, or next step. This text",
  "  is background reference, not a request. Describe what happened in the past",
  "  tense.",
  "- Keep every identifier exactly as written; never abbreviate or normalise them.",
  "- Answer in the language the conversation is in.",
].join("\n");

/** Serialises a message range into a transcript for the summariser. */
function renderTranscript(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = String((m as { role?: unknown }).role ?? "unknown");
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") {
      lines.push(`${role}: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const parts: string[] = [];
    for (const raw of content) {
      const part = raw as {
        type?: string;
        text?: string;
        toolName?: string;
        output?: { value?: unknown };
      };
      if (part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      } else if (part.type === "tool-call") {
        parts.push(`[called tool ${part.toolName ?? "?"}]`);
      } else if (part.type === "tool-result") {
        const value = part.output?.value;
        parts.push(
          `[result of ${part.toolName ?? "?"}] ${
            typeof value === "string" ? value : JSON.stringify(value ?? "")
          }`,
        );
      } else if (part.type !== undefined) {
        parts.push(`[${part.type}]`);
      }
    }
    if (parts.length > 0) lines.push(`${role}: ${parts.join("\n")}`);
  }
  return lines.join("\n\n");
}

/**
 * Hard cap on the transcript handed to the summariser.
 *
 * The range being compacted is by definition large — that is why it is being
 * compacted — and feeding all of it back would just move the oversized-request
 * problem to the summariser. Head and tail of the transcript are kept, which is
 * where the framing and the most recent state live.
 */
export const SUMMARY_INPUT_MAX_CHARS = 160_000;

/** Applies {@link SUMMARY_INPUT_MAX_CHARS}, keeping head and tail. */
export function capSummaryInput(
  transcript: string,
  maxChars: number = SUMMARY_INPUT_MAX_CHARS,
): string {
  if (transcript.length <= maxChars) return transcript;
  const marker = "\n\n[... middle of the transcript omitted ...]\n\n";
  const budget = maxChars - marker.length;
  if (budget <= 0) return transcript.slice(0, maxChars);
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  return (
    transcript.slice(0, head) + marker + transcript.slice(transcript.length - tail)
  );
}

/** Output token budget for the summary itself. */
const SUMMARY_MAX_OUTPUT_TOKENS = 2_048;

/**
 * Builds a {@link Summarizer} bound to a runtime and model.
 *
 * Returns a function suitable for `compressHistory({ summarize })`; all provider
 * interaction and accounting is contained inside it.
 */
export function createHistorySummarizer(
  runtime: ExecRuntime,
  llm: LlmConfig,
  nodeId: string,
): (middle: ModelMessage[]) => Promise<string | undefined> {
  return async (middle) => {
    const transcript = capSummaryInput(renderTranscript(middle));
    if (transcript.trim() === "") return undefined;

    let model: ReturnType<typeof runtime.llmProviderFactory>;
    try {
      model = runtime.llmProviderFactory(llm, runtime.appConfig, {
        ...(runtime.ctx.providerKeyOverrides !== undefined
          ? { providerKeyOverrides: runtime.ctx.providerKeyOverrides }
          : {}),
      });
    } catch (err) {
      // Fail open — Req 7.8: the caller keeps the full history.
      runtime.metrics.recordCounter("aiperator_degraded_total", {
        component: "history_summarizer",
      });
      if (err instanceof UnknownProviderError) return undefined;
      return undefined;
    }

    const params = filterLlmParameters(
      llm.parameters as Record<string, unknown> | undefined,
      llm.provider,
      llm.model,
    );
    // Temperature 0: the summary is cached and re-emitted verbatim on later
    // turns, so a deterministic result keeps the prompt bytes stable for as long
    // as the covered range is unchanged.
    const temperature = (params?.temperature as number | undefined) ?? 0;

    let text: string;
    let genUsage: { inputTokens?: number; outputTokens?: number } | undefined;
    try {
      const res = await generateText({
        model,
        allowSystemInMessages: true,
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        temperature,
        // Bind the flow's execution deadline — see ExecRuntime.signal. A hung
        // summarizer call would otherwise outlive the engine's timeout.
        ...(runtime.signal !== undefined
          ? { abortSignal: runtime.signal }
          : {}),
      });
      text = res.text;
      genUsage = res.usage;
    } catch {
      // Fail open — caller keeps the full history. Req 7.8.
      runtime.metrics.recordCounter("aiperator_degraded_total", {
        component: "history_summarizer",
      });
      return undefined;
    }

    // Accounting (mirrors rag-compression): estimate when the provider omits
    // usage, which local models routinely do.
    try {
      const finite = (n: number | undefined): number =>
        typeof n === "number" && Number.isFinite(n) ? n : 0;
      let promptTokens = finite(genUsage?.inputTokens);
      let completionTokens = finite(genUsage?.outputTokens);
      if (promptTokens === 0) {
        promptTokens = estimateTokensFromText(
          SUMMARY_SYSTEM_PROMPT + transcript,
        );
      }
      if (completionTokens === 0 && text.length > 0) {
        completionTokens = estimateTokensFromText(text);
      }
      runtime.usage.promptTokens += promptTokens;
      runtime.usage.completionTokens += completionTokens;
      runtime.usage.totalTokens += promptTokens + completionTokens;
      runtime.executionBudget?.addTokens(promptTokens + completionTokens);
      const cost = estimateCost(
        llm.provider,
        llm.model,
        { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
      );
      runtime.metrics.recordLlmCall(
        llm.provider,
        llm.model,
        "ok",
        promptTokens,
        completionTokens,
        cost,
      );
      if (cost > 0) {
        runtime.usage.costUsd = (runtime.usage.costUsd ?? 0) + cost;
        runtime.costTracker?.record(runtime.ctx.clientId, cost, {
          provider: llm.provider,
          model: llm.model,
          promptTokens,
          completionTokens,
          ...buildCostAttribution(runtime.ctx, runtime.flowId),
        });
      }
    } catch {
      /* accounting is best-effort */
    }

    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    runtime.onNodeDiagnostic?.(nodeId, {
      level: "info",
      code: "history_summarized",
      message:
        `Compacted ${middle.length} messages of history into a ` +
        `${trimmed.length}-character summary using ${llm.provider}/${llm.model}.`,
      details: {
        summarizedMessages: middle.length,
        summaryChars: trimmed.length,
        model: `${llm.provider}/${llm.model}`,
      },
    });
    return trimmed;
  };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structured-output path for `llm` nodes (`src/graph/handlers/llm-structured.ts`).
 *
 * A normal `llm` node streams free-form text (with a `<think>` state machine and
 * an agent tool-loop). Some nodes instead must emit ONE schema-conforming JSON
 * object as the assistant message content — e.g. the `userstory-classify` flow,
 * whose `syncReorder` batch caller invokes it with `stream=false` and parses
 * `choices[0].message.content` as JSON. A `classifier` node is the wrong tool
 * for that: it deliberately does NOT emit an assistant message (routing-only).
 *
 * This module implements the schema-enforced generation for an `llm` node that
 * declares `config.outputSchema`. It mirrors the classifier's per-model
 * structured-output strategy (see `handlers/classifier.ts` +
 * `model-capabilities.ts`) but, unlike the classifier, STREAMS the resulting
 * JSON as the node's assistant message content (via `runtime.onToken`) and
 * returns it as an `AIMessage`, so the batch consumer receives it verbatim.
 *
 * Strategy per (provider, model), from the capability registry:
 *   • "response_format"  — `generateText` + an `output` spec (json_schema).
 *                          Enforced by OpenAI-compatible servers (LM Studio /
 *                          Ollama / vLLM). The JSON is read from the response
 *                          TEXT, so text-returning mocks keep working.
 *   • "generateObject"   — the SDK's native structured output (Google
 *                          responseSchema, Claude/Bedrock tool-use).
 *   • "prompt_validate"  — plain `generateText` + a JSON-schema hint appended to
 *                          the system prompt + a tolerant parse. The universal
 *                          fallback and the path for models whose native
 *                          structured output is broken (e.g. Bedrock sonnet-5).
 *
 * No tool-loop, caching, groundedness gate or `<think>` routing applies here —
 * a structured node produces a single JSON object, not a conversational turn.
 *
 * No `any` at module boundaries.
 */
import { AIMessage } from "@langchain/core/messages";
import {
  generateText,
  generateObject,
  NoObjectGeneratedError,
  Output,
  jsonSchema,
} from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import { UnknownProviderError } from "../llm-factory.js";
import {
  applyAnthropicPromptCache,
  applyBedrockPromptCache,
} from "../message-mapping.js";
import { getModelCapabilities } from "../model-capabilities.js";
import {
  estimateCost,
  estimateTokensFromText,
  buildCostAttribution,
} from "../../observability/cost.js";
import { extractJsonFromText } from "../exec-runtime.js";
import type { ExecRuntime } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";

/**
 * Parsed `config.outputSchema` for an `llm` node.
 * `schema` is a JSON Schema (subset the AI SDK's `jsonSchema()` accepts).
 * `name` names the output object (defaults to `"output"`).
 */
export interface LlmOutputSchemaConfig {
  schema: Record<string, unknown>;
  name: string;
}

/**
 * Reads and validates `config.outputSchema` off an `llm` node. Returns
 * `undefined` when absent or malformed (the node then takes the normal
 * streaming path). A malformed schema is treated as "not configured" rather
 * than a hard error so a typo cannot silently break an otherwise-valid node —
 * the streaming path still produces an answer.
 */
export function parseLlmOutputSchema(
  config: Record<string, unknown> | undefined,
): LlmOutputSchemaConfig | undefined {
  const raw = config?.outputSchema;
  if (raw === undefined || raw === null || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const schema = obj.schema;
  if (
    schema === undefined ||
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return undefined;
  }
  const nameRaw = obj.name;
  const name =
    typeof nameRaw === "string" && nameRaw.trim() !== ""
      ? nameRaw.trim()
      : "output";
  return { schema: schema as Record<string, unknown>, name };
}

/**
 * Waits `ms`, returning early if the flow's execution deadline fires. Retries
 * used to hit the provider back-to-back, which turns a server that is briefly
 * confused (a warm-up or a model swap) into three failures instead of one
 * failure and a success. Bound to the abort signal so a pause can never outlive
 * the run it belongs to.
 */
async function delayUnlessAborted(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ms <= 0 || signal?.aborted === true) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Provider usage as reported by the SDK, on success and on a thrown result alike. */
interface StructuredUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** What could be recovered from a thrown `NoObjectGeneratedError`. */
interface SalvagedGeneration {
  text: string;
  usage: StructuredUsage | undefined;
  finishReason: string | undefined;
}

/**
 * Reads the response the SDK attached to a `NoObjectGeneratedError`.
 *
 * `generateText` + an `output` spec (and `generateObject`) throw when the
 * model's text does not STRICTLY parse into the schema — but the SDK still
 * carries the raw `text`, `usage` and `finishReason` on the error. Discarding
 * that turned every near-miss (a code fence, a trailing sentence, a document
 * the server delivered outside `content`) into a failed node AND reported zero
 * tokens for a call that had actually run to completion.
 *
 * Returns `undefined` for any other error, so auth/deadline/transport failures
 * keep their existing behaviour.
 */
function salvageNoObjectGenerated(err: unknown): SalvagedGeneration | undefined {
  if (!NoObjectGeneratedError.isInstance(err)) return undefined;
  return {
    text: typeof err.text === "string" ? err.text : "",
    usage: err.usage as StructuredUsage | undefined,
    finishReason:
      typeof err.finishReason === "string" ? err.finishReason : undefined,
  };
}

/** Inputs for {@link runStructuredLlmOutput}. */
export interface StructuredLlmArgs {
  node: FlowNode;
  llmConfig: LlmConfig;
  runtime: ExecRuntime;
  /** System-prompt-prefixed conversation, already assembled by the llm handler. */
  messages: ModelMessage[];
  temperature: number | undefined;
  maxTokens: number | undefined;
  output: LlmOutputSchemaConfig;
}

/**
 * Runs the schema-enforced generation for an `llm` node and emits the resulting
 * JSON as the node's assistant message content. Returns a `Partial<AgentState>`
 * exactly like the streaming path: `{ currentNodeId, messages: [AIMessage] }`
 * on success, or `{ currentNodeId, errors: [...] }` on failure.
 */
export async function runStructuredLlmOutput(
  args: StructuredLlmArgs,
): Promise<Partial<AgentState>> {
  const { node, llmConfig, runtime, temperature, maxTokens, output } = args;

  let model: LanguageModel;
  try {
    model = runtime.llmProviderFactory(llmConfig, runtime.appConfig, {
      ...(runtime.ctx.providerKeyOverrides !== undefined
        ? { providerKeyOverrides: runtime.ctx.providerKeyOverrides }
        : {}),
    });
  } catch (err) {
    const providerValue =
      err instanceof UnknownProviderError
        ? err.provider
        : String(llmConfig.provider);
    return {
      currentNodeId: node.id,
      errors: [
        {
          message: `Node "${node.id}": unknown LLM provider "${providerValue}".`,
          type: "provider_error",
          details: { node_id: node.id, provider: providerValue },
        },
      ],
    };
  }

  // Per-model structured-output strategy + prompt-cache scheme + whether a
  // system message may ride inside `messages`.
  const caps = getModelCapabilities(llmConfig.provider, llmConfig.model);

  // For the non-enforcing fallback (`prompt_validate`) the provider does NOT
  // constrain the output, so we must tell the model — in the prompt — to emit
  // exactly one JSON object of this shape. `response_format` and
  // `generateObject` enforce the schema natively → no hint needed. When a hint
  // is required we append it to the existing system message (or add one).
  let messages = args.messages;
  if (caps.structuredOutput === "prompt_validate") {
    const hint =
      `\n\nRespond with ONLY a single valid JSON object matching this schema, ` +
      `no prose, no code fences:\n${JSON.stringify(output.schema)}`;
    const first = messages[0];
    if (first !== undefined && first.role === "system") {
      const existing =
        typeof first.content === "string"
          ? first.content
          : JSON.stringify(first.content);
      messages = [
        { role: "system", content: existing + hint } as ModelMessage,
        ...messages.slice(1),
      ];
    } else {
      messages = [
        { role: "system", content: hint.trimStart() } as ModelMessage,
        ...messages,
      ];
    }
  }

  // Prompt-cache the (large, static) system prompt where the provider supports
  // it. No-op for local OpenAI-compatible servers (promptCache: "none").
  const cachedMessages =
    runtime.appConfig.anthropicPromptCacheEnabled !== false
      ? caps.promptCache === "anthropic"
        ? applyAnthropicPromptCache(messages)
        : caps.promptCache === "bedrock"
          ? applyBedrockPromptCache(messages)
          : messages
      : messages;

  const useGenerateObject = caps.structuredOutput === "generateObject";
  const outputSpec =
    caps.structuredOutput === "response_format"
      ? Output.object({
          schema: jsonSchema(output.schema),
          name: output.name,
        })
      : undefined;

  /**
   * A schema-constrained call can come back with nothing usable: the SDK throws
   * `No output generated` when the provider emitted no parsable object, and some
   * OpenAI-compatible servers return an empty `text` with no `output` at all.
   * Both are transient decode failures rather than permanent errors, so the
   * generation is retried a bounded number of times before failing the node.
   * Returning an empty assistant message instead would be worse: the batch
   * consumer would parse `""` as a valid answer.
   *
   * Every attempt is recorded on the node's debug-trace diagnostics timeline.
   * Previously a retry left only a Prometheus counter behind, so a trace showed
   * one node, one response and no hint that the model had been called three
   * times — which makes "the provider was called three times" and "the client
   * submitted the same turn three times" indistinguishable after the fact.
   */
  const maxAttempts = 3;
  /** Bounded pause between attempts, so a momentarily confused server is not hammered. */
  const retryDelayMs = 150;
  let lastEmptyError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      let text = "";
      let genUsage: StructuredUsage | undefined;
      /** Set when the payload came off a thrown NoObjectGeneratedError. */
      let salvaged: SalvagedGeneration | undefined;

      try {
        if (useGenerateObject) {
          const objResult = await generateObject({
            model,
            schema: jsonSchema(output.schema),
            messages: cachedMessages,
            allowSystemInMessages: caps.allowSystemInMessages,
            ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            // Bind the flow's execution deadline — see ExecRuntime.signal.
            ...(runtime.signal !== undefined
              ? { abortSignal: runtime.signal }
              : {}),
          });
          genUsage = objResult.usage;
          text = JSON.stringify(objResult.object);
        } else {
          const genResult = await generateText({
            model,
            messages: cachedMessages,
            allowSystemInMessages: caps.allowSystemInMessages,
            ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
            ...(temperature !== undefined ? { temperature } : {}),
            ...(outputSpec !== undefined ? { output: outputSpec } : {}),
            // Bind the flow's execution deadline — see ExecRuntime.signal.
            ...(runtime.signal !== undefined
              ? { abortSignal: runtime.signal }
              : {}),
          });
          // Prefer the schema-validated object from the enforced output; fall back
          // to the raw text (prompt_validate path, or a server that returned the
          // JSON only as text). If the enforced object is present but `text` is
          // empty (some servers only populate `output`), serialise the object.
          const enforced =
            outputSpec !== undefined
              ? ((genResult as { output?: unknown }).output as
                  | Record<string, unknown>
                  | undefined)
              : undefined;
          if (genResult.text.trim() !== "") {
            text = genResult.text;
          } else if (enforced !== undefined) {
            text = JSON.stringify(enforced);
          } else {
            text = genResult.text;
          }
          genUsage = genResult.usage;
        }
      } catch (genErr) {
        // A strict-parse failure still carries the model's raw response. Keep it
        // when a tolerant parse can make an object out of it; otherwise rethrow
        // and let the retry/fail path below handle it as before.
        const candidate = salvageNoObjectGenerated(genErr);
        const extracted =
          candidate !== undefined ? extractJsonFromText(candidate.text) : null;
        if (candidate === undefined || extracted === null) {
          throw genErr;
        }
        salvaged = candidate;
        // The CANONICAL object, not the raw text: the consumer parses this
        // node's content as JSON, so emitting the code fence / surrounding prose
        // that made the strict parse fail would just move the failure downstream.
        text = JSON.stringify(extracted);
        genUsage = candidate.usage;
      }

      // Nothing usable came back — treat exactly like a thrown decode failure so
      // the retry below applies and an empty message is never emitted.
      if (text.trim() === "") {
        throw new Error("No output generated");
      }

    // Token + cost accounting (mirrors the classifier path). Coerce non-finite
    // provider usage to 0 and estimate from text when the local server omits it.
    // Accounted BEFORE the emit decision: a discarded attempt still consumed
    // provider tokens, and dropping them under-reported the cost of exactly the
    // runs that cost the most.
      const finiteUsage = (n: number | undefined): number =>
        typeof n === "number" && Number.isFinite(n) ? n : 0;
      let promptTokens = finiteUsage(genUsage?.inputTokens);
      let completionTokens = finiteUsage(genUsage?.outputTokens);
      if (promptTokens === 0) {
        const promptText = cachedMessages
          .map((m) =>
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content),
          )
          .join("\n");
        promptTokens = estimateTokensFromText(promptText);
      }
      if (completionTokens === 0 && text.length > 0) {
        completionTokens = estimateTokensFromText(text);
      }
      runtime.usage.promptTokens += promptTokens;
      runtime.usage.completionTokens += completionTokens;
      runtime.usage.totalTokens +=
        genUsage?.totalTokens && genUsage.totalTokens > 0
          ? genUsage.totalTokens
          : promptTokens + completionTokens;
      runtime.setGenAiAttributes?.(node.id, undefined, {
        inputTokens: promptTokens,
        outputTokens: completionTokens,
      });

      const cost = estimateCost(
        llmConfig.provider,
        llmConfig.model,
        { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
      );
      if (cost > 0) {
        runtime.usage.costUsd = (runtime.usage.costUsd ?? 0) + cost;
        runtime.costTracker?.record(runtime.ctx.clientId, cost, {
          provider: llmConfig.provider,
          model: llmConfig.model,
          promptTokens,
          completionTokens,
          ...buildCostAttribution(runtime.ctx, runtime.flowId),
        });
      }

      // A tolerant parse decides whether this attempt produced usable JSON at
      // all. It runs BEFORE the emit: on the `prompt_validate` path the provider
      // does not constrain the output, so the model can answer with prose. That
      // used to be streamed out as the node's "JSON" content with nothing but a
      // counter to show for it, and the consumer then parsed an object that was
      // never there. An unusable result is now retried like any other decode
      // failure, and only the final attempt is emitted as-is.
      const parsed = extractJsonFromText(text);
      const aborted = runtime.signal?.aborted === true;
      if (parsed === null && !aborted && attempt < maxAttempts) {
        runtime.metrics.recordLlmCall(
          llmConfig.provider,
          llmConfig.model,
          "error",
          promptTokens,
          completionTokens,
          cost,
        );
        runtime.metrics.recordCounter(
          "aiperator_llm_structured_unparsable_total",
          { node: node.id, model: llmConfig.model },
        );
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "structured_output_unparsable_retry",
          message:
            `Attempt ${attempt}/${maxAttempts} returned no parsable JSON ` +
            `(${text.length} chars); retrying.`,
          details: {
            attempt,
            max_attempts: maxAttempts,
            provider: String(llmConfig.provider),
            model: llmConfig.model,
            strategy: caps.structuredOutput,
            response_chars: text.length,
          },
        });
        await delayUnlessAborted(retryDelayMs * attempt, runtime.signal);
        continue;
      }

      runtime.metrics.recordLlmCall(
        llmConfig.provider,
        llmConfig.model,
        "ok",
        promptTokens,
        completionTokens,
        cost,
      );

      // Stream the JSON out as the node's assistant content. On stream=false the
      // engine accumulates onToken output into `choices[0].message.content`,
      // which is exactly what the batch consumer parses.
      try {
        await runtime.onToken(node.id, text);
      } catch {
        /* client disconnected — the node still completes and is accounted */
      }

      runtime.onNodeIo?.(node.id, { response: text });
      if (parsed === null) {
        // Final attempt still unusable. Emitted rather than failed (a partial
        // answer beats no answer), but recorded so the trace says why the
        // downstream parse will disappoint.
        runtime.metrics.recordCounter(
          "aiperator_llm_structured_unparsable_total",
          { node: node.id, model: llmConfig.model },
        );
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "structured_output_unparsable",
          message: `No parsable JSON after ${attempt} attempt(s); emitting raw text.`,
          details: {
            attempts: attempt,
            provider: String(llmConfig.provider),
            model: llmConfig.model,
            strategy: caps.structuredOutput,
            response_chars: text.length,
          },
        });
      } else if (salvaged !== undefined) {
        // The provider's strict schema parse rejected the response, but the raw
        // text carried a usable object. Recorded so the trace shows the node
        // succeeded on a tolerant parse rather than on enforced output.
        runtime.metrics.recordCounter(
          "aiperator_llm_structured_salvaged_total",
          { node: node.id, model: llmConfig.model },
        );
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "structured_output_salvaged",
          message:
            `Strict schema parse rejected the response on attempt ${attempt}; ` +
            "recovered a valid JSON object from the raw text.",
          details: {
            attempts: attempt,
            provider: String(llmConfig.provider),
            model: llmConfig.model,
            strategy: caps.structuredOutput,
            response_chars: text.length,
            raw_response_chars: salvaged.text.length,
            ...(salvaged.finishReason !== undefined
              ? { finish_reason: salvaged.finishReason }
              : {}),
          },
        });
      } else if (attempt > 1) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "info",
          code: "structured_output_recovered",
          message: `Structured output succeeded on attempt ${attempt}/${maxAttempts}.`,
          details: {
            attempts: attempt,
            provider: String(llmConfig.provider),
            model: llmConfig.model,
            strategy: caps.structuredOutput,
          },
        });
      }

      return {
        currentNodeId: node.id,
        messages: [new AIMessage(text)],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // What the provider actually returned, when the SDK attached it. Without
      // this a trace showed only "could not parse the response", which cannot
      // distinguish a truncated document (finish_reason "length" → raise
      // maxTokens) from an empty one (nothing in `content` at all).
      const failed = salvageNoObjectGenerated(err);
      const failureDetails: Record<string, unknown> =
        failed !== undefined
          ? {
              response_chars: failed.text.length,
              ...(failed.finishReason !== undefined
                ? { finish_reason: failed.finishReason }
                : {}),
              ...(failed.usage?.outputTokens !== undefined
                ? { output_tokens: failed.usage.outputTokens }
                : {}),
            }
          : {};
      runtime.metrics.recordLlmCall(
        llmConfig.provider,
        llmConfig.model,
        "error",
        0,
        0,
        0,
      );
      // An empty/unparsable structured result is retried; anything else (auth,
      // deadline, unreachable provider) fails immediately — retrying would only
      // burn the run's budget.
      // The SDK words this differently per path ("No output generated" from the
      // `output` spec, "No object generated: could not parse the response." from
      // generateObject), and a local server can also simply return nothing.
      const emptyOutput =
        /no (?:output|object) generated/iu.test(errMsg) ||
        /could not parse the response/iu.test(errMsg);
      const aborted = runtime.signal?.aborted === true;
      if (emptyOutput && !aborted && attempt < maxAttempts) {
        lastEmptyError = err instanceof Error ? err : new Error(errMsg);
        runtime.metrics.recordCounter(
          "aiperator_llm_structured_empty_retry_total",
          { node: node.id, model: llmConfig.model },
        );
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "structured_output_empty_retry",
          message:
            `Attempt ${attempt}/${maxAttempts} produced no output ` +
            `(${errMsg}); retrying.`,
          details: {
            attempt,
            max_attempts: maxAttempts,
            provider: String(llmConfig.provider),
            model: llmConfig.model,
            strategy: caps.structuredOutput,
            error: errMsg,
            ...failureDetails,
          },
        });
        await delayUnlessAborted(retryDelayMs * attempt, runtime.signal);
        continue;
      }
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "structured_output_failed",
        message: `Structured-output generation failed after ${attempt} attempt(s): ${errMsg}`,
        details: {
          attempts: attempt,
          provider: String(llmConfig.provider),
          model: llmConfig.model,
          strategy: caps.structuredOutput,
          aborted,
          retryable: emptyOutput,
          ...failureDetails,
        },
      });
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Node "${node.id}": structured-output generation failed — ${errMsg}`,
            type: "execution_error",
            details: {
              node_id: node.id,
              provider: String(llmConfig.provider),
              model: llmConfig.model,
              attempts: attempt,
            },
          },
        ],
      };
    }
  }

  // Unreachable in practice: the loop either returns a result or returns an
  // error on its final attempt. Kept so the function is total.
  return {
    currentNodeId: node.id,
    errors: [
      {
        message: `Node "${node.id}": structured-output generation failed — ${
          lastEmptyError?.message ?? "No output generated"
        }`,
        type: "execution_error",
        details: {
          node_id: node.id,
          provider: String(llmConfig.provider),
          model: llmConfig.model,
          attempts: maxAttempts,
        },
      },
    ],
  };
}

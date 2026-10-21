// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `classifier` node type handler.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004). A
 * classifier node calls `generateText` and extracts a JSON/XML object from the
 * response. The field nominated by `classifierSchema.classKey` is extracted as
 * `state.classLabel` for downstream routing conditions.
 */
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { generateText, generateObject, Output, jsonSchema } from "ai";
import type { ModelMessage } from "ai";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import { UnknownProviderError, filterLlmParameters } from "../llm-factory.js";
import {
  baseMessagesToModelMessages,
  coreMessagesToText,
  applyAnthropicPromptCache,
  applyBedrockPromptCache,
} from "../message-mapping.js";
import {
  estimateCost,
  estimateTokensFromText,
  buildCostAttribution,
} from "../../observability/cost.js";
import {
  getRuntime,
  extractJsonFromText,
  extractXmlToJson,
  buildXmlSchemaHint,
  buildFallbackClassification,
  resolveContextPlaceholders,
  messagesHaveAttachments,
  lastUserMessageHasAttachments,
  sanitizeSystemMessages,
} from "../exec-runtime.js";
import {
  appendNodeClassification,
  buildClassificationNamespaces,
} from "../classification-access.js";
import { getModelCapabilities } from "../model-capabilities.js";
import { buildPoolCandidateChain, poolSignature } from "../model-pool.js";
import { providerTransportErrorCode } from "../provider-circuit-breaker.js";
import type { AgentState } from "../graph-engine.js";

/**
 * A `classifier` node calls `generateText` and extracts a JSON object from
 * the response. Using generateText instead of generateObject avoids the
 * structured-output / function-calling API that local models (LM Studio,
 * Ollama) often do not support, while being equally compatible with hosted
 * providers (OpenAI, Google, Anthropic).
 *
 * JSON is extracted from the text via three strategies in order:
 *   1. First ```json … ``` fenced code block.
 *   2. First { … } balanced brace span in the text.
 *   3. The entire trimmed text parsed as JSON.
 *
 * The field nominated by `classifierSchema.classKey` is extracted as
 * `state.classLabel` for downstream routing conditions.
 */
export function createClassifierNodeHandler(
  node: FlowNode,
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    const runtime = getRuntime(config);
    if (runtime === undefined) return { currentNodeId: node.id };

    // Attachment gate (mirrors the `llm` handler's `config.inputFilter`): an
    // optional vision-preprocessing classifier (e.g. an image-transcription
    // step ahead of retrieval) runs on EVERY turn otherwise, costing a full
    // LLM round-trip just to answer "no image present". With the filter set,
    // a turn without attachments resolves to `config.fallback` immediately —
    // the same classification a model failure would produce — and the graph
    // continues on the unchanged route. `attachments` looks at the whole
    // conversation, `current-turn-attachments` only at the latest user
    // message (so a checkpointed image from an earlier turn cannot keep the
    // classifier alive in a later text-only turn).
    //
    // Unlike the `llm` handler's silent skip, this node opens its monitoring
    // lifecycle anyway: the fallback classification IS the node's (model-free)
    // result, so the trace shows it completed in ~0 ms with a
    // `classifier_skipped_no_attachments` diagnostic instead of vanishing from
    // the graph — which is what makes "why is this node suddenly fast?"
    // answerable from the trace alone.
    // The gate runs AFTER onNodeStart so both branches (skip and warn) land
    // their diagnostics in the node's current attempt — onNodeStart resets
    // per-attempt trace state (clearNodeAttemptState), which would drop a
    // diagnostic recorded before it.
    runtime.onNodeStart(node.id);

    const inputFilter = (node.config as { inputFilter?: string } | undefined)
      ?.inputFilter;
    if (inputFilter !== undefined) {
      const hasAttachments =
        inputFilter === "current-turn-attachments"
          ? lastUserMessageHasAttachments(state)
          : messagesHaveAttachments(state);
      if (!hasAttachments) {
        const fb = buildFallbackClassification(
          node,
          node.classifierSchema ?? { classKey: "" },
        );
        if (fb !== undefined) {
          runtime.onDebugClassification?.(node.id, {
            response_format:
              ((node.config?.responseFormat as string) ?? "json").toLowerCase(),
            ...(node.classifierSchema !== undefined
              ? { schema: node.classifierSchema.schema }
              : {}),
            raw_output: "",
            parsed: fb.classification,
            class_label: fb.label,
            used_fallback: true,
          });
          runtime.onNodeDiagnostic?.(node.id, {
            level: "info",
            code: "classifier_skipped_no_attachments",
            message: `Classifier node "${node.id}": skipped — no attachments for inputFilter "${inputFilter}"; using config.fallback route "${fb.label}".`,
            details: {
              node_id: node.id,
              input_filter: inputFilter,
              fallback_label: fb.label,
            },
          });
          await runtime.onNodeEnd?.(node.id);
          return {
            currentNodeId: node.id,
            classification: fb.classification,
            classLabel: fb.label,
            turns: appendNodeClassification(
              state.turns,
              node.id,
              fb.classification,
              fb.label,
            ),
          };
        }
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "classifier_input_filter_without_fallback",
          message: `Classifier node "${node.id}": config.inputFilter is set but config.fallback is missing — running the model call instead.`,
          details: { node_id: node.id, input_filter: inputFilter },
        });
      }
    }

    const llmConfig = node.llm ?? runtime.appConfig.defaultLlm;
    if (llmConfig === undefined) {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Classifier node "${node.id}": no LLM configuration.`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    }

    const schema = node.classifierSchema;
    if (schema === undefined) {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Classifier node "${node.id}": no classifierSchema defined.`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    }

    // config.responseFormat selects between "json" (default) and "xml".
    const responseFormat = (
      (node.config?.responseFormat as string) ?? "json"
    ).toLowerCase();

    // Resolve runtime placeholders in the classifier prompt: {{context.*}},
    // {{now.*}} and — non-destructively — {{node.<id>.classification.<field>}}
    // / {{turn[<n>].<id>.classification.<field>}}. At this point state.turns
    // does not yet hold THIS node's output (added on return), so a classifier
    // can reference earlier classifiers of this run (node.*) and previous turns
    // (turn[1..]) but not itself. NOTE: referencing per-turn accessors makes
    // the system prompt vary per turn, which defeats the prompt cache below —
    // only use them in a classifier prompt when that trade-off is intended.
    const resolvedSystemPrompt =
      resolveContextPlaceholders(
        node.systemPrompt,
        state.context,
        buildClassificationNamespaces(state.turns),
      ) ?? "";
    // A classifier running AFTER a tool node with `injectResultContext` (e.g.
    // a folder-listing tool → mode classifier) receives that node's live-result
    // system message inside `state.messages` — mid-conversation, after the
    // human turn. Strict chat templates (vLLM's Qwen: "System message must be
    // at the beginning") reject that with a 500 Jinja error on EVERY pool
    // candidate, so the classifier silently lands on `config.fallback` and the
    // routing decision is worthless (observed in a production trace: every pool
    // candidate failed, used_fallback=true, raw_output=""). The llm handler folds these
    // via `sanitizeSystemMessages` before prepending its prompt; the classifier
    // must apply the same contract.
    const coreMessages = sanitizeSystemMessages(
      baseMessagesToModelMessages(state.messages),
    );

    // Pool support: a node whose shortcut resolved to a POOL carries
    // `llmConfig.pool` (see flows/model-shortcuts.yaml + LlmPoolConfig). The
    // chain is the ordered list of candidates to attempt — configured order for
    // "fallback", rotated per call for "round-robin". Without a pool the chain
    // is exactly [llmConfig], so single-model behaviour is unchanged. Each
    // attempt re-derives its per-model strategy (structured-output mode, prompt
    // cache) from the capability registry, so a mixed pool (local + cloud)
    // routes each member correctly.
    const sticky = llmConfig.pool?.sticky;
    const stickyKey =
      sticky === "conversation"
        ? (runtime.poolSticky?.conversation ?? runtime.poolSticky?.execution)
        : sticky === "execution"
          ? runtime.poolSticky?.execution
          : undefined;
    const poolChain = buildPoolCandidateChain(
      llmConfig,
      `${runtime.flowId ?? ""}/${node.id}/${poolSignature(llmConfig.pool?.candidates ?? [])}`,
      {
        isAvailable: (candidate) =>
          runtime.providerCircuitBreaker?.getState(candidate.provider).state !==
          "open",
        ...(stickyKey !== undefined ? { stickyKey } : {}),
      },
    );
    let lastAttemptError = "classifier model call failed";

    // Debug trace: record the structured classification decision. `schema` and
    // `responseFormat` are in scope for both the success and the catch path.
    const emitClassifierDebug = (
      raw: string,
      parsed: Record<string, unknown> | null,
      label: string | undefined,
      usedFallback: boolean,
    ): void => {
      runtime.onDebugClassification?.(node.id, {
        response_format: responseFormat,
        schema: schema.schema,
        raw_output: raw,
        parsed,
        ...(label !== undefined ? { class_label: label } : {}),
        used_fallback: usedFallback,
      });
    };

    // Safe default route when every candidate failed — shared by the
    // parse-failure, generation-failure and pool-exhausted paths.
    const finishWithFallback = async (
      raw: string,
      reason: string,
    ): Promise<Partial<AgentState>> => {
      const fb = buildFallbackClassification(node, schema);
      if (fb !== undefined) {
        emitClassifierDebug(raw, null, fb.label, true);
        try {
          await runtime.onReasoning(
            node.id,
            `🧭 Route: **${fb.label}** (Fallback — ${reason})\n`,
          );
        } catch {
          /* non-critical */
        }
        return {
          currentNodeId: node.id,
          classification: fb.classification,
          classLabel: fb.label,
          turns: appendNodeClassification(
            state.turns,
            node.id,
            fb.classification,
            fb.label,
          ),
        };
      }
      emitClassifierDebug(raw, null, undefined, false);
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Classifier node "${node.id}": ${reason}`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    };

    for (const [attemptIndex, candidate] of poolChain.entries()) {
      const isPoolFallback = attemptIndex > 0;

      let model: ReturnType<typeof runtime.llmProviderFactory>;
      try {
        model = runtime.llmProviderFactory(candidate, runtime.appConfig, {
          ...(runtime.ctx.providerKeyOverrides !== undefined
            ? { providerKeyOverrides: runtime.ctx.providerKeyOverrides }
            : {}),
        });
      } catch (err) {
        const providerValue =
          err instanceof UnknownProviderError
            ? err.provider
            : String(candidate.provider);
        lastAttemptError = `unknown provider "${providerValue}"`;
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "llm_provider_candidate_failed",
          message: `Classifier node "${node.id}": could not initialize ${candidate.provider}/${candidate.model}.`,
          details: {
            node_id: node.id,
            provider: providerValue,
            candidate_index: attemptIndex,
          },
        });
        continue;
      }

      // Resolve engine×model quirks from the capability registry (replaces the
      // former hardcoded `provider === "openai"` branches). Drives the
      // structured-output strategy, the prompt-cache scheme and whether the
      // system message may ride inside `messages`.
      const caps = getModelCapabilities(candidate.provider, candidate.model);

      // Schema hint in the prompt. XML always gets an example hint. JSON only
      // needs one for the `prompt_validate` strategy — there the provider does
      // NOT enforce the schema (plain generateText + tolerant parse), so we must
      // tell the model to emit exactly one JSON object. `response_format` and
      // `generateObject` enforce the schema natively → no in-prompt hint.
      const schemaHint =
        responseFormat === "xml"
          ? buildXmlSchemaHint(schema.schema)
          : caps.structuredOutput === "prompt_validate"
            ? `\n\nRespond with ONLY a valid JSON object matching this schema, no prose, no code fences:\n${JSON.stringify(
                schema.schema,
              )}`
            : "";
      const systemContent = resolvedSystemPrompt + schemaHint;

      const messagesWithSystem: ModelMessage[] = [
        { role: "system", content: systemContent },
        ...coreMessages,
      ];

      // Surface the resolved classifier prompt to monitoring.
      runtime.onNodeIo?.(node.id, {
        prompt: coreMessagesToText(messagesWithSystem),
      });

      const classifierParams = filterLlmParameters(
        candidate.parameters as Record<string, unknown> | undefined,
        candidate.provider,
        candidate.model,
      );
      const classifierTemperature = classifierParams?.temperature as
        | number
        | undefined;
      const classifierMaxTokens = classifierParams?.maxTokens as
        | number
        | undefined;

      // Prompt-cache the classifier's (large, static) system prompt. A dispatcher
      // classifier runs on EVERY request and carries a big, byte-
      // identical system block (route rules + full client table + JSON schema
      // hint). Marking the system message with an ephemeral cache breakpoint lets
      // Anthropic/Bedrock serve it from cache (~10% input cost on hits) instead of
      // re-billing it every turn. Mirrors the llm-node path; no-op for providers
      // without prompt caching or when disabled via appConfig.
      const cachedMessages =
        runtime.appConfig.anthropicPromptCacheEnabled !== false
          ? caps.promptCache === "anthropic"
            ? applyAnthropicPromptCache(messagesWithSystem)
            : caps.promptCache === "bedrock"
              ? applyBedrockPromptCache(messagesWithSystem)
              : messagesWithSystem
          : messagesWithSystem;

      // Structured-output strategy for JSON classifiers — selected per model from
      // the capability registry, because a single mechanism does not work
      // everywhere:
      //   • "response_format": `generateText` + `output` spec (json_schema). The
      //     object is parsed from the response TEXT (Output.parseCompleteOutput),
      //     so raw `text` stays available and text-returning test mocks keep
      //     working. Enforced by OpenAI-compatible servers (LM Studio / Ollama).
      //   • "generateObject": the SDK's NATIVE structured output (tool-use for
      //     Claude/Bedrock, responseSchema for Google). A prod trace showed
      //     `generateText`+`output` returns EMPTY on Bedrock (silent fallback →
      //     misroute), so those providers must go through generateObject.
      //   • "prompt_validate": plain `generateText` (NO output spec) + a JSON
      //     schema hint in the prompt + tolerant parse. The universal fallback
      //     and the path for models whose native structured output is broken
      //     (e.g. Bedrock claude-sonnet-5 rejects output_config.format).
      // XML classifiers stay on plain `generateText` + extractXmlToJson,
      // regardless of the model's JSON strategy.
      const jsonStrategy =
        responseFormat === "json" ? caps.structuredOutput : undefined;
      const useGenerateObject = jsonStrategy === "generateObject";
      const outputSpec =
        jsonStrategy === "response_format"
          ? Output.object({
              schema: jsonSchema(schema.schema),
              name: "classification",
            })
          : undefined;

      if (isPoolFallback) {
        runtime.metrics.recordLlmFallback(candidate.provider, candidate.model);
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "fallback",
          message: `Classifier falling back to ${candidate.provider}/${candidate.model} after the previous pool candidate failed.`,
          details: {
            node_id: node.id,
            provider: candidate.provider,
            model: candidate.model,
            candidate_index: attemptIndex,
          },
        });
      }

      // With another pool candidate left, fail over immediately instead of
      // letting the AI SDK retry a dead endpoint twice (2 s + 4 s backoff).
      // The last candidate keeps the SDK default retries.
      const sdkRetryOverride =
        attemptIndex < poolChain.length - 1 ? 0 : undefined;
      // Per-execution budget (T-036): checked before each attempt's model
      // call; a call already in flight is never aborted.
      runtime.executionBudget?.check("tokens");
      runtime.executionBudget?.check("wallMs");
      try {
        let text: string;
        let genUsage:
          | {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
            }
          | undefined;
        let structuredObject: Record<string, unknown> | undefined;

        if (useGenerateObject) {
          // Native structured output (schema-enforced) for cloud providers.
          const objResult = await generateObject({
            model,
            schema: jsonSchema(schema.schema),
            messages: cachedMessages,
            // Allow the system message to stay in `messages` (it carries the
            // prompt-cache breakpoint). Without this generateObject rejects it
            // with "System messages are not allowed ... Use the instructions
            // option instead" and every Bedrock classifier would fall back.
            allowSystemInMessages: caps.allowSystemInMessages,
            maxOutputTokens: classifierMaxTokens ?? 512,
            ...(sdkRetryOverride !== undefined ? { maxRetries: sdkRetryOverride } : {}),
            ...(classifierTemperature !== undefined
              ? { temperature: classifierTemperature }
              : undefined),
            // Bind the flow's execution deadline: without this, a hung classifier
            // call outlives the engine's timeout — the graph moves on (or the
            // request ends) while the provider call and its billed tokens keep
            // running. See ExecRuntime.signal for the full reasoning.
            ...(runtime.signal !== undefined
              ? { abortSignal: runtime.signal }
              : {}),
          });
          structuredObject = objResult.object as Record<string, unknown>;
          genUsage = objResult.usage;
          text = JSON.stringify(objResult.object);
        } else {
          const genResult = await generateText({
            model,
            messages: cachedMessages,
            // The system prompt is intentionally carried as the first `messages`
            // entry (the engine merges/orders it to stay provider-valid for
            // Gemma/Mistral). Opt into that explicitly so ai@6 does not emit its
            // "system messages in messages" warning on every classifier call.
            allowSystemInMessages: caps.allowSystemInMessages,
            maxOutputTokens: classifierMaxTokens ?? 512,
            ...(sdkRetryOverride !== undefined ? { maxRetries: sdkRetryOverride } : {}),
            ...(classifierTemperature !== undefined
              ? { temperature: classifierTemperature }
              : undefined),
            ...(outputSpec !== undefined ? { output: outputSpec } : {}),
            // See the generateObject branch above — same deadline-binding reasoning.
            ...(runtime.signal !== undefined
              ? { abortSignal: runtime.signal }
              : {}),
          });
          text = genResult.text;
          genUsage = genResult.usage;
          // Schema-validated object from the enforced output (JSON path).
          // Undefined on the XML path.
          structuredObject =
            outputSpec !== undefined
              ? ((genResult as { output?: unknown }).output as
                  | Record<string, unknown>
                  | undefined)
              : undefined;
        }

        // Surface the raw classifier output to monitoring.
        runtime.onNodeIo?.(node.id, { response: text });

        // Account tokens + cost. Coerce non-finite provider usage (NaN) to 0 so
        // it cannot poison the accumulator and serialize to `null`.
        const finiteUsage = (n: number | undefined): number =>
          typeof n === "number" && Number.isFinite(n) ? n : 0;
        let promptTokens = finiteUsage(genUsage?.inputTokens);
        let completionTokens = finiteUsage(genUsage?.outputTokens);
        // Fallback estimation: local providers (LM Studio, Ollama) often omit
        // usage for generateText. Estimate from input messages + output text so
        // the classifier still contributes to the run's token accounting.
        if (promptTokens === 0) {
          const promptText = messagesWithSystem
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
        runtime.executionBudget?.addTokens(promptTokens + completionTokens);
        // Surface per-node token usage so the live graph / history can show
        // tokens and the estimated per-call cost for this classifier node. The
        // classifier handler does not set the model via the llm-node path, so
        // report it here too — otherwise cost cannot be computed (needs a model).
        // Attribution follows the candidate ACTUALLY used, which under a pool
        // may differ from the node's primary config.
        runtime.setGenAiAttributes?.(
          node.id,
          {
            provider: candidate.provider,
            model: candidate.model,
            operation: "chat",
          },
          {
            inputTokens: promptTokens,
            outputTokens: completionTokens,
          },
        );
        const cost = estimateCost(
          candidate.provider,
          candidate.model,
          { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
        );
        runtime.metrics.recordLlmCall(
          candidate.provider,
          candidate.model,
          "ok",
          promptTokens,
          completionTokens,
          cost,
        );
        if (cost > 0) {
          runtime.usage.costUsd = (runtime.usage.costUsd ?? 0) + cost;
          runtime.costTracker?.record(runtime.ctx.clientId, cost, {
            provider: candidate.provider,
            model: candidate.model,
            promptTokens,
            completionTokens,
            ...buildCostAttribution(runtime.ctx, runtime.flowId),
          });
        }

        const classification: Record<string, unknown> | null =
          responseFormat === "xml"
            ? extractXmlToJson(text, schema.schema)
            : // Prefer the enforced, schema-validated object; fall back to a
              // tolerant text parse for non-enforcing servers / edge cases.
              (structuredObject ?? extractJsonFromText(text));
        if (classification === null) {
          // Could not parse JSON. With pool candidates remaining, treat it as a
          // failed attempt and rotate to the next model (a member that answers
          // in prose instead of schema JSON is a per-model failure, not a
          // flow-level one). Without remaining candidates, fall back to the
          // safe default classification (config.fallback) instead of failing
          // the whole response — unchanged single-model behaviour.
          if (attemptIndex < poolChain.length - 1) {
            lastAttemptError = `could not parse JSON from model output: ${text.slice(0, 200)}`;
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "classifier_unparseable",
              message: `Classifier node "${node.id}": ${candidate.provider}/${candidate.model} returned unparseable output — trying next pool candidate.`,
              details: { node_id: node.id, candidate_index: attemptIndex },
            });
            continue;
          }
          return finishWithFallback(
            text,
            `could not parse JSON from model output: ${text.slice(0, 200)}`,
          );
        }

        const rawLabel = classification[schema.classKey];
        const classLabel =
          typeof rawLabel === "string" ? rawLabel : String(rawLabel ?? "");
        emitClassifierDebug(text, classification, classLabel, false);

        // Do NOT emit classification as a message — it would leak into the SSE
        // stream visible to the client. Store only in state for routing conditions.
        // But DO emit a reasoning_content step so Open WebUI shows it in the
        // collapsible thinking block.
        try {
          await runtime.onReasoning(
            node.id,
            `🧭 Route: **${classLabel}**${classification.client ? ` · client: ${String(classification.client)}` : ""}${classification.needsRag !== undefined ? ` · RAG: ${classification.needsRag ? "yes" : "no"}` : ""}\n`,
          );
        } catch {
          /* non-critical */
        }
        return {
          currentNodeId: node.id,
          classification,
          classLabel,
          turns: appendNodeClassification(
            state.turns,
            node.id,
            classification,
            classLabel,
          ),
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastAttemptError = `generateText failed — ${errMsg}`;
        // Feed the flow's provider circuit like the LLM handler does, so a
        // provider found dead here is skipped by the nodes that follow instead
        // of being probed again.
        const flowAborted = runtime.signal?.aborted === true;
        const transportErrorCode = providerTransportErrorCode(err, { flowAborted });
        if (transportErrorCode !== undefined) {
          runtime.providerCircuitBreaker?.recordTransportFailure(
            candidate.provider,
            transportErrorCode,
          );
        } else if (!flowAborted) {
          runtime.providerCircuitBreaker?.recordReachable(candidate.provider);
        }
        runtime.metrics.recordLlmCall(
          candidate.provider,
          candidate.model,
          "error",
          0,
          0,
          0,
        );
        // Transient provider failure (e.g. LM Studio model swap → 400) or a
        // pool member that is down. With remaining candidates, move to the
        // next one; after the last, fall back to a safe default route instead
        // of failing the whole response.
        if (attemptIndex < poolChain.length - 1) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "classifier_candidate_failed",
            message: `Classifier node "${node.id}": ${candidate.provider}/${candidate.model} failed (${errMsg}) — trying next pool candidate.`,
            details: { node_id: node.id, candidate_index: attemptIndex },
          });
          continue;
        }
        return finishWithFallback("", lastAttemptError);
      }
    }

    // Every pool candidate failed before its try block could produce output
    // (e.g. provider-initialisation errors). Same terminal handling as a
    // generation failure on the last candidate.
    return finishWithFallback("", lastAttemptError);
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "classifier",
  emitsLifecycle: true,
  factory: (node) => createClassifierNodeHandler(node),
};

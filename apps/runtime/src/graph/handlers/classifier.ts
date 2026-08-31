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
} from "../exec-runtime.js";
import {
  appendNodeClassification,
  buildClassificationNamespaces,
} from "../classification-access.js";
import { getModelCapabilities } from "../model-capabilities.js";
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

    runtime.onNodeStart(node.id);

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

    let model: ReturnType<typeof runtime.llmProviderFactory>;
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
            message: `Classifier node "${node.id}": unknown provider "${providerValue}".`,
            type: "provider_error",
            details: { node_id: node.id, provider: providerValue },
          },
        ],
      };
    }

    // Resolve engine×model quirks from the capability registry (replaces the
    // former hardcoded `provider === "openai"` branches). Drives the
    // structured-output strategy, the prompt-cache scheme and whether the
    // system message may ride inside `messages`.
    const caps = getModelCapabilities(llmConfig.provider, llmConfig.model);

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
    const systemContent = resolvedSystemPrompt + schemaHint;

    const coreMessages = baseMessagesToModelMessages(state.messages);
    const messagesWithSystem: ModelMessage[] = [
      { role: "system", content: systemContent },
      ...coreMessages,
    ];

    // Surface the resolved classifier prompt to monitoring.
    runtime.onNodeIo?.(node.id, {
      prompt: coreMessagesToText(messagesWithSystem),
    });

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

    const classifierParams = filterLlmParameters(
      llmConfig.parameters as Record<string, unknown> | undefined,
      llmConfig.provider,
      llmConfig.model,
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

    try {
      let text: string;
      let genUsage:
        | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
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
      // Surface per-node token usage so the live graph / history can show
      // tokens and the estimated per-call cost for this classifier node. The
      // classifier handler does not set the model via the llm-node path, so
      // report it here too — otherwise cost cannot be computed (needs a model).
      runtime.setGenAiAttributes?.(
        node.id,
        {
          provider: llmConfig.provider,
          model: llmConfig.model,
          operation: "chat",
        },
        {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        },
      );
      const cost = estimateCost(
        llmConfig.provider,
        llmConfig.model,
        { prompt_tokens: promptTokens, completion_tokens: completionTokens },
        runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
      );
      runtime.metrics.recordLlmCall(
        llmConfig.provider,
        llmConfig.model,
        "ok",
        promptTokens,
        completionTokens,
        cost,
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

      const classification: Record<string, unknown> | null =
        responseFormat === "xml"
          ? extractXmlToJson(text, schema.schema)
          : // Prefer the enforced, schema-validated object; fall back to a
            // tolerant text parse for non-enforcing servers / edge cases.
            (structuredObject ?? extractJsonFromText(text));
      if (classification === null) {
        // Could not parse JSON — fall back to a safe default classification
        // (config.fallback) instead of failing the whole response.
        const fb = buildFallbackClassification(node, schema);
        if (fb !== undefined) {
          emitClassifierDebug(text, null, fb.label, true);
          try {
            await runtime.onReasoning(
              node.id,
              `🧭 Route: **${fb.label}** (Fallback — Klassifizierung unklar)\n`,
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
        emitClassifierDebug(text, null, undefined, false);
        return {
          currentNodeId: node.id,
          errors: [
            {
              message: `Classifier node "${node.id}": could not parse JSON from model output: ${text.slice(0, 200)}`,
              type: "execution_error",
              details: { node_id: node.id },
            },
          ],
        };
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
      runtime.metrics.recordLlmCall(
        llmConfig.provider,
        llmConfig.model,
        "error",
        0,
        0,
        0,
      );
      // Transient provider failure (e.g. LM Studio model swap → 400). Fall back
      // to a safe default route instead of failing the whole response.
      const fb = buildFallbackClassification(node, schema);
      if (fb !== undefined) {
        emitClassifierDebug("", null, fb.label, true);
        try {
          await runtime.onReasoning(
            node.id,
            `🧭 Route: **${fb.label}** (Fallback — ${errMsg})\n`,
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
      emitClassifierDebug("", null, undefined, false);
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Classifier node "${node.id}": generateText failed — ${errMsg}`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    }
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "classifier",
  emitsLifecycle: true,
  factory: (node) => createClassifierNodeHandler(node),
};

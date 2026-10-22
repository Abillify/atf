// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `llm` node type handler.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004). This is
 * the core streaming-LLM handler: it resolves tools, builds messages, handles
 * caching, retries across a fallback chain, and streams the response with
 * <think> block detection and tool-call passthrough.
 *
 * NOTE: This file exceeds the 800-line target because the streaming loop is
 * inherently coupled to the setup (cache check, tool selection, message
 * building) and cannot be meaningfully split without introducing complex shared
 * state passing. The streaming state machine in particular (think-block
 * detection, pre-tool narration routing, multi-step tool calls, finish-step
 * usage accumulation) forms one atomic unit.
 */

import { AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import type { FlowNode, LlmConfig } from "../../types/flow.js";
import {
  allowsTerminalEmptyResponseFallback,
  reportsStreamFallbacks,
  resolveLlmStreamFallbackPolicy,
} from "../../llm-stream-fallback-policy.js";
import type { LlmStreamFallbackNodeConfig } from "../../llm-stream-fallback-policy.js";

import type { NodeHandlerRegistration } from "../node-handler-registry.js";

import {
  DEFAULT_EMPTY_RESPONSE_FALLBACK,
  type FinalAnswerContractConfig,
} from "./llm-final-answer.js";

import { filterLlmParameters } from "../llm-factory.js";
import { buildClassificationNamespaces } from "../classification-access.js";
import { coreMessagesToText } from "../message-mapping.js";

import { buildPoolCandidateChain, poolSignature } from "../model-pool.js";

import {
  parseRoutingConfig,
  selectModel,
  modelKey as modelKeyOf,
} from "../cost-router.js";
import { parseObjectiveConfig, solveObjective } from "../objective-solver.js";
import type { CachedResponse } from "../response-cache.js";
import { SINGLE_TENANT_SCOPE } from "../response-cache.js";

import {
  sameModel,
  getRuntime,
  resolveContextPlaceholders,
  lastUserQuery,
  messagesHaveAttachments,
  lastUserMessageHasAttachments,
} from "../exec-runtime.js";
import { resolveNodeConfig } from "../graph-engine/node-config.js";
import type { AgentState } from "../graph-engine.js";

import {
  decideRequireToolUse,
  type RequireToolUseConfig,
} from "../require-tool-use.js";
import { resolveToolSequenceContract } from "../tool-sequence-contract.js";

import {
  charsPerTokenFor,
  resolveContextWindow,
} from "../context-window.js";
import { budgetForContextWindow } from "../tool-result-budget.js";
import {
  parseLlmOutputSchema,
  runStructuredLlmOutput,
} from "./llm-structured.js";
import {
  readSafeAssistantRetryToolRefs,
  setupLlmTools,
} from "./llm-tool-setup.js";
import { buildLlmMessages } from "./llm-message-build.js";
import { runCandidateLoop } from "./llm-candidate-loop.js";
import { withCascade } from "../cascade.js";

export function createLlmNodeHandler(
  node: FlowNode,
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    const runtime = getRuntime(config);
    if (runtime === undefined) {
      return { currentNodeId: node.id };
    }

    const inputFilter = (node.config as { inputFilter?: string } | undefined)
      ?.inputFilter;
    if (inputFilter === "attachments" && !messagesHaveAttachments(state)) {
      return { currentNodeId: node.id };
    }
    if (
      inputFilter === "current-turn-attachments" &&
      !lastUserMessageHasAttachments(state)
    ) {
      return { currentNodeId: node.id };
    }

    runtime.onNodeStart(node.id);

    // Per-execution budget: checked before the node's first model
    // call; a call already in flight is never aborted.
    runtime.executionBudget?.check("tokens");
    runtime.executionBudget?.check("wallMs");

    const resolved = resolveNodeConfig(node, state);
    resolved.systemPrompt = resolveContextPlaceholders(
      resolved.systemPrompt,
      state.context,
      buildClassificationNamespaces(state.turns),
    );
    let llmConfig = resolved.llm ?? runtime.appConfig.defaultLlm;

    // Objective-driven routing (`config.objective`) takes precedence over the
    // single-strategy cost-router (`config.routing`) when both are declared —
    // it is a strict generalization of "quality-aware" into an arbitrary
    // constraint list, so a node author moving to it does not need to remove
    // the older config. See `objective-solver.ts` for the full solve
    // semantics (cost-ascending attempts, exploration, bounded fallback).
    const objective = parseObjectiveConfig(node.config);
    const routing = parseRoutingConfig(node.config);
    if (objective !== undefined) {
      const solved = solveObjective(objective, {
        pricing: runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
        ...(runtime.modelQuality !== undefined
          ? { qualityStats: runtime.modelQuality.lookup() }
          : {}),
      });
      llmConfig = solved.selected;
      runtime.metrics.recordCounter("aiperator_objective_solver_total", {
        node: node.id,
        outcome: solved.satisfiedObjective ? "satisfied" : "fallback",
      });
      runtime.onNodeDiagnostic?.(node.id, {
        level: solved.satisfiedObjective ? "info" : "warn",
        code: "objective_solver_attempt",
        message: solved.satisfiedObjective
          ? `Objective-driven routing selected ${modelKeyOf(solved.selected)} (clears every declared objective).`
          : `Objective-driven routing: ${solved.fallbackReason ?? "no candidate satisfied every objective"} Selected ${modelKeyOf(solved.selected)}.`,
        details: {
          selected: modelKeyOf(solved.selected),
          satisfiedObjective: solved.satisfiedObjective,
          fallbackUsed: solved.fallbackUsed,
          attempts: solved.attempts,
        },
      });
    } else if (routing !== undefined) {
      llmConfig = selectModel(routing, {
        pricing: runtime.pricingOverrides ?? runtime.appConfig.llmPricing,
        ...(runtime.modelQuality !== undefined
          ? { qualityStats: runtime.modelQuality.lookup() }
          : {}),
      });
    }

    // Pool selection (`llm.shortcut` → POOL in flows/model-shortcuts.yaml).
    // When the resolved config carries a `pool`, pick the primary candidate
    // NOW — before the response-cache key, temperature/maxTokens extraction
    // and the candidate chain below — so a round-robin rotation is reflected
    // consistently in the cache key, the request parameters and the fallback
    // chain. The remaining pool members become failovers (in configured order
    // for "fallback", wrapped order for "round-robin") at the candidate loop.
    // `config.routing`/`config.objective` above take precedence: they replace
    // llmConfig entirely, which drops any pool by design.
    let poolChain: LlmConfig[] | undefined;
    if (llmConfig?.pool !== undefined) {
      const sticky = llmConfig.pool.sticky;
      const stickyKey =
        sticky === "conversation"
          ? (runtime.poolSticky?.conversation ?? runtime.poolSticky?.execution)
          : sticky === "execution"
            ? runtime.poolSticky?.execution
            : undefined;
      const chain = buildPoolCandidateChain(
        llmConfig,
        `${runtime.flowId ?? ""}/${node.id}/${poolSignature(llmConfig.pool.candidates)}`,
        {
          isAvailable: (candidate) =>
            runtime.providerCircuitBreaker?.getState(candidate.provider)
              .state !== "open",
          ...(stickyKey !== undefined ? { stickyKey } : {}),
        },
      );
      const primary = chain[0];
      if (primary !== undefined) {
        poolChain = chain;
        llmConfig = { ...primary, pool: llmConfig.pool };
      }
    }

    if (llmConfig !== undefined) {
      const key = modelKeyOf(llmConfig);
      state.context.selectedModels ??= [];
      const list = state.context.selectedModels;
      if (!list.includes(key)) list.push(key);
    }

    if (llmConfig === undefined) {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Node "${node.id}": no LLM configuration found and no global default LLM is configured.`,
            type: "execution_error",
            details: { node_id: node.id },
          },
        ],
      };
    }

    runtime.setGenAiAttributes?.(node.id, {
      provider: llmConfig.provider,
      model: llmConfig.model,
      operation: "chat",
      ...(llmConfig.parameters?.temperature !== undefined
        ? { temperature: llmConfig.parameters.temperature }
        : {}),
      ...(llmConfig.parameters?.maxTokens !== undefined
        ? { maxTokens: llmConfig.parameters.maxTokens }
        : {}),
    });

    const {
      aiTools,
      effectiveToolArgsByCallId,
      assistantSessionBinding,
      unavailableTools,
      toolKeyByRef,
      activeToolKeys,
      selectedBoundToolCount,
      selectedBoundToolBestScore,
      selectedBoundToolKeys,
      clientToolKeys,
      imageInspectionEnabled,
      imageInspectionToolName,
    } = await setupLlmTools({ runtime, node, state, resolved });

    const effectiveParams = filterLlmParameters(
      llmConfig.parameters as Record<string, unknown> | undefined,
      llmConfig.provider,
      llmConfig.model,
    );
    const temperature = effectiveParams?.temperature as number | undefined;
    const maxTokens = effectiveParams?.maxTokens as number | undefined;

    // Tool-result budget, scaled to this model's context window. Unknown window
    // → absolute defaults (see budgetForContextWindow), so behaviour is
    // unchanged for models whose window we cannot resolve. A node may override
    // the derived caps via `config.toolResultBudget`.
    const toolResultBudgetOverride = (
      node.config as
        | {
            toolResultBudget?: {
              perResultChars?: number;
              perTurnChars?: number;
            };
          }
        | undefined
    )?.toolResultBudget;
    const derivedToolBudget = budgetForContextWindow(
      resolveContextWindow(llmConfig),
      charsPerTokenFor(llmConfig),
    );
    const toolResultBudget = {
      perResultChars:
        typeof toolResultBudgetOverride?.perResultChars === "number" &&
        toolResultBudgetOverride.perResultChars > 0
          ? Math.floor(toolResultBudgetOverride.perResultChars)
          : derivedToolBudget.perResultChars,
      perTurnChars:
        typeof toolResultBudgetOverride?.perTurnChars === "number" &&
        toolResultBudgetOverride.perTurnChars > 0
          ? Math.floor(toolResultBudgetOverride.perTurnChars)
          : derivedToolBudget.perTurnChars,
    };

    // Opt-in (config.dropRagContext): strip injected RAG/overview system
    // messages before building this node's prompt. Used by a synthesizer that
    // works purely from the carried-forward findings (which already embed the
    // [n] citations) and does NOT need the large COLLECTION OVERVIEW map re-sent —
    // it only inflates the prompt (and, on small local models, risks an empty
    // completion). Citations remain registered for the client regardless.
    const { messagesWithSystemPrompt } = await buildLlmMessages({
      runtime,
      node,
      state,
      resolved,
      llmConfig,
      maxTokens,
      toolResultBudget,
      tools: {
        assistantSessionBinding,
        unavailableTools,
        toolKeyByRef,
        activeToolKeys,
        imageInspectionEnabled,
        imageInspectionToolName,
      },
    });

    const rawFinalAnswerContract = (
      node.config as
        | { finalAnswerContract?: Partial<FinalAnswerContractConfig> }
        | undefined
    )?.finalAnswerContract;
    const finalAnswerContract =
      rawFinalAnswerContract !== undefined &&
      typeof rawFinalAnswerContract.startMarker === "string" &&
      rawFinalAnswerContract.startMarker.length > 0 &&
      typeof rawFinalAnswerContract.endMarker === "string" &&
      rawFinalAnswerContract.endMarker.length > 0 &&
      (rawFinalAnswerContract.streamAfterStartMarker === undefined ||
        typeof rawFinalAnswerContract.streamAfterStartMarker === "boolean") &&
      rawFinalAnswerContract.startMarker !== rawFinalAnswerContract.endMarker &&
      !rawFinalAnswerContract.startMarker.includes(
        rawFinalAnswerContract.endMarker,
      ) &&
      !rawFinalAnswerContract.endMarker.includes(
        rawFinalAnswerContract.startMarker,
      )
        ? (rawFinalAnswerContract as FinalAnswerContractConfig)
        : undefined;
    if (
      rawFinalAnswerContract !== undefined &&
      finalAnswerContract === undefined
    ) {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message: `Node "${node.id}": invalid config.finalAnswerContract`,
            type: "invalid_request_error",
            details: { node_id: node.id },
          },
        ],
      };
    }

    // Structured-output path: when the node declares `config.outputSchema`, it
    // must emit ONE schema-conforming JSON object as its assistant content
    // (schema-enforced via the model's structured-output mode) instead of a
    // free-form streamed turn. Used by non-interactive batch consumers that
    // parse `choices[0].message.content` as JSON (e.g. userstory-classify's
    // syncReorder job). This mode has no tool-loop, cache or think-routing, so
    // it returns early before the streaming setup. A node that both declares
    // outputSchema AND binds tools is a misconfiguration; the schema wins (the
    // model cannot both stream a tool-loop and emit one enforced object).
    const outputSchema = parseLlmOutputSchema(
      node.config as Record<string, unknown> | undefined,
    );
    if (outputSchema !== undefined) {
      if (finalAnswerContract !== undefined) {
        return {
          currentNodeId: node.id,
          errors: [
            {
              message:
                `Node "${node.id}": config.outputSchema and ` +
                "config.finalAnswerContract cannot be combined",
              type: "invalid_request_error",
              details: { node_id: node.id },
            },
          ],
        };
      }
      // Build the same ordered failover chain the streaming path uses: the
      // pool's candidates (primary first, already rotated for round-robin) plus
      // the deployment-wide fallback model/chain. Passing it lets the structured
      // path fail over to a reachable provider instead of dying on an
      // unreachable pool primary (e.g. an offline local llama.cpp endpoint).
      const structuredCandidates: LlmConfig[] = poolChain
        ? poolChain.map((c) => ({ ...c, pool: undefined }))
        : [llmConfig];
      if (
        runtime.appConfig.fallbackLlm &&
        !sameModel(runtime.appConfig.fallbackLlm, llmConfig)
      ) {
        structuredCandidates.push(runtime.appConfig.fallbackLlm);
      }
      for (const chainEntry of runtime.appConfig.fallbackChain ?? []) {
        if (!structuredCandidates.some((c) => sameModel(c, chainEntry))) {
          structuredCandidates.push(chainEntry);
        }
      }
      return runStructuredLlmOutput({
        node,
        llmConfig,
        candidates: structuredCandidates,
        runtime,
        messages: messagesWithSystemPrompt,
        temperature,
        maxTokens,
        output: outputSchema,
      });
    }

    // Response caching
    //
    // `tenantScope` binds every cache entry to the requesting tenant (falling
    // back to the user, then to a fixed single-tenant sentinel). Without this a
    // cache hit — exact OR semantic — could return one tenant's response
    // (including any RAG/grounding context embedded in it) to another tenant.
    // See the cross-tenant-leak finding this closes: response-cache.ts /
    // semantic-cache.ts previously namespaced ONLY by provider/model/params.
    const tenantScope =
      runtime.ctx.clientId ?? runtime.ctx.userId ?? SINGLE_TENANT_SCOPE;
    const hasTools = aiTools !== undefined && Object.keys(aiTools).length > 0;
    if (finalAnswerContract !== undefined && hasTools) {
      return {
        currentNodeId: node.id,
        errors: [
          {
            message:
              `Node "${node.id}": config.finalAnswerContract requires a ` +
              "tool-less LLM node",
            type: "invalid_request_error",
            details: { node_id: node.id },
          },
        ],
      };
    }
    const exactCache = runtime.responseCache;
    const semCache = runtime.semanticCache;
    // Contract-bound answers deliberately bypass response caches. Existing
    // entries predate the marker boundary and cannot be proven clean; disabling
    // lookup and storage prevents both exact and semantic legacy hits.
    const cacheable =
      finalAnswerContract === undefined &&
      (exactCache?.isCacheable({ hasTools, temperature }) ||
        semCache?.isCacheable({ hasTools, temperature }));
    const cacheKeyInput = cacheable
      ? {
          provider: llmConfig.provider,
          model: llmConfig.model,
          ...(temperature !== undefined ? { temperature } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          messages: messagesWithSystemPrompt,
          tenantScope,
        }
      : undefined;
    const semKeyInput =
      cacheable && semCache !== undefined
        ? {
            provider: llmConfig.provider,
            model: llmConfig.model,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            text: coreMessagesToText(messagesWithSystemPrompt),
            tenantScope,
          }
        : undefined;

    if (cacheable) {
      const emitExactCacheHit = async (
        hit: CachedResponse,
      ): Promise<Partial<AgentState>> => {
        runtime.metrics.recordCache("exact-hit");
        try {
          await runtime.onToken(node.id, hit.text);
        } catch {
          /* disconnect */
        }
        runtime.usage.promptTokens += hit.usage.promptTokens;
        runtime.usage.completionTokens += hit.usage.completionTokens;
        runtime.usage.totalTokens += hit.usage.totalTokens;
        runtime.executionBudget?.addTokens(
          hit.usage.promptTokens + hit.usage.completionTokens,
        );
        runtime.setGenAiAttributes?.(node.id, undefined, {
          inputTokens: hit.usage.promptTokens,
          outputTokens: hit.usage.completionTokens,
        });
        return { currentNodeId: node.id, messages: [new AIMessage(hit.text)] };
      };
      const emitSemanticCacheHit = async (
        hit: CachedResponse,
      ): Promise<Partial<AgentState>> => {
        runtime.metrics.recordCache("semantic-hit");
        try {
          await runtime.onToken(node.id, hit.text);
        } catch {
          /* disconnect */
        }
        runtime.usage.promptTokens += hit.usage.promptTokens;
        runtime.usage.completionTokens += hit.usage.completionTokens;
        runtime.usage.totalTokens += hit.usage.totalTokens;
        runtime.executionBudget?.addTokens(
          hit.usage.promptTokens + hit.usage.completionTokens,
        );
        runtime.setGenAiAttributes?.(node.id, undefined, {
          inputTokens: hit.usage.promptTokens,
          outputTokens: hit.usage.completionTokens,
        });
        return { currentNodeId: node.id, messages: [new AIMessage(hit.text)] };
      };

      if (exactCache !== undefined && cacheKeyInput !== undefined) {
        const hit = await exactCache.get(cacheKeyInput);
        if (hit !== undefined) return emitExactCacheHit(hit);
      }
      if (semCache !== undefined && semKeyInput !== undefined) {
        const hit = await semCache.get(semKeyInput);
        if (hit !== undefined) return emitSemanticCacheHit(hit);
      }
      runtime.metrics.recordCache("miss");
    }

    // Candidate models with retry + fallback
    const maxAttempts = runtime.appConfig.llmMaxAttempts ?? 3;
    const backoffMs = runtime.appConfig.llmRetryBackoffMs ?? 500;
    const requestTimeoutMs = runtime.appConfig.llmRequestTimeoutMs ?? 600_000;
    const configuredMaxOutputChars = (
      node.config as { maxOutputChars?: number } | undefined
    )?.maxOutputChars;
    const maxOutputChars =
      typeof configuredMaxOutputChars === "number" &&
      Number.isFinite(configuredMaxOutputChars) &&
      configuredMaxOutputChars > 0
        ? Math.floor(configuredMaxOutputChars)
        : (runtime.appConfig.llmMaxOutputChars ?? 64_000);
    const streamFallbackPolicy = resolveLlmStreamFallbackPolicy(
      runtime.appConfig.llmStreamFallbackPolicy,
    );
    const streamFallbackNodeConfig = node.config as
      | LlmStreamFallbackNodeConfig
      | undefined;
    const reportStreamFallback = (
      reason:
        | "reasoning_salvage"
        | "empty_response_fallback"
        | "require_tool_use_released"
        | "require_tool_use_history_copy_fallback",
      details?: Record<string, unknown>,
    ): void => {
      if (!reportsStreamFallbacks(streamFallbackPolicy)) return;
      runtime.metrics.recordCounter("aiperator_stream_fallback_total", {
        kind: "semantic",
        reason,
      });
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "stream_fallback_report",
        message: `Semantic stream fallback applied: ${reason}.`,
        details: {
          kind: "semantic",
          reason,
          policy: streamFallbackPolicy,
          ...details,
        },
      });
    };
    // See `require-tool-use.ts` for the policy: an authored contract
    // (`requireToolUse`) is enforced to the point of failing the node, while a
    // requirement merely inferred from semantic tool selection degrades to a
    // plain answer once the nudges are spent.
    const requireToolUseDecision = decideRequireToolUse({
      config: node.config as RequireToolUseConfig | undefined,
      selectedBoundToolCount,
      selectedBoundToolBestScore,
      query: lastUserQuery(state),
      safeRetryToolOverride: readSafeAssistantRetryToolRefs(
        runtime.ctx.requestParams,
      ).some((ref) => toolKeyByRef[ref] !== undefined),
    });
    const toolSequenceContract = resolveToolSequenceContract(
      node.config,
      lastUserQuery(state),
    );
    // A declared tool sequence marks a consequential action. Its answer is
    // only meaningful when each configured tool succeeded in order this turn.
    const requireToolUse =
      requireToolUseDecision.required || toolSequenceContract !== undefined;
    const requireToolUseMandatory =
      requireToolUseDecision.mandatory || toolSequenceContract !== undefined;
    // Candidate models with retry + fallback.
    //
    // When the node's shortcut resolved to a POOL, the chain starts with the
    // pool's ordered candidates (primary first — already rotated for
    // round-robin above, so `llmConfig` IS `poolChain[0]`), followed by the
    // deployment-wide fallback model/chain as last-resort failovers. Without a
    // pool the chain is exactly the previous `[llmConfig]`, so behaviour is
    // unchanged.
    const candidates: LlmConfig[] = poolChain
      ? poolChain.map((c) => ({ ...c, pool: undefined }))
      : [llmConfig];
    if (
      runtime.appConfig.fallbackLlm &&
      !sameModel(runtime.appConfig.fallbackLlm, llmConfig)
    ) {
      candidates.push(runtime.appConfig.fallbackLlm);
    }
    for (const chainEntry of runtime.appConfig.fallbackChain ?? []) {
      if (!candidates.some((c) => sameModel(c, chainEntry))) {
        candidates.push(chainEntry);
      }
    }

    const loop = await runCandidateLoop({
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
    });
    if (loop.done) return loop.value;
    let lastErrMsg = loop.lastErrMsg;
    const providerAttemptCount = loop.providerAttemptCount;
    const policySuppressedToolFallback = loop.policySuppressedToolFallback;
    const circuitSkippedProviders = loop.circuitSkippedProviders;

    if (providerAttemptCount === 0 && circuitSkippedProviders.length > 0) {
      lastErrMsg = `all configured provider circuits were open: ${circuitSkippedProviders.join(", ")}`;
    }

    // Opt-in graceful degradation at the terminal exhaustion point.
    //
    // The clean `!emittedAny` branch above only reaches its fallback when the
    // FINAL attempt of the FINAL candidate completes the stream and then finds
    // no output. But retries can also be exhausted through the `catch (err)`
    // path — every attempt's stream THREW (an empty-completion StreamErrorSignal,
    // a provider stream error, the repetition-guard AbortController, or a forced
    // tool call the model refused). In that case we land here with the strict
    // provider_error, bypassing the fallback entirely. When a node opted into
    // `config.emptyResponseFallback`, that hard failure is exactly what we must
    // avoid: it propagates out of an agent-harness worker and marks the whole
    // run errored even though downstream nodes (e.g. the synthesizer) could
    // still assemble a best-effort answer from the findings gathered so far
    // (trace 85a4ebf1: two researcher delegations exhausted their retries with
    // "empty LLM response" and errored the orchestrator while the synthesizer
    // completed). So mirror the clean-path behaviour here: emit the configured
    // fallback answer as a COMPLETED turn instead of an error. Non-opted nodes
    // keep the strict provider_error so genuine failures still surface.
    const terminalEmptyCfg = node.config as
      | { emptyResponseFallback?: boolean; emptyResponseFallbackText?: string }
      | undefined;
    if (
      allowsTerminalEmptyResponseFallback(
        streamFallbackPolicy,
        terminalEmptyCfg,
        policySuppressedToolFallback,
      )
    ) {
      const fallbackText =
        typeof terminalEmptyCfg?.emptyResponseFallbackText === "string" &&
        terminalEmptyCfg.emptyResponseFallbackText.trim().length > 0
          ? terminalEmptyCfg.emptyResponseFallbackText
          : DEFAULT_EMPTY_RESPONSE_FALLBACK;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "empty_response_fallback",
        message:
          `${providerAttemptCount} provider call(s) completed without a usable ` +
          "response; emitting the configured fallback answer instead of failing " +
          `the node — ${lastErrMsg}`,
        details: {
          node_id: node.id,
          phase: "terminal-fallback",
          last_error: lastErrMsg,
          actual_provider_attempts: providerAttemptCount,
          circuit_skipped_providers: circuitSkippedProviders,
          candidates: candidates.map(
            (candidate) => `${candidate.provider}/${candidate.model}`,
          ),
          max_attempts_per_candidate: maxAttempts,
        },
      });
      reportStreamFallback("empty_response_fallback", {
        phase: "terminal-fallback",
      });
      try {
        await runtime.onToken(node.id, fallbackText);
      } catch {
        /* disconnect */
      }
      runtime.onNodeIo?.(node.id, { response: fallbackText });
      return {
        currentNodeId: node.id,
        messages: [
          new AIMessage({
            content: fallbackText,
            additional_kwargs: {
              aiperator_empty_response_fallback: true,
            },
          }),
        ],
      };
    }

    return {
      currentNodeId: node.id,
      errors: [
        {
          message: `Node "${node.id}": LLM call failed after ${providerAttemptCount} actual provider call(s) — ${lastErrMsg}`,
          type: "provider_error",
          details: {
            node_id: node.id,
            phase: "provider-exhausted",
            last_error: lastErrMsg,
            actual_provider_attempts: providerAttemptCount,
            circuit_skipped_providers: circuitSkippedProviders,
            candidates: candidates.map(
              (candidate) => `${candidate.provider}/${candidate.model}`,
            ),
            max_attempts_per_candidate: maxAttempts,
          },
        },
      ],
    };
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "llm",
  emitsLifecycle: true,
  factory: (node) => withCascade(node, createLlmNodeHandler),
};

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
import crypto from "node:crypto";
import { AIMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { streamText, stepCountIs } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type {
  FlowNode,
  LlmConfig,
  ImageInspectionConfig,
} from "../../types/flow.js";
import {
  allowsEmptyResponseFallback,
  allowsTerminalEmptyResponseFallback,
  allowsInferredToolUseFallback,
  allowsReasoningSalvage,
  reportsStreamFallbacks,
  resolveLlmStreamFallbackPolicy,
} from "../../llm-stream-fallback-policy.js";
import type { LlmStreamFallbackNodeConfig } from "../../llm-stream-fallback-policy.js";
import { isBudgetExceededError } from "../../transaction/budget.js";
import {
  isAssistantContextFrame,
  stripLeakedContextEcho,
} from "../../assistants/context-frame.js";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { McpWrapperService } from "../../mcp/mcp-wrapper.js";
import type { RequestContext } from "../../types/monitoring.js";
import { decodeBase64Bytes } from "../media-store.js";
import {
  describePromptSchemaIssues,
  describeProviderError,
  formatPromptSchemaIssue,
  providerTransportErrorCode,
} from "../provider-circuit-breaker.js";
import { filterLlmParameters } from "../llm-factory.js";
import { buildClassificationNamespaces } from "../classification-access.js";
import {
  baseMessagesToModelMessages,
  aiResponseMessagesToBaseMessages,
  sanitizeReasoningSentinelModelMessages,
  stripReasoningSentinelMarkers,
  applyAnthropicPromptCache,
  applyBedrockPromptCache,
  coreMessagesToText,
  modelMessagesContainImages,
  isToolErrorOutput,
  sanitizeToolResultOutput,
  sanitizeToolResultModelMessages,
  toolErrorExcerpt,
  sanitizeToolCallModelMessages,
} from "../message-mapping.js";
import { getModelCapabilities } from "../model-capabilities.js";
import { buildPoolCandidateChain, poolSignature } from "../model-pool.js";
import {
  buildAiTools,
  buildMediaTools,
  buildImageInspectionTools,
  buildClientTools,
  buildToolSelectionMetaTool,
  mapToolChoice,
  uniqueMediaToolKey,
} from "../agent-tools.js";
import {
  offloadInlineImages,
  inlineImageBytes,
  IMAGE_INSPECTION_TOOL_NAME,
} from "../image-reference.js";
import {
  parseToolSelection,
  expandPatterns,
  buildGroupSummary,
} from "../tool-selection.js";
import {
  parseRoutingConfig,
  selectModel,
  modelKey as modelKeyOf,
} from "../cost-router.js";
import { parseObjectiveConfig, solveObjective } from "../objective-solver.js";
import type { CachedResponse } from "../response-cache.js";
import { SINGLE_TENANT_SCOPE } from "../response-cache.js";
import {
  estimateCost,
  estimateTokensFromText,
  buildCostAttribution,
} from "../../observability/cost.js";
import {
  sleep,
  fullJitter,
  sameModel,
  getRuntime,
  sanitizeSystemMessages,
  stripUnsignedGeminiToolHistory,
  ensureValidConversationStart,
  ensureTrailingUserTurn,
  resolveContextPlaceholders,
  lastUserQuery,
  messagesHaveAttachments,
  lastUserMessageHasAttachments,
  deduplicateRagContext,
  isRagContextMessage,
  maskRagContextForModel,
  trimConversationHistory,
  dedupeGuidanceListLines,
  attachVolatileGuidance,
  combineAbortSignals,
} from "../exec-runtime.js";
import { resolveNodeConfig } from "../graph-engine/node-config.js";
import type { AgentState } from "../graph-engine.js";
import {
  detectRepeatedTail,
  REPETITION_CHECK_INTERVAL,
} from "../repetition-guard.js";
import {
  decideRequireToolUse,
  type RequireToolUseConfig,
} from "../require-tool-use.js";
import { resolveToolSequenceContract } from "../tool-sequence-contract.js";
import {
  detectToolLoop,
  hashToolArgs,
  isFailedOutcome,
  looksMutating,
  recordToolCall,
  recordToolOutcome,
  shouldEmitLoopWarning,
  type ToolLoopDetectionConfig,
} from "../tool-loop-detection.js";
import {
  promptPrefixTracker,
  streamKey,
} from "../prompt-prefix-stability.js";
import {
  clampMaxOutputTokens,
  estimateMessagesTokens,
  measureContextPressure,
  resolveContextWindow,
  truncateMessagesToWindow,
} from "../context-window.js";
import {
  compressHistory,
  dedupeRepeatedToolResults,
  effectiveThresholdRatio,
} from "../history-compression.js";
import { createHistorySummarizer } from "../history-summarizer.js";
import {
  applyToolResultBudget,
  applyToolResultBudgetToHistory,
  budgetForContextWindow,
} from "../tool-result-budget.js";
import {
  parseLlmOutputSchema,
  runStructuredLlmOutput,
} from "./llm-structured.js";
import { resolveAssistantScope } from "../../assistants/types.js";

const SAFE_ASSISTANT_RETRY_TOOL_REFS = new Set([
  "parking/status",
  "parking/availability",
]);

function readSafeAssistantRetryToolRefs(
  requestParams: Record<string, unknown> | undefined,
): string[] {
  const raw = requestParams?.assistant_retry_tool_refs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (ref): ref is string =>
      typeof ref === "string" && SAFE_ASSISTANT_RETRY_TOOL_REFS.has(ref),
  );
}

// ---------------------------------------------------------------------------
// Asset fetch for `inspect_image` (Req 16.3)
// ---------------------------------------------------------------------------

/** Config block that enables `asset:<id>[#bbox]` resolution. */
type AssetSourceConfig = NonNullable<ImageInspectionConfig["assetSource"]>;

/** One MCP content part, in the shape `get_asset` returns image bytes as. */
interface McpImagePart {
  type: string;
  data?: unknown;
  mimeType?: unknown;
}

/**
 * Extracts the first image part (base64 `data` + `mimeType`) from an MCP tool
 * result's `content` array. Returns `undefined` when the result carries no
 * decodable image — which is exactly what a fail-closed `get_asset` returns for
 * an unauthorized/unknown asset (an `isError` text-only result). Never throws.
 */
function extractMcpImage(
  content: unknown,
): { bytes: Uint8Array; mediaType: string } | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const part = raw as McpImagePart;
    if (part.type !== "image") continue;
    if (typeof part.data !== "string") continue;
    const mediaType =
      typeof part.mimeType === "string" && part.mimeType !== ""
        ? part.mimeType
        : "image/png";
    const bytes = decodeBase64Bytes(part.data);
    if (bytes === undefined || bytes.byteLength === 0) continue;
    return { bytes, mediaType };
  }
  return undefined;
}

/**
 * Builds the `fetchAsset` hook the `inspect_image` tool uses to resolve an
 * `asset:<id>[#bbox]` reference (Req 16.3). It calls the configured MCP server's
 * `get_asset` tool with the caller's request context, so the read inherits
 * `get_asset`'s tenant/collection/row ACL and fail-closed behaviour (task 3.9),
 * and returns only the decoded image bytes — the responder model never sees the
 * base64. A `region` triggers `get_asset`'s server-side zoom crop; a whole-asset
 * fetch uses the configured `variant`. Any error or an image-less result yields
 * `undefined`, which the tool reports as a fail-closed `unknown_image`.
 */
function buildAssetFetch(
  mcpWrapper: McpWrapperService,
  ctx: RequestContext,
  assetSource: AssetSourceConfig,
  signal?: AbortSignal,
): (
  assetId: string,
  opts: { region?: [number, number, number, number] },
) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
  return async (assetId, opts) => {
    const args: Record<string, unknown> = { asset_id: assetId };
    if (assetSource.collection !== undefined) {
      args.collection = assetSource.collection;
    }
    if (opts.region !== undefined) {
      args.region = opts.region;
    } else if (assetSource.variant !== undefined) {
      args.variant = assetSource.variant;
    }
    let result: Awaited<ReturnType<McpWrapperService["callTool"]>>;
    try {
      result = await mcpWrapper.callTool(
        assetSource.server,
        "get_asset",
        args,
        ctx,
        signal !== undefined ? { signal } : undefined,
      );
    } catch {
      // Fail closed: a transport/tool error must not crash the inspection or
      // leak its cause. The tool treats undefined as an unavailable asset.
      return undefined;
    }
    if (result.isError === true) return undefined;
    return extractMcpImage(result.content);
  };
}

// ---------------------------------------------------------------------------
// Require-tool-use history-copy guard
// ---------------------------------------------------------------------------

const HISTORY_COPY_MIN_CHARS = 40;
const HISTORY_COPY_MIN_SHARED_TOKENS = 8;

/**
 * Decoded inline-image bytes we are willing to keep shipping in a prompt before
 * it becomes a trace-level warning. A single phone photo is ~2–4 MB, so this
 * fires on the first attachment — which is exactly when the cost of re-sending
 * it on every turn of a long conversation starts to matter.
 */
const PROMPT_INLINE_IMAGE_WARN_BYTES = 1_500_000;

function normalizeHistoryCopyText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Finds a plain historical assistant answer that the current text substantially
 * reproduces. This deliberately ignores structured assistant tool-call messages:
 * removing one side of a tool pair would make the provider history invalid.
 */
function findCopiedAssistantHistoryIndex(
  text: string,
  messages: readonly ModelMessage[],
): number | undefined {
  const normalized = normalizeHistoryCopyText(text);
  if (normalized.length < HISTORY_COPY_MIN_CHARS) return undefined;

  const currentTokens = new Set(normalized.match(/[\p{L}\p{N}_-]+/gu) ?? []);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || typeof message.content !== "string") {
      continue;
    }
    const historical = normalizeHistoryCopyText(message.content);
    if (historical.length < HISTORY_COPY_MIN_CHARS) continue;
    if (normalized === historical || normalized.includes(historical) || historical.includes(normalized)) {
      return index;
    }

    const historicalTokens = new Set(historical.match(/[\p{L}\p{N}_-]+/gu) ?? []);
    let shared = 0;
    for (const token of currentTokens) {
      if (historicalTokens.has(token)) shared += 1;
    }
    const smallerSize = Math.min(currentTokens.size, historicalTokens.size);
    const unionSize = currentTokens.size + historicalTokens.size - shared;
    if (
      shared >= HISTORY_COPY_MIN_SHARED_TOKENS &&
      smallerSize > 0 &&
      shared / smallerSize >= 0.5 &&
      unionSize > 0 &&
      shared / unionSize >= 0.25
    ) {
      return index;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pre-tool-call preamble: bounded lookahead
// ---------------------------------------------------------------------------

/**
 * Max time (ms) after the first preamble delta before we give up waiting for
 * a tool call and resolve the buffered text as the real answer.
 */
const PREAMBLE_MAX_MS = 400;

/** Max buffered preamble characters before forcing resolution as content. */
const PREAMBLE_MAX_CHARS = 200;

/** Matches a sentence-ending boundary at the end of the buffered preamble. */
const PREAMBLE_SENTENCE_BOUNDARY_RE = /[.!?][\s"'”)\]]*$/;

/**
 * Default visible answer used when `config.emptyResponseFallback` is enabled and
 * every attempt (and fallback candidate) came back with an empty completion —
 * no visible text, no salvageable reasoning, no tool call. Overridable per node
 * via `config.emptyResponseFallbackText`. Kept short and neutral so a downstream
 * synthesizer treats the step as "produced nothing" rather than choking on it.
 */
const DEFAULT_EMPTY_RESPONSE_FALLBACK =
  "(No answer was produced for this step.)";

interface FinalAnswerContractConfig {
  startMarker: string;
  endMarker: string;
  streamAfterStartMarker?: boolean;
}

type FinalAnswerExtraction =
  | { ok: true; answer: string }
  | {
      ok: false;
      reason:
        | "missing_start_marker"
        | "missing_end_marker"
        | "duplicate_start_marker"
        | "duplicate_end_marker"
        | "misordered_markers"
        | "empty_final_answer"
        | "placeholder_final_answer";
    };

/** Rejects marker content that can never be a useful final answer. */
function isFinalAnswerPlaceholder(answer: string): boolean {
  // Models occasionally wrap a placeholder in an inline or fenced Markdown code
  // span. Strip only the outer backticks so normal Markdown prose is untouched.
  const normalized = answer
    .trim()
    .replace(/^`+\s*/u, "")
    .replace(/\s*`+$/u, "")
    .replace(/\s+/gu, "");
  return /^(?:\.\.\.|…|[-–—]+)$/u.test(normalized);
}

/**
 * Live output is irreversible. Delay symbol-only candidates until the end
 * marker, where the full contract can reject placeholders such as `...`.
 * Short legitimate answers (for example "Ja.") still stream as soon as a
 * letter or digit arrives; symbol-only answers remain valid but are emitted
 * once their complete marker pair is verified.
 */
function hasFinalAnswerStreamingSubstance(answer: string): boolean {
  return /[\p{L}\p{N}]/u.test(answer);
}

/**
 * Extract exactly one non-empty, non-placeholder answer enclosed by the configured markers.
 * Anything before/after the pair is deliberately discarded: it may be model
 * planning emitted through the ordinary content channel rather than a native
 * reasoning channel. Ambiguous output fails closed instead of guessing which
 * segment is safe to show.
 */
function extractFinalAnswer(
  raw: string,
  contract: FinalAnswerContractConfig,
): FinalAnswerExtraction {
  const start = raw.indexOf(contract.startMarker);
  if (start === -1) return { ok: false, reason: "missing_start_marker" };
  if (raw.indexOf(contract.startMarker, start + 1) !== -1) {
    return { ok: false, reason: "duplicate_start_marker" };
  }

  const firstEnd = raw.indexOf(contract.endMarker);
  const end = raw.indexOf(
    contract.endMarker,
    start + contract.startMarker.length,
  );
  if (end === -1) return { ok: false, reason: "missing_end_marker" };
  if (firstEnd !== end) return { ok: false, reason: "misordered_markers" };
  if (raw.indexOf(contract.endMarker, end + 1) !== -1) {
    return { ok: false, reason: "duplicate_end_marker" };
  }

  const answer = raw
    .slice(start + contract.startMarker.length, end)
    .trim();
  if (answer.length === 0) {
    return { ok: false, reason: "empty_final_answer" };
  }
  return isFinalAnswerPlaceholder(answer)
    ? { ok: false, reason: "placeholder_final_answer" }
    : { ok: true, answer };
}

function longestMarkerPrefixSuffix(
  text: string,
  markers: readonly string[],
): number {
  let longest = 0;
  for (const marker of markers) {
    const max = Math.min(text.length, marker.length - 1);
    for (let length = max; length > longest; length--) {
      if (text.endsWith(marker.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

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
      const chain = buildPoolCandidateChain(
        llmConfig,
        `${runtime.flowId ?? ""}/${node.id}/${poolSignature(llmConfig.pool.candidates)}`,
        {
          isAvailable: (candidate) =>
            runtime.providerCircuitBreaker?.getState(candidate.provider)
              .state !== "open",
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

    let aiTools: ToolSet | undefined;
    const effectiveToolArgsByCallId = new Map<
      string,
      Record<string, unknown>
    >();
    const assistantSessionBinding = (() => {
      if (runtime.assistants === undefined) return undefined;
      const resolution = resolveAssistantScope({
        tenantId: runtime.ctx.clientId,
        userId: runtime.ctx.userId ?? runtime.ctx.userEmail,
        assistantId:
          typeof runtime.ctx.requestParams?.assistant_id === "string"
            ? runtime.ctx.requestParams.assistant_id
            : undefined,
      });
      if (!resolution.ok) return undefined;
      return {
        scope: resolution.scope,
        conversationId:
          runtime.ctx.chatId ??
          runtime.ctx.sessionId ??
          runtime.ctx.executionId,
      };
    })();
    const assistantToolJournal = (() => {
      const journal = runtime.assistants?.stores.toolJournal;
      if (journal === undefined || assistantSessionBinding === undefined)
        return undefined;
      return {
        journal,
        scope: assistantSessionBinding.scope,
        conversationId: assistantSessionBinding.conversationId,
        executionId: runtime.ctx.executionId,
      };
    })();
    let unavailableTools: string[] = [];
    let toolKeyByRef: Record<string, string> = {};
    let activeToolKeys: Set<string> | undefined;
    // Tool-call loop guard (opt-in: `config.toolLoopGuard: true`, or an object
    // of ToolLoopDetectionConfig overrides). The detectors in
    // tool-loop-detection.ts exist since their commit but were never wired into
    // this loop — a production trace shows the consequence: an
    // unanswerable question drove 11 near-identical searches (863k prompt
    // tokens, 263 s) because `stopWhen: stepCountIs(maxToolSteps)` only bounds
    // the ceiling, not the futility. Off by default: research flows
    // legitimately fire dozens of varied searches per assignment; interactive
    // responders opt in. The guard wraps
    // `runtime.executeToolCall` (coverage single-flight) rather than replacing
    // it, and runs BEFORE the call so a critical verdict never reaches the MCP
    // server. Warnings ride inside the tool result — the model reads them;
    // diagnostics alone would not.
    const loopGuardSetting = (
      node.config as { toolLoopGuard?: boolean | ToolLoopDetectionConfig } | undefined
    )?.toolLoopGuard;
    const loopGuardEnabled =
      loopGuardSetting === true ||
      (typeof loopGuardSetting === "object" && loopGuardSetting !== null);
    const innerExecuteToolCall = runtime.executeToolCall;
    // Result memo (per node execution): a research flow that repeats the exact
    // same read-only call pays the MCP round-trip twice for identical bytes.
    // An internal test series showed 27 tool steps whose prompts grew ~6k chars each —
    // repeated searches for the same phrase cost ~1.2M prompt tokens in a single
    // flow. Keyed by tool name + canonicalised args, so only bit-identical
    // calls hit. Mutating tools (`looksMutating`) are never memoised, and a
    // failed outcome is never stored — a timeout must stay retryable.
    const toolResultMemo = new Map<string, Promise<unknown>>();
    const loopGuardedExecuteToolCall: typeof runtime.executeToolCall =
      loopGuardEnabled
        ? async (toolCallId, toolName, args, execute) => {
            const memoKey = looksMutating(toolName)
              ? undefined
              : `${toolName}\u0000${hashToolArgs(args)}`;
            // The memo is consulted only AFTER the guard verdict below, never
            // before: a cached answer must still count as a call, or the
            // identical-repeat detector would never reach its threshold and a
            // model looping on one query would loop forever for free.
            const reuseMemo = async (): Promise<unknown> => {
              const cached = await (toolResultMemo as Map<string, Promise<unknown>>).get(memoKey as string) as unknown;
              runtime.onNodeDiagnostic?.(node.id, {
                level: "info",
                code: "tool_result_memo_hit",
                message: `Reused cached result for \`${toolName}\` (identical arguments).`,
                details: { node_id: node.id, tool: toolName },
              });
              return cached;
            };
            const runInner = (): Promise<unknown> =>
              innerExecuteToolCall !== undefined
                ? innerExecuteToolCall(toolCallId, toolName, args, execute)
                : execute();
            // Record the outcome against the call the guard is about to log, so
            // the churn detector can tell "the model kept re-asking" from "the
            // server kept timing out" — see CallRecord.failed.
            const runAndRecord = async (): Promise<unknown> => {
              let outcome: unknown;
              try {
                outcome = await runInner();
              } catch (error) {
                recordToolOutcome({
                  state: runtime.toolLoopState as NonNullable<
                    typeof runtime.toolLoopState
                  >,
                  toolName,
                  outcome: error,
                });
                throw error;
              }
              recordToolOutcome({
                state: runtime.toolLoopState as NonNullable<
                  typeof runtime.toolLoopState
                >,
                toolName,
                outcome,
              });
              return outcome;
            };
            const loopState = runtime.toolLoopState;
            if (loopState === undefined) {
              if (memoKey !== undefined && toolResultMemo.has(memoKey))
                return reuseMemo();
              const result = await runInner();
              if (memoKey !== undefined && !isFailedOutcome(result))
                toolResultMemo.set(memoKey, Promise.resolve(result));
              return result;
            }
            const verdict = detectToolLoop({
              state: loopState,
              toolName,
              args,
              now: Date.now(),
              ...(typeof loopGuardSetting === "object" && loopGuardSetting !== null
                ? { config: loopGuardSetting }
                : {}),
            });
            if (verdict.stuck) {
              runtime.metrics.recordCounter(
                "aiperator_tool_loop_guard_total",
                {
                  node: node.id,
                  detector: verdict.detector,
                  severity: verdict.severity,
                },
                1,
              );
              if (verdict.severity === "critical") {
                runtime.onNodeDiagnostic?.(node.id, {
                  level: "warn",
                  code: "tool_loop_blocked",
                  message: `Tool loop guard blocked \`${toolName}\` (${verdict.detector}, ${verdict.count}x): ${verdict.message}`,
                  details: {
                    node_id: node.id,
                    detector: verdict.detector,
                    count: verdict.count,
                  },
                });
                // Deliberately NOT an `isError` envelope: the model must be
                // able to READ why the call was refused so it can change
                // strategy or answer from what it already has. A tool-error
                // shape is anonymised to a generic "Tool execution failed."
                // by `sanitizeToolResultOutput` before it reaches the prompt
                // (message-mapping.ts), which would erase the only signal the
                // model has. The operator-facing diagnostic above keeps the
                // structured code; the model gets a plain, readable result.
                return {
                  loop_blocked: true,
                  detector: verdict.detector,
                  count: verdict.count,
                  message: verdict.message,
                };
              }
              if (shouldEmitLoopWarning(loopState, verdict.warningKey)) {
                runtime.onNodeDiagnostic?.(node.id, {
                  level: "info",
                  code: "tool_loop_warning",
                  message: `Tool loop guard warned on \`${toolName}\` (${verdict.detector}, ${verdict.count}x).`,
                  details: {
                    node_id: node.id,
                    detector: verdict.detector,
                    count: verdict.count,
                  },
                });
                recordToolCall({ state: loopState, toolName, args, now: Date.now() });
                if (memoKey !== undefined && toolResultMemo.has(memoKey)) {
                  const cached = await reuseMemo();
                  recordToolOutcome({ state: loopState, toolName, outcome: cached });
                  // The warning must reach the MODEL, not just the operator: it
                  // rides along as a sibling field of the real result.
                  return { loop_warning: verdict.message, result: cached };
                }
                const result = await runAndRecord();
                if (memoKey !== undefined && !isFailedOutcome(result))
                  toolResultMemo.set(memoKey, Promise.resolve(result));
                // The warning must reach the MODEL, not just the operator: it
                // rides along as a sibling field of the real result.
                return { loop_warning: verdict.message, result };
              }
            }
            recordToolCall({ state: loopState, toolName, args, now: Date.now() });
            if (memoKey !== undefined && toolResultMemo.has(memoKey)) {
              const cached = await reuseMemo();
              recordToolOutcome({ state: loopState, toolName, outcome: cached });
              return cached;
            }
            const pending = runAndRecord();
            if (memoKey !== undefined) {
              // Store the promise so concurrent identical calls share one
              // round-trip; drop the entry again if it fails, keeping the call
              // retryable.
              toolResultMemo.set(memoKey, pending);
              pending.catch(() => {
                if (toolResultMemo.get(memoKey) === pending)
                  toolResultMemo.delete(memoKey);
              });
            }
            return pending;
          }
        : innerExecuteToolCall;
    // A semantic hit only becomes actionable when its MCP schema was bound to
    // an AI-SDK tool key. Keep the best bound score separately: the visibility
    // threshold is intentionally permissive, while mandatory tool use needs a
    // stronger relevance signal.
    let selectedBoundToolCount = 0;
    let selectedBoundToolBestScore = Number.NEGATIVE_INFINITY;
    const selectedBoundToolKeys: string[] = [];
    if (resolved.tools.length > 0 && runtime.mcpWrapper) {
      const nodeWithResolvedTools = { ...node, tools: resolved.tools };
      const toolEgressGuardrail = runtime.toolEgressGuardrail;
      const classificationNamespaces = buildClassificationNamespaces(
        state.turns,
      );
      const toolTemplateContext: Record<string, unknown> = {
        query: lastUserQuery(state),
        classLabel: state.classLabel,
        classification: state.classification,
        context: state.context,
        node: classificationNamespaces.node,
        turn: classificationNamespaces.turn,
      };
      try {
        const built = await buildAiTools(
          nodeWithResolvedTools,
          runtime.mcpWrapper,
          runtime.ctx,
          runtime.approvalGate !== undefined
            ? {
                gate: runtime.approvalGate,
                ...(runtime.onApprovalRequired !== undefined
                  ? { notify: runtime.onApprovalRequired }
                  : {}),
                onDecision: (toolRef, approved) =>
                  runtime.metrics.recordCounter("aiperator_approvals_total", {
                    decision: approved ? "approved" : "denied",
                    tool: toolRef,
                  }),
              }
            : undefined,
          toolEgressGuardrail !== undefined
            ? {
                guardrail: toolEgressGuardrail,
                onFindings: (toolRef) =>
                  runtime.metrics.recordCounter(
                    "aiperator_tool_egress_findings_total",
                    {
                      tool: toolRef,
                      mode: toolEgressGuardrail.mode,
                    },
                  ),
              }
            : undefined,
          runtime.toolOutputValidator,
          runtime.compliancePolicy !== undefined
            ? {
                policy: runtime.compliancePolicy,
                ...(runtime.flowId !== undefined
                  ? { flowId: runtime.flowId }
                  : {}),
              }
            : undefined,
          // Self-search citations: when the model calls a vectorsearch tool
          // itself, register the retrieved documents (global [n], deduped
          // against grounding) and annotate the result so it can cite them.
          runtime.registerCitations !== undefined
            ? { register: runtime.registerCitations }
            : undefined,
          // Bind the graph-state template namespaces and optional execution
          // hooks to every tool the model may call.
          {
            templateContext: toolTemplateContext,
            ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
            ...(assistantToolJournal !== undefined
              ? { journal: assistantToolJournal }
              : {}),
            onEffectiveToolArgs: (
              toolCallId: string,
              toolRef: string,
              args: Record<string, unknown>,
            ) => {
              effectiveToolArgsByCallId.set(toolCallId, args);
              return runtime.onToolEffectiveArgs?.(
                toolCallId,
                toolRef,
                JSON.stringify(args),
              );
            },
            ...(loopGuardedExecuteToolCall !== undefined
              ? { executeToolCall: loopGuardedExecuteToolCall }
              : {}),
            // Ref-handle indirection (config.refHandles): resolve the model's
            // short handles back to real references and mask references in
            // tool results, per node opt-in only.
            ...(runtime.refHandles !== undefined &&
            (node.config as { refHandles?: unknown } | undefined)?.refHandles ===
              true
              ? { refHandles: runtime.refHandles }
              : {}),
          },
        );
        aiTools = built.tools;
        unavailableTools = built.unavailable;
        toolKeyByRef = built.keyByRef;
        // Surface WHY tools are unavailable in the trace: one diagnostic per
        // server and cause, so e.g. a rejected token exchange is not visible
        // only as the model saying "temporarily unavailable".
        const byCause = new Map<string, { server: string; reason: string; tools: string[] }>();
        for (const toolRef of built.unavailable) {
          const server = toolRef.includes("/") ? (toolRef.split("/")[0] ?? toolRef) : toolRef;
          const reason = built.unavailableReasons[toolRef] ?? "unknown error";
          const causeKey = `${server}\u001f${reason}`;
          const entry = byCause.get(causeKey) ?? { server, reason, tools: [] };
          entry.tools.push(toolRef);
          byCause.set(causeKey, entry);
        }
        for (const { server, reason, tools } of byCause.values()) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "tool_schema_unavailable",
            message: `Tool schema for MCP server ${server} could not be loaded: ${reason}`,
            details: { server, reason, tools },
          });
        }
      } catch {
        aiTools = undefined;
      }
    }

    // Dynamic Tool Retrieval (semantic tool selection).
    const toolSelCfg = parseToolSelection(
      node.config as Record<string, unknown> | undefined,
    );
    if (
      toolSelCfg?.mode === "semantic" &&
      toolSelCfg.cacheStable !== true &&
      aiTools !== undefined &&
      runtime.toolIndex !== undefined
    ) {
      const toolIndex = runtime.toolIndex;
      const toolGroupSummarizer = runtime.toolGroupSummarizer;
      const pool = resolved.tools;
      const query = lastUserQuery(state);
      const safeRetryToolRefs = readSafeAssistantRetryToolRefs(
        runtime.ctx.requestParams,
      ).filter((ref) => pool.includes(ref));
      const active = new Set<string>();
      const alwaysIncludedRefs: string[] = [];
      for (const ref of expandPatterns(toolSelCfg.alwaysInclude, pool)) {
        const k = toolKeyByRef[ref];
        if (k !== undefined) {
          active.add(k);
          alwaysIncludedRefs.push(ref);
        }
      }
      const semanticHits: import("../tool-index.js").ToolSelectionHit[] = [];
      if (safeRetryToolRefs.length > 0) {
        for (const ref of safeRetryToolRefs) {
          const key = toolKeyByRef[ref];
          if (key === undefined) continue;
          active.add(key);
          selectedBoundToolKeys.push(key);
          selectedBoundToolCount += 1;
          selectedBoundToolBestScore = 1;
        }
      } else if (query.trim() !== "") {
        try {
          const hits = await toolIndex.select(query, pool, {
            topK: toolSelCfg.topK,
            ...(toolSelCfg.minScore !== undefined
              ? { minScore: toolSelCfg.minScore }
              : {}),
            ...(runtime.ctx.ssoToken !== undefined
              ? { authToken: runtime.ctx.ssoToken }
              : {}),
          });
          for (const hit of hits) {
            const k = toolKeyByRef[hit.ref];
            if (k !== undefined) {
              active.add(k);
              if (!selectedBoundToolKeys.includes(k)) {
                selectedBoundToolKeys.push(k);
              }
              selectedBoundToolCount += 1;
              selectedBoundToolBestScore = Math.max(
                selectedBoundToolBestScore,
                hit.score,
              );
            }
            semanticHits.push(hit);
          }
        } catch {
          /* embedding failure — fall through */
        }
      }
      if (query.trim() !== "" || active.size > 0) {
        if (toolSelCfg.metaTool) {
          const inactiveByServer = new Map<string, string[]>();
          for (const ref of pool) {
            const k = toolKeyByRef[ref];
            if (k === undefined || active.has(k)) continue;
            const server = ref.includes("/")
              ? (ref.split("/")[0] ?? "(local)")
              : "(local)";
            const list = inactiveByServer.get(server) ?? [];
            list.push(ref);
            inactiveByServer.set(server, list);
          }
          const summaryLines: string[] = [];
          for (const [server, refs] of inactiveByServer) {
            const llmSummary = toolGroupSummarizer?.getSummary(server);
            if (llmSummary !== undefined && llmSummary.trim() !== "") {
              summaryLines.push(`• ${server}: ${llmSummary.trim()}`);
            } else {
              summaryLines.push(
                buildGroupSummary(refs, (ref) =>
                  toolIndex.getDescription(ref, {
                    ...(runtime.ctx.ssoToken !== undefined
                      ? { authToken: runtime.ctx.ssoToken }
                      : {}),
                  }),
                ),
              );
            }
          }
          const groupsSummary = summaryLines.filter((s) => s !== "").join("\n");
          const meta = buildToolSelectionMetaTool({
            name: toolSelCfg.metaToolName,
            toolIndex,
            pool,
            keyByRef: toolKeyByRef,
            topK: toolSelCfg.metaTopK,
            ...(toolSelCfg.minScore !== undefined
              ? { minScore: toolSelCfg.minScore }
              : {}),
            ...(runtime.ctx.ssoToken !== undefined
              ? { authToken: runtime.ctx.ssoToken }
              : {}),
            ...(groupsSummary !== "" ? { groupsSummary } : {}),
            ...(toolGroupSummarizer !== undefined
              ? {
                  getInstructions: (server: string) =>
                    toolGroupSummarizer.getSummary(server),
                }
              : {}),
            activate: (keys) => {
              for (const k of keys) active.add(k);
            },
            onEffectiveArgs: (toolCallId, toolName, argsJson) =>
              runtime.onToolEffectiveArgs?.(toolCallId, toolName, argsJson),
          });
          aiTools[meta.key] = meta.tool;
          active.add(meta.key);
        }
        activeToolKeys = active;
        if (runtime.onDebugToolSelection !== undefined) {
          runtime.onDebugToolSelection(node.id, {
            query,
            always_included: alwaysIncludedRefs,
            selected: semanticHits.map((h) => ({ ref: h.ref, score: h.score })),
            pool_size: pool.length,
          });
        }
        runtime.metrics.recordCounter("aiperator_tool_selection_total", {
          node: node.id,
          selected: String(active.size),
          pool: String(pool.length),
        });
      }
    }

    // Media-generation tools
    const mediaTools = buildMediaTools(node, {
      appConfig: runtime.appConfig,
      ...(runtime.pricingOverrides !== undefined
        ? { pricingOverrides: runtime.pricingOverrides }
        : {}),
      llmProviderFactory: runtime.llmProviderFactory,
      ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
      ...(runtime.ctx.providerKeyOverrides !== undefined
        ? {
            resolution: {
              providerKeyOverrides: runtime.ctx.providerKeyOverrides,
            },
          }
        : {}),
      ...(runtime.publishMedia !== undefined
        ? { publishMedia: runtime.publishMedia }
        : {}),
      emit: (token: string) => runtime.onToken(node.id, token),
      ...(runtime.setGenAiAttributes !== undefined
        ? { setGenAiAttributes: runtime.setGenAiAttributes }
        : {}),
      ...(runtime.costTracker !== undefined
        ? { costTracker: runtime.costTracker }
        : {}),
      metrics: runtime.metrics,
      clientId: runtime.ctx.clientId,
      costAttribution: buildCostAttribution(runtime.ctx, runtime.flowId),
      onEffectiveArgs: (toolCallId, toolName, argsJson) =>
        runtime.onToolEffectiveArgs?.(toolCallId, toolName, argsJson),
    });
    if (Object.keys(mediaTools).length > 0) {
      aiTools = { ...(aiTools ?? {}), ...mediaTools };
      if (activeToolKeys !== undefined) {
        for (const k of Object.keys(mediaTools)) activeToolKeys.add(k);
      }
    }

    // Client tool-call passthrough. A node may opt out with `config.clientTools:
    // false` even when client tools are globally enabled — e.g. a RAG-only flow
    // that must ignore a caller's per-user Knowledge tools (Open WebUI) so the
    // model answers strictly from the flow's own tools. Defaults to accepting.
    const nodeAcceptsClientTools =
      (node.config as { clientTools?: boolean } | undefined)?.clientTools !==
      false;
    let clientToolKeys: Set<string> = new Set();
    const clientTools = runtime.ctx.clientTools;
    if (
      nodeAcceptsClientTools &&
      clientTools !== undefined &&
      clientTools.length > 0 &&
      runtime.onClientToolCall !== undefined
    ) {
      const built = buildClientTools(clientTools);
      if (built.keys.size > 0) {
        aiTools = { ...(aiTools ?? {}), ...built.tools };
        clientToolKeys = built.keys;
        if (activeToolKeys !== undefined) {
          for (const k of built.keys) activeToolKeys.add(k);
        }
      }
    }

    // Image inspection (see `image-reference.ts`) is assembled after every
    // other tool source, including caller-provided tools. That final ordering
    // reserves a non-colliding key instead of allowing a client `inspect_image`
    // declaration to overwrite the internal, server-executed inspection tool.
    const imageInspection = (
      node.config as { imageInspection?: ImageInspectionConfig } | undefined
    )?.imageInspection;
    const imageInspectionEnabled =
      imageInspection?.llm !== undefined && runtime.imageRefs !== undefined;
    if (imageInspection?.llm !== undefined && runtime.imageRefs === undefined) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "image_inspection_unavailable",
        message:
          `Node ${node.id} declares config.imageInspection but no media store is ` +
          "configured, so inline images cannot be referenced or inspected. Set " +
          "MEDIA_BASE_URL / enable the media store, or remove the config.",
      });
    }
    let imageInspectionToolName = IMAGE_INSPECTION_TOOL_NAME;
    if (imageInspectionEnabled && runtime.imageRefs !== undefined) {
      imageInspectionToolName = uniqueMediaToolKey(
        (aiTools ?? {}) as Record<string, unknown>,
        IMAGE_INSPECTION_TOOL_NAME,
      );
      // Asset resolution (Req 16.3): when the node declares `assetSource` and an
      // MCP wrapper is available, thread a `fetchAsset` hook that fetches the
      // asset's bytes via the configured server's `get_asset` tool. The call
      // runs with the caller's request context, so it inherits get_asset's
      // ACL + fail-closed behaviour (task 3.9); `agent-tools.ts` stays decoupled
      // from the MCP client. Absent config/wrapper → the hook is omitted and
      // `asset:` references are simply not resolvable.
      const assetSource = imageInspection.assetSource;
      const fetchAsset =
        assetSource !== undefined && runtime.mcpWrapper !== undefined
          ? buildAssetFetch(
              runtime.mcpWrapper,
              runtime.ctx,
              assetSource,
              runtime.signal,
            )
          : undefined;
      const inspectionTools = buildImageInspectionTools({
        existingTools: aiTools,
        nodeId: node.id,
        usage: runtime.usage,
        onNodeDiagnostic: runtime.onNodeDiagnostic,
        registry: runtime.imageRefs,
        config: imageInspection,
        appConfig: runtime.appConfig,
        llmProviderFactory: runtime.llmProviderFactory,
        ...(fetchAsset !== undefined ? { fetchAsset } : {}),
        ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
        ...(runtime.pricingOverrides !== undefined
          ? { pricingOverrides: runtime.pricingOverrides }
          : {}),
        ...(runtime.ctx.providerKeyOverrides !== undefined
          ? {
              resolution: {
                providerKeyOverrides: runtime.ctx.providerKeyOverrides,
              },
            }
          : {}),
        ...(runtime.setGenAiAttributes !== undefined
          ? { setGenAiAttributes: runtime.setGenAiAttributes }
          : {}),
        ...(runtime.costTracker !== undefined
          ? { costTracker: runtime.costTracker }
          : {}),
        metrics: runtime.metrics,
        clientId: runtime.ctx.clientId,
        costAttribution: buildCostAttribution(runtime.ctx, runtime.flowId),
        onEffectiveArgs: (toolCallId, toolName, argsJson) =>
          runtime.onToolEffectiveArgs?.(toolCallId, toolName, argsJson),
      });
      if (Object.keys(inspectionTools).length > 0) {
        aiTools = { ...(aiTools ?? {}), ...inspectionTools };
        if (activeToolKeys !== undefined) {
          for (const k of Object.keys(inspectionTools)) activeToolKeys.add(k);
        }
      }
    }

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
    const dropRagContext =
      (node.config as { dropRagContext?: boolean } | undefined)
        ?.dropRagContext === true;
    const groundedMessages = dropRagContext
      ? state.messages.filter((m) => {
          if (m._getType() !== "system") return true;
          const c = (m as { content?: unknown }).content;
          return !(typeof c === "string" && isRagContextMessage(c));
        })
      : state.messages;
    // Ref-handle opt-in (config.refHandles): the tool node registered the
    // grounding references; swap them for short handles on the MODEL-FACING
    // copy only. The grounding header advertises `(Ref: ...)` as the
    // get_document argument, and a small model truncates those long paths
    // (trace 55c5b138) — a 4-char handle it can copy verbatim cannot. The
    // persisted state keeps the real references, so history, client citations
    // and audit surfaces are unaffected; resolution maps the handle back
    // before every tool call.
    const modelFacingMessages =
      runtime.refHandles !== undefined &&
      (node.config as { refHandles?: unknown } | undefined)?.refHandles === true
        ? maskRagContextForModel(groundedMessages, runtime.refHandles)
        : groundedMessages;
    const rawModelMessages = baseMessagesToModelMessages(
      deduplicateRagContext(modelFacingMessages),
    );

    // `assistant-context` runs after the human turn and therefore emits a
    // non-leading SystemMessage. `sanitizeSystemMessages` must normally fold
    // such messages into an adjacent provider-valid user turn, but doing that
    // to the assistant's own identity made Qwen interpret "Name: Assistant1" as the
    // user's identity and echo the block on every response. Extract this
    // explicitly framed block before generic sanitization and merge it into the
    // one leading system message below.
    const assistantContextBlocks: string[] = [];
    const promptHistory = rawModelMessages.flatMap((message) => {
      if (
        message.role === "system" &&
        typeof message.content === "string" &&
        isAssistantContextFrame(message.content)
      ) {
        assistantContextBlocks.push(message.content.trim());
        return [];
      }

      // Existing LangGraph checkpoints may already contain prompt echoes as
      // assistant turns, or as user turns polluted by an old retry/context
      // fold. Clean only the model-facing copy; durable audit history remains
      // byte-for-byte intact. The transform is idempotent.
      if (
        (message.role === "assistant" || message.role === "user") &&
        typeof message.content === "string"
      ) {
        const content = stripLeakedContextEcho(message.content);
        return [{ ...message, content } as ModelMessage];
      }
      return [message];
    });
    const sanitized = sanitizeSystemMessages(promptHistory);
    const maxHistoryTurns = (
      node.config as { maxHistoryTurns?: number } | undefined
    )?.maxHistoryTurns;
    const trimmed =
      maxHistoryTurns !== undefined && maxHistoryTurns > 0
        ? trimConversationHistory(sanitized, maxHistoryTurns)
        : sanitized;

    // ── History compression ────────────────────────────────────────────────
    // Runs BEFORE the system prompt is prepended, so compaction only ever
    // touches conversation turns and can never rewrite the cacheable system
    // prefix. Applied here (at prompt assembly) rather than in state because
    // `AgentStateAnnotation.messages` has an append-only reducer — a node cannot
    // replace history. The summary is cached per (conversation, node) and keyed
    // by a fingerprint of the range it covers, so an unchanged range re-emits
    // identical bytes and the prompt prefix survives across turns.
    //
    // Stage 1 (identical-tool-result dedup) is deterministic and free, so it
    // runs on every request; the summarising stage only engages over the
    // trigger and requires a known context window.
    const compressionCfg = (
      node.config as
        | {
            historyCompression?: {
              enabled?: boolean;
              thresholdRatio?: number;
              llm?: LlmConfig;
            };
          }
        | undefined
    )?.historyCompression;
    let compressedMessages = trimmed;
    if (compressionCfg?.enabled === true) {
      const summarizerLlm = compressionCfg.llm ?? llmConfig;
      const pressure = measureContextPressure(trimmed, llmConfig, maxTokens);
      const result = await compressHistory(trimmed, {
        key: `${runtime.ctx.chatId ?? "-"}::${node.id}`,
        ...(pressure.inputBudget !== undefined
          ? { inputBudget: pressure.inputBudget }
          : {}),
        thresholdRatio: effectiveThresholdRatio(
          pressure.contextLength,
          compressionCfg.thresholdRatio,
        ),
        summarize: createHistorySummarizer(runtime, summarizerLlm, node.id),
      });
      compressedMessages = result.messages;

      if (result.dedupe.collapsed > 0) {
        runtime.metrics.recordCounter(
          "aiperator_history_dedupe_total",
          { node: node.id },
          result.dedupe.collapsed,
        );
      }
      if (result.summarized) {
        runtime.metrics.recordCounter("aiperator_history_compaction_total", {
          node: node.id,
          source: result.summaryFromCache ? "cache" : "generated",
        });

        // Persist a newly generated summary as immutable session provenance. The
        // prompt transform remains fail-open, while the snapshot makes the exact
        // compacted bytes inspectable and reusable after a process restart.
        if (
          !result.summaryFromCache &&
          result.summary !== undefined &&
          assistantSessionBinding !== undefined
        ) {
          const sessionStore = runtime.assistants?.stores.sessionStore;
          if (sessionStore !== undefined) {
            try {
              const transcript = await sessionStore.read(
                assistantSessionBinding.scope,
                assistantSessionBinding.conversationId,
                1_000,
              );
              const localEntries = transcript.filter(
                (entry) =>
                  entry.conversationId ===
                    assistantSessionBinding.conversationId &&
                  entry.sequence !== undefined,
              );
              const first = localEntries[0];
              const latest = localEntries.at(-1);
              if (
                first?.sequence !== undefined &&
                latest?.sequence !== undefined
              ) {
                const snapshot = await sessionStore.createSnapshot({
                  scope: assistantSessionBinding.scope,
                  conversationId: assistantSessionBinding.conversationId,
                  sequence: latest.sequence,
                  kind: "summary",
                  content: result.summary,
                  // Prompt transformations (sanitization, trimming and tool-result
                  // dedupe) currently do not preserve event IDs. Do not claim
                  // sequence-exact provenance until that mapping exists.
                });
                if (runtime.ctx.ssoToken !== "") {
                  try {
                    await runtime.assistants?.indexSessionDocument({
                      scope: assistantSessionBinding.scope,
                      conversationId: assistantSessionBinding.conversationId,
                      documentId: snapshot.id,
                      content: snapshot.content,
                      kind: "snapshot",
                      sequence: snapshot.sequence,
                      token: runtime.ctx.ssoToken,
                    });
                  } catch {
                    runtime.onNodeDiagnostic?.(node.id, {
                      level: "warn",
                      code: "history_snapshot_index_failed",
                      message:
                        "The durable history snapshot was stored, but its Vectorsearch projection failed.",
                    });
                  }
                }
              }
            } catch {
              runtime.onNodeDiagnostic?.(node.id, {
                level: "warn",
                code: "history_snapshot_persist_failed",
                message:
                  "History compaction succeeded, but its durable session snapshot could not be persisted.",
              });
            }
          }
        }
      } else if (result.skipped !== undefined) {
        runtime.metrics.recordCounter("aiperator_history_compaction_skipped", {
          node: node.id,
          reason: result.skipped,
        });
      }
    } else {
      // Even with compaction disabled, the deterministic pre-pass is worth
      // running: collapsing byte-identical repeated tool results removes only
      // content the model has already been shown in that exact form, needs no
      // model call, and is idempotent — so it cannot cost anything or shift the
      // prompt prefix between turns.
      const deduped = dedupeRepeatedToolResults(trimmed);
      compressedMessages = deduped.messages;
      if (deduped.stats.collapsed > 0) {
        runtime.metrics.recordCounter(
          "aiperator_history_dedupe_total",
          { node: node.id },
          deduped.stats.collapsed,
        );
      }
    }

    // Bound tool output that arrived in the INCOMING history, not just output
    // this node produces. Two paths feed oversized results into a prompt:
    // (a) the agent loop, handled in `prepareStep` below, and (b) history — an
    // OpenAI-compatible client legitimately replays `role: "tool"` messages, and
    // a checkpointed thread carries the ones earlier turns produced. Without this
    // pass a single huge inbound tool result can exceed the window before the
    // loop even starts. Deterministic and idempotent, so re-capping content that
    // was already capped on a previous turn is a no-op and the prefix holds.
    const historyBudgeted = applyToolResultBudget(
      compressedMessages,
      toolResultBudget,
    );
    if (historyBudgeted.stats.charsSaved > 0) {
      runtime.metrics.recordCounter(
        "aiperator_tool_result_chars_saved_total",
        { node: node.id, stage: "inbound" },
        historyBudgeted.stats.charsSaved,
      );
    }

    const validStart = ensureValidConversationStart(historyBudgeted.messages);

    // A prompt that ENDS on an assistant turn asks the model to open a second
    // consecutive assistant turn, which local Qwen builds answer with an
    // immediate end token — an empty completion on every attempt and every
    // fallback candidate. See `ensureTrailingUserTurn` for the full mechanism.
    // Opt out with `config.allowTrailingAssistantTurn: true` for a node that
    // genuinely wants the model to continue its own last message.
    const allowTrailingAssistantTurn =
      (node.config as { allowTrailingAssistantTurn?: boolean } | undefined)
        ?.allowTrailingAssistantTurn === true;
    const trailingTurn = allowTrailingAssistantTurn
      ? { messages: validStart, appended: false }
      : ensureTrailingUserTurn(validStart);
    if (trailingTurn.appended) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "prompt_trailing_assistant_turn",
        message:
          "The assembled prompt ended on an assistant turn (engine-injected " +
          "context); appended a short user turn so the model has a turn " +
          "boundary to answer at.",
        details: { message_count: validStart.length },
      });
    }
    const coreMessages = trailingTurn.messages;

    const unavailableNote =
      unavailableTools.length > 0
        ? "\n\n[System] These tools are currently unavailable and MUST NOT be " +
          "called: " +
          unavailableTools.map((t) => t.split("/").pop()).join(", ") +
          ". If the user's request requires one of them, briefly tell the user " +
          "(in their language) that the function is temporarily unavailable and " +
          "continue with whatever you can do without it."
        : "";
    let instructionsNote = "";
    if (runtime.mcpWrapper !== undefined) {
      const activeServers = new Set<string>();
      if (activeToolKeys !== undefined) {
        for (const [ref, key] of Object.entries(toolKeyByRef)) {
          if (activeToolKeys.has(key)) {
            const server = ref.includes("/") ? (ref.split("/")[0] ?? "") : "";
            if (server !== "") activeServers.add(server);
          }
        }
      } else {
        for (const ref of resolved.tools) {
          const server = ref.includes("/") ? (ref.split("/")[0] ?? "") : "";
          if (server !== "") activeServers.add(server);
        }
      }
      const blocks: string[] = [];
      // Sorted, not insertion-ordered: the iteration order of `toolKeyByRef` /
      // `resolved.tools` is an implementation detail, and semantic tool
      // selection can surface the same SET of servers in a different order from
      // one request to the next. Emitting them in a different order would
      // change these bytes — and therefore break prompt-cache reuse — without
      // any change in meaning.
      for (const server of [...activeServers].sort()) {
        const instr = runtime.mcpWrapper.getInstructions(server);
        if (instr !== undefined && instr.trim() !== "") {
          // Compact repeated entries in list lines (e.g. taiga's duplicated
          // "Known epics") before injecting — this text is re-sent on every
          // agent-loop step, so trimming it saves input tokens per turn.
          blocks.push(
            `### ${server}\n${dedupeGuidanceListLines(instr.trim())}`,
          );
        }
      }
      if (blocks.length > 0) {
        instructionsNote =
          "\n\n[Tool guidance — follow these conventions when calling the " +
          "respective tools]\n" +
          blocks.join("\n\n");
      }
    }

    // Volatile, per-request guidance. Deliberately NOT concatenated onto the
    // system prompt: both notes depend on live MCP server state and on the
    // per-request semantic tool selection, and the system message is message 0 —
    // changing a single byte there re-prefills the entire conversation. It is
    // attached to the last user message below instead (see
    // `attachVolatileGuidance`), which keeps the cacheable prefix byte-stable.
    const volatileGuidance = (instructionsNote + unavailableNote).trim();

    // The leading system prompt contains the node's stable instructions plus
    // assistant-owned identity/limits extracted above. Keeping those sections
    // in the system role is a correctness boundary: they must never be parsed
    // as user-authored text. Per-request MCP guidance remains on the newest user
    // turn below for cache locality.
    const currentAssistantContext = assistantContextBlocks.at(-1);
    const effectiveSystemSections = [
      resolved.systemPrompt,
      currentAssistantContext,
    ].filter(
      (section): section is string =>
        typeof section === "string" && section.trim() !== "",
    );
    const effectiveSystemPrompt =
      effectiveSystemSections.length > 0
        ? effectiveSystemSections.join("\n\n")
        : undefined;

    let messagesWithSystemPrompt: ModelMessage[];
    if (effectiveSystemPrompt) {
      const firstCoreMessage = coreMessages[0];
      if (
        firstCoreMessage !== undefined &&
        firstCoreMessage.role === "system"
      ) {
        const existingContent = firstCoreMessage.content;
        const existing =
          typeof existingContent === "string"
            ? existingContent
            : JSON.stringify(existingContent);
        const trimmed = existing.trim();
        const merged =
          trimmed.length > 0 && trimmed !== "User Context:"
            ? `${effectiveSystemPrompt}\n\n${existing}`
            : effectiveSystemPrompt;
        messagesWithSystemPrompt = [
          { role: "system", content: merged } as ModelMessage,
          ...coreMessages.slice(1),
        ];
      } else {
        messagesWithSystemPrompt = [
          { role: "system", content: effectiveSystemPrompt } as ModelMessage,
          ...coreMessages,
        ];
      }
    } else {
      messagesWithSystemPrompt = coreMessages;
    }

    // Attach the volatile guidance to the newest user turn, leaving the system
    // message (and thus the whole cacheable prefix) untouched.
    if (volatileGuidance !== "") {
      const attachment = attachVolatileGuidance(
        messagesWithSystemPrompt,
        volatileGuidance,
      );
      if (attachment.attached) {
        messagesWithSystemPrompt = attachment.messages;
      } else {
        // No user message to attach to (e.g. a system-prompt-only invocation).
        // Correctness wins over cache efficiency: fold the guidance into the
        // system message, or create one, so the model still receives it.
        const first = messagesWithSystemPrompt[0];
        if (first !== undefined && first.role === "system") {
          const existing =
            typeof first.content === "string"
              ? first.content
              : JSON.stringify(first.content);
          messagesWithSystemPrompt = [
            {
              role: "system",
              content: `${existing}\n\n${volatileGuidance}`,
            } as ModelMessage,
            ...messagesWithSystemPrompt.slice(1),
          ];
        } else {
          messagesWithSystemPrompt = [
            { role: "system", content: volatileGuidance } as ModelMessage,
            ...messagesWithSystemPrompt,
          ];
        }
      }
    }

    // ── Inline images → references ────────────────────────────────────────
    // Runs once the prompt is final and before any candidate request is built,
    // so the base64 never reaches the provider (or the prompt-cache key, or the
    // context-window accounting) for a node that opted into reference-based
    // image handling. The bytes live in the run-scoped registry and are reachable
    // again through `inspect_image`; identical images reuse the same `img-N`, so
    // a re-sent attachment does not change the prompt across turns.
    //
    // This also lifts the vision guard: a node that offloads its images sends no
    // image parts at all, so `vision_not_supported` below no longer skips a
    // text-only model that would otherwise reject the whole request.
    //
    // Scope note: what is rewritten here is the *incoming* prompt, including
    // images a tool returned on an earlier turn. A tool result produced later in
    // the SAME provider loop is appended by the SDK itself and goes out with its
    // bytes — the AI SDK exposes no per-step message hook to rewrite it.
    if (imageInspectionEnabled && runtime.imageRefs !== undefined) {
      const offloaded = offloadInlineImages(
        messagesWithSystemPrompt,
        runtime.imageRefs,
        imageInspectionToolName,
      );
      if (offloaded.offloaded > 0) {
        messagesWithSystemPrompt = offloaded.messages;
        runtime.onNodeDiagnostic?.(node.id, {
          level: "info",
          code: "llm_images_offloaded",
          message:
            `Replaced ${offloaded.offloaded} inline image(s) with ` +
            `${IMAGE_INSPECTION_TOOL_NAME} references (${offloaded.refs.join(
              ", ",
            )}), keeping ${offloaded.bytesRemoved} image bytes out of the prompt.`,
          details: {
            offloaded: offloaded.offloaded,
            refs: offloaded.refs,
            bytesRemoved: offloaded.bytesRemoved,
          },
        });
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
      if (offloaded.unresolved > 0) {
        const message =
          `${offloaded.unresolved} image reference(s) could not be parked because ` +
          "they are remote or otherwise undecodable; refusing to send them to the hosting model.";
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "image_inspection_remote_image_unavailable",
          message,
          details: { unresolved: offloaded.unresolved },
        });
        throw new Error("IMAGE_INSPECTION_REMOTE_IMAGE_UNAVAILABLE");
      }
    }

    // Prompt-size guard for images that are *still* inline: a node without
    // `config.imageInspection` (or a remote image URL that cannot be parked)
    // sends those bytes to the provider on every single turn, which is both a
    // cost and a context-window problem long before it becomes an error. Loudly
    // visible here rather than inferred from a truncated answer.
    const remainingImages = inlineImageBytes(messagesWithSystemPrompt);
    if (remainingImages.totalBytes > PROMPT_INLINE_IMAGE_WARN_BYTES) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "llm_prompt_image_payload_large",
        message:
          `${remainingImages.count} inline image(s) totalling ` +
          `${remainingImages.totalBytes} bytes are part of this prompt. ` +
          "Consider config.imageInspection so images are referenced instead of " +
          "re-sent on every turn.",
        details: {
          images: remainingImages.count,
          totalBytes: remainingImages.totalBytes,
          maxBytes: remainingImages.maxBytes,
        },
      });
    }

    runtime.onNodeIo?.(node.id, {
      prompt: coreMessagesToText(messagesWithSystemPrompt),
    });

    // ── Prompt-prefix stability probe ──────────────────────────────────────
    // Measured on the UNDECORATED message list (before cache_control markers
    // are applied) because those markers are cache metadata, not part of the
    // token stream the caches key on.
    //
    // This is the only prompt-cache signal available for local OpenAI-compatible
    // servers (LM Studio / llama.cpp / vLLM), which reuse a KV cache for a
    // byte-identical prefix but report no `cachedInputTokens`. `appendOnly` is
    // the goal state; a divergence at index 0 means the system prompt is not
    // byte-stable and the whole prompt re-prefills every turn.
    if (llmConfig !== undefined) {
      const prefixReport = promptPrefixTracker.observe(
        streamKey(runtime.ctx.chatId, node.id, modelKeyOf(llmConfig)),
        messagesWithSystemPrompt,
      );
      if (prefixReport !== undefined) {
        runtime.metrics.recordCounter(
          "aiperator_prompt_prefix_observations_total",
          {
            node: node.id,
            model: modelKeyOf(llmConfig),
            shape: prefixReport.appendOnly ? "append_only" : "diverged",
          },
        );
        // Char counters, so a reuse ratio is derivable in PromQL across many
        // observations instead of only per-call.
        if (prefixReport.currentChars > 0) {
          runtime.metrics.recordCounter(
            "aiperator_prompt_prefix_chars_total",
            { node: node.id, model: modelKeyOf(llmConfig), part: "total" },
            prefixReport.currentChars,
          );
        }
        if (prefixReport.stableChars > 0) {
          runtime.metrics.recordCounter(
            "aiperator_prompt_prefix_chars_total",
            { node: node.id, model: modelKeyOf(llmConfig), part: "stable" },
            prefixReport.stableChars,
          );
        }
        // Only a divergence is worth a diagnostic entry — append-only is the
        // expected shape and would flood the timeline.
        if (!prefixReport.appendOnly) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: prefixReport.firstDivergenceIndex === 0 ? "warn" : "info",
            code: "prompt_prefix_diverged",
            message:
              prefixReport.firstDivergenceIndex === 0
                ? "Prompt prefix diverged at the SYSTEM message — the whole " +
                  "prompt re-prefills this turn (no prompt/KV cache reuse). " +
                  "Something volatile is being injected into the system prompt."
                : `Prompt prefix diverged at message ${prefixReport.firstDivergenceIndex} ` +
                  `(role: ${prefixReport.firstDivergenceRole ?? "?"}) — history was ` +
                  "rewritten mid-array; everything from that point re-prefills.",
            details: {
              firstDivergenceIndex: prefixReport.firstDivergenceIndex,
              ...(prefixReport.firstDivergenceRole !== undefined
                ? { firstDivergenceRole: prefixReport.firstDivergenceRole }
                : {}),
              stableMessages: prefixReport.stableMessages,
              previousMessages: prefixReport.previousMessages,
              currentMessages: prefixReport.currentMessages,
              reuseRatio: prefixReport.reuseRatio,
            },
          });
        }
      }
    }

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

    type StreamPart = {
      type: string;
      text?: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        /**
         * Prompt-cache read tokens (a SUBSET of `inputTokens`, not an addition
         * to it) — verified against a live Bedrock Haiku endpoint, which reports
         * e.g. `{inputTokens: 11697, inputTokenDetails: {cacheReadTokens: 11680,
         * noCacheTokens: 17}}` on a warm prefix.
         *
         * This is the ai@7 `LanguageModelUsage` shape. `cachedInputTokens` below
         * is the older provider-level field name and is kept as a fallback so a
         * provider still emitting it is not silently ignored.
         */
        inputTokenDetails?: {
          noCacheTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
        /** Legacy/alternate field name for the same quantity. */
        cachedInputTokens?: number;
      };
      error?: unknown;
    };

    class StreamErrorSignal extends Error {
      constructor(message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
      }
    }

    let lastErrMsg = "LLM provider request failed.";
    let providerAttemptCount = 0;
    let policySuppressedToolFallback = false;
    const circuitSkippedProviders: string[] = [];

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
        lastErrMsg = "LLM provider initialization failed.";
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
        lastErrMsg = `Model ${candidate.provider}/${candidate.model} does not declare vision input support`;
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "vision_not_supported",
          message: lastErrMsg,
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
      if (aiTools !== undefined && Object.keys(aiTools).length > 0) {
        streamParams.tools = aiTools;
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
        streamParams.stopWhen = stepCountIs(effectiveMaxToolSteps);
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
            ...(liveActive !== undefined
              ? { activeTools: [...liveActive] }
              : {}),
            ...(requireToolUse && firstStep
              ? { toolChoice: "required" as const }
              : {}),
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

      let retryGuidance: ModelMessage | undefined;
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
          retryGuidance === undefined
            ? retryBaseMessages
            : [...retryBaseMessages, retryGuidance];
        return runtime.appConfig.anthropicPromptCacheEnabled !== false
          ? cacheMode === "anthropic"
            ? applyAnthropicPromptCache(attemptMessages)
            : cacheMode === "bedrock"
              ? applyBedrockPromptCache(attemptMessages)
              : attemptMessages
          : attemptMessages;
      };

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        providerAttemptCount += 1;
        // Every retry starts from the identical original prefix plus at most one
        // replacement guidance message. Invalid model output is never appended
        // cumulatively, preserving provider prompt-cache reuse.
        streamParams.messages = messagesForAttempt();
        const attemptStartedAt = Date.now();
        // Hard cap against the output-token clamp: deterministically shrink the
        // assembled prompt so it fits the usable input budget, BEFORE clamping
        // the output allowance. Without this a prompt larger than the window
        // floors maxOutputTokens at 1 (clampMaxOutputTokens), and the model can
        // emit no final-answer marker / verifier pass signal — the run ends with
        // no result despite valid findings. Truncating the input instead keeps
        // the output allowance intact and is recorded in the trace below.
        const truncation = truncateMessagesToWindow(
          streamParams.messages ?? [],
          candidate,
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
        let fullText = "";
        // Always retains the raw contract content for diagnostics, repetition
        // detection and strict-mode validation. In live mode a separate rolling
        // buffer releases answer text only after the start marker is complete.
        let finalAnswerBuffer = "";
        // Streaming a contract answer before its end marker is unsafe: SSE
        // output cannot be retracted if the closing validation rejects it.
        // Keep this false until the protocol supports a reversible client
        // transaction; validated content is emitted at stream completion.
        const streamFinalAnswer = false;
        type FinalAnswerStreamState =
          | "seeking-start"
          | "streaming"
          | "ended"
          | "interrupted";
        let finalAnswerStreamState: FinalAnswerStreamState = "seeking-start";
        const currentFinalAnswerStreamState = (): FinalAnswerStreamState =>
          finalAnswerStreamState;
        let finalAnswerPending = "";
        let liveAnswerStarted = false;
        let reasoningText = "";
        let emittedAny = false;
        // Set when the visible answer was synthesized by the engine rather than
        // streamed by the model (reasoning-salvage or the empty-response
        // fallback). In that case the model's own response messages are empty
        // or missing, so the success path must return `fullText` explicitly
        // instead of the (empty) provider response messages.
        let forcedAnswer = false;
        // Distinguishes graceful empty-completion degradation from a real
        // model answer. Agent-harness aggregation must not treat this marker as
        // a factual research finding for a downstream synthesizer.
        let emptyResponseFallbackUsed = false;
        // Tracks whether requireToolUse was active but the model produced text
        // without calling any tool (i.e. ignored the forced toolChoice). Detected
        // post-stream and triggers a retry with a nudge, analogous to the
        // reasoning-only retry path.
        let textWithoutToolCall = false;
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
              fullText + reasoningText,
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
        let thinkBuf = "";
        let inThink = false;
        let toolPhaseStarted = false;
        // A tool call itself is not a user-facing completion. Remember the
        // visible-text boundary at the latest result so an empty post-tool
        // model step cannot silently complete the node with a stale preamble.
        let visibleTextLengthAtLastToolResult: number | undefined;
        let lastToolResultForRetry: unknown;
        let preambleBuf = "";
        // Bounded lookahead for the preamble: text before a tool call is
        // ambiguous (narration vs. the direct answer), so we hold it back
        // from `content` only briefly — up to PREAMBLE_MAX_MS after the
        // first preamble delta, or PREAMBLE_MAX_CHARS, or a sentence
        // boundary, whichever comes first. If a tool call hasn't fired by
        // then, we resolve it as the real answer and stream everything from
        // that point on live, instead of withholding the whole response
        // until the stream ends (which made direct answers on tool-enabled
        // nodes appear to never stream).
        let preambleResolved = false;
        let preambleStartedAt = 0;
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
        let loopAborted = false;
        let outputAborted = false;
        let repScanAt = 0;
        const repAbort = new AbortController();

        const flushThinkBuf = async (): Promise<void> => {
          if (thinkBuf.length === 0) return;
          if (inThink) {
            reasoningText += thinkBuf;
            try {
              await runtime.onReasoning(node.id, thinkBuf);
            } catch {
              /* disconnect */
            }
          } else {
            fullText += thinkBuf;
            emittedAny = true;
            try {
              await runtime.onToken(node.id, thinkBuf);
            } catch {
              /* disconnect */
            }
          }
          thinkBuf = "";
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
              reasoningText += reasoning;
              try {
                await runtime.onReasoning(node.id, reasoning);
              } catch {
                /* disconnect */
              }
            }
            return;
          }
          thinkBuf += delta;
          while (true) {
            if (!inThink) {
              const openIdx = thinkBuf.indexOf("<think>");
              if (openIdx === -1) {
                const ltIdx = thinkBuf.lastIndexOf("<");
                const safeLen = ltIdx !== -1 ? ltIdx : thinkBuf.length;
                if (safeLen > 0) {
                  const safe = thinkBuf.slice(0, safeLen);
                  fullText += safe;
                  emittedAny = true;
                  try {
                    await runtime.onToken(node.id, safe);
                  } catch {
                    /* disconnect */
                  }
                  thinkBuf = thinkBuf.slice(safeLen);
                }
                break;
              }
              if (openIdx > 0) {
                const before = thinkBuf.slice(0, openIdx);
                fullText += before;
                emittedAny = true;
                try {
                  await runtime.onToken(node.id, before);
                } catch {
                  /* disconnect */
                }
              }
              inThink = true;
              thinkBuf = thinkBuf.slice(openIdx + 7);
            } else {
              const closeIdx = thinkBuf.indexOf("</think>");
              if (closeIdx === -1) {
                const ltIdx = thinkBuf.lastIndexOf("<");
                const safeLen = ltIdx !== -1 ? ltIdx : thinkBuf.length;
                if (safeLen > 0) {
                  const safe = thinkBuf.slice(0, safeLen);
                  reasoningText += safe;
                  try {
                    await runtime.onReasoning(node.id, safe);
                  } catch {
                    /* disconnect */
                  }
                  thinkBuf = thinkBuf.slice(safeLen);
                }
                break;
              }
              if (closeIdx > 0) {
                const thinking = thinkBuf.slice(0, closeIdx);
                reasoningText += thinking;
                try {
                  await runtime.onReasoning(node.id, thinking);
                } catch {
                  /* disconnect */
                }
              }
              inThink = false;
              thinkBuf = thinkBuf.slice(closeIdx + 8);
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
          fullText += visible;
          emittedAny = true;
          forcedAnswer = true;
          liveAnswerStarted = true;
          try {
            await runtime.onToken(node.id, visible);
          } catch {
            /* disconnect */
          }
        };

        const routeFinalAnswerDelta = async (delta: string): Promise<void> => {
          finalAnswerBuffer += delta;
          if (!streamFinalAnswer || finalAnswerContract === undefined) return;
          if (
            finalAnswerStreamState === "ended" ||
            finalAnswerStreamState === "interrupted"
          ) {
            return;
          }

          finalAnswerPending += delta;
          if (finalAnswerStreamState === "seeking-start") {
            const rawStart = finalAnswerBuffer.indexOf(
              finalAnswerContract.startMarker,
            );
            const rawEnd = finalAnswerBuffer.indexOf(
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
            forcedAnswer = true;
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
          const result = streamText(streamParams);

          for await (const rawPart of result.fullStream) {
            const part = rawPart as StreamPart;

            const generatedChars =
              (finalAnswerContract !== undefined
                ? finalAnswerBuffer.length
                : fullText.length + preambleBuf.length + thinkBuf.length) +
              reasoningText.length;
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
              outputAborted = true;
              thinkBuf = "";
              preambleBuf = "";
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
              break;
            }

            // Repetition guard — throttled scan of what has been generated so
            // far. Placed at the top of the loop so it observes the text/
            // reasoning appended by previous parts. On a detected loop we
            // truncate to the first (non-repeated) block, abort the upstream
            // generation, and break — treating the truncated text as the
            // answer (see the post-loop success path).
            const candidateText =
              finalAnswerContract !== undefined ? finalAnswerBuffer : fullText;
            const grown = candidateText.length + reasoningText.length;
            if (grown - repScanAt >= REPETITION_CHECK_INTERVAL) {
              repScanAt = grown;
              const repFull = detectRepeatedTail(candidateText);
              const repReason = repFull.loop
                ? { loop: false, safeLen: reasoningText.length }
                : detectRepeatedTail(reasoningText);
              if (repFull.loop || repReason.loop) {
                if (repFull.loop && finalAnswerContract === undefined) {
                  fullText = fullText.slice(0, repFull.safeLen);
                }
                if (repReason.loop)
                  reasoningText = reasoningText.slice(0, repReason.safeLen);
                loopAborted = true;
                thinkBuf = "";
                preambleBuf = "";
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
                        ? finalAnswerBuffer.length
                        : fullText.length) + reasoningText.length,
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
                break;
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
                !preambleResolved &&
                (!toolPhaseStarted || suppressToolPreamble) &&
                !delta.startsWith("\x00r")
              ) {
                if (preambleBuf.length === 0) preambleStartedAt = Date.now();
                preambleBuf += delta;
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
                const elapsedMs = Date.now() - preambleStartedAt;
                if (
                  !suppressToolPreamble &&
                  !requireToolUse &&
                  (elapsedMs >= PREAMBLE_MAX_MS ||
                    preambleBuf.length >= PREAMBLE_MAX_CHARS ||
                    PREAMBLE_SENTENCE_BOUNDARY_RE.test(preambleBuf))
                ) {
                  preambleResolved = true;
                  fullText += preambleBuf;
                  emittedAny = true;
                  try {
                    await runtime.onToken(node.id, preambleBuf);
                  } catch {
                    /* disconnect */
                  }
                  preambleBuf = "";
                }
              } else {
                await routeDelta(delta);
              }
            } else if (part.type === "reasoning-delta") {
              await flushThinkBuf();
              const reasoning = (part as { text?: string }).text ?? "";
              if (reasoning.length > 0) {
                reasoningText += reasoning;
                try {
                  await runtime.onReasoning(node.id, reasoning);
                } catch {
                  /* disconnect */
                }
              }
            } else if (part.type === "tool-call") {
              await flushThinkBuf();
              if (!toolPhaseStarted) {
                toolPhaseStarted = true;
                // The narration was already streamed live on the reasoning
                // channel; fold it into the persisted reasoning too, so the
                // debug trace and history match what the client saw.
                reasoningText += preambleBuf;
                preambleBuf = "";
              } else if (suppressToolPreamble && preambleBuf.length > 0) {
                // Planning narration between tool steps: a subsequent call
                // proves it was not the answer, so drop it from `content`
                // (keeping it in the reasoning trail) and re-arm the buffer
                // for the next step.
                reasoningText += preambleBuf;
                preambleBuf = "";
              }
              const id = part.toolCallId ?? crypto.randomUUID();
              const toolName = part.toolName ?? "unknown";
              const toolRef = toolRefByKey.get(toolName);
              if (toolRef !== undefined) toolRefByCallId.set(id, toolRef);
              emittedAny = true;
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
              if (!toolPhaseStarted) {
                toolPhaseStarted = true;
                reasoningText += preambleBuf;
                preambleBuf = "";
              } else if (suppressToolPreamble && preambleBuf.length > 0) {
                // Same as the tool-call branch: narration preceding a later
                // tool result is planning text, not the answer — kept in the
                // reasoning trail, dropped from `content`.
                reasoningText += preambleBuf;
                preambleBuf = "";
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
                    ...(excerpt !== undefined ? { error_excerpt: excerpt } : {}),
                  },
                });
              }
              visibleTextLengthAtLastToolResult = fullText.length;
              lastToolResultForRetry = output;
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
              if (!toolPhaseStarted) {
                toolPhaseStarted = true;
                reasoningText += preambleBuf;
                preambleBuf = "";
              } else if (suppressToolPreamble && preambleBuf.length > 0) {
                // Same as the tool-call branch: narration preceding a later
                // tool error is planning text, not the answer — kept in the
                // reasoning trail, dropped from `content`.
                reasoningText += preambleBuf;
                preambleBuf = "";
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
              visibleTextLengthAtLastToolResult = fullText.length;
              lastToolResultForRetry = {
                isError: true,
                error: detail,
              };
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
                  fullText += mdImage;
                  emittedAny = true;
                  try {
                    await runtime.onToken(node.id, mdImage);
                  } catch {
                    /* disconnect */
                  }
                } else {
                  const mdImage = `\n\n![](data:${gf.mediaType};base64,${gf.base64})\n\n`;
                  fullText += mdImage;
                  emittedAny = true;
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
              outputAborted = true;
              thinkBuf = "";
              preambleBuf = "";
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
              break;
            }
          }

          await flushThinkBuf();

          // A held-back preamble is normally released here as the direct answer.
          // Keep it held for every requireToolUse attempt, including the final
          // one: the post-stream guard must first determine whether the model
          // merely copied a historical assistant error. A legitimate inferred
          // text answer is emitted explicitly by the release branch below.
          const holdPreambleForToolUse = requireToolUse && !toolPhaseStarted;
          // With suppression the buffer also collects text emitted AFTER the
          // first tool call (per-step narration lookahead). Whatever is still
          // buffered when the stream ends follows the last tool result, so it
          // is the real answer and must be released here — this also keeps the
          // `post_tool_answer_missing` guard below from firing on a correct
          // answer that only ever lived in the buffer.
          if (
            preambleBuf.length > 0 &&
            !holdPreambleForToolUse &&
            (!toolPhaseStarted || suppressToolPreamble)
          ) {
            fullText += preambleBuf;
            emittedAny = true;
            try {
              await runtime.onToken(node.id, preambleBuf);
            } catch {
              /* disconnect */
            }
            preambleBuf = "";
          }

          let liveFinalAnswerAccepted = false;
          if (streamFinalAnswer && finalAnswerContract !== undefined) {
            await flushIncompleteLiveAnswer();
            liveFinalAnswerAccepted =
              currentFinalAnswerStreamState() === "ended" &&
              extractFinalAnswer(finalAnswerBuffer, finalAnswerContract).ok;
          }

          if (finalAnswerContract !== undefined && !liveFinalAnswerAccepted) {
            const extracted = extractFinalAnswer(
              finalAnswerBuffer,
              finalAnswerContract,
            );
            if (extracted.ok) {
              fullText = extracted.answer;
              emittedAny = true;
              // The provider response still contains the rejected planning
              // around the markers. Persist a clean engine-owned AIMessage.
              forcedAnswer = true;
              const SSE_CHUNK_SIZE = 60_000;
              try {
                for (
                  let offset = 0;
                  offset < fullText.length;
                  offset += SSE_CHUNK_SIZE
                ) {
                  await runtime.onToken(
                    node.id,
                    fullText.slice(offset, offset + SSE_CHUNK_SIZE),
                  );
                }
              } catch {
                /* disconnect */
              }
            } else {
              // Tool/file events must not turn a rejected textual answer into a
              // successful provider-message persistence path.
              fullText = "";
              emittedAny = false;
              forcedAnswer = true;
              lastErrMsg = `final-answer contract rejected model output (${extracted.reason})`;
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
                  raw_chars: finalAnswerBuffer.length,
                  reason: extracted.reason,
                },
              });

              if (attempt < maxAttempts) {
                const rawExcerpt = finalAnswerBuffer.slice(-800);
                retryGuidance = {
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
                continue;
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
              fullText = "";
              preambleBuf = "";
              emittedAny = false;
              forcedAnswer = true;
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
                retryGuidance = {
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
                continue;
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
            !toolPhaseStarted &&
            (emittedAny || preambleBuf.length > 0)
          ) {
            const textOnly = fullText + preambleBuf;
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
              textWithoutToolCall = true;
              // Rejected retry attempts and mandatory failures are accounted as
              // errors here. A final engine-owned history-copy fallback falls
              // through to the normal success accounting below, exactly once.
              if (attempt < maxAttempts || requireToolUseMandatory) {
                accountAttempt("error");
              }
              fullText = "";
              preambleBuf = "";
              emittedAny = false;
              forcedAnswer = true;
            }

            if (attempt < maxAttempts) {
              const selectedToolHint =
                selectedBoundToolKeys.length > 0
                  ? ` Use one of these active tools: ${selectedBoundToolKeys.join(", ")}.`
                  : "";
              retryGuidance = {
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
              continue;
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
              policySuppressedToolFallback = true;
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
              fullText =
                "I could not re-query the live status because no tool call was " +
                "executed. The previously reported error is therefore not a " +
                "new result.";
              emittedAny = true;
              forcedAnswer = true;
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
                await runtime.onToken(node.id, fullText);
              } catch {
                /* disconnect */
              }
            } else {
              // The requirement was inferred from semantic selection, not an
              // authored contract. Preserve the existing fail-open behaviour for
              // an independent text answer, but emit its held preamble only now.
              if (preambleBuf.length > 0) {
                fullText += preambleBuf;
                emittedAny = true;
                try {
                  await runtime.onToken(node.id, preambleBuf);
                } catch {
                  /* disconnect */
                }
                preambleBuf = "";
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
            visibleTextLengthAtLastToolResult !== undefined &&
            fullText.slice(visibleTextLengthAtLastToolResult).trim().length ===
              0;
          if (missingPostToolAnswer) {
            const serializedResult = (() => {
              try {
                const text = JSON.stringify(lastToolResultForRetry);
                return text.length > 6_000 ? `${text.slice(0, 6_000)}…` : text;
              } catch {
                return "[Tool result could not be serialized]";
              }
            })();
            fullText = "";
            preambleBuf = "";
            emittedAny = false;
            forcedAnswer = true;
            runtime.onNodeDiagnostic?.(node.id, {
              level: attempt < maxAttempts ? "warn" : "error",
              code: "post_tool_answer_missing",
              message:
                "Tool result was received but the model produced no visible " +
                "answer afterwards.",
              details: {
                attempt,
                model: `${candidate.provider}/${candidate.model}`,
              },
            });
            if (attempt < maxAttempts && !requireToolUse) {
              retryGuidance = {
                role: "user",
                content:
                  "You received a tool result but did not phrase a visible " +
                  "answer for the user. Produce a short, correct answer from " +
                  "this result now. Do not call another tool. " +
                  "Tool result: " +
                  serializedResult,
              };
              streamParams.toolChoice = "none" as const;
              accountAttempt("error");
              runtime.metrics.recordLlmRetry(
                candidate.provider,
                candidate.model,
              );
              await sleep(fullJitter(backoffMs));
              continue;
            }
          }

          if (!emittedAny) {
            // Detect "reasoning-only" response: the model produced <think> content
            // but no visible text and no tool call.  This happens when maxTokens
            // is tight relative to the prompt size — the model exhausts its budget
            // inside the <think> block and emits nothing afterwards.
            //
            // Mitigation: on attempts before the last one inject a short nudge
            // user-message asking the model to stop reasoning and produce output.
            // We append it to messagesWithSystemPrompt so the next streaming call
            // sees it, then pop it so the outer message list stays clean.
            if (reasoningText.length > 0 && attempt < maxAttempts) {
              retryGuidance = {
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
                  reasoning_chars: reasoningText.length,
                },
              });
              // Full jitter — see the requireToolUse retry above.
              await sleep(fullJitter(backoffMs));
              continue;
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
            const salvaged = stripReasoningSentinelMarkers(reasoningText)
              .replace(/<\/?think>/gi, "")
              .trim();
            const reasoningSalvageEnabled =
              finalAnswerContract === undefined &&
              (!requireToolUse || toolPhaseStarted) &&
              allowsReasoningSalvage(
                streamFallbackPolicy,
                streamFallbackNodeConfig,
              );
            if (salvaged.length > 0 && reasoningSalvageEnabled) {
              fullText = salvaged;
              emittedAny = true;
              forcedAnswer = true;
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
                fullText = fallbackText;
                emittedAny = true;
                forcedAnswer = true;
                emptyResponseFallbackUsed = true;
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
                  await runtime.onToken(node.id, fullText);
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
                    ...(textWithoutToolCall
                      ? { require_tool_use_ignored: true }
                      : {}),
                  },
                });
                throw new StreamErrorSignal(
                  textWithoutToolCall
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
          fullText = stripLeakedContextEcho(fullText);

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
            fullText = runtime.refHandles.unmapText(fullText);
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

          // Never cache a response the repetition guard had to truncate: it is
          // a degenerate/looped output, and persisting it would replay the
          // corrupted answer on every future cache hit.
          if (cacheable && !loopAborted && !outputAborted) {
            const cachedValue: CachedResponse = {
              text: fullText,
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
            if (fullText.trim().length > 0) {
              const report = await runtime.groundednessGate.evaluate(
                fullText,
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
            response: fullText + groundedFooter,
            ...(reasoningText.length > 0 ? { reasoning: reasoningText } : {}),
          });
          runtime.providerCircuitBreaker?.recordReachable(candidate.provider);

          return {
            currentNodeId: node.id,
            // When the answer was synthesized by the engine (reasoning-salvage
            // or the empty-response fallback), the provider's response messages
            // are empty/missing — return the forced `fullText` explicitly so
            // the salvaged/fallback answer is not silently dropped.
            messages: forcedAnswer
              ? [
                  new AIMessage({
                    content: fullText + groundedFooter,
                    ...(emptyResponseFallbackUsed
                      ? {
                          additional_kwargs: {
                            aiperator_empty_response_fallback: true,
                          },
                        }
                      : {}),
                  }),
                ]
              : (responseMessages ?? [
                  new AIMessage(fullText + groundedFooter),
                ]),
          };
        } catch (err) {
          accountAttempt("error");
          const requestTimedOut =
            !runtime.signal?.aborted && requestDeadline.aborted;
          const errorCause = err instanceof Error ? err.cause : undefined;
          const transactionBudgetExceeded =
            isBudgetExceededError(err) || isBudgetExceededError(errorCause);
          lastErrMsg = transactionBudgetExceeded
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
                after_partial_output: emittedAny,
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
                  after_partial_output: emittedAny,
                  issues: promptSchemaIssues.map(formatPromptSchemaIssue),
                },
              });
            }
          }
          if (emittedAny) {
            if (fullText.length > 0 || reasoningText.length > 0)
              runtime.onNodeIo?.(node.id, {
                ...(fullText.length > 0 ? { response: fullText } : {}),
                ...(reasoningText.length > 0
                  ? { reasoning: reasoningText }
                  : {}),
              });
            return {
              currentNodeId: node.id,
              errors: [
                {
                  message: `Node "${node.id}": LLM stream error after partial output — ${lastErrMsg}`,
                  type: "execution_error",
                  details: { node_id: node.id },
                },
              ],
            };
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
            break;
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
            break;
          }

          if (attempt < maxAttempts) {
            runtime.metrics.recordLlmRetry(candidate.provider, candidate.model);
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "retry",
              message: `LLM stream error; retrying (attempt ${attempt}/${maxAttempts}): ${lastErrMsg}`,
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
            continue;
          }
          break;
        }
      }
    }

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
  factory: (node) => createLlmNodeHandler(node),
};

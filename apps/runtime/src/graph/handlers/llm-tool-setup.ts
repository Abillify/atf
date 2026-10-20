// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool setup for the `llm` node handler.
 *
 * Extracted verbatim from `llm.ts` (task 18.1, Req 13.6) — behaviour is
 * unchanged. Builds the AI-SDK tool set (MCP tools with semantic selection,
 * media tools, client-tool passthrough, image inspection) and the assistant
 * session binding / tool journal used by the streaming loop.
 */
import type { ToolSet } from "ai";
import type {
  FigureEmbeddingConfig,
  FlowNode,
  ImageInspectionConfig,
} from "../../types/flow.js";
import { resolveAssistantScope } from "../../assistants/types.js";
import type { ExecRuntime } from "../exec-runtime.js";
import { lastUserQuery } from "../exec-runtime.js";
import type { AgentState } from "../graph-engine.js";
import type { resolveNodeConfig } from "../graph-engine/node-config.js";
import { buildClassificationNamespaces } from "../classification-access.js";
import {
  buildAiTools,
  buildMediaTools,
  buildImageInspectionTools,
  buildClientTools,
  buildToolSelectionMetaTool,
  uniqueMediaToolKey,
} from "../agent-tools.js";
import { IMAGE_INSPECTION_TOOL_NAME } from "../image-reference.js";
import { buildShowFigureTools } from "../figure-embedding.js";
import {
  parseToolSelection,
  expandPatterns,
  buildGroupSummary,
} from "../tool-selection.js";
import { buildCostAttribution } from "../../observability/cost.js";
import { buildAssetFetch } from "./llm-asset-fetch.js";
import { buildLoopGuardedExecuteToolCall } from "./llm-tool-loop-guard.js";
import {
  markTaintFromSearchLabels,
  markTaintFromUntrustedSource,
  reportingValidator,
} from "../injection-findings.js";
import { taintGuardForNode } from "../execution-taint.js";

/**
 * Tool refs a safe assistant retry may force back into the tool pool without a
 * semantic-selection round: read-only status probes whose re-invocation cannot
 * cause side effects.
 */
const SAFE_ASSISTANT_RETRY_TOOL_REFS = new Set([
  "parking/status",
  "parking/availability",
]);

/**
 * Run-scoped ref-handle registries whose `ref_strict_check_disabled`
 * diagnostic was already emitted (one per run, not one per tool call).
 */
const strictDisabledReported = new WeakSet<object>();

export function readSafeAssistantRetryToolRefs(
  requestParams: Record<string, unknown> | undefined,
): string[] {
  const raw = requestParams?.assistant_retry_tool_refs;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (ref): ref is string =>
      typeof ref === "string" && SAFE_ASSISTANT_RETRY_TOOL_REFS.has(ref),
  );
}

/**
 * Resolves every tool source for one `llm` node execution. Returns the
 * assembled AI-SDK tool set plus the selection bookkeeping the streaming loop
 * and the system-prompt builder need.
 */
export async function setupLlmTools(params: {
  runtime: ExecRuntime;
  node: FlowNode;
  state: AgentState;
  resolved: ReturnType<typeof resolveNodeConfig>;
}) {
  const { runtime, node, state, resolved } = params;
  let aiTools: ToolSet | undefined;
  const effectiveToolArgsByCallId = new Map<string, Record<string, unknown>>();
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
        runtime.ctx.chatId ?? runtime.ctx.sessionId ?? runtime.ctx.executionId,
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
  const loopGuardedExecuteToolCall = buildLoopGuardedExecuteToolCall(
    runtime,
    node,
  );
  const taintGuard = taintGuardForNode(runtime, node.id);
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
    const classificationNamespaces = buildClassificationNamespaces(state.turns);
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
        reportingValidator(runtime, node.id),
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
          // Write tools need approval once the injection scan has flagged
          // content in this run (no-op for a clean run or read-only tools).
          ...(taintGuard !== undefined ? { taint: taintGuard } : {}),
          // Search's own content-trust verdict (`injection_risk:
          // "suspected"`) taints the run too — its signal list diverges
          // from the runtime regex scan by design.
          onSearchInjectionLabel: (
            sourceRef: string,
            toolContent: unknown,
            resultMeta?: unknown,
          ) => {
            markTaintFromSearchLabels(runtime, node.id, sourceRef, toolContent);
            markTaintFromUntrustedSource(runtime, node.id, sourceRef, toolContent, resultMeta);
          },
          // Ref-handle indirection (config.refHandles): resolve the model's
          // short handles back to real references and mask references in
          // tool results, per node opt-in only.
          ...(runtime.refHandles !== undefined &&
          (node.config as { refHandles?: unknown } | undefined)?.refHandles ===
            true
            ? {
                refHandles: runtime.refHandles,
                onRefHandleRejected: (info: {
                  toolCallId: string;
                  toolRef: string;
                  kind: "unknown_ref_handle" | "unregistered_ref";
                  values: string[];
                }) => {
                  runtime.onNodeDiagnostic?.(node.id, {
                    level: "warn",
                    code:
                      info.kind === "unregistered_ref"
                        ? "unregistered_ref_rejected"
                        : "unknown_ref_handle_rejected",
                    message:
                      info.kind === "unregistered_ref"
                        ? `Rejected ${info.toolRef} call: reference(s) not returned by any tool in this run (model-assembled).`
                        : `Rejected ${info.toolRef} call: unknown reference handle(s).`,
                    details: {
                      tool_call_id: info.toolCallId,
                      tool_ref: info.toolRef,
                      values: info.values,
                    },
                  });
                },
                onRefStrictCheckDisabled: () => {
                  const registry = runtime.refHandles;
                  if (
                    registry === undefined ||
                    strictDisabledReported.has(registry)
                  )
                    return;
                  strictDisabledReported.add(registry);
                  runtime.onNodeDiagnostic?.(node.id, {
                    level: "info",
                    code: "ref_strict_check_disabled",
                    message:
                      "Seen-reference budget exhausted: unregistered references are no longer rejected for the rest of this run.",
                  });
                },
              }
            : runtime.refHandles !== undefined
              ? { refObserver: runtime.refHandles }
              : {}),
        },
      );
      aiTools = built.tools;
      unavailableTools = built.unavailable;
      toolKeyByRef = built.keyByRef;
      // Surface WHY tools are unavailable in the trace: one diagnostic per
      // server and cause, so e.g. a rejected token exchange is not visible
      // only as the model saying "temporarily unavailable".
      const byCause = new Map<
        string,
        { server: string; reason: string; tools: string[] }
      >();
      for (const toolRef of built.unavailable) {
        const server = toolRef.includes("/")
          ? (toolRef.split("/")[0] ?? toolRef)
          : toolRef;
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

  // Figure embedding (`show_figure`, see `figure-embedding.ts`): the node may
  // put a document figure into its answer as a short-lived media link. Double
  // gate — the deployment must enable it (`EMBED_SEARCH_FIGURES=true`) and be
  // able to hand out browser-reachable media URLs (`MEDIA_BASE_URL`), and the
  // node must declare `config.figureEmbedding` with its own `assetSource`
  // (synthesizer nodes typically have no `imageInspection` to inherit from).
  // The `get_asset` fetch runs with the caller's request context, so figure
  // access inherits the same ACL + fail-closed behaviour as `inspect_image`.
  const figureEmbedding = (
    node.config as { figureEmbedding?: FigureEmbeddingConfig } | undefined
  )?.figureEmbedding;
  if (figureEmbedding !== undefined) {
    const figureMcp = runtime.mcpWrapper;
    const figurePublish = runtime.publishMedia;
    const figureGateOpen =
      runtime.appConfig.embedSearchFigures === true &&
      runtime.appConfig.mediaBaseUrl !== undefined &&
      figureMcp !== undefined &&
      figurePublish !== undefined;
    if (!figureGateOpen) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "figure_embedding_unavailable",
        message:
          `Node ${node.id} declares config.figureEmbedding but the feature ` +
          "gate is off: it needs EMBED_SEARCH_FIGURES=true, MEDIA_BASE_URL, " +
          "a configured MCP server and the media store. The show_figure tool " +
          "is not exposed for this node.",
      });
    } else {
      const figureTools = buildShowFigureTools({
        existingTools: aiTools,
        config: figureEmbedding,
        fetchAsset: buildAssetFetch(
          figureMcp,
          runtime.ctx,
          figureEmbedding.assetSource,
          runtime.signal,
        ),
        publishMedia: figurePublish,
        onEffectiveArgs: (toolCallId, toolName, argsJson) =>
          runtime.onToolEffectiveArgs?.(toolCallId, toolName, argsJson),
      });
      if (Object.keys(figureTools).length > 0) {
        aiTools = { ...(aiTools ?? {}), ...figureTools };
        if (activeToolKeys !== undefined) {
          for (const k of Object.keys(figureTools)) activeToolKeys.add(k);
        }
      }
    }
  }

  return {
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
  };
}

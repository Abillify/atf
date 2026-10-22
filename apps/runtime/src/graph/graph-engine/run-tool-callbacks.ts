// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-call streaming callbacks for the graph engine execution:
 * synthetic tool nodes, tool telemetry, debug-trace tool calls, client
 * tool passthrough and the approval-required widget. Extracted from
 * handler-factories.ts per Req 13.6 (module size); behaviour unchanged.
 */

import crypto from "node:crypto";
import type { AppConfig } from "../../config/index.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { DebugToolCall } from "../../types/debug-trace.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { ExecutionEventMeta } from "../../monitoring/execution-store.js";
import type { DebugTraceStore } from "../../monitoring/debug-trace-store.js";
import { isToolErrorOutput, sanitizeToolResultOutput } from "../message-mapping.js";
import { nodeStateKey } from "./node-instance.js";
import { parseVectorSearchResults } from "../reranker.js";
import type { HashRefHandleRegistry } from "../ref-handles.js";
import { signApprovalLinkToken } from "../approval-link.js";
import type { PendingApproval } from "../approval-gate.js";
import { makeToolCallChunk } from "../exec-runtime.js";
import type { ExecRuntime } from "../exec-runtime.js";
import { estimateCost } from "../../observability/cost.js";
import type { SpendRecorder } from "../../observability/cost.js";
import { extractToolUsage } from "./tool-usage.js";
import type { NodeRunState } from "./run-state.js";

/**
 * Creates the per-execution tool callbacks. Deps are destructured into
 * locals with the same names the closures used before the extraction; the
 * debug store and the runtime are passed as getters because both are only
 * valid at CALL time (setDebugStore may replace the store; the runtime
 * const is defined later in _executeFlowInternal).
 */
export function createToolCallbacks(deps: {
  monitoring: MonitoringServiceInterface | undefined;
  monitoringMeta: ExecutionEventMeta;
  executionId: string;
  flowId: string;
  model: string;
  ctx: RequestContext;
  st: NodeRunState;
  userPromptPreview: string | undefined;
  emitReasoningStep: (text: string) => Promise<void>;
  onChunk: (chunk: ChatCompletionChunk) => Promise<void>;
  refHandles: HashRefHandleRegistry | undefined;
  llmPricing: AppConfig["llmPricing"];
  costTracker: SpendRecorder | undefined;
  getDebugStore: () => DebugTraceStore | undefined;
  getRuntime: () => ExecRuntime;
}) {
  const {
    monitoring,
    monitoringMeta,
    executionId,
    flowId,
    model,
    ctx,
    st,
    userPromptPreview,
    emitReasoningStep,
    onChunk,
    refHandles,
    llmPricing,
    costTracker,
    getDebugStore,
    getRuntime,
  } = deps;
  const {
    nodeToolCalls,
    nodeDebugToolCalls,
    nodeModels,
    nodeInputTokens,
    nodeOutputTokens,
    nodeToolCostOverride,
  } = st;

    // Tracks in-flight tool calls so onToolResult can build the <details> block
    const _pendingToolCallIds = new Map<
      string,
      { name: string; argsJson: string }
    >();

    // -----------------------------------------------------------------------
    // Synthetic "tool" nodes
    // -----------------------------------------------------------------------
    const toolNodes = new Map<
      string,
      { nodeId: string; parentId: string; startTime: string; sequence: number }
    >();
    /**
     * Captured input (args) and output (result) per tool call, so the synthetic
     * tool node in the live graph can show what a tool (e.g. vectorsearch) was
     * called with and what it returned — not just its timing/token/cost.
     */
    const toolNodeArgs = new Map<string, string>();
    const toolNodeResults = new Map<string, string>();
    const TOOL_IO_LIMIT = 16_000;
    const truncateToolIo = (s: string): string =>
      s.length > TOOL_IO_LIMIT
        ? `${s.slice(0, TOOL_IO_LIMIT)}…[truncated]`
        : s;
    /**
     * Effective tool-call arguments (after forced flow args, ref-handle
     * resolution and egress DLP), reported by `onToolEffectiveArgs` from
     * inside the tool execution. `onToolCall` only ever sees the RAW model
     * output, which is pre-DLP and therefore reduced to `argument_keys` for
     * telemetry — which left operators unable to see the actual search query
     * a tool ran with. The effective arguments are exactly what the tool
     * received (in redact mode already scrubbed), so they may be surfaced
     * wherever the full tool RESULT is already shown: the live graph node,
     * the debug trace and the reasoning `<details>` block.
     */
    const toolEffectiveArgs = new Map<string, string>();
    /**
     * Builds the display "response" text for a tool node. Any tool result that
     * parses as a vectorsearch-style payload (`{ results: [...] }`, incl. the
     * MCP text-content wrapper) is normalised into a compact
     * `{ totalMatches, findings:[{id,title,score,url}] }` shape the dashboard
     * renders as a findings table — this is name-agnostic, so it works for
     * vectorsearch, retrieval, and any other tool returning that shape.
     * `parseVectorSearchResults` returns `[]` for anything else, in which case
     * the raw result JSON is used. Returns undefined when there is nothing to
     * show.
     */
    const buildToolResultDisplay = (content: unknown): string | undefined => {
      const chunks = parseVectorSearchResults(content);
      if (chunks.length > 0) {
        return JSON.stringify({
          totalMatches: chunks.length,
          findings: chunks.map((c) => ({
            id: c.id,
            title: c.title,
            score: c.retrievalScore,
            ...(c.url !== "" ? { url: c.url } : {}),
          })),
        });
      }
      try {
        return typeof content === "string" ? content : JSON.stringify(content);
      } catch {
        return undefined;
      }
    };
    /** Emits the "running" event for a synthetic tool node. */
    const emitToolNodeStart = (toolCallId: string, toolName: string): void => {
      if (!monitoring) return;
      const parentId = st.lastActiveNodeId ?? "";
      const nodeId = `${parentId}::tool::${toolCallId}`;
      const startTime = new Date().toISOString();
      st.nodeSequence += 1;
      const sequence = st.nodeSequence;
      toolNodes.set(toolCallId, { nodeId, parentId, startTime, sequence });
      monitoring.emitNodeEvent(
        executionId,
        {
          execution_id: executionId,
          node_id: nodeId,
          kind: "tool",
          ...(parentId !== "" ? { parent_node_id: parentId } : {}),
          label: toolName,
          status: "running",
          start_time: startTime,
          end_time: null,
          latency_ms: null,
          sequence,
          // Identity fields, stamped like regular node events (see
          // userPromptPreview below): a live picker row built solely from
          // tool-node events (e.g. when the dashboard joined mid-run and
          // missed the parent node's events) would otherwise show no user
          // or prompt until the parent node finally completes.
          ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
          ...(userPromptPreview !== undefined
            ? { user_prompt: userPromptPreview }
            : {}),
          flow_id: flowId,
        },
        monitoringMeta,
      );
    };
    /** Emits the terminal (completed/error) event for a synthetic tool node. */
    const emitToolNodeEnd = (
      toolCallId: string,
      execTimeSec: number,
      errorMessage?: string,
    ): void => {
      if (!monitoring) return;
      const info = toolNodes.get(toolCallId);
      if (info === undefined) return;
      toolNodes.delete(toolCallId);
      let toolCost: number | undefined = nodeToolCostOverride.get(toolCallId);
      nodeToolCostOverride.delete(toolCallId);
      const toolModelKey = nodeModels.get(toolCallId);
      if (toolCost === undefined && toolModelKey !== undefined) {
        const slash = toolModelKey.indexOf("/");
        const provider =
          slash >= 0 ? toolModelKey.slice(0, slash) : toolModelKey;
        const modelName =
          slash >= 0 ? toolModelKey.slice(slash + 1) : toolModelKey;
        const inp = nodeInputTokens.get(toolCallId) ?? 0;
        const out = nodeOutputTokens.get(toolCallId) ?? 0;
        if (inp > 0 || out > 0) {
          toolCost = estimateCost(
            provider,
            modelName,
            { prompt_tokens: inp, completion_tokens: out },
            llmPricing,
          );
        }
      }
      monitoring.emitNodeEvent(
        executionId,
        {
          execution_id: executionId,
          node_id: info.nodeId,
          kind: "tool",
          ...(info.parentId !== "" ? { parent_node_id: info.parentId } : {}),
          status: errorMessage !== undefined ? "error" : "completed",
          start_time: info.startTime,
          end_time: new Date().toISOString(),
          latency_ms: Math.round(execTimeSec * 1000),
          ...(errorMessage !== undefined
            ? { error_message: errorMessage }
            : {}),
          sequence: info.sequence,
          ...(toolModelKey !== undefined ? { model: toolModelKey } : {}),
          ...(nodeInputTokens.has(toolCallId)
            ? { input_tokens: nodeInputTokens.get(toolCallId) }
            : {}),
          ...(nodeOutputTokens.has(toolCallId)
            ? { output_tokens: nodeOutputTokens.get(toolCallId) }
            : {}),
          ...(toolCost !== undefined ? { cost: toolCost } : {}),
          ...(toolNodeArgs.has(toolCallId)
            ? { prompt: toolNodeArgs.get(toolCallId) }
            : {}),
          ...(toolNodeResults.has(toolCallId)
            ? { response: toolNodeResults.get(toolCallId) }
            : {}),
          // See emitToolNodeStart: keep identity fields on every tool event.
          ...(ctx.userName !== undefined ? { user_name: ctx.userName } : {}),
          ...(userPromptPreview !== undefined
            ? { user_prompt: userPromptPreview }
            : {}),
          flow_id: flowId,
        },
        monitoringMeta,
      );
      toolNodeArgs.delete(toolCallId);
      toolNodeResults.delete(toolCallId);
    };

    // --- Tool streaming callbacks (Req 6.2, 6.3) ---
    type ToolTraceMetadata = NonNullable<DebugToolCall["coverage_search"]>;
    const pendingToolTraceMetadata = new Map<string, ToolTraceMetadata>();
    const toolCallOwnerNodeIds = new Map<string, string>();
    const mergeToolTraceMetadata = (
      toolCallId: string,
      metadata: ToolTraceMetadata,
    ): void => {
      const previous = pendingToolTraceMetadata.get(toolCallId);
      const merged: ToolTraceMetadata = {
        ...previous,
        ...metadata,
        ...(previous?.dedupe !== undefined || metadata.dedupe !== undefined
          ? { dedupe: { ...previous?.dedupe, ...metadata.dedupe } as ToolTraceMetadata["dedupe"] }
          : {}),
      };
      pendingToolTraceMetadata.set(toolCallId, merged);
      if (getDebugStore() === undefined) return;
      const ownerNodeId = toolCallOwnerNodeIds.get(toolCallId);
      const call =
        ownerNodeId === undefined
          ? undefined
          : nodeDebugToolCalls
              .get(ownerNodeId)
              ?.findLast((item) => item.id === toolCallId);
      if (call !== undefined) {
        call.coverage_search = merged;
        pendingToolTraceMetadata.delete(toolCallId);
      }
    };

    const onToolCall = async (
      toolCallId: string,
      toolName: string,
      argsJson: string,
      ownerNodeId?: string,
      instance?: string,
    ): Promise<void> => {
      let safeArgsJson = '{"argument_keys":[]}';
      try {
        const args = JSON.parse(argsJson) as unknown;
        const keys =
          args !== null && typeof args === "object" && !Array.isArray(args)
            ? Object.keys(args as Record<string, unknown>).sort()
            : [];
        safeArgsJson = JSON.stringify({ argument_keys: keys });
      } catch {
        // Invalid arguments are represented by an empty key list, never raw.
      }
      // Tool arguments are pre-DLP model output. Telemetry records shape only;
      // execution receives the original value through the AI SDK tool closure.
      // The SDK can start the tool's execute BEFORE this stream consumer
      // reaches the tool-call part, so effective args may already exist —
      // surface them immediately instead of the key-only placeholder.
      const preEffective = toolEffectiveArgs.get(toolCallId);
      const visibleArgsJson = preEffective ?? safeArgsJson;
      toolNodeArgs.set(toolCallId, visibleArgsJson);
      if (!_pendingToolCallIds.has(toolCallId)) {
        _pendingToolCallIds.set(toolCallId, {
          name: toolName,
          argsJson: safeArgsJson,
        });
      }
      emitToolNodeStart(toolCallId, toolName);
      // A delegation instance keeps its tool calls under its own state key.
      const owner = ownerNodeId ?? st.lastActiveNodeId;
      const activeNodeId =
        owner !== undefined && instance !== undefined
          ? nodeStateKey(owner, instance)
          : owner;
      if (activeNodeId !== undefined) {
        toolCallOwnerNodeIds.set(toolCallId, activeNodeId);
        const existing = nodeToolCalls.get(activeNodeId) ?? [];
        existing.push({
          id: toolCallId,
          name: toolName,
          args_json: visibleArgsJson,
        });
        nodeToolCalls.set(activeNodeId, existing);
      }
      if (getDebugStore() !== undefined && activeNodeId !== undefined) {
        let debugArguments: unknown;
        try {
          debugArguments = JSON.parse(visibleArgsJson) as unknown;
        } catch {
          // Truncated effective args are not valid JSON — fall back to the
          // key-only placeholder rather than failing the whole call.
          debugArguments = JSON.parse(safeArgsJson) as unknown;
        }
        const debugCalls = nodeDebugToolCalls.get(activeNodeId) ?? [];
        debugCalls.push({
          id: toolCallId,
          name: toolName,
          arguments: debugArguments,
          result: null,
          is_error: false,
          called_at: new Date().toISOString(),
          ...(pendingToolTraceMetadata.has(toolCallId)
            ? { coverage_search: pendingToolTraceMetadata.get(toolCallId) }
            : {}),
        });
        pendingToolTraceMetadata.delete(toolCallId);
        nodeDebugToolCalls.set(activeNodeId, debugCalls);
      }
      // The initial line carries NO argument payload: at this moment only the
      // raw pre-DLP model output exists, and showing just its keys
      // (`argument_keys`) carried no value for operators. It stays as the
      // "call started" marker (still shown when a tool errors before its
      // effective args exist — approval denial, missing required params,
      // egress block). The full key-value JSON follows on the next
      // `🔧 Tool:` line from `onToolEffectiveArgs`. When the effective args
      // already arrived BEFORE this callback (a fast tool execute racing the
      // stream consumer), that line was emitted already — skip this one.
      if (preEffective === undefined) {
        await emitReasoningStep(`🔧 Tool: **${toolName}**\n`);
      }
    };

    /**
     * Receives the final server-bound arguments once the tool execution
     * derives them (forced args + ref handles + egress DLP applied). Replaces
     * the key-only placeholder on every surface that renders AFTER this point:
     * the live graph node prompt (read at node completion), the owning node's
     * `tool_calls` telemetry (the dashboard's Tool Calls accordion), the
     * debug-trace tool call, and the `<details>` block built by
     * `onToolResult`. It also emits the follow-up `🔧 Tool:` reasoning line
     * carrying the FULL key-value JSON — the effective args are exactly what
     * the tool received (already egress-DLP scrubbed), so they are safe to
     * stream wherever the full tool RESULT is shown.
     */
    const onToolEffectiveArgs = async (
      toolCallId: string,
      toolName: string,
      argsJson: string,
    ): Promise<void> => {
      // Prefer the name `onToolCall` used for the first `🔧 Tool:` line so the
      // follow-up matches it exactly (MCP reports the `server/tool` ref there,
      // while the call line shows the AI-SDK tool key).
      const displayName =
        _pendingToolCallIds.get(toolCallId)?.name ?? toolName;
      const safe = truncateToolIo(argsJson);
      toolEffectiveArgs.set(toolCallId, safe);
      toolNodeArgs.set(toolCallId, safe);
      let parsedValid = false;
      try {
        JSON.parse(argsJson);
        parsedValid = true;
      } catch {
        /* invalid JSON stays key-only on every user-facing surface */
      }
      const ownerNodeId = toolCallOwnerNodeIds.get(toolCallId);
      const call =
        ownerNodeId === undefined
          ? undefined
          : nodeDebugToolCalls
              .get(ownerNodeId)
              ?.findLast((item) => item.id === toolCallId);
      if (call !== undefined && parsedValid) {
        call.arguments = JSON.parse(argsJson) as unknown;
      }
      if (ownerNodeId !== undefined && parsedValid) {
        const tc = nodeToolCalls
          .get(ownerNodeId)
          ?.findLast(
            (item) =>
              item.id === toolCallId && item.exec_time_seconds === undefined,
          );
        if (tc !== undefined) tc.args_json = safe;
      }
      if (parsedValid) {
        try {
          await emitReasoningStep(
            `🔧 Tool: **${displayName}** (arguments: ${safe})\n`,
          );
        } catch {
          /* client disconnect — telemetry must never break tool execution */
        }
      }
    };

    // --- Client tool-call passthrough callback ---
    let clientToolCallIndex = 0;
    const onClientToolCall = async (
      toolCallId: string,
      toolName: string,
      argsJson: string,
    ): Promise<void> => {
      const activeNodeId = st.lastActiveNodeId;
      if (activeNodeId !== undefined) {
        const existing = nodeToolCalls.get(activeNodeId) ?? [];
        existing.push({ id: toolCallId, name: toolName, args_json: argsJson });
        nodeToolCalls.set(activeNodeId, existing);
      }
      await onChunk(
        makeToolCallChunk(
          crypto.randomUUID(),
          model,
          toolCallId,
          toolName,
          argsJson,
          clientToolCallIndex++,
        ),
      );
      // A client tool has no server-side execute, so nothing ever fires
      // `onToolEffectiveArgs` for it and the node would show no INPUT at all.
      // The raw args are already handed to the client verbatim above and
      // recorded in `nodeToolCalls`, so surfacing them on the node is not a
      // new exposure — it just makes the live graph consistent with the
      // server-side tools, whose effective key-value args are visible there.
      // Must be set BEFORE the end-emit: `emitToolNodeEnd` deletes the entry.
      toolNodeArgs.set(toolCallId, truncateToolIo(argsJson));
      emitToolNodeStart(toolCallId, toolName);
      emitToolNodeEnd(toolCallId, 0);
    };

    const onToolError = (
      toolCallId: string,
      _errorMessage: string,
      execTimeSec: number,
    ): void => {
      const safeMessage = "Tool execution failed.";
      const visibleContent = {
        isError: true,
        error: {
          name: "ToolExecutionError",
          message: safeMessage,
        },
      };
      toolNodeResults.set(toolCallId, JSON.stringify(visibleContent));
      const activeNodeId =
        toolCallOwnerNodeIds.get(toolCallId) ?? st.lastActiveNodeId;
      if (activeNodeId !== undefined) {
        const calls = nodeToolCalls.get(activeNodeId);
        const call = calls?.findLast(
          (item) =>
            item.id === toolCallId && item.exec_time_seconds === undefined,
        );
        if (call !== undefined) {
          call.exec_time_seconds = Math.round(execTimeSec * 1000) / 1000;
        }
        const debugCalls = nodeDebugToolCalls.get(activeNodeId);
        const debugCall = debugCalls?.findLast(
          (item) => item.id === toolCallId && item.result === null,
        );
        if (debugCall !== undefined) {
          debugCall.result = visibleContent;
          debugCall.exec_time_seconds =
            Math.round(execTimeSec * 1000) / 1000;
          debugCall.is_error = true;
        }
      }
      toolCallOwnerNodeIds.delete(toolCallId);
      _pendingToolCallIds.delete(toolCallId);
      emitToolNodeEnd(toolCallId, execTimeSec, safeMessage);
    };

    const onToolResult = async (
      toolCallId: string,
      content: unknown,
      execTimeSec: number,
      options?: { streamDetails?: boolean },
    ): Promise<void> => {
      // The model was shown ref-handles in place of long document references
      // (config.refHandles). Everything below — the client `tool_calls` details
      // block, the live-graph findings table, and the debug trace — is a
      // USER/OPERATOR surface, so map the handles back to real references
      // first. No-op when the flow has no refHandles.
      const visibleContent =
        refHandles !== undefined
          ? refHandles.unmapContent(sanitizeToolResultOutput(content))
          : sanitizeToolResultOutput(content);
      const errorMessage = isToolErrorOutput(content)
        ? "Tool execution failed."
        : undefined;
      // Error envelopes are untrusted provider/tool output. Preserve successful
      // results, but expose only a stable error object to monitoring, debug
      // traces, and client reasoning streams.
      const toolUsage = extractToolUsage(content);
      if (toolUsage !== undefined) {
        nodeToolCostOverride.set(toolCallId, toolUsage.cost);
        nodeInputTokens.set(
          toolCallId,
          (nodeInputTokens.get(toolCallId) ?? 0) + toolUsage.inputTokens,
        );
        nodeOutputTokens.set(
          toolCallId,
          (nodeOutputTokens.get(toolCallId) ?? 0) + toolUsage.outputTokens,
        );
      }
      // Capture the tool's output for its synthetic node's detail view — a
      // vectorsearch-style payload normalises to a findings table shape.
      const resultDisplay = buildToolResultDisplay(visibleContent);
      if (resultDisplay !== undefined) {
        toolNodeResults.set(toolCallId, truncateToolIo(resultDisplay));
      }
      emitToolNodeEnd(toolCallId, execTimeSec, errorMessage);
      const activeNodeId =
        toolCallOwnerNodeIds.get(toolCallId) ?? st.lastActiveNodeId;
      if (activeNodeId !== undefined) {
        const calls = nodeToolCalls.get(activeNodeId);
        if (calls !== undefined) {
          const tc = calls.findLast(
            (call) =>
              call.id === toolCallId && call.exec_time_seconds === undefined,
          );
          if (tc !== undefined)
            tc.exec_time_seconds = Math.round(execTimeSec * 1000) / 1000;
        }
      }
      if (getDebugStore() !== undefined && activeNodeId !== undefined) {
        const debugCalls = nodeDebugToolCalls.get(activeNodeId);
        if (debugCalls !== undefined) {
          const dtc = debugCalls.findLast(
            (call) => call.id === toolCallId && call.result === null,
          );
          if (dtc !== undefined) {
            dtc.result = visibleContent;
            dtc.exec_time_seconds = Math.round(execTimeSec * 1000) / 1000;
            dtc.is_error = errorMessage !== undefined;
          }
        }
      }
      toolCallOwnerNodeIds.delete(toolCallId);

      const callMeta = _pendingToolCallIds.get(toolCallId);
      _pendingToolCallIds.delete(toolCallId);

      const toolName = callMeta?.name ?? "unknown";
      // Fold a tool-reported cost (e.g. vectorsearch's own embedding/rerank
      // spend) into tenant/user/flow rolling-window spend tracking — mirrors
      // the LLM-backed synthetic tools (agent-tools.ts, agent-harness/tools.ts),
      // and runs independent of `monitoring` since budget enforcement must not
      // depend on whether the live dashboard is enabled.
      if (toolUsage !== undefined && toolUsage.cost > 0) {
        const slash = toolName.indexOf("/");
        costTracker?.record(ctx.clientId, toolUsage.cost, {
          provider: slash >= 0 ? toolName.slice(0, slash) : toolName,
          model: toolName,
          promptTokens: toolUsage.inputTokens,
          completionTokens: toolUsage.outputTokens,
        });
      }
      // Prefer the effective (post forced-args / ref-handle / egress-DLP)
      // arguments over the key-only placeholder captured at call time, so the
      // details block shows the ACTUAL query a search ran with — the result
      // body below is far more revealing than these args already.
      const argsJson =
        toolEffectiveArgs.get(toolCallId) ?? callMeta?.argsJson ?? "{}";
      toolEffectiveArgs.delete(toolCallId);

      // The tool call itself was already streamed by onToolCall. Private
      // delegated workers can suppress the potentially large/sensitive result
      // block while all monitoring, timing, cost and error bookkeeping above
      // remains intact.
      if (options?.streamDetails === false) return;

      // Render as Open WebUI <details type="tool_calls"> content block.
      let displayResult: unknown = visibleContent;
      try {
        const raw =
          typeof visibleContent === "string"
            ? JSON.parse(visibleContent)
            : visibleContent;
        if (
          Array.isArray(raw) &&
          raw.length > 0 &&
          typeof raw[0] === "object" &&
          raw[0] !== null &&
          "text" in raw[0]
        ) {
          const inner = JSON.parse((raw[0] as { text: string }).text);
          displayResult = inner;
        } else {
          displayResult = raw;
        }
        if (
          displayResult !== null &&
          typeof displayResult === "object" &&
          "results" in (displayResult as Record<string, unknown>)
        ) {
          const results = (displayResult as { results: unknown[] }).results;
          if (Array.isArray(results)) {
            const mapped = results.map((r: unknown) => {
              const item = r as Record<string, unknown>;
              const meta =
                (item.metadata as Record<string, unknown> | undefined) ?? {};
              const rawTags = item.tags ?? meta.tags ?? meta.tag;
              const tag = Array.isArray(rawTags)
                ? rawTags.join(", ")
                : (rawTags ?? undefined);
              return {
                title:
                  item.title ??
                  meta.title ??
                  meta.name ??
                  item.id ??
                  "–",
                score:
                  typeof item.score === "number"
                    ? Math.round(item.score * 1000) / 1000
                    : item.score,
                tag,
                collection:
                  item.collection ?? meta.collection ?? undefined,
                url:
                  item.link ??
                  item.url ??
                  meta.url ??
                  meta.link ??
                  undefined,
              };
            });
            const byDoc = new Map<
              string,
              Record<string, unknown> & { _chunks: number }
            >();
            for (const m of mapped) {
              const key =
                typeof m.url === "string" && m.url.length > 0
                  ? m.url
                  : String(m.title);
              const existing = byDoc.get(key);
              if (existing === undefined) {
                byDoc.set(key, { ...m, _chunks: 1 });
              } else {
                existing._chunks += 1;
                if (
                  typeof m.score === "number" &&
                  (typeof existing.score !== "number" ||
                    m.score > existing.score)
                ) {
                  existing.score = m.score;
                }
              }
            }
            displayResult = Array.from(byDoc.values()).sort((a, b) => {
              const sa = typeof a.score === "number" ? a.score : -Infinity;
              const sb = typeof b.score === "number" ? b.score : -Infinity;
              return sb - sa;
            });
          }
        }
      } catch {
        displayResult = visibleContent;
      }

      const formatVectorHits = (val: unknown): string | undefined => {
        if (!Array.isArray(val) || val.length === 0) return undefined;
        const entries: Record<string, unknown>[] = [];
        for (const entry of val) {
          if (entry === null || typeof entry !== "object") return undefined;
          const e = entry as Record<string, unknown>;
          if (!("title" in e) || !("score" in e)) return undefined;
          entries.push(e);
        }
        let maxScore = 0;
        for (const e of entries) {
          const s =
            typeof e.score === "number" ? (e.score as number) : NaN;
          if (Number.isFinite(s) && s > maxScore) maxScore = s;
        }
        const lines: string[] = [];
        for (const e of entries) {
          const scoreNum =
            typeof e.score === "number" ? (e.score as number) : NaN;
          const pct = Number.isFinite(scoreNum)
            ? maxScore > 0
              ? `${Math.round((scoreNum / maxScore) * 100)}%`
              : `${Math.round(scoreNum * 100)}%`
            : String(e.score ?? "");
          const pctCol = pct.padStart(4, " ");
          const title = String(e.title ?? "–");
          const url = typeof e.url === "string" ? e.url : "";
          const chunkCount =
            typeof e._chunks === "number" ? (e._chunks as number) : 1;
          const chunkSuffix = chunkCount > 1 ? `  ·  ${chunkCount} Chunks` : "";
          lines.push(`${pctCol}  ${title}${chunkSuffix}`);
          if (url.length > 0) lines.push(`      ${url}`);
        }
        return lines.join("\n");
      };

      const vectorHitsFormatted =
        typeof displayResult === "string"
          ? undefined
          : formatVectorHits(displayResult);
      const resultIsHtml = false;
      const resultStr =
        typeof displayResult === "string"
          ? displayResult
          : (vectorHitsFormatted ?? JSON.stringify(displayResult, null, 2));

      let displayName = toolName;
      try {
        const a = JSON.parse(argsJson) as {
          collection?: unknown;
          filter?: { tag?: unknown };
        };
        const hitCount = Array.isArray(displayResult)
          ? displayResult.length
          : undefined;
        const labelParts: string[] = [];
        if (typeof a.collection === "string" && a.collection.length > 0)
          labelParts.push(a.collection);
        if (
          a.filter &&
          typeof a.filter.tag === "string" &&
          a.filter.tag.length > 0
        )
          labelParts.push(`tag=${a.filter.tag}`);
        if (hitCount !== undefined) labelParts.push(`${hitCount} Treffer`);
        if (labelParts.length > 0)
          displayName = `${toolName} · ${labelParts.join(" · ")}`;
      } catch {
        /* keep the bare tool name */
      }

      const escapeAttr = (s: string): string =>
        s
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      const escapedArgs = escapeAttr(argsJson);
      const escapedName = escapeAttr(displayName);
      const escapedResult = resultIsHtml
        ? resultStr
        : resultStr
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

      const detailsBlock =
        `<details type="tool_calls" done="true" ` +
        `id="${toolCallId}" name="${escapedName}" ` +
        `arguments="${escapedArgs}">\n` +
        `<summary>${escapedName} (${Math.round(execTimeSec * 1000)}ms)</summary>\n` +
        `${escapedResult}\n` +
        `</details>\n`;

      try {
        await emitReasoningStep(detailsBlock);
      } catch {
        /* client disconnected */
      }
    };

    // --- Approval-required callback (human-in-the-loop).
    const onApprovalRequired = (pending: PendingApproval): void => {
      const base = (getRuntime().appConfig.approvalBaseUrl ?? "").replace(/\/$/, "");
      const linkSecret = getRuntime().appConfig.oidcSessionSecret;
      const linkToken =
        linkSecret !== undefined
          ? signApprovalLinkToken(
              pending.id,
              linkSecret,
              Date.now() + 3_600_000,
            )
          : undefined;
      const decideTokenQuery =
        linkToken !== undefined
          ? `&token=${encodeURIComponent(linkToken)}`
          : "";
      const approveUrl = `${base}/monitoring/approvals/${pending.id}/decide?decision=approved${decideTokenQuery}`;
      const denyUrl = `${base}/monitoring/approvals/${pending.id}/decide?decision=denied${decideTokenQuery}`;

      const toolLabel = pending.tool.split("/").pop() ?? pending.tool;
      const argEntries = Object.entries(pending.args ?? {});
      const argSummary =
        argEntries.length > 0
          ? argEntries
              .map(([k, v]) => `**${k}**: ${JSON.stringify(v)}`)
              .join(", ")
          : "_keine Argumente_";

      const widgetTokenQuery =
        linkToken !== undefined
          ? `?token=${encodeURIComponent(linkToken)}`
          : "";
      const widgetUrl = `${base}/monitoring/approvals/${pending.id}/widget${widgetTokenQuery}`;
      const approvalMessage =
        base.length > 0
          ? `\n\n<iframe src="${widgetUrl}" title="Freigabe erforderlich: ${toolLabel}" ` +
            `style="width:100%;max-width:520px;height:172px;border:1px solid rgba(127,127,127,.3);` +
            `border-radius:8px;background:transparent" loading="lazy"></iframe>\n\n`
          : `\n\n> ⏳ **Freigabe erforderlich:** \`${toolLabel}\`\n` +
            `>\n` +
            `> Argumente: ${argSummary}\n` +
            `>\n` +
            `> [✅ Genehmigen](${approveUrl}) | [🚫 Ablehnen](${denyUrl})\n\n`;

      void (async () => {
        try {
          await getRuntime().onToken(
            st.lastActiveNodeId ?? "approval",
            approvalMessage,
          );
        } catch {
          /* client disconnected */
        }
        await onChunk({
          id: crypto.randomUUID(),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          approval_required: {
            id: pending.id,
            execution_id: pending.executionId,
            node_id: pending.nodeId,
            tool: pending.tool,
            args: pending.args,
            ...(pending.tenantId !== undefined
              ? { tenant_id: pending.tenantId }
              : {}),
            requested_at: pending.requestedAt,
          },
        } as ChatCompletionChunk);
      })();
    };

  return {
    toolNodes,
    emitToolNodeStart,
    emitToolNodeEnd,
    mergeToolTraceMetadata,
    onToolCall,
    onToolEffectiveArgs,
    onClientToolCall,
    onToolResult,
    onToolError,
    onApprovalRequired,
  };
}

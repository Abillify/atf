// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * graphUtils — shared types and pure helper functions used across the graph
 * sub-components (NodeRenderer, GraphLegend, NodeDetailPanel, GraphVisualizer)
 * AND the editable Studio builder canvas (FlowCanvas) — the same node-state
 * shape and status/colour derivation drive both the read-only live monitor
 * and the editor, so a node looks identical whether it's being edited or
 * watched live.
 *
 */

import type { NodeType } from "../../types/flow";
import { withCurrency } from "../../lib/currency";
import type { NodePalette } from "../../lib/theme/palette";
import { nodeTypeVarColor } from "../../lib/theme/palette";
import type {
  NodeExecutionEvent,
  NodeToolCall,
  RoutingDecision,
} from "../../types/monitoring";
import type {
  DebugNodeCascade,
  DebugNodeDiagnostic,
  DebugTrace,
  HarnessProgress,
} from "../../types/debug-trace";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Visual category that drives a node's fill colour. Extends the flow's
 * `NodeType` with the two synthetic boundary nodes and an `unknown` fallback
 * for nodes we can't classify (e.g. executed ids with no flow definition).
 */
export type NodeVisualType = NodeType | "boundary" | "unknown";

/** Approval outcome bound to a node, orthogonal to its execution status. */
export type ApprovalState = "pending" | "approved" | "rejected";

export interface NodeState {
  id: string;
  label: string;
  status: "running" | "completed" | "error" | "pending";
  latency_ms: number | null;
  error_message?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  tool_calls?: NodeToolCall[];
  sequence?: number;
  start_time?: string;
  end_time?: string | null;
  prompt?: string;
  response?: string;
  /** Display name (or email/id) of the user who triggered the request. */
  user_name?: string;
  /** The user's prompt text (last user message), truncated. */
  user_prompt?: string;
  /** Routing decision a `router` node made (which edge it took and why). */
  routing_decision?: RoutingDecision;
  /** Tool-approval outcome bound to this node, when any (orthogonal to status). */
  approval?: ApprovalState;
  /** Marks a synthetic tool-call node (vs. a real flow node). */
  kind?: "tool";
  /** For a tool node, the flow node that issued the call (edge source). */
  parent_node_id?: string;
  /** Visual category driving the node's fill colour (resolved at render). */
  nodeType?: NodeVisualType;
  /**
   * Machine-readable error category (e.g. "provider_error"), from the debug
   * trace's structured error recording. Present only when the node failed
   * AND its trace is still in the runtime's in-memory buffer.
   */
  error_type?: string;
  /**
   * Structured error context (mirrors the runtime's `StreamError.details`),
   * from the debug trace. Present only for failed nodes with a live trace.
   */
  error_details?: Record<string, unknown>;
  /**
   * Ordered in-node diagnostics timeline (retries, fallbacks, tool errors,
   * …) from the debug trace. Present even on completed nodes that degraded
   * along the way; absent when no trace is available.
   */
  diagnostics?: DebugNodeDiagnostic[];
  /**
   * For a failed synthetic tool node: the full result payload the tool
   * returned for the failing call, from the debug trace. The monitoring
   * event stream only carries the anonymized `error_message`; the trace
   * keeps the complete (still operator-safe) payload.
   */
  tool_error_result?: unknown;
  /**
   * Model cascade outcome (kept vs. escalated, reasons, first/final model),
   * from the debug trace. Present only for nodes that ran with a cascade.
   */
  cascade?: DebugNodeCascade;
  /**
   * Last structured `atf.progress` event of an agent-harness node, from the
   * debug trace. Present only while the harness's trace is still available.
   */
  progress?: HarnessProgress;
  /**
   * Short editor-only descriptive line (e.g. "openai/gpt-4o-mini", "3 tool(s)")
   * shown under the label. Set by the Studio builder for a node that has no
   * live execution data yet; live events never populate this, so it quietly
   * disappears once real status/latency/cost rows have something to show.
   */
  subtitle?: string;
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

export function nodeTypeColor(type: NodeVisualType | undefined): string {
  switch (type) {
    case "llm":
      return "bg-node-llm border-node-llm-border";
    case "classifier":
      return "bg-node-classifier border-node-classifier-border";
    case "router":
      return "bg-node-router border-node-router-border";
    case "parallel":
      return "bg-node-parallel border-node-parallel-border";
    case "retrieval":
      return "bg-node-retrieval border-node-retrieval-border";
    case "memory":
      return "bg-node-memory border-node-memory-border";
    case "tool":
      return "bg-node-tool border-node-tool-border";
    case "agent-harness":
      return "bg-node-agent-harness border-node-agent-harness-border";
    case "transform":
      return "bg-node-transform border-node-transform-border";
    case "trigger":
      return "bg-node-trigger border-node-trigger-border";
    case "assistant-context":
    case "assistant-learn":
      return "bg-node-assistant border-node-assistant-border";
    case "boundary":
      return "bg-node-boundary border-node-boundary-border";
    default:
      return "bg-node-default border-node-default-border";
  }
}

function nodePaletteKey(type: NodeVisualType | undefined): keyof NodePalette {
  switch (type) {
    case "llm":
      return "llm";
    case "classifier":
      return "classifier";
    case "router":
      return "router";
    case "parallel":
      return "parallel";
    case "retrieval":
      return "retrieval";
    case "memory":
      return "memory";
    case "tool":
      return "tool";
    case "agent-harness":
      return "agentHarness";
    case "transform":
      return "transform";
    case "trigger":
      return "trigger";
    case "assistant-context":
    case "assistant-learn":
      return "assistant";
    case "boundary":
      return "boundary";
    default:
      return "default";
  }
}

/**
 * Resolved category color (from the `--node-*` token) for SVG attributes
 * and inline styles (MiniMap, legend). See `lib/theme/palette.ts`.
 */
export function nodeTypeHex(type: NodeVisualType | undefined): string {
  return nodeTypeVarColor(nodePaletteKey(type));
}

export function nodeTypeLabel(type: NodeVisualType | undefined): string {
  switch (type) {
    case "boundary":
      return "boundary";
    case "unknown":
    case undefined:
      return "node";
    default:
      return type;
  }
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

export function statusIndicator(status: NodeState["status"]): {
  dot: string;
  glyph: string;
  ring: string;
  label: string;
} {
  switch (status) {
    case "completed":
      return {
        dot: "bg-success-solid border-success-solid-hover text-on-solid",
        glyph: "✓",
        ring: "",
        label: "completed",
      };
    case "running":
      return {
        dot: "bg-info-solid border-info-solid-hover animate-pulse",
        glyph: "",
        ring: "",
        label: "running",
      };
    case "error":
      return {
        dot: "bg-danger-solid border-danger-solid-hover text-on-solid",
        glyph: "✕",
        ring: "ring-2 ring-offset-1 ring-danger",
        label: "error",
      };
    case "pending":
      return {
        dot: "bg-background border-muted-foreground/50",
        glyph: "",
        ring: "",
        label: "pending",
      };
  }
}

export function approvalRing(approval: ApprovalState | undefined): string {
  switch (approval) {
    case "pending":
      return "ring-2 ring-offset-1 ring-info";
    case "approved":
      return "ring-2 ring-offset-1 ring-success";
    case "rejected":
      return "ring-2 ring-offset-1 ring-danger";
    default:
      return "";
  }
}

export function approvalBadge(approval: ApprovalState): {
  label: string;
  className: string;
} {
  switch (approval) {
    case "pending":
      return { label: "⏳ approval", className: "bg-info-soft text-info" };
    case "approved":
      return { label: "✓ approved", className: "bg-success-soft text-success" };
    case "rejected":
      return { label: "✕ denied", className: "bg-danger-soft text-danger" };
  }
}

// ---------------------------------------------------------------------------
// Node state derivation from monitoring events
// ---------------------------------------------------------------------------

/**
 * Synthetic node id the engine emits once per run to mark the true end of the
 * flow (see runtime `FLOW_END_NODE_ID`). It is a rollup marker for the
 * execution status, not a graph node — the canvas must not render it.
 */
export const FLOW_END_NODE_ID = "__flow_end__";

/**
 * Folds a stream of `NodeExecutionEvent`s into one `NodeState` per node id.
 *
 * Pure and transport-agnostic: works identically whether events came from the
 * live monitoring SSE stream (GraphVisualizer) or a short-lived subscription
 * scoped to a single in-editor test run (Studio builder's run drawer) — both
 * consumers get the exact same running/completed/error + latency/cost/token
 * semantics instead of two divergent implementations.
 *
 * The synthetic `__flow_end__` marker is dropped: it carries the execution's
 * terminal status for the history rollup but is not a node in the graph.
 *
 * A "running" event never regresses a node that a later-processed event
 * already marked "completed" for the SAME invocation (matched by identical
 * `start_time`) — event receipt order is not guaranteed to match emission
 * order (SSE Last-Event-ID resume can replay an already-seen event), so
 * without this guard a node could appear stuck "running" forever. An
 * "error" node CAN be superseded by "running" — that is the retry
 * semantics: a fresh attempt on the same node after a failure.
 */
export function deriveNodeStates(
  events: NodeExecutionEvent[],
): Map<string, NodeState> {
  const stateMap = new Map<string, NodeState>();
  for (const event of events) {
    if (event.node_id === FLOW_END_NODE_ID) continue;
    const existing = stateMap.get(event.node_id);
    const isStaleRunningDuplicateOfCompleted =
      event.status === "running" &&
      existing?.status === "completed" &&
      existing.start_time === event.start_time;
    if (isStaleRunningDuplicateOfCompleted) {
      continue;
    }
    if (event.status === "running" && existing?.status === "error") {
      stateMap.set(event.node_id, {
        id: event.node_id,
        label: event.label ?? existing?.label ?? event.node_id,
        status: "running",
        latency_ms: event.latency_ms,
        start_time: event.start_time,
        end_time: null,
        kind: event.kind ?? existing?.kind,
        parent_node_id: event.parent_node_id ?? existing?.parent_node_id,
      });
    } else {
      const merged: NodeState = {
        id: event.node_id,
        label: event.label ?? existing?.label ?? event.node_id,
        status: event.status,
        latency_ms: event.latency_ms,
        error_message:
          event.status === "error" ? event.error_message : undefined,
        start_time: event.start_time,
        end_time: event.end_time,
        model: event.model ?? existing?.model,
        input_tokens: event.input_tokens ?? existing?.input_tokens,
        output_tokens: event.output_tokens ?? existing?.output_tokens,
        cost: event.cost ?? existing?.cost,
        tool_calls: event.tool_calls ?? existing?.tool_calls,
        sequence: event.sequence ?? existing?.sequence,
        prompt: event.prompt ?? existing?.prompt,
        response: event.response ?? existing?.response,
        kind: event.kind ?? existing?.kind,
        parent_node_id: event.parent_node_id ?? existing?.parent_node_id,
        user_name: event.user_name ?? existing?.user_name,
        user_prompt: event.user_prompt ?? existing?.user_prompt,
        routing_decision: event.routing_decision ?? existing?.routing_decision,
      };
      stateMap.set(event.node_id, merged);
    }
  }
  return stateMap;
}

// ---------------------------------------------------------------------------
// Cost formatting
// ---------------------------------------------------------------------------

/**
 * Formats an estimated cost for display with the configured display currency
 * symbol (no conversion — the number is shown as-is). Uses up to 6
 * significant decimals for small amounts and 2 decimals for larger figures.
 */
export function formatCost(cost: number): string {
  const bare =
    cost === 0
      ? "0"
      : cost < 0.01
        ? cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
        : cost.toFixed(cost < 1 ? 4 : 2);
  return withCurrency(bare);
}

// ---------------------------------------------------------------------------
// Debug-trace error enrichment
// ---------------------------------------------------------------------------

/**
 * Id of the synthetic tool node the engine emits for one tool call issued by
 * `nodeId` (see runtime `handler-factories.ts`: `${parentId}::tool::${id}`).
 */
export function toolNodeId(nodeId: string, toolCallId: string): string {
  return `${nodeId}::tool::${toolCallId}`;
}

/** Best-effort human message from an unknown tool-error payload. */
function toolResultMessage(result: unknown): string | undefined {
  if (typeof result === "string" && result.trim() !== "") return result;
  if (result !== null && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const key of ["error", "message", "error_message"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim() !== "") return v;
    }
  }
  return undefined;
}

/**
 * Enriches event-derived `NodeState`s with the structured error recording from
 * the execution's debug trace (`GET /monitoring/debug/:executionId`).
 *
 * The monitoring event stream only carries a bare `error_message`; the trace
 * additionally holds the machine-readable `error_type`, structured
 * `error_details`, the in-node diagnostics timeline (retries, fallbacks,
 * tool errors), and full tool-call result payloads. Synthetic tool nodes
 * (`kind === "tool"`) are NOT trace nodes of their own — their data lives on
 * the issuing node's `tool_calls[]` entry (matched by tool-call id) plus the
 * diagnostics tagged with `details.tool_call_id`.
 *
 * Pure: returns a new Map; the input is untouched. A null/undefined trace
 * (evicted from the runtime's bounded buffer, not fetched yet, or fetch
 * failed) returns the input map unchanged — the UI degrades to event-level
 * error info. Node STATUS always stays event-derived (the durable log is the
 * source of truth); the trace only adds detail, and `error_message` is only
 * backfilled when the event stream never delivered one for a failed node.
 */
export function mergeDebugTraceIntoNodeStates(
  states: Map<string, NodeState>,
  trace: DebugTrace | null | undefined,
): Map<string, NodeState> {
  if (trace == null || !Array.isArray(trace.nodes)) return states;
  const merged = new Map(states);
  for (const tn of trace.nodes) {
    // Diagnostics tagged with a tool_call_id belong to the synthetic tool
    // node, not (only) to the issuing node.
    const diagsByToolCall = new Map<string, DebugNodeDiagnostic[]>();
    for (const d of tn.diagnostics ?? []) {
      const tcId =
        typeof d.details?.tool_call_id === "string"
          ? d.details.tool_call_id
          : undefined;
      if (tcId === undefined) continue;
      const list = diagsByToolCall.get(tcId) ?? [];
      list.push(d);
      diagsByToolCall.set(tcId, list);
    }

    const own = merged.get(tn.node_id);
    if (own !== undefined) {
      merged.set(tn.node_id, {
        ...own,
        ...(tn.status === "error" && tn.error_type !== undefined
          ? { error_type: tn.error_type }
          : {}),
        ...(tn.status === "error" && tn.error_details !== undefined
          ? { error_details: tn.error_details }
          : {}),
        ...(tn.diagnostics !== undefined && tn.diagnostics.length > 0
          ? { diagnostics: tn.diagnostics }
          : {}),
        ...(tn.cascade !== undefined ? { cascade: tn.cascade } : {}),
        ...(tn.progress !== undefined ? { progress: tn.progress } : {}),
        ...(own.status === "error" &&
        own.error_message === undefined &&
        tn.error_message !== undefined
          ? { error_message: tn.error_message }
          : {}),
      });
    }

    for (const tc of tn.tool_calls ?? []) {
      const id = toolNodeId(tn.node_id, tc.id);
      const toolState = merged.get(id);
      if (toolState === undefined) continue;
      const toolDiags = diagsByToolCall.get(tc.id);
      merged.set(id, {
        ...toolState,
        ...(tc.is_error ? { tool_error_result: tc.result } : {}),
        ...(toolDiags !== undefined && toolDiags.length > 0
          ? { diagnostics: toolDiags }
          : {}),
        ...(toolState.status === "error" &&
        toolState.error_message === undefined &&
        tc.is_error
          ? { error_message: toolResultMessage(tc.result) ?? "Tool call failed" }
          : {}),
      });
    }
  }
  return merged;
}

/** Longest tool-result snippet shown in a hover tooltip. */
const TOOLTIP_RESULT_MAX = 400;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Multi-line hover-tooltip text summarising a node's full error recording
 * (type, message, diagnostics timeline, failing tool result). Returns
 * undefined for a node without any error info, so the card omits the
 * `title` attribute entirely.
 */
export function nodeErrorTooltip(state: NodeState): string | undefined {
  const lines: string[] = [];
  if (state.error_message !== undefined || state.error_type !== undefined) {
    lines.push(
      state.error_type !== undefined
        ? `${state.error_type}: ${state.error_message ?? "no message"}`
        : (state.error_message ?? ""),
    );
  }
  for (const d of state.diagnostics ?? []) {
    lines.push(`[${d.level}] ${d.code}: ${truncate(d.message, 160)}`);
  }
  if (state.tool_error_result !== undefined && state.tool_error_result !== null) {
    const raw =
      typeof state.tool_error_result === "string"
        ? state.tool_error_result
        : safeJsonStringify(state.tool_error_result);
    if (raw !== undefined) lines.push(`Result: ${truncate(raw, TOOLTIP_RESULT_MAX)}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/** JSON stringify that never throws (circular structures → undefined). */
function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

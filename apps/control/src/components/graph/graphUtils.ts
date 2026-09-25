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
 * Requirements: 11.2
 */

import type { NodeType } from "../../types/flow";
import type {
  NodeExecutionEvent,
  NodeToolCall,
  RoutingDecision,
} from "../../types/monitoring";

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
      return "bg-indigo-600 border-indigo-800";
    case "classifier":
      return "bg-purple-600 border-purple-800";
    case "router":
      return "bg-amber-500 border-amber-700";
    case "parallel":
      return "bg-violet-600 border-violet-800";
    case "retrieval":
      return "bg-cyan-700 border-cyan-900";
    case "memory":
      return "bg-fuchsia-600 border-fuchsia-800";
    case "tool":
      return "bg-teal-600 border-teal-800";
    case "agent-harness":
      return "bg-rose-600 border-rose-800";
    case "transform":
      return "bg-lime-700 border-lime-900";
    case "trigger":
      return "bg-orange-600 border-orange-800";
    case "assistant-context":
    case "assistant-learn":
      return "bg-sky-600 border-sky-800";
    case "boundary":
      return "bg-slate-600 border-slate-800";
    default:
      return "bg-gray-500 border-gray-700";
  }
}

export function nodeTypeHex(type: NodeVisualType | undefined): string {
  switch (type) {
    case "llm":
      return "#4f46e5";
    case "classifier":
      return "#9333ea";
    case "router":
      return "#f59e0b";
    case "parallel":
      return "#7c3aed";
    case "retrieval":
      return "#0e7490";
    case "memory":
      return "#c026d3";
    case "tool":
      return "#0d9488";
    case "agent-harness":
      return "#e11d48";
    case "transform":
      return "#4d7c0f";
    case "trigger":
      return "#ea580c";
    case "assistant-context":
    case "assistant-learn":
      return "#0284c7";
    case "boundary":
      return "#475569";
    default:
      return "#6b7280";
  }
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
        dot: "bg-green-400 border-green-700 text-green-900",
        glyph: "✓",
        ring: "",
        label: "completed",
      };
    case "running":
      return {
        dot: "bg-amber-400 border-amber-600 animate-pulse",
        glyph: "",
        ring: "",
        label: "running",
      };
    case "error":
      return {
        dot: "bg-red-500 border-red-800 text-white",
        glyph: "✕",
        ring: "ring-2 ring-offset-1 ring-red-500",
        label: "error",
      };
    case "pending":
      return {
        dot: "bg-white border-gray-400",
        glyph: "",
        ring: "",
        label: "pending",
      };
  }
}

export function approvalRing(approval: ApprovalState | undefined): string {
  switch (approval) {
    case "pending":
      return "ring-2 ring-offset-1 ring-blue-500";
    case "approved":
      return "ring-2 ring-offset-1 ring-green-500";
    case "rejected":
      return "ring-2 ring-offset-1 ring-red-500";
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
      return { label: "⏳ approval", className: "bg-blue-100 text-blue-700" };
    case "approved":
      return { label: "✓ approved", className: "bg-green-100 text-green-700" };
    case "rejected":
      return { label: "✕ denied", className: "bg-red-100 text-red-700" };
  }
}

// ---------------------------------------------------------------------------
// Node state derivation from monitoring events
// ---------------------------------------------------------------------------

/**
 * Folds a stream of `NodeExecutionEvent`s into one `NodeState` per node id.
 *
 * Pure and transport-agnostic: works identically whether events came from the
 * live monitoring SSE stream (GraphVisualizer) or a short-lived subscription
 * scoped to a single in-editor test run (Studio builder's run drawer) — both
 * consumers get the exact same running/completed/error + latency/cost/token
 * semantics instead of two divergent implementations.
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
 * Formats an estimated cost for display. Currency-agnostic: shows the bare
 * numeric value (no currency symbol). Uses up to 6 significant decimals for
 * small amounts and 2 decimals for larger figures.
 */
export function formatCost(cost: number): string {
  if (cost === 0) return "0";
  if (cost < 0.01) return cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return cost.toFixed(cost < 1 ? 4 : 2);
}

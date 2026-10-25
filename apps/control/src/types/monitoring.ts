// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Monitoring types for the frontend dashboard.
 * Mirrors the NodeExecutionEvent from the backend.
 */

/**
 * A single tool call recorded during a node execution.
 */
export interface NodeToolCall {
  id: string;
  name: string;
  args_json: string;
  exec_time_seconds?: number | null;
}

/**
 * Event emitted by the backend Monitoring Service for each node execution lifecycle step.
 * Received by the frontend dashboard over SSE or WebSocket.
 */
export interface NodeExecutionEvent {
  /** UUID that correlates all events belonging to a single top-level request */
  execution_id: string;
  /** ID of the flow node being executed */
  node_id: string;
  /** Current execution state of the node */
  status: "running" | "completed" | "error";
  /** ISO-8601 timestamp when node execution started */
  start_time: string;
  /** ISO-8601 timestamp when node execution ended; null while still running */
  end_time: string | null;
  /** Wall-clock duration in milliseconds; null while still running */
  latency_ms: number | null;
  /** Human-readable error description — only present when status is "error" */
  error_message?: string;
  /**
   * Marks a synthetic node. Absent = a real flow-graph node; `"tool"` = a node
   * the engine synthesises for a single tool call so each invocation appears as
   * its own node instead of being folded into the issuing node.
   */
  kind?: "tool";
  /**
   * For a synthetic node, the id of the real flow node that issued it — the
   * edge source the dashboard draws so the tool node hangs off its caller.
   */
  parent_node_id?: string;
  /** Display label (e.g. the tool name for a `"tool"` node). */
  label?: string;
  /** LLM provider/model used for this node, e.g. "openai/gpt-4o" */
  model?: string;
  /** Number of prompt (input) tokens consumed — LLM nodes only */
  input_tokens?: number;
  /** Number of completion (output) tokens produced — LLM nodes only */
  output_tokens?: number;
  /** Estimated cost of this node's LLM call(s) — priced LLM nodes only. */
  cost?: number;
  /** Tool calls made during this node execution */
  tool_calls?: NodeToolCall[];
  /** Execution order within this execution (1-based) */
  sequence?: number;
  /** Resolved prompt sent to the model (LLM/classifier nodes, truncated). */
  prompt?: string;
  /** Final text the model produced for this node (truncated). */
  response?: string;
  /** Display name (or email/id) of the user who triggered the request. */
  user_name?: string;
  /** The user's prompt text (last user message), truncated. */
  user_prompt?: string;
  /** ID of the flow this run executed (set on boundary nodes). */
  flow_id?: string;
  /** Routing decision a `router` node made (which edge was taken and why). */
  routing_decision?: RoutingDecision;
}

/**
 * A single outgoing edge a `router` node evaluated, in declaration order.
 * `matched` marks the edge that was taken; the others are false.
 */
export interface RoutingCandidate {
  /** Target node id this edge points to (or "__end__"). */
  target: string;
  /** The routing condition expression evaluated; absent for an unconditional edge. */
  condition?: string;
  /** The flow author's human-readable edge label, when set. */
  label?: string;
  /** True for the edge that was taken; false for the others. */
  matched: boolean;
}

/**
 * The outcome of a `router` node: the chosen target plus every candidate edge
 * it evaluated, so the dashboard can show the taken branch in context.
 */
export interface RoutingDecision {
  /** The selected next node id, or "__end__" when no edge matched. */
  target: string;
  /** The condition expression that selected the target, when conditional. */
  matched_condition?: string;
  /** The label of the selected edge, when set. */
  matched_label?: string;
  /** Every outgoing edge evaluated, in order, with the outcome of each. */
  candidates: RoutingCandidate[];
}

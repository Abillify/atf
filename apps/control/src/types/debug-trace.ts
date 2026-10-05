// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Frontend subset of the runtime's full debug-trace types
 * (`apps/runtime/src/types/debug-trace.ts`), as returned by
 * `GET /monitoring/debug/:executionId`.
 *
 * Only the fields the Live Graph's error recording needs are modelled here;
 * everything else in the JSON payload is ignored. The runtime keeps traces in
 * a bounded in-memory ring buffer (last 200 executions) and never persists
 * them, so a 404 ("not found") is an expected outcome for older runs — the
 * UI must degrade gracefully to the plain event `error_message` then.
 */

/** A single noteworthy in-node event on a node's diagnostics timeline. */
export interface DebugNodeDiagnostic {
  /** ISO-8601 timestamp when the event was recorded. */
  at: string;
  /** Severity: "info" (normal but noteworthy), "warn" (degraded), "error". */
  level: "info" | "warn" | "error";
  /** Stable machine code, e.g. "retry", "fallback", "tool_execution_failed". */
  code: string;
  /** Human-readable one-line description. */
  message: string;
  /** Optional structured context (attempt number, tool_call_id, …). */
  details?: Record<string, unknown>;
}

/** A tool call recorded on a trace node (subset of the runtime shape). */
export interface DebugToolCallRecord {
  /** Tool call ID assigned by the LLM (or a synthetic UUID for retrieval). */
  id: string;
  /** Full tool reference, e.g. "myserver/tool_name". */
  name: string;
  /** Full parsed arguments object. */
  arguments?: unknown;
  /** Result payload returned by the tool; null while in-flight. */
  result?: unknown;
  /** True when the tool returned an error response. */
  is_error: boolean;
  /** Wall-clock seconds the call took, once finished. */
  exec_time_seconds?: number | null;
}

/** Per-node detail inside a debug trace (subset of the runtime shape). */
export interface DebugNodeTrace {
  node_id: string;
  node_type?: string;
  status: "running" | "completed" | "error";
  /** For a synthetic tool-call trace entry, the node that issued the call. */
  parent_node_id?: string;
  /** Human-readable error description (only when status = "error"). */
  error_message?: string;
  /** Machine-readable error category, e.g. "provider_error". */
  error_type?: string;
  /** Structured error context (mirrors `StreamError.details`). */
  error_details?: Record<string, unknown>;
  /** Ordered in-node timeline: retries, fallbacks, tool errors, … */
  diagnostics?: DebugNodeDiagnostic[];
  /** Tool calls made by this node, with full result payloads. */
  tool_calls?: DebugToolCallRecord[];
}

/** Full debug trace for one flow execution (subset of the runtime shape). */
export interface DebugTrace {
  execution_id: string;
  flow_id: string | null;
  status: "running" | "completed" | "error";
  started_at: string;
  finished_at: string | null;
  /** Per-node execution detail, in the order nodes were started. */
  nodes: DebugNodeTrace[];
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Full debug trace types (`src/types/debug-trace.ts`)
 *
 * Captures everything about a single flow execution for post-mortem debugging:
 * the prompts and system prompts, the LLM responses, every MCP/RAG tool call
 * with its arguments and result payloads, semantic tool selection decisions, and
 * the complete session identity.
 *
 * Size contract: METADATA IS COMPLETE — refs, ids, scores, status, timestamps,
 * token/cost/latency numbers, the diagnostics timeline and the structured error
 * are never abridged. Free TEXT fields are byte-bounded on ingest by
 * `monitoring/debug-trace-limits.ts` (see {@link DebugTrace.limits}), because an
 * unbounded trace of an agentic run reached several megabytes — too large for the
 * ring buffer, the JSON export and any reader.
 *
 * Debug traces live in a bounded in-memory ring buffer and are never written to
 * the database — they are operator/developer tooling only.
 *
 * No `any` at module boundaries.
 */

import type { EdgeFlowRecord } from "./edge-flow.js";

// ---------------------------------------------------------------------------
// Top-level trace
// ---------------------------------------------------------------------------

/** A sub-flow file merged into the executed flow. */
export interface DebugSubflowVersion {
  /** Path relative to the flows directory, e.g. `subflows/guard.yaml`. */
  path: string;
  /** The sub-flow's own `metadata.version`; null when it declares none. */
  version: string | null;
}

/** Full debug trace for one flow execution. */
export interface DebugTrace {
  /** UUID correlating all events for this execution. */
  execution_id: string;
  /** Flow ID that was executed. */
  flow_id: string | null;
  /** Declared `metadata.version` of the resolved entry flow; null if absent. */
  flow_version?: string | null;
  /**
   * `sha256:<hex>` over the flow definition the runtime executed (prompt
   * files, sub-flows and model shortcuts expanded; layout and changelog
   * excluded). Identical digests mean identical flow logic even when the
   * declared `flow_version` was forgotten or reused.
   */
  flow_digest?: string | null;
  /** Sub-flow files merged into the flow and the version each declares. */
  subflow_versions?: DebugSubflowVersion[];
  /** Overall execution status. */
  status: "running" | "completed" | "error";
  /** ISO-8601 timestamp when execution started. */
  started_at: string;
  /** ISO-8601 timestamp when execution finished; null while still running. */
  finished_at: string | null;

  /** Request/session identity resolved from JWT + Open WebUI headers. */
  context: DebugTraceContext;

  /**
   * Full conversation messages exactly as received from the client
   * (input to the flow, before any graph processing).
   */
  input_messages: DebugMessage[];

  /** Per-node execution detail, in the order nodes were started. */
  nodes: DebugNodeTrace[];

  /**
   * Data that crossed graph edges during the run, in traversal order. One
   * record per edge traversal (loops produce several records for the same
   * edge; consumers keep the last). Captured by the engine via
   * `ExecRuntime.onEdgeFlow`; absent for flows that never advanced an edge
   * and for runtimes without edge instrumentation.
   */
  edge_flows?: EdgeFlowRecord[];

  /** Accumulated token usage across all LLM nodes. */
  usage: DebugUsage;

  /** Stream errors accumulated during execution. */
  errors: DebugStreamError[];

  /**
   * The answer the flow returned (last assistant message), bounded to
   * {@link DebugTraceLimits.finalResponseBytes} — see there for why this gets
   * its own, much larger budget than `full_response`. Absent while running and
   * when the flow produced none.
   */
  final_response?: string;
  /** Node that produced {@link final_response}. */
  final_node_id?: string;

  /**
   * The text budgets that were applied to this trace when it was recorded.
   * Present on every trace the store accepted, so a reader can tell a bounded
   * excerpt from a complete text instead of guessing.
   */
  limits?: DebugTraceLimits;
}

/**
 * Per-field UTF-8 byte budgets for the free-text parts of a trace. Metadata is
 * not covered by any of these — it is always complete.
 */
export interface DebugTraceLimits {
  /** {@link DebugNodeTrace.full_response}, `full_reasoning`, `classifier.raw_output`. */
  llmResultBytes: number;
  /** {@link DebugNodeTrace.full_prompt} — system prompt + conversation. */
  promptBytes: number;
  /** Per entry in {@link DebugTrace.input_messages}. */
  messageBytes: number;
  /** Per string leaf inside {@link DebugToolCall.arguments} / `result`. */
  toolPayloadBytes: number;
  /** Per {@link EdgeFlowRecord} `items[].content` in {@link DebugTrace.edge_flows}. */
  edgeFlowBytes: number;
  /**
   * {@link DebugTrace.final_response} — the answer the flow returned.
   *
   * Deliberately far larger than {@link llmResultBytes}: a per-node excerpt
   * only needs to identify an output, but the final answer IS the artifact an
   * operator debugs ("why did the flow answer Nein?"). Truncating it to 512
   * bytes made the trace useless for exactly the question it is opened for.
   */
  finalResponseBytes: number;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Session and identity metadata for one execution. */
export interface DebugTraceContext {
  chat_id?: string;
  session_id?: string;
  /**
   * The `conversation_id` the client supplied, i.e. the identity it used to
   * continue a thread. Recorded separately from `chat_id` because a client may
   * send either, and it is the input to {@link thread_key}.
   */
  conversation_id?: string;
  /**
   * The checkpoint thread key this execution actually read and wrote
   * (`<flow_id>:<conversation_id>`), or absent for a stateless run. Makes it
   * verifiable from the trace alone whether two executions shared persisted
   * history — the difference between "the model repeated itself" and "two flows
   * were writing into the same transcript".
   */
  thread_key?: string;
  /**
   * How the request transcript was reconciled against the persisted thread.
   * Absent for stateless runs. See `graph-engine/history-contract.ts`.
   */
  history_reconciliation?: DebugHistoryReconciliation;
  message_id?: string;
  user_id?: string;
  user_email?: string;
  user_name?: string;
  client_id?: string;
  language?: string;
  role?: string;
  plan?: string;
  /**
   * Sanitized copy of the decoded JWT payload. This never contains the raw
   * compact JWT, its protected header, or signature material.
   */
  jwt_claims?: Record<string, unknown>;
  /** W3C trace-id from the inbound traceparent header (if present). */
  trace_id?: string;
}

/**
 * Result of applying the threaded-history contract to one turn — how many
 * messages were already persisted, how many the request carried, and how many
 * of those were dropped as already-present duplicates.
 */
export interface DebugHistoryReconciliation {
  /** Messages already in the checkpoint before this turn. */
  persisted: number;
  /** Messages the request carried. */
  incoming: number;
  /** Incoming messages dropped because the checkpoint already had them. */
  dropped: number;
  /** Incoming messages actually appended to state. */
  appended: number;
  /**
   * True when the request added nothing new — a repeated submit of an unchanged
   * transcript. The single strongest signal that an identical answer came from a
   * duplicate request rather than from the model.
   */
  duplicate_turn: boolean;
  /**
   * Set only when `duplicate_turn` is true: whether the turn was regenerated
   * from its start. `outcome: "duplicate_turn_regenerated"` is the trace
   * diagnostic for "the engine forked from `base_checkpoint_id` and the new
   * answer replaced the old one". `duplicate_turn_kept` means the turn ran on
   * top of the persisted thread as before; `reason` says why.
   */
  regenerate?: {
    outcome: "duplicate_turn_regenerated" | "duplicate_turn_kept";
    reason?:
      | "last_incoming_not_user"
      | "not_latest_user_turn"
      | "nothing_to_replace"
      | "base_checkpoint_not_found"
      | "history_unreadable";
    base_checkpoint_id?: string;
    /** Persisted messages after the user turn that left the active branch. */
    replaced_messages?: number;
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A single conversation message (input or accumulated by the graph).
 * Content is stored as-is — plain text or multimodal content blocks.
 */
export interface DebugMessage {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * Plain-text string or array of multimodal content blocks, bounded to
   * {@link DebugTraceLimits.messageBytes} per entry (per string leaf for the
   * multimodal shape, so image/file block structure survives).
   */
  content: string | unknown[];
  /** Tool-result message identifier (only on role="tool" messages). */
  tool_call_id?: string;
  /** Tool calls the assistant requested (only on role="assistant" messages). */
  tool_calls?: DebugAssistantToolCall[];
  /** Function name (on tool-result messages). */
  name?: string;
}

/** Tool call reference embedded in an assistant message. */
export interface DebugAssistantToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-serialised arguments, as the model produced them. */
    arguments: string;
  };
}

// ---------------------------------------------------------------------------
// Node trace
// ---------------------------------------------------------------------------

/** Metadata explaining why one node execution attempt was started. */
export interface DebugNodeAttemptContext {
  trigger: string;
  parent_node_id?: string;
  delegation_id?: string;
}

/** Full detail for a single graph node execution. */
export interface DebugNodeTrace {
  /** Graph node ID (matches FlowNode.id). */
  node_id: string;
  /** Node type: "llm", "retrieval", "classifier", "tool", "memory", … */
  node_type?: string;
  /** Execution status. */
  status: "running" | "completed" | "error";
  /** ISO-8601 start timestamp. */
  started_at: string;
  /** ISO-8601 end timestamp; null while still running. */
  finished_at: string | null;
  /** Wall-clock duration in milliseconds; null while still running. */
  latency_ms: number | null;
  /**
   * 1-based GRAPH execution attempt for this node within the flow run (graph
   * retries, harness re-delegation). Provider/model retries inside one node
   * attempt do not increment it — see {@link DebugNodeTrace.provider_attempts}.
   */
  attempt?: number;
  /**
   * Provider/model call attempts made inside THIS node attempt (LLM retries
   * after an empty, reasoning-only or contract-violating reply, plus fallback
   * candidates), derived from the `llm_provider_attempt_completed` diagnostics.
   * Present only when at least one provider attempt was recorded.
   *   - `total`         — provider attempts made
   *   - `failed`        — attempts that completed with outcome `error`
   *   - `final_attempt` — per-candidate attempt number of the last attempt
   *   - `final_outcome` — outcome of the last attempt
   */
  provider_attempts?: {
    total: number;
    failed: number;
    final_attempt: number;
    final_outcome: "ok" | "error";
  };
  /** Why this attempt started (graph lifecycle, harness delegation, retry, …). */
  attempt_trigger?: string;
  /** Parent node that initiated the attempt, when delegated. */
  parent_node_id?: string;
  /** Stable task/run identifier associated with a delegated attempt. */
  delegation_id?: string;
  /**
   * Complete per-attempt history. The top-level node mirrors the latest attempt
   * for backward compatibility with existing trace consumers.
   */
  attempts?: DebugNodeAttempt[];
  /** 1-based execution order within this flow run. */
  sequence?: number;

  // -------------------------------------------------------------------------
  // LLM-node fields
  // -------------------------------------------------------------------------

  /** LLM used for this node, e.g. "openai/gpt-4o". Present on llm/classifier nodes. */
  model?: string;
  /** Prompt (input) tokens consumed. Present on llm/classifier nodes. */
  input_tokens?: number;
  /** Completion (output) tokens produced. Present on llm/classifier nodes. */
  output_tokens?: number;
  /** Estimated USD cost of this node's LLM call(s). Present on priced nodes. */
  cost?: number;

  /**
   * System prompt + conversation sent to the LLM, serialised to readable text.
   * Present on llm and classifier nodes. Includes the resolved system prompt,
   * any MCP instructions injected by the engine, and the conversation history.
   * Bounded to {@link DebugTraceLimits.promptBytes}; a truncation marker records
   * the original byte length.
   */
  full_prompt?: string;

  /**
   * Text the LLM produced for this node. Present on llm and classifier nodes.
   * Bounded to {@link DebugTraceLimits.llmResultBytes} — enough to identify the
   * answer in a post-mortem, not a verbatim archive.
   */
  full_response?: string;

  /**
   * Reasoning / chain-of-thought the model produced for this node, before and
   * between tool calls, bounded to {@link DebugTraceLimits.llmResultBytes}.
   * Aggregates every thinking source:
   * native `reasoning-delta` parts (Gemini, Anthropic extended thinking,
   * OpenAI o-series), `<think>…</think>` blocks (local OpenAI-compatible
   * models), the `reasoning_content` SSE shim, and pre-tool narration. Streamed
   * live to the client's collapsible thinking block but otherwise not part of
   * `full_response`. Present on llm/classifier nodes that emitted any thinking.
   */
  full_reasoning?: string;

  // -------------------------------------------------------------------------
  // Tool calls (MCP + RAG retrieval)
  // -------------------------------------------------------------------------

  /**
   * All MCP/RAG tool calls made during this node, in order of invocation, with
   * their arguments and result payloads. Structure and metadata (refs, ids,
   * scores, counts) stay complete; string leaves are bounded to
   * {@link DebugTraceLimits.toolPayloadBytes}.
   */
  tool_calls: DebugToolCall[];

  // -------------------------------------------------------------------------
  // Semantic tool selection
  // -------------------------------------------------------------------------

  /**
   * Present when the node is configured with `config.toolSelection.mode: "semantic"`.
   * Shows the query used, which tools were selected from the pool, and which
   * were always included unconditionally.
   */
  tool_selection?: DebugToolSelection;

  /**
   * Present on classifier nodes. Captures the structured classification
   * decision: the requested output format, the schema the model was asked to
   * satisfy, the raw model output, the parsed object, and the routed class
   * label. This is the dispatcher's actual decision — the most useful artifact
   * for debugging routing.
   */
  classifier?: DebugClassifierOutput;

  /** Human-readable error description (only when status = "error"). */
  error_message?: string;

  /**
   * Machine-readable error category (only when status = "error"), mirroring the
   * `StreamError.type` of the error that failed the node (e.g.
   * "provider_error", "execution_error"). Lets a reader group/triage failures
   * without parsing the free-text {@link error_message}.
   */
  error_type?: string;

  /**
   * Structured error context (only when status = "error"), mirroring
   * `StreamError.details` (e.g. `{ node_id, task_id, target }`). Preserves the
   * details the failing handler attached instead of collapsing them into the
   * message string.
   */
  error_details?: Record<string, unknown>;

  /**
   * Ordered timeline of noteworthy events that occurred WITHIN this node's
   * execution — retries, model fallbacks, repetition-loop aborts, reasoning-
   * only salvages, empty responses, tool errors, etc. Empty/absent for a clean
   * run. This is the primary artifact for post-mortem "why did this node
   * degrade or fail" analysis: a bare `error_message` says a node failed, the
   * diagnostics timeline says how it got there (e.g. three
   * `reasoning_only_retry` entries then an `empty_response`).
   */
  diagnostics?: DebugNodeDiagnostic[];

  /**
   * Present on llm/classifier nodes that ran the groundedness/citation gate
   * (`GROUNDEDNESS_ENABLED=true`) with retrieval context available. Mirrors
   * the `groundedness` SSE chunk shape so the debug trace and the live stream
   * report identical numbers. Backs the "why did the model say this" section
   * of the Decision-Provenance Explainability Card (`GET
   * /monitoring/explain/:executionId`).
   */
  groundedness?: DebugGroundedness;
}

/** One immutable execution attempt retained under a canonical node trace. */
export type DebugNodeAttempt = Omit<
  DebugNodeTrace,
  "node_id" | "node_type" | "attempt" | "attempts"
> & {
  attempt: number;
};

/**
 * A single noteworthy in-node event captured on {@link DebugNodeTrace.diagnostics}.
 *
 * Emitted by handlers via `runtime.onNodeDiagnostic` at points that are
 * otherwise invisible in a post-mortem (they only surfaced as Prometheus
 * counters or transient reasoning tokens): LLM retries, provider fallbacks,
 * the repetition-guard abort, the reasoning-only salvage, empty responses, and
 * so on. Kept deliberately small and stringly-typed so any handler can emit one
 * without a coupling to a fixed enum.
 */
export interface DebugNodeDiagnostic {
  /** ISO-8601 timestamp when the event was recorded. */
  at: string;
  /** Severity: "info" (normal but noteworthy), "warn" (degraded), "error". */
  level: "info" | "warn" | "error";
  /**
   * Stable machine code for the event, e.g. "retry", "fallback",
   * "repetition_aborted", "reasoning_salvage", "empty_response",
   * "max_output_tokens_clamped", "context_truncated". Groupable and
   * greppable; not a closed enum so new events need no type change.
   */
  code: string;
  /** Human-readable one-line description. */
  message: string;
  /** Optional structured context (attempt number, model, char counts, …). */
  details?: Record<string, unknown>;
}

/**
 * The payload a handler passes to `runtime.onNodeDiagnostic` — same as
 * {@link DebugNodeDiagnostic} minus the `at` timestamp, which the engine stamps
 * on receipt so handlers never have to.
 */
export type NodeDiagnosticInput = Omit<DebugNodeDiagnostic, "at">;

/** Groundedness/citation gate outcome for one node, captured for the debug trace. */
export interface DebugGroundedness {
  score: number;
  passed: boolean;
  checked_sentences: number;
  unsupported: Array<{ sentence: string; support: number }>;
}

// ---------------------------------------------------------------------------
// Tool call
// ---------------------------------------------------------------------------

/** A single MCP or RAG retrieval tool call with its full result payload. */
export interface DebugToolCall {
  /** Tool call ID assigned by the LLM (or a synthetic UUID for retrieval). */
  id: string;
  /**
   * Full tool reference, e.g. "myserver/tool_name" for MCP tools or
   * "retrieval/my-collection" for RAG retrieval nodes.
   */
  name: string;
  /** Full parsed arguments object (not truncated). */
  arguments: unknown;
  /**
   * Full result content returned by the MCP server or retrieval engine.
   * For MCP tools: the raw SDK ToolResult content array.
   * For RAG: `{ collection, retrieved, chunks: [{id, text, score}] }`.
   * Null when the call is still in-flight.
   */
  result: unknown | null;
  /** True when the tool returned an error response. */
  is_error: boolean;
  /** Coverage-search provenance attached by the agent harness runtime. */
  coverage_search?: {
    parse_status?:
      | "parsed"
      | "tool-error"
      | "invalid-effective-args"
      | "unparseable-success";
    effective_args_fingerprint?: string;
    dedupe?: {
      status: "hit" | "miss";
      source_tool_call_id?: string;
    };
  };
  /** Execution wall-clock time in seconds (rounded to 3 decimal places). */
  exec_time_seconds?: number;
  /** ISO-8601 timestamp when the tool call was initiated. */
  called_at: string;
}

// ---------------------------------------------------------------------------
// Semantic tool selection
// ---------------------------------------------------------------------------

/** Semantic (embedding-based) tool selection decision made by a node. */
export interface DebugToolSelection {
  /** The user query string used to rank the tool pool. */
  query: string;
  /** Tool refs in the always-include set (advertised unconditionally). */
  always_included: string[];
  /** Tools selected by semantic similarity ranking. */
  selected: DebugToolSelectionHit[];
  /** Total number of tools in the candidate pool. */
  pool_size: number;
}

/** A single tool matched by semantic similarity. */
export interface DebugToolSelectionHit {
  /** Full tool reference, e.g. "server/tool_name". */
  ref: string;
  /** Embedding cosine similarity score in range 0–1. */
  score: number;
}

// ---------------------------------------------------------------------------
// Classifier output
// ---------------------------------------------------------------------------

/** The structured decision produced by a classifier (dispatcher) node. */
export interface DebugClassifierOutput {
  /** Output format requested from the model: "json" | "xml". */
  response_format: string;
  /** The JSON schema the model was asked to satisfy (classifierSchema.schema). */
  schema?: unknown;
  /**
   * Raw model text before JSON/XML extraction (mirrors `full_response`, kept
   * here so the classifier decision is self-contained).
   */
  raw_output: string;
  /** Parsed classification object, or null when extraction failed. */
  parsed: Record<string, unknown> | null;
  /**
   * The class label routed on (value of `classifierSchema.classKey`). May come
   * from a configured fallback when extraction failed.
   */
  class_label?: string;
  /** True when the parsed result came from the configured fallback, not the model. */
  used_fallback?: boolean;
}

// ---------------------------------------------------------------------------
// Usage + errors
// ---------------------------------------------------------------------------

/** Accumulated token usage across all LLM nodes in the execution. */
export interface DebugUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** A stream error recorded during execution. */
export interface DebugStreamError {
  message: string;
  type: string;
  details?: Record<string, unknown>;
}

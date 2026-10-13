// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Monitoring TypeScript Interfaces
 *
 * Covers node execution events emitted by the Graph Engine, the per-request
 * context that flows through graph execution, and the accumulated agent state
 * held by the LangGraph state machine. No `any` at module boundaries.
 */

import type {
  StreamError,
  Citation,
  OpenAITool,
  ToolChoice,
} from "./openai.js";

// ---------------------------------------------------------------------------
// NodeExecutionEvent
// ---------------------------------------------------------------------------

/**
 * Synthetic node id marking the true end of a flow execution. Emitted by the
 * graph engine exactly once per run — on the success path after the trace is
 * sealed, and on the error path before the exception propagates — carrying the
 * flow's real terminal status (`completed`/`error`).
 *
 * The execution rollup in `monitoring/execution-store.ts` flips an execution's
 * status to its terminal value ONLY on this event (or the chat route's
 * `__response__` boundary, which covers non-flow requests). Before that an
 * execution honestly reports `running`, even when individual nodes have
 * already completed — a multi-node flow that reports `completed` after its
 * first node is indistinguishable from one that finished.
 *
 * Excluded from `node_count`/`error_count` (it is a rollup marker, not a
 * graph node) and from dashboard rendering.
 */
export const FLOW_END_NODE_ID = "__flow_end__";

/**
 * Boundary node id the chat route emits when the response to a request has
 * been fully produced (see `routes/chat/handler.ts`). Like
 * {@link FLOW_END_NODE_ID} it is a terminal marker for the execution rollup —
 * it is what flips a non-flow (direct LLM) request, which never runs the graph
 * engine and so never emits {@link FLOW_END_NODE_ID}, to its real status.
 */
export const RESPONSE_NODE_ID = "__response__";

/**
 * Boundary node id the chat route emits at the start of a request, carrying
 * the resolved identity/prompt. It is a terminal (`completed`) event but NOT a
 * status-flip marker: flipping on it would mark every execution `completed`
 * the instant it begins.
 */
export const REQUEST_NODE_ID = "__request__";

/**
 * Event emitted by the Graph Engine for each node execution lifecycle step.
 * Sent by the Monitoring Service to all connected dashboard clients.
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
   * Discriminates a synthetic node from a real flow-graph node. Absent (the
   * common case) means a node declared in the flow definition. `"tool"` marks a
   * node the engine synthesises for a single tool call so every tool invocation
   * surfaces as its own node in the live graph instead of being folded into the
   * issuing node.
   */
  kind?: "tool";
  /**
   * For a synthetic node (see {@link kind}), the id of the real flow node that
   * issued it — the edge source the dashboard draws so the tool node visibly
   * hangs off the node that called it. Absent for ordinary flow nodes.
   */
  parent_node_id?: string;
  /**
   * Display label for the node. Set for synthetic nodes (e.g. the tool name for
   * a `"tool"` node) and for ordinary flow nodes (from the flow definition).
   * When present, the dashboard uses this value directly instead of deriving a
   * label from the node id or looking it up in the flow definition.
   */
  label?: string;
  // -------------------------------------------------------------------------
  // Optional detail fields — populated when the monitoring service has access
  // to the execution context (LLM nodes, tool nodes).
  // -------------------------------------------------------------------------
  /** LLM provider/model used for this node, e.g. "openai/gpt-4o" */
  model?: string;
  /** Number of prompt (input) tokens consumed — LLM nodes only */
  input_tokens?: number;
  /** Number of completion (output) tokens produced — LLM nodes only */
  output_tokens?: number;
  /**
   * Estimated cost of this node's LLM call(s), derived from the token counts
   * above and the flow's configured per-model prices (falling back to the
   * global pricing table). Currency-agnostic price units. Present only for
   * nodes that made a priced LLM call; 0 when the model has no known/configured
   * price (e.g. local models).
   */
  cost?: number;
  /** Tool calls made during this node execution */
  tool_calls?: NodeToolCall[];
  /** Execution order within this execution (1-based) */
  sequence?: number;
  /**
   * Resolved prompt sent to the model for LLM/classifier nodes (system prompt +
   * conversation), serialized to readable text. Truncated to a bounded length
   * so large contexts do not bloat the event stream. Debug/inspection only.
   */
  prompt?: string;
  /** Final text the model produced for this node (truncated). Debug only. */
  response?: string;
  /**
   * Display name (or email/id fallback) of the end user who triggered the
   * request. Set on the synthetic `__request__` boundary node so the live
   * graph / request list can attribute each run to a user.
   */
  user_name?: string;
  /**
   * The end user's prompt text (last user message), truncated. Set on the
   * `__request__` boundary node so the request list can preview what was asked.
   */
  user_prompt?: string;
  /**
   * Stable id of the end user (JWT `sub` / OWUI user id). Set on the
   * `__request__` boundary node so the permanent token-usage log can attribute
   * (and GDPR-erase) a request by user, not just by display name.
   */
  user_id?: string;
  /**
   * ID of the flow this run executed. Set on the synthetic boundary nodes so
   * the live request list can show the flow name without a separate lookup.
   */
  flow_id?: string;
  /**
   * The routing decision a `router` node made — which outgoing edge (target)
   * was selected and the conditions it evaluated. Present only for router
   * nodes, so the live graph / history can show *why* the run took the branch
   * it did instead of just timing.
   */
  routing_decision?: RoutingDecision;
}

// ---------------------------------------------------------------------------
// RoutingDecision — the branch a `router` node took
// ---------------------------------------------------------------------------

/**
 * A single outgoing edge a `router` node evaluated, in declaration order.
 * `matched` marks the first edge whose condition was true (the one taken);
 * every other candidate is `false`.
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
 * The outcome of a `router` node: the chosen target plus the full list of
 * candidate edges it evaluated (so the dashboard can show the taken branch in
 * context of the alternatives that were not).
 */
export interface RoutingDecision {
  /** The selected next node id, or "__end__" when no edge matched. */
  target: string;
  /** The condition expression that selected {@link target}, when conditional. */
  matched_condition?: string;
  /** The label of the selected edge, when the flow author set one. */
  matched_label?: string;
  /** Every outgoing edge evaluated, in order, with the outcome of each. */
  candidates: RoutingCandidate[];
}

// ---------------------------------------------------------------------------
// RequestContext
// ---------------------------------------------------------------------------

/**
 * Immutable per-request context that travels through the entire graph execution.
 * Holds authentication credentials, decoded JWT claims and all request-level
 * attributes used for dynamic flow/model/tool selection.
 */
/**
 * Canonical execution context shared by graph, MCP and Transaction Fabric
 * boundaries. RequestContext remains as a compatibility alias for callers.
 */
export interface AgentExecutionContext {
  /** SSO bearer token extracted by Auth Middleware */
  ssoToken: string;
  /** UUID correlating all monitoring events for this request */
  executionId: string;
  /**
   * Pre-generated parent Decision_Receipt id (Req 15.4). The chat route sets
   * this before execution so the `X-ATF-Receipt` response header can be sent
   * immediately; the receipt decorator consumes it instead of generating a
   * fresh UUID. Optional — receipts are off by default.
   */
  decisionReceiptId?: string;
  /** Authenticated user's email address (optional) */
  userEmail?: string;
  /**
   * Authenticated user's stable id (optional). Populated from the
   * `X-OpenWebUI-User-Id` header or the JWT `sub` claim.
   */
  userId?: string;
  /**
   * Authenticated user's display name (optional). Populated from the
   * `X-OpenWebUI-User-Name` header (URL-decoded) or the JWT `name` claim.
   */
  userName?: string;
  /** Tenant/client identifier for multi-tenant deployments (optional) */
  clientId?: string;

  // -------------------------------------------------------------------------
  // Conversation identifiers forwarded by the client (Open WebUI) in the
  // request body `metadata` — correlate this execution to a chat/turn.
  // -------------------------------------------------------------------------
  /** Conversation id (Open WebUI `metadata.chat_id`; a fresh UUID when absent). */
  chatId?: string;
  /** Client session/socket id (Open WebUI `metadata.session_id`; a fresh UUID when absent). */
  sessionId?: string;
  /**
   * Session id cryptographically bound to the authenticated bearer (JWT `sid`
   * or `session_id`). Unlike `sessionId`, this value is safe for signed
   * transaction envelopes and authorization checks.
   */
  authenticatedSessionId?: string;
  /** Id of the user message that triggered this run (Open WebUI `metadata.message_id`; a fresh UUID when absent). */
  messageId?: string;

  // -------------------------------------------------------------------------
  // Decoded JWT payload claims — populated when JWT_SECRET / JWT_JWKS_URL is
  // configured. Raw key→value map; consume via ctx.claims["role"] etc.
  // -------------------------------------------------------------------------
  /** All decoded JWT payload claims (sub, roles, groups, custom claims …) */
  claims?: Record<string, unknown>;
  /** Convenience shortcut: first string-valued "role" claim if present */
  role?: string;
  /** Convenience shortcut: string[] "groups" or "group" claim if present */
  groups?: string[];

  // -------------------------------------------------------------------------
  // Request-level attributes from Open WebUI / the client
  // These come from the request body's `metadata` field.
  // -------------------------------------------------------------------------
  /**
   * Arbitrary key→value map forwarded from `request.metadata` (minus `token`).
   * Open WebUI sends custom attributes here, e.g.:
   *   { "language": "de", "plan": "pro", "tenant": "acme" }
   */
  requestParams?: Record<string, unknown>;
  /**
   * Preferred language / locale string, e.g. "de", "en-US".
   * Extracted from requestParams["language"] or Accept-Language header.
   */
  language?: string;
  /**
   * User-tier or subscription plan, e.g. "free", "pro", "enterprise".
   * Extracted from requestParams["plan"] or a JWT claim.
   */
  plan?: string;

  /**
   * Distributed-trace context for this request, parsed from the inbound W3C
   * `traceparent` header (or generated when absent). Flow/node spans are
   * created as children of this context so traces link end-to-end across the
   * caller, the platform, and downstream services.
   */
  traceContext?: {
    traceId: string;
    spanId: string;
    /** Whether the trace is sampled (W3C trace-flags bit 0). */
    sampled: boolean;
  };

  /**
   * Execution-output accumulator (NOT an input): the `provider/model` keys of
   * every LLM responder model selected during this run. Populated by the graph
   * engine's LLM nodes so the request path can attribute a post-hoc quality
   * (judge) score back to the exact model(s) that produced the answer — the
   * write side of the adaptive quality-aware router. Empty/absent for runs that
   * executed no LLM node.
   */
  selectedModels?: string[];

  /**
   * Per-request BYOK provider keys, keyed by provider name, resolved from the
   * calling tenant's stored keys before execution. When present for a provider,
   * the LLM factory uses it instead of the shared pool / platform key, so the
   * tenant's traffic bills to and is isolated on its own provider account.
   * Absent for tenants without BYOK configured (platform key is used as before).
   */
  providerKeyOverrides?: Partial<Record<string, string>>;

  /**
   * Per-request overrides for the executed flow's variables (see
   * `FlowDefinition.variables`). Keyed by variable name; values replace the
   * flow's declared defaults for this execution only. Used to, e.g., swap the
   * LLM model a flow runs on without editing the flow file. Unknown names are
   * ignored. Absent for the common case (flow defaults are used).
   */
  variableOverrides?: Record<string, unknown>;

  /**
   * Caller-supplied tools (function-calling passthrough). When present, an
   * `llm` node exposes these to the model alongside any of its own MCP tools,
   * but DOES NOT execute them: the model's `tool_calls` are streamed straight
   * back to the caller, which executes the tool and returns the result on the
   * next turn. Sourced from the request body's `tools` field.
   */
  clientTools?: OpenAITool[];
  /** Constrains how the model may use {@link clientTools}. From `tool_choice`. */
  clientToolChoice?: ToolChoice;
}

/** @deprecated Prefer AgentExecutionContext for new execution-boundary code. */
export type RequestContext = AgentExecutionContext;

// ---------------------------------------------------------------------------
// AgentState
// ---------------------------------------------------------------------------

/**
 * LangGraph StateGraph annotation — the complete mutable state carried through
 * all nodes during a single flow execution.
 *
 * `messages` uses LangChain's BaseMessage-compatible shape so it can be passed
 * directly to the LangGraph annotation without casts. The concrete runtime type
 * is resolved at the LangGraph layer; the interface only constrains the shape
 * known at compile time.
 */
export interface AgentState {
  /**
   * Accumulated conversation messages (LangChain BaseMessage-compatible objects).
   * Typed as a readonly array of structured objects to avoid `any`.
   */
  messages: ReadonlyArray<{
    _getType(): string;
    content: string | ContentBlockLike[];
    additional_kwargs?: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  /** Immutable request context — should not be mutated by node handlers */
  context: RequestContext;
  /** RAG citations accumulated across all nodes during this execution */
  citations: Citation[];
  /** Raw tool results collected across all tool-node executions */
  toolResults: ToolResultEntry[];
  /** Stream errors accumulated during execution */
  errors: StreamError[];
  /** ID of the node currently being executed (used for monitoring correlation) */
  currentNodeId?: string;
}

// ---------------------------------------------------------------------------
// Supporting types referenced by AgentState
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a multimodal content block as understood at the state level.
 * Mirrors the ContentBlock union from openai.ts without re-importing the full union,
 * keeping this interface self-contained for consumers that only need AgentState.
 */
export interface ContentBlockLike {
  type: string;
  [key: string]: unknown;
}

/** A single tool call recorded in a NodeExecutionEvent */
export interface NodeToolCall {
  /** Tool call ID assigned by the LLM */
  id: string;
  /** MCP tool name */
  name: string;
  /** Serialized arguments JSON */
  args_json: string;
  /** Execution time in seconds, null while pending */
  exec_time_seconds?: number | null;
}

/** A single tool result entry accumulated in AgentState */
export interface ToolResultEntry {
  /** Tool call ID that produced this result */
  tool_call_id: string;
  /** Name of the MCP tool that was called */
  tool_name: string;
  /** Raw result payload returned by the MCP server */
  result: Record<string, unknown>;
  /** Execution wall-clock time in seconds, rounded to 3 decimal places */
  execution_time_seconds: number;
}

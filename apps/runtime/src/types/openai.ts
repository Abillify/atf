// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OpenAI Chat Completions Request/Response TypeScript Interfaces
 *
 * Covers both streaming (SSE) and non-streaming response formats,
 * multimodal content blocks, tool call chunks, citations, and stream errors.
 * No `any` at module boundaries.
 */

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

/** Plain text content block */
export interface TextContentBlock {
  type: "text";
  text: string;
}

/** Image content block — URL or data:image/...;base64,... */
export interface ImageContentBlock {
  type: "image";
  image_url: { url: string };
}

/**
 * OpenAI-standard image content block.
 * OpenAI's API and clients (e.g. Open WebUI) send `type: "image_url"` rather
 * than `type: "image"`. Both shapes are structurally identical and handled
 * the same way by the content processor.
 */
export interface ImageUrlContentBlock {
  type: "image_url";
  image_url: { url: string };
}

/** File content block — URL or data URI */
export interface FileContentBlock {
  type: "file";
  file_url: { url: string };
}

/** Union of all supported multimodal content block types */
export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ImageUrlContentBlock
  | FileContentBlock;

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

/**
 * A tool call attached to an assistant message (OpenAI function-calling shape).
 * Present on an assistant turn in the conversation history (replayed by the
 * client after it executed the tool) and on the assistant message of a response
 * whose `finish_reason` is `"tool_calls"`.
 */
export interface MessageToolCall {
  /** Unique call identifier the client echoes back on the matching tool result. */
  id: string;
  type: "function";
  function: {
    /** Function name — matches a tool the client declared in `tools`. */
    name: string;
    /** JSON-serialized arguments object. */
    arguments: string;
  };
}

/** A single message in the conversation history */
export interface ChatMessage {
  /** Participant role */
  role: "user" | "assistant" | "system" | "tool";
  /** Text content or multimodal content block array */
  content: string | ContentBlock[];
  /** Tool call identifier (only present when role is "tool") */
  tool_call_id?: string;
  /** Tool name (optional, only present when role is "tool" or similar) */
  name?: string;
  /**
   * Tool calls the assistant requested (only present when role is "assistant").
   * Carried in history so a follow-up turn round-trips the prior tool call, and
   * returned on the assistant message when the model emits client-tool calls.
   */
  tool_calls?: MessageToolCall[];
}

// ---------------------------------------------------------------------------
// Client-supplied tools (function-calling passthrough)
// ---------------------------------------------------------------------------

/** A single function definition supplied by the caller in `tools`. */
export interface OpenAIToolFunction {
  /** Function name, must match `^[A-Za-z0-9_-]{1,64}$`. */
  name: string;
  /** Human/LLM-facing description of when to use the function. */
  description?: string;
  /** JSON Schema describing the function's parameters object. */
  parameters?: Record<string, unknown>;
}

/** A tool the caller exposes to the model (OpenAI `tools[]` entry). */
export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

/**
 * How the model may use the supplied `tools`:
 *   - `"auto"`     — model decides (default when tools are present)
 *   - `"none"`     — model must not call a tool
 *   - `"required"` — model must call at least one tool
 *   - object       — force a specific function
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Incoming OpenAI-compatible chat completions request */
export interface ChatCompletionRequest {
  /** Flow ID to execute — maps to FlowDefinition.id */
  model: string;
  /** Conversation history — must contain at least one message */
  messages: ChatMessage[];
  /** Stream response as SSE when true; return full JSON when false or absent */
  stream?: boolean;
  /**
   * Tools (functions) the caller exposes to the model. When present, aiperator
   * passes them through to the model and streams back any `tool_calls` the model
   * emits WITHOUT executing them — the caller runs the tool and sends the result
   * back as a follow-up `tool` message. This is independent of a flow node's own
   * server-side MCP tools (which aiperator does execute internally).
   */
  tools?: OpenAITool[];
  /** Constrains how the model may use `tools`. Ignored when `tools` is absent. */
  tool_choice?: ToolChoice;
  /**
   * Optional per-request overrides for the target flow's declared variables
   * (see `FlowDefinition.variables`). Keyed by variable name; each value
   * replaces the flow's default for this request only (e.g. swap the LLM
   * model the flow runs on). Unknown names are ignored. May also be supplied
   * via `metadata.variables`.
   */
  variables?: Record<string, unknown>;
  /** Optional request metadata */
  metadata?: {
    /** Fallback auth token when Authorization header is absent (Req 2.2) */
    token?: string;
    /** Per-request flow variable overrides (alias of the top-level `variables`). */
    variables?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

/** A single choice in a non-streaming completion response */
export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: "stop" | "tool_calls" | "length" | "error" | null;
}

/** Token usage statistics */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * OpenAI-compatible prompt-cache breakdown. `cached_tokens` is the subset of
   * `prompt_tokens` the provider served from a warm prompt cache rather than
   * re-prefilling. Optional and additive — clients that don't expect it ignore
   * it, and it is omitted entirely when no provider in the run reported cache
   * data.
   */
  prompt_tokens_details?: { cached_tokens: number };
  /**
   * Estimated USD cost of the run, summed across every LLM/classifier/tool node
   * at each node's own provider/model price (optional, additive — clients that
   * don't expect it ignore it). Populated by the graph engine; consumers like
   * the SLO registry use it for an EXACT per-run cost instead of a single-model
   * approximation.
   */
  cost_usd?: number;
}

/** Full non-streaming chat completion response */
export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  /** Unix timestamp */
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// SSE streaming chunks
// ---------------------------------------------------------------------------

/** A tool call chunk as sent inside an SSE delta */
export interface ToolCallChunk {
  /** Non-empty call identifier */
  id: string;
  type: "function";
  function: {
    /** Tool / function name */
    name: string;
    /** JSON-serialized arguments object */
    arguments: string;
  };
  /**
   * Position of this tool call within the assistant message's `tool_calls`
   * array. Required by spec-compliant OpenAI clients to assemble streamed
   * tool-call deltas — without it, parallel calls (each defaulting to index 0)
   * get merged into one. Omitted for the internal MCP reasoning-step path.
   */
  index?: number;
  /** Execution time rounded to 3 decimal places (tool-result chunks only) */
  execution_time_seconds?: number;
}

/** Delta object inside a streaming chunk choice */
export interface ChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: ToolCallChunk[];
  /** Reasoning / thinking content (Open WebUI shows this in a collapsible block) */
  reasoning_content?: string;
}

/** A single choice entry in a streaming chunk */
export interface ChunkChoice {
  index: number;
  delta: ChunkDelta;
  finish_reason?: string | null;
}

/** Passage-level provenance attached to a document-stable citation source. */
export interface CitationEvidence {
  citation_id?: string;
  document_id?: string;
  version?: string;
  page?: string | number;
  section?: string;
  char_start?: number;
  char_end?: number;
  chunk_id?: string;
  /** Passage text retained independently from the document-level fallback snippet. */
  text?: string;
  score?: number;
}

/**
 * A retrieved source surfaced for citation. Streamed on an otherwise no-op
 * chunk (empty delta) so an Open WebUI filter can turn the ones the answer
 * actually references (`[n]`) into native, clickable citations. `index` is the
 * 1-based number the answer cites with (`[index]`).
 */
export interface CitationSource {
  /** 1-based citation number the answer references as `[index]`. */
  index: number;
  /** Source document title. */
  title: string;
  /** Source URL (may be empty when the source has no link). */
  url: string;
  /** Relevant excerpt — max 500 characters. */
  snippet: string;
  /** Embedding similarity in range 0.0–1.0. */
  score: number;
  citation_id?: string;
  document_id?: string;
  version?: string;
  page?: string | number;
  section?: string;
  char_start?: number;
  char_end?: number;
  chunk_id?: string;
  /** Distinct passage-level evidence for this document; does not affect `[index]`. */
  evidence?: CitationEvidence[];
}

/** SSE streaming response chunk */
export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  /** Unix timestamp */
  created: number;
  model: string;
  choices: ChunkChoice[];
  /**
   * Retrieved sources for citation, carried on an otherwise no-op chunk.
   * Non-standard OpenAI field — consumed by the Open WebUI status/citation
   * filter, ignored by clients that don't understand it.
   */
  sources?: CitationSource[];
}

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

/** RAG source citation emitted as an SSE chunk */
export interface Citation {
  /** Source document title used for document identity and prompt grounding. */
  title: string;
  /**
   * Optional human-readable title for source chips. It may append a chapter
   * breadcrumb while preserving the raw {@link title} for identity and prompts.
   */
  displayTitle?: string;
  /** Source URL */
  url: string;
  /** Relevant excerpt — max 500 characters */
  snippet: string;
  /** Embedding similarity in range 0.0–1.0 */
  similarity_score: number;
  citation_id?: string;
  document_id?: string;
  version?: string;
  page?: string | number;
  section?: string;
  char_start?: number;
  char_end?: number;
  chunk_id?: string;
  /** Multiple passages remain attached to one document-level citation. */
  evidence?: CitationEvidence[];
}

// ---------------------------------------------------------------------------
// Stream error
// ---------------------------------------------------------------------------

/** Structured error sent as an SSE chunk before [DONE] */
export interface StreamError {
  message: string;
  type:
    | "execution_error"
    | "invalid_request_error"
    | "provider_error"
    | "tool_error";
  details?: {
    node_id?: string;
    provider?: string;
    parameter?: string;
    [key: string]: unknown;
  };
}

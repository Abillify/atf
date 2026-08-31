// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * OpenAI Responses API Request/Response TypeScript Interfaces
 *
 * Covers the `POST /v1/responses` surface: the structured `input` item list,
 * multimodal content parts, function tools, and both the non-streaming
 * `response` object and the typed streaming events.
 *
 * These are the wire shapes the OpenAI SDK (and clients like n8n's OpenAI node)
 * send and expect. aiperator translates them to/from its internal Chat
 * Completions shapes (`src/types/openai.ts`) — see `src/routes/responses/`.
 *
 * No `any` at module boundaries.
 */

import type { TokenUsage } from "./openai.js";

// ---------------------------------------------------------------------------
// Input content parts
// ---------------------------------------------------------------------------

/** Text supplied by the caller (`input`) or echoed assistant history. */
export interface ResponsesInputText {
  type: "input_text";
  text: string;
}

/** Assistant-authored text carried in conversation history. */
export interface ResponsesOutputText {
  type: "output_text";
  text: string;
  /** Citations / references — passed through, not interpreted. */
  annotations?: unknown[];
}

/**
 * Image input. OpenAI accepts either a URL/data-URI string or an object with a
 * `url` field; both shapes are handled by the translation layer.
 */
export interface ResponsesInputImage {
  type: "input_image";
  image_url?: string | { url: string };
  /** Optional detail hint ("auto" | "low" | "high") — ignored downstream. */
  detail?: string;
}

/** File input (URL or data-URI). */
export interface ResponsesInputFile {
  type: "input_file";
  file_url?: string | { url: string };
  filename?: string;
}

/** Union of all supported content parts on a message input item. */
export type ResponsesContentPart =
  | ResponsesInputText
  | ResponsesOutputText
  | ResponsesInputImage
  | ResponsesInputFile;

// ---------------------------------------------------------------------------
// Input items
// ---------------------------------------------------------------------------

/** Role on a Responses message item. `developer` maps to a system message. */
export type ResponsesRole = "user" | "assistant" | "system" | "developer";

/** A conversational message item in `input`. */
export interface ResponsesMessageItem {
  type?: "message";
  role: ResponsesRole;
  content: string | ResponsesContentPart[];
}

/**
 * A prior tool call the model requested (conversation history). Mirrors an
 * assistant `tool_calls` entry in Chat Completions.
 */
export interface ResponsesFunctionCallItem {
  type: "function_call";
  /** Stable id of the tool call the caller echoes back on its output. */
  call_id: string;
  name: string;
  /** JSON-serialized arguments object. */
  arguments: string;
  id?: string;
  status?: string;
}

/** The caller's result for a previously requested tool call. */
export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  /** Tool result payload (string or JSON-serializable). */
  output: string;
}

/** Any item accepted in the `input` array. */
export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

// ---------------------------------------------------------------------------
// Tools (function-calling passthrough)
// ---------------------------------------------------------------------------

/**
 * A function tool in the Responses API shape — note the fields are flattened
 * (name/description/parameters at the top level), unlike Chat Completions where
 * they nest under `function`.
 */
export interface ResponsesFunctionTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

/** How the model may use the supplied tools. */
export type ResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Incoming `POST /v1/responses` request. */
export interface ResponsesRequest {
  /** Flow ID to execute — maps to FlowDefinition.id (same as chat `model`). */
  model: string;
  /** Prompt input: a bare string or a structured item list. */
  input: string | ResponsesInputItem[];
  /** System-level instructions, prepended as a system message. */
  instructions?: string;
  /** Stream typed SSE events when true; return a single JSON object otherwise. Default false. */
  stream?: boolean;
  /** Function tools the caller exposes (passed through, not executed server-side). */
  tools?: ResponsesFunctionTool[];
  /** Constrains tool usage. Ignored when `tools` is absent. */
  tool_choice?: ResponsesToolChoice;
  /** Whether parallel tool calls are permitted (passed through). */
  parallel_tool_calls?: boolean;
  /** Upper bound on generated tokens (advisory — surfaced back in the response). */
  max_output_tokens?: number;
  /** Sampling temperature (advisory passthrough). */
  temperature?: number;
  /** Nucleus sampling (advisory passthrough). */
  top_p?: number;
  /** Whether OpenAI would persist the response — accepted and ignored. */
  store?: boolean;
  /** Whether to run in the background — accepted; maps to async job mode. */
  background?: boolean;
  /** Per-request flow variable overrides (see chat request `variables`). */
  variables?: Record<string, unknown>;
  /** Arbitrary caller metadata (also carries the fallback `token`). */
  metadata?: {
    token?: string;
    variables?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Non-streaming response object
// ---------------------------------------------------------------------------

/**
 * Usage in Responses API naming (input/output rather than prompt/completion).
 * The nested detail objects are part of the official wire shape and are
 * required by the OpenAI SDK's usage model, so they are always present.
 */
export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

/** A content part on an assistant output message. */
export interface ResponsesOutputContent {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

/** An assistant message output item. */
export interface ResponsesOutputMessage {
  type: "message";
  id: string;
  status: "completed" | "incomplete";
  role: "assistant";
  content: ResponsesOutputContent[];
}

/** A tool call the model emitted (surfaced for the caller to execute). */
export interface ResponsesOutputFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "completed";
}

/** Any item that can appear in a response's `output` array. */
export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall;

/** The full non-streaming `response` object. */
export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "failed" | "incomplete" | "in_progress";
  model: string;
  output: ResponsesOutputItem[];
  /** SDK convenience: the concatenated assistant text of `output`. */
  output_text: string;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  parallel_tool_calls: boolean;
  temperature: number | null;
  top_p: number | null;
  tool_choice: ResponsesToolChoice;
  tools: ResponsesFunctionTool[];
  metadata: Record<string, unknown>;
  usage?: ResponsesUsage;
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the streaming SSE events aiperator emits. Each is
 * written as `event: <type>\ndata: <json>\n\n`. `sequence_number` increments
 * across the whole stream.
 */
export type ResponsesStreamEvent =
  | { type: "response.created"; sequence_number: number; response: ResponsesResponse }
  | { type: "response.in_progress"; sequence_number: number; response: ResponsesResponse }
  | {
      type: "response.output_item.added";
      sequence_number: number;
      output_index: number;
      item: ResponsesOutputItem;
    }
  | {
      type: "response.content_part.added";
      sequence_number: number;
      item_id: string;
      output_index: number;
      content_index: number;
      part: ResponsesOutputContent;
    }
  | {
      type: "response.output_text.delta";
      sequence_number: number;
      item_id: string;
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      sequence_number: number;
      item_id: string;
      output_index: number;
      content_index: number;
      text: string;
    }
  | {
      type: "response.content_part.done";
      sequence_number: number;
      item_id: string;
      output_index: number;
      content_index: number;
      part: ResponsesOutputContent;
    }
  | {
      type: "response.output_item.done";
      sequence_number: number;
      output_index: number;
      item: ResponsesOutputItem;
    }
  | { type: "response.completed"; sequence_number: number; response: ResponsesResponse }
  | { type: "response.failed"; sequence_number: number; response: ResponsesResponse }
  | {
      type: "error";
      sequence_number: number;
      code: string;
      message: string;
    };

/** Re-export for convenience so translation code has one import site. */
export type { TokenUsage };

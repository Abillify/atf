// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Responses API ⇄ Chat Completions translation
 *
 * Converts the OpenAI Responses API wire shapes (`src/types/responses.ts`) to
 * and from aiperator's internal Chat Completions shapes (`src/types/openai.ts`)
 * so the existing chat pipeline (guardrails, routing, budget, graph execution,
 * finalize) can be reused verbatim for `POST /v1/responses`.
 *
 * No `any` at module boundaries.
 */

import crypto from "node:crypto";
import type {
  ChatMessage,
  ContentBlock,
  OpenAITool,
  ToolChoice,
  ChatCompletionResponse,
  MessageToolCall,
  TokenUsage,
} from "../../types/openai.js";
import type {
  ResponsesRequest,
  ResponsesInputItem,
  ResponsesContentPart,
  ResponsesFunctionTool,
  ResponsesToolChoice,
  ResponsesResponse,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesUsage,
} from "../../types/responses.js";

// ---------------------------------------------------------------------------
// Request translation: Responses → internal chat
// ---------------------------------------------------------------------------

/** Maps a Responses message role onto a Chat Completions role. */
function mapRole(role: string): ChatMessage["role"] {
  switch (role) {
    case "assistant":
      return "assistant";
    case "system":
    case "developer":
      return "system";
    default:
      return "user";
  }
}

/** Normalizes an `image_url`/`file_url` field (string or `{url}`) to a URL. */
function extractUrl(v: string | { url: string } | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.url === "string") return v.url;
  return undefined;
}

/**
 * Converts a Responses content-part array into a Chat Completions message
 * content value. Collapses a single text part to a plain string (the common
 * case) and otherwise emits multimodal content blocks.
 */
function translateContent(
  parts: ResponsesContentPart[],
): string | ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "input_text":
      case "output_text":
        blocks.push({ type: "text", text: part.text });
        break;
      case "input_image": {
        const url = extractUrl(part.image_url);
        if (url !== undefined) {
          blocks.push({ type: "image_url", image_url: { url } });
        }
        break;
      }
      case "input_file": {
        const url = extractUrl(part.file_url);
        if (url !== undefined) {
          blocks.push({ type: "file", file_url: { url } });
        }
        break;
      }
      default:
        break;
    }
  }
  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return blocks[0].text;
  }
  return blocks;
}

/**
 * Translates a Responses API request into the internal Chat Completions message
 * list. `instructions` (when present) is prepended as a system message.
 */
export function translateInputToMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (typeof req.instructions === "string" && req.instructions.trim() !== "") {
    messages.push({ role: "system", content: req.instructions });
  }

  if (typeof req.input === "string") {
    messages.push({ role: "user", content: req.input });
    return messages;
  }

  // Pending assistant tool calls are grouped onto a single assistant message so
  // the downstream conversation round-trips like Chat Completions history.
  let pendingToolCalls: MessageToolCall[] = [];
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }
  };

  for (const item of req.input as ResponsesInputItem[]) {
    if (isFunctionCall(item)) {
      pendingToolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    flushToolCalls();

    if (isFunctionCallOutput(item)) {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      });
      continue;
    }

    // Message item
    const role = mapRole(item.role);
    const content =
      typeof item.content === "string"
        ? item.content
        : translateContent(item.content);
    messages.push({ role, content });
  }
  flushToolCalls();

  return messages;
}

function isFunctionCall(
  item: ResponsesInputItem,
): item is Extract<ResponsesInputItem, { type: "function_call" }> {
  return (item as { type?: string }).type === "function_call";
}

function isFunctionCallOutput(
  item: ResponsesInputItem,
): item is Extract<ResponsesInputItem, { type: "function_call_output" }> {
  return (item as { type?: string }).type === "function_call_output";
}

// ---------------------------------------------------------------------------
// Tools translation: Responses (flat) → Chat Completions (nested)
// ---------------------------------------------------------------------------

/** Translates Responses function tools into Chat Completions `tools[]`. */
export function translateTools(
  tools: ResponsesFunctionTool[] | undefined,
): OpenAITool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const out: OpenAITool[] = [];
  for (const t of tools) {
    if (t.type !== "function" || typeof t.name !== "string") continue;
    out.push({
      type: "function",
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Translates a Responses `tool_choice` into the Chat Completions shape. */
export function translateToolChoice(
  choice: ResponsesToolChoice | undefined,
): ToolChoice | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") return choice;
  if (choice.type === "function" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Response translation: internal chat → Responses `response` object
// ---------------------------------------------------------------------------

/** Converts internal token usage to the Responses input/output naming. */
export function toResponsesUsage(usage: TokenUsage): ResponsesUsage {
  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: usage.completion_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage.total_tokens,
  };
}

/** A fresh Responses object id (`resp_...`). */
export function newResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** A fresh assistant message-item id (`msg_...`). */
export function newMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** A fresh function-call item id (`fc_...`). */
export function newFunctionCallId(): string {
  return `fc_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Builds the immutable descriptive fields of a `response` object from the
 * originating request. Shared by the initial (streaming) skeleton and the final
 * assembled response.
 */
export function baseResponseFields(
  req: ResponsesRequest,
): Pick<
  ResponsesResponse,
  | "instructions"
  | "max_output_tokens"
  | "parallel_tool_calls"
  | "temperature"
  | "top_p"
  | "tool_choice"
  | "tools"
  | "metadata"
> {
  return {
    instructions: req.instructions ?? null,
    max_output_tokens: req.max_output_tokens ?? null,
    parallel_tool_calls: req.parallel_tool_calls ?? true,
    temperature: req.temperature ?? null,
    top_p: req.top_p ?? null,
    tool_choice: req.tool_choice ?? "auto",
    tools: req.tools ?? [],
    metadata:
      req.metadata !== undefined
        ? sanitizeMetadata(req.metadata)
        : {},
  };
}

/** Strips the internal `token`/`variables` keys from echoed metadata. */
function sanitizeMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const { token: _t, variables: _v, ...rest } = metadata;
  void _t;
  void _v;
  return rest;
}

/**
 * Assembles the `output` array (function calls first, then the assistant
 * message) from collected text + tool calls.
 */
export function buildOutputItems(
  text: string,
  toolCalls: MessageToolCall[],
  messageId: string,
): ResponsesOutputItem[] {
  const items: ResponsesOutputItem[] = [];
  for (const tc of toolCalls) {
    items.push({
      type: "function_call",
      id: newFunctionCallId(),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: "completed",
    });
  }
  if (text.length > 0 || toolCalls.length === 0) {
    const message: ResponsesOutputMessage = {
      type: "message",
      id: messageId,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    items.push(message);
  }
  return items;
}

/**
 * Translates a fully-assembled internal `ChatCompletionResponse` into the
 * Responses API `response` object.
 */
export function chatResponseToResponses(
  chat: ChatCompletionResponse,
  req: ResponsesRequest,
  responseId: string,
): ResponsesResponse {
  const choice = chat.choices[0];
  const message = choice?.message;
  const text =
    typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content
            .map((b) =>
              (b as { type?: string; text?: string }).type === "text"
                ? ((b as { text?: string }).text ?? "")
                : "",
            )
            .join("")
        : "";
  const toolCalls = message?.tool_calls ?? [];
  const hadError = choice?.finish_reason === "error";
  const output = buildOutputItems(text, toolCalls, newMessageId());

  return {
    id: responseId,
    object: "response",
    created_at: chat.created,
    status: hadError ? "failed" : "completed",
    model: chat.model,
    output,
    output_text: text,
    error: hadError ? { code: "server_error", message: text || "error" } : null,
    incomplete_details: null,
    ...baseResponseFields(req),
    ...(chat.usage !== undefined
      ? { usage: toResponsesUsage(chat.usage) }
      : {}),
  };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Anthropic Messages API ⇄ internal Chat Completions (ADR 0038, §2).
 *
 * `POST /v1/messages` is a translation layer: the request becomes a Chat
 * Completions request that runs through the unchanged chat pipeline, and the
 * result is turned back into an Anthropic `message`. Pinned to the Messages
 * API as documented for `anthropic-version: 2023-06-01`.
 *
 * Fields the pipeline cannot honour are refused with a 400 that names the
 * field instead of being dropped: a client that believes it set a cache
 * breakpoint or enabled extended thinking, and silently did not, is a worse
 * audit story than a hard error.
 *
 * Pure functions, no I/O.
 */

/** A 400 naming the offending field. */
export class MessagesRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagesRequestError";
  }
}

// ---------------------------------------------------------------------------
// Anthropic shapes (the subset this layer accepts)
// ---------------------------------------------------------------------------

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
};
type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
};
type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string };
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal Chat Completions shapes (what the chat route accepts)
// ---------------------------------------------------------------------------

type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessageOut =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequestOut {
  model: string;
  messages: ChatMessageOut[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: Array<{
    type: "function";
    function: { name: string; description?: string; parameters: Record<string, unknown> };
  }>;
  tool_choice?:
    | "auto"
    | "none"
    | "required"
    | { type: "function"; function: { name: string } };
  stream_options?: { include_usage: boolean };
}

/** Top-level fields the layer knows; everything else is refused. */
const KNOWN_FIELDS = new Set([
  "model",
  "max_tokens",
  "messages",
  "system",
  "stream",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "tools",
  "tool_choice",
  "metadata",
]);

/**
 * Fields of the Messages API this layer deliberately does not support (ADR
 * 0038). Listed so the error can say WHY, not only that a field is unknown.
 */
const UNSUPPORTED_FIELDS: Record<string, string> = {
  thinking: "extended thinking is not supported by this gateway",
  service_tier: "service tiers are not supported by this gateway",
  container: "code-execution containers are not supported by this gateway",
  mcp_servers: "server-side MCP connectors are not supported by this gateway",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(message: string): never {
  throw new MessagesRequestError(message);
}

/** Rejects `cache_control` anywhere in a block (it is never honoured). */
function rejectCacheControl(block: Record<string, unknown>, where: string): void {
  if ("cache_control" in block) {
    refuse(`${where}.cache_control: prompt caching is not supported by this gateway`);
  }
}

function textOf(value: unknown, where: string): string {
  if (typeof value !== "string") refuse(`${where} must be a string`);
  return value;
}

function imageUrl(block: Record<string, unknown>, where: string): string {
  const source = block.source;
  if (!isRecord(source)) refuse(`${where}.source must be an object`);
  if (source.type === "base64") {
    const media = textOf(source.media_type, `${where}.source.media_type`);
    const data = textOf(source.data, `${where}.source.data`);
    return `data:${media};base64,${data}`;
  }
  if (source.type === "url") return textOf(source.url, `${where}.source.url`);
  return refuse(`${where}.source.type must be "base64" or "url"`);
}

function toolResultText(block: Record<string, unknown>, where: string): string {
  const content = block.content;
  let text: string;
  if (content === undefined) text = "";
  else if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((part, i) => {
        if (!isRecord(part)) refuse(`${where}.content[${i}] must be an object`);
        if (part.type === "text") return textOf(part.text, `${where}.content[${i}].text`);
        return refuse(
          `${where}.content[${i}].type "${String(part.type)}" is not supported in a tool_result (text only)`,
        );
      })
      .join("\n");
  } else {
    refuse(`${where}.content must be a string or a list of text blocks`);
  }
  return block.is_error === true ? `Error: ${text}` : text;
}

/** One Anthropic message → one or more Chat Completions messages. */
function translateMessage(message: unknown, index: number): ChatMessageOut[] {
  const where = `messages[${index}]`;
  if (!isRecord(message)) refuse(`${where} must be an object`);
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    refuse(`${where}.role must be "user" or "assistant"`);
  }
  const content = message.content;
  if (typeof content === "string") {
    return role === "user"
      ? [{ role: "user", content }]
      : [{ role: "assistant", content }];
  }
  if (!Array.isArray(content)) refuse(`${where}.content must be a string or a list`);

  if (role === "assistant") {
    let text = "";
    const toolCalls: NonNullable<
      Extract<ChatMessageOut, { role: "assistant" }>["tool_calls"]
    > = [];
    content.forEach((block, i) => {
      const at = `${where}.content[${i}]`;
      if (!isRecord(block)) refuse(`${at} must be an object`);
      rejectCacheControl(block, at);
      if (block.type === "text") text += textOf(block.text, `${at}.text`);
      else if (block.type === "tool_use") {
        toolCalls.push({
          id: textOf(block.id, `${at}.id`),
          type: "function",
          function: {
            name: textOf(block.name, `${at}.name`),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else {
        refuse(`${at}.type "${String(block.type)}" is not supported in an assistant message`);
      }
    });
    return [
      {
        role: "assistant",
        content: text === "" ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    ];
  }

  // A user turn: tool results become `tool` messages (in order, before the
  // user's own text), the rest one user message.
  const out: ChatMessageOut[] = [];
  const parts: ChatPart[] = [];
  content.forEach((block, i) => {
    const at = `${where}.content[${i}]`;
    if (!isRecord(block)) refuse(`${at} must be an object`);
    rejectCacheControl(block, at);
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: textOf(block.text, `${at}.text`) });
        break;
      case "image":
        parts.push({ type: "image_url", image_url: { url: imageUrl(block, at) } });
        break;
      case "tool_result":
        out.push({
          role: "tool",
          tool_call_id: textOf(block.tool_use_id, `${at}.tool_use_id`),
          content: toolResultText(block, at),
        });
        break;
      default:
        refuse(`${at}.type "${String(block.type)}" is not supported in a user message`);
    }
  });
  if (parts.length > 0) {
    const onlyText = parts.every((p) => p.type === "text");
    out.push({
      role: "user",
      content: onlyText
        ? parts.map((p) => (p.type === "text" ? p.text : "")).join("\n")
        : parts,
    });
  }
  return out;
}

/**
 * Validates an Anthropic Messages request and returns the equivalent Chat
 * Completions request. Throws {@link MessagesRequestError} for anything the
 * pipeline cannot honour.
 */
export function translateMessagesRequest(body: unknown): ChatRequestOut {
  if (!isRecord(body)) refuse("the request body must be a JSON object");
  for (const key of Object.keys(body)) {
    const reason = UNSUPPORTED_FIELDS[key];
    if (reason !== undefined) refuse(`${key}: ${reason}`);
    if (!KNOWN_FIELDS.has(key)) refuse(`${key}: unknown field`);
  }
  const model = body.model;
  if (typeof model !== "string" || model === "") refuse("model is required");
  const maxTokens = body.max_tokens;
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens < 1) {
    refuse("max_tokens is required and must be a positive integer");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    refuse("messages must be a non-empty list");
  }
  if (body.top_k !== undefined) {
    refuse("top_k: not supported by the internal pipeline (use temperature or top_p)");
  }
  if (isRecord(body.metadata) && Object.keys(body.metadata).length > 0) {
    refuse("metadata: forwarding request metadata is not supported by this gateway");
  }

  const messages: ChatMessageOut[] = [];
  const system = body.system;
  if (typeof system === "string") {
    if (system !== "") messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .map((block, i) => {
        if (!isRecord(block) || block.type !== "text") {
          refuse(`system[${i}] must be a text block`);
        }
        rejectCacheControl(block, `system[${i}]`);
        return textOf(block.text, `system[${i}].text`);
      })
      .join("\n\n");
    if (text !== "") messages.push({ role: "system", content: text });
  } else if (system !== undefined) {
    refuse("system must be a string or a list of text blocks");
  }
  body.messages.forEach((message, i) => {
    messages.push(...translateMessage(message, i));
  });

  const out: ChatRequestOut = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: body.stream === true,
  };
  if (body.stream === true) out.stream_options = { include_usage: true };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (body.stop_sequences !== undefined) {
    if (
      !Array.isArray(body.stop_sequences) ||
      !body.stop_sequences.every((s) => typeof s === "string")
    ) {
      refuse("stop_sequences must be a list of strings");
    }
    out.stop = body.stop_sequences as string[];
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) refuse("tools must be a list");
    out.tools = body.tools.map((tool, i) => {
      if (!isRecord(tool)) refuse(`tools[${i}] must be an object`);
      rejectCacheControl(tool, `tools[${i}]`);
      if ("type" in tool && tool.type !== "custom") {
        refuse(`tools[${i}].type "${String(tool.type)}": server tools are not supported by this gateway`);
      }
      const schema = tool.input_schema;
      if (!isRecord(schema)) refuse(`tools[${i}].input_schema must be an object`);
      return {
        type: "function" as const,
        function: {
          name: textOf(tool.name, `tools[${i}].name`),
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: schema,
        },
      };
    });
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (!isRecord(choice)) refuse("tool_choice must be an object");
    if (choice.disable_parallel_tool_use !== undefined) {
      refuse("tool_choice.disable_parallel_tool_use is not supported by this gateway");
    }
    switch (choice.type) {
      case "auto":
        out.tool_choice = "auto";
        break;
      case "none":
        out.tool_choice = "none";
        break;
      case "any":
        out.tool_choice = "required";
        break;
      case "tool":
        out.tool_choice = {
          type: "function",
          function: { name: textOf(choice.name, "tool_choice.name") },
        };
        break;
      default:
        refuse('tool_choice.type must be "auto", "any", "tool" or "none"');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Response direction
// ---------------------------------------------------------------------------

export type AnthropicStopReason = "end_turn" | "max_tokens" | "tool_use" | "stop_sequence";

/** Chat Completions `finish_reason` → Anthropic `stop_reason`. */
export function stopReasonFor(finishReason: unknown): AnthropicStopReason {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export function usageFor(usage: unknown): AnthropicUsage {
  const u = isRecord(usage) ? usage : {};
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { input_tokens: n(u.prompt_tokens), output_tokens: n(u.completion_tokens) };
}

/** Parses tool-call arguments; a malformed string becomes `{ _raw }`. */
export function parseToolInput(args: unknown): unknown {
  if (typeof args !== "string" || args.trim() === "") return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

export function newMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * A non-streaming Chat Completions response → an Anthropic `message`.
 * `model` is the name the client asked for (ADR 0038: the client's view of
 * the world is its own model names; traces and receipts carry the real one).
 */
export function chatResponseToMessage(
  chat: unknown,
  requestedModel: string,
): Record<string, unknown> {
  const record = isRecord(chat) ? chat : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(first.message) ? first.message : {};
  const content: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content !== "") {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || !isRecord(call.function)) continue;
      content.push({
        type: "tool_use",
        id: typeof call.id === "string" ? call.id : `toolu_${crypto.randomUUID()}`,
        name: call.function.name,
        input: parseToolInput(call.function.arguments),
      });
    }
  }
  return {
    id: newMessageId(),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReasonFor(first.finish_reason),
    stop_sequence: null,
    usage: usageFor(record.usage),
  };
}

/** HTTP status → Anthropic error type. */
export function errorTypeFor(status: number): string {
  if (status === 400 || status === 413 || status === 422) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 402 || status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status === 503 || status === 529) return "overloaded_error";
  return "api_error";
}

/** Any error body the chat route produced → the Anthropic error envelope. */
export function errorEnvelope(status: number, body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {};
  const err = isRecord(record.error) ? record.error : {};
  const message =
    typeof err.message === "string"
      ? err.message
      : typeof record.message === "string"
        ? record.message
        : `Request failed with status ${status}.`;
  return { type: "error", error: { type: errorTypeFor(status), message } };
}

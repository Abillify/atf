// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Message mapping (`src/graph/message-mapping.ts`)
 *
 * Pure conversion helpers between the three message representations the engine
 * juggles:
 *   - OpenAI `ChatMessage` (the wire format on the inbound request)
 *   - LangChain `BaseMessage` (LangGraph state)
 *   - Vercel AI SDK `ModelMessage` (what `streamText`/`generateObject` consume)
 *
 * Extracted from `graph-engine.ts` so the (large, hot-path) engine file stays
 * focused on orchestration while these stateless, individually-testable
 * transforms live on their own. No `any` at module boundaries.
 *
 * Requirements: 8.1–8.7 (multimodal preservation).
 */

import crypto from "node:crypto";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { ModelMessage, ToolContent } from "ai";
import type { StreamError, ChatMessage } from "../types/openai.js";
import { stripLeakedContextEcho } from "../assistants/context-frame.js";
import { processContentBlocks } from "./content-processor.js";

/** LangChain complex message content part. */
export type LcContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string };
      /** Preserved for AI SDK `file` parts; optional for legacy checkpoints. */
      mediaType?: string;
    };

/**
 * Strips the engine's own rendered UI scaffolding out of assistant text that
 * comes back as conversation history.
 *
 * The streaming path emits tool results as `<details type="tool_calls">…</details>`
 * blocks and the human-in-the-loop approval prompt as an `<iframe>` (see
 * `graph-engine.ts`). Open WebUI persists this assistant text verbatim and
 * replays it as history on the next turn. Left intact, it becomes an in-context
 * "worked example" the model imitates: instead of issuing a real tool call it
 * reproduces a fake approval widget (referencing a UUID that was never
 * registered, so the widget reports the request as no longer available) and a
 * fabricated tool-result block — so the action is reported as done but never
 * reaches the MCP server. Removing these artifacts before the history reaches
 * the model keeps it calling the actual tool.
 *
 * The closing tags can be matched non-greedily without risk of over-eating:
 * the tool-result body is HTML-escaped at emit time, so a literal `</details>`
 * can never appear inside the block.
 */
const TOOL_CALLS_DETAILS_RE =
  /<details\b[^>]*\btype="tool_calls"[^>]*>[\s\S]*?<\/details>/gi;
const IFRAME_RE = /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi;
const SELF_CLOSING_IFRAME_RE = /<iframe\b[^>]*\/>/gi;

export function stripRenderedArtifacts(text: string): string {
  return (
    text
      .replace(TOOL_CALLS_DETAILS_RE, "")
      .replace(IFRAME_RE, "")
      .replace(SELF_CLOSING_IFRAME_RE, "")
      // Collapse the blank lines left behind so the surviving prose stays clean.
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Converts an OpenAI ChatMessage to a LangChain BaseMessage, preserving
 * multimodal content as structured parts (not flattened to text). Invalid
 * content blocks are reported via onContentError and skipped.
 *
 * Assistant turns are sanitised with {@link stripRenderedArtifacts} so the
 * engine's own UI scaffolding (tool-result `<details>` blocks, approval
 * `<iframe>`s) replayed by the client as history is not imitated by the model.
 */
export function chatMessageToBaseMessage(
  msg: ChatMessage,
  onContentError?: (error: StreamError) => void,
): BaseMessage {
  // Plain string content
  if (typeof msg.content === "string") {
    const content =
      msg.role === "assistant"
        ? stripRenderedArtifacts(msg.content)
        : msg.content;
    return buildMessage(msg.role, content, msg);
  }

  // Multimodal content — validate + decode via content-processor
  const { processed, errors } = processContentBlocks(msg.content);
  if (onContentError) {
    for (const err of errors) onContentError(err);
  }

  const parts: LcContentPart[] = [];
  for (const block of processed) {
    if (block.type === "text") {
      const text =
        msg.role === "assistant"
          ? stripRenderedArtifacts(block.text)
          : block.text;
      parts.push({ type: "text", text });
    } else if (block.type === "image") {
      // Preserve the validated MIME type for the provider-bound AI SDK file part.
      parts.push({
        type: "image_url",
        image_url: { url: block.url },
        mediaType: block.mimeType,
      });
    } else if (block.type === "url") {
      parts.push({ type: "text", text: `[url: ${block.url}]` });
    } else if (block.type === "file") {
      // Files are referenced as text for non-vision models
      parts.push({
        type: "text",
        text: `[file: ${block.mimeType} ${block.url}]`,
      });
    }
  }

  // If only text parts, collapse to a plain string for simplicity
  const onlyText = parts.every((p) => p.type === "text");
  if (onlyText) {
    const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return buildMessage(msg.role, text, msg);
  }

  return buildMessage(msg.role, parts, msg);
}

function buildMessage(
  role: ChatMessage["role"],
  content: string | LcContentPart[],
  extra?: {
    tool_call_id?: string;
    name?: string;
    tool_calls?: ChatMessage["tool_calls"];
  },
): BaseMessage {
  switch (role) {
    case "system":
      return new SystemMessage({ content: content as never });
    case "assistant": {
      // Preserve any tool calls the assistant requested so a follow-up turn
      // round-trips the call (assistant tool-call → tool result) and stays
      // provider-valid. OpenAI's `arguments` are a JSON string; LangChain's
      // tool_calls carry a parsed object, so decode here (tolerating
      // malformed JSON by falling back to an empty object).
      const toolCalls = extra?.tool_calls;
      if (toolCalls !== undefined && toolCalls.length > 0) {
        const lcToolCalls: LcToolCall[] = toolCalls.map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(tc.function.arguments || "{}");
            if (parsed !== null && typeof parsed === "object") {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            /* malformed arguments — keep empty object */
          }
          return { id: tc.id, name: tc.function.name, args };
        });
        return new AIMessage({
          content: content as never,
          tool_calls: lcToolCalls,
        });
      }
      return new AIMessage({ content: content as never });
    }
    case "tool":
      return new ToolMessage({
        content: content as never,
        tool_call_id: extra?.tool_call_id ?? "unknown",
        name: extra?.name,
      });
    default:
      return new HumanMessage({ content: content as never });
  }
}

/** LangChain tool-call shape attached to an AIMessage. */
export interface LcToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** AI SDK assistant tool-call content part. */
export interface AiToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown; // ai@6.x (was `args` in ai@4.x)
}

/** AI SDK tool-result content part. */
export interface AiToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown; // ai@6.x (was `result` in ai@4.x)
}

const SAFE_TOOL_ERROR_OUTPUT = Object.freeze({
  isError: true,
  error: Object.freeze({
    name: "ToolExecutionError",
    message: "Tool execution failed.",
  }),
});

/**
 * Replaces untrusted tool-error envelopes before retry prompts or durable
 * conversation history can expose provider payloads, credentials, or private
 * endpoints. Successful outputs retain their original identity and content.
 */
export function sanitizeToolResultOutput(output: unknown): unknown {
  const seen = new Set<object>();
  const containsError = (value: unknown, depth: number): boolean => {
    if (depth > 6 || value === null || value === undefined) return false;
    if (typeof value === "string") {
      try {
        return containsError(JSON.parse(value) as unknown, depth + 1);
      } catch {
        return false;
      }
    }
    if (Array.isArray(value)) {
      return value.some((item) => containsError(item, depth + 1));
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      record.isError === true ||
      record.status === "error" ||
      (typeof record.type === "string" && record.type.startsWith("error-"))
    ) {
      return true;
    }
    return ["output", "result", "content", "value"].some((key) =>
      containsError(record[key], depth + 1),
    );
  };
  return containsError(output, 0) ? SAFE_TOOL_ERROR_OUTPUT : output;
}

/**
 * True when a tool output is (or sanitizes to) the error envelope. Callers
 * must not infer errors from `sanitizeToolResultOutput(x) !== x` alone: an
 * output that was already sanitized upstream is returned by identity, which
 * previously recorded failed calls as `is_error: false` in the debug trace.
 */
export function isToolErrorOutput(output: unknown): boolean {
  return (
    output === SAFE_TOOL_ERROR_OUTPUT ||
    sanitizeToolResultOutput(output) === SAFE_TOOL_ERROR_OUTPUT
  );
}

/**
 * Bounded, operator-only excerpt of the raw failure text inside an MCP error
 * result (first text part, or a string `error`/`message`). Never fed to the
 * model or the client stream; used only for server-side diagnostics so a gate
 * rejection such as "Invalid transaction token: …" is visible in the runtime.
 */
export function toolErrorExcerpt(output: unknown, maxChars = 300): string | undefined {
  const seen = new Set<object>();
  const find = (value: unknown, depth: number): string | undefined => {
    if (depth > 5 || value === null || value === undefined) return undefined;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "object" && parsed !== null) return find(parsed, depth + 1);
      } catch {
        /* plain text */
      }
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = find(item, depth + 1);
        if (text !== undefined) return text;
      }
      return undefined;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["text", "message", "error", "content", "value", "output", "result"]) {
      const text = find(record[key], depth + 1);
      if (text !== undefined) return text;
    }
    return undefined;
  };
  const text = find(output, 0)?.replace(/\s+/gu, " ").trim();
  if (text === undefined || text === "") return undefined;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export function sanitizeToolCallModelMessages(
  messages: ModelMessage[],
  effectiveArgsByCallId?: ReadonlyMap<string, Record<string, unknown>>,
): ModelMessage[] {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    let contentChanged = false;
    const content = message.content.map((rawPart) => {
      const part = rawPart as {
        type?: string;
        toolCallId?: string;
        input?: unknown;
      };
      if (part.type !== "tool-call") return rawPart;
      const safeInput =
        part.toolCallId === undefined
          ? {}
          : (effectiveArgsByCallId?.get(part.toolCallId) ?? {});
      if (part.input === safeInput) return rawPart;
      contentChanged = true;
      return { ...part, input: safeInput };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? sanitized : messages;
}

/**
 * Model-facing replacement for a sanitized tool-result part. `ModelMessage`
 * tool-result parts require an AI SDK `ToolResultOutput` (`{ type, value }`);
 * the bare {@link SAFE_TOOL_ERROR_OUTPUT} envelope fails the SDK's prompt
 * schema (`output.type` discriminator) and aborts the whole step with
 * `AI_InvalidPromptError` — observed as an empty answer after a failed tool.
 */
const SAFE_TOOL_ERROR_MODEL_OUTPUT = Object.freeze({
  type: "error-json" as const,
  value: SAFE_TOOL_ERROR_OUTPUT,
});

/** Sanitizes tool-result parts before any model step or prompt trace sees them. */
export function sanitizeToolResultModelMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  let changed = false;
  const sanitized = messages.map((message) => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    let contentChanged = false;
    const content = message.content.map((rawPart) => {
      const part = rawPart as { type?: string; output?: unknown };
      if (part.type !== "tool-result") return rawPart;
      // Already-sanitized parts are idempotent: prepareStep runs on every
      // step and must not rewrap (or re-allocate) the replacement.
      if (part.output === SAFE_TOOL_ERROR_MODEL_OUTPUT) return rawPart;
      const output = sanitizeToolResultOutput(part.output);
      if (output === part.output) return rawPart;
      contentChanged = true;
      return { ...part, output: SAFE_TOOL_ERROR_MODEL_OUTPUT };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content } as ModelMessage;
  });
  return changed ? sanitized : messages;
}

export type AiToolResultOutput =
  | { type: "text"; value: string }
  | { type: "error-text"; value: string }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | {
            type: "file";
            data: { type: "data"; data: string };
            mediaType: string;
          }
      >;
    };

const MAX_MCP_IMAGE_BYTES = 20 * 1024 * 1024;
const MCP_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Convert MCP text/image content into provider-neutral AI SDK tool output. */
export function mcpToolResultToModelOutput(content: unknown): AiToolResultOutput {
  if (!Array.isArray(content)) {
    return {
      type: "text",
      value:
        typeof content === "string"
          ? content
          : JSON.stringify(content) ?? String(content),
    };
  }
  const value: Array<
    | { type: "text"; text: string }
    | { type: "file"; data: { type: "data"; data: string }; mediaType: string }
  > = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      value.push({ type: "text", text: item.text });
      continue;
    }
    if (item.type === "image") {
      const mediaType = typeof item.mimeType === "string" ? item.mimeType : "";
      const data = typeof item.data === "string" ? item.data : "";
      const normalized = data.replace(/\s+/g, "");
      const validBase64 =
        normalized.length > 0 &&
        normalized.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(normalized);
      const decodedBytes = validBase64
        ? Buffer.byteLength(normalized, "base64")
        : Number.POSITIVE_INFINITY;
      if (
        !MCP_IMAGE_MEDIA_TYPES.has(mediaType) ||
        !validBase64 ||
        decodedBytes > MAX_MCP_IMAGE_BYTES
      ) {
        return {
          type: "error-text",
          value: "MCP image content was rejected because its MIME type, base64 payload, or decoded size is invalid.",
        };
      }
      value.push({
        type: "file",
        data: { type: "data", data: normalized },
        mediaType,
      });
    }
  }
  if (value.some((part) => part.type === "file")) {
    return { type: "content", value };
  }
  const text = value
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return { type: "text", value: text || JSON.stringify(content) };
}

/** True when provider-bound messages contain a real image/file input. */
export function modelMessagesContainImages(messages: readonly ModelMessage[]): boolean {
  const containsImagePart = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    return value.some((raw) => {
      if (raw === null || typeof raw !== "object") return false;
      const part = raw as Record<string, unknown>;
      if (part.type === "image") return true;
      if (part.type === "file" && typeof part.mediaType === "string") {
        return (
          part.mediaType === "image" || part.mediaType.startsWith("image/")
        );
      }
      if (part.type === "tool-result") {
        const output = part.output;
        if (output !== null && typeof output === "object") {
          return containsImagePart((output as Record<string, unknown>).value);
        }
      }
      return false;
    });
  };
  return messages.some((message) => containsImagePart(message.content));
}

/**
 * Validates tool call/result pairing and filters orphaned messages.
 *
 * AWS Bedrock (and other providers) require that:
 * 1. Every tool result message has a corresponding tool call in a prior assistant message
 * 2. Every tool call in an assistant message has a corresponding tool result message
 *
 * If either side of the pair is missing, the provider will reject the request with
 * a validation error (e.g., "Expected toolResult blocks at messages.0.content").
 *
 * This function:
 * 1. Tracks all tool call IDs from assistant messages
 * 2. Tracks all tool result IDs from tool messages
 * 3. Filters out tool messages without matching calls
 * 4. Filters out tool calls without matching results from AI messages
 * 5. Returns the cleaned message list safe for provider APIs
 *
 * Special case: If there are no AI messages with tool calls at all, we assume
 * this is a unit test or edge case and pass through the messages unchanged to
 * preserve backwards compatibility with existing test cases.
 *
 * @param messages - The raw message list (may contain orphaned tool calls/results)
 * @returns Filtered message list with only complete tool call/result pairs
 */
function filterOrphanedToolResults(messages: BaseMessage[]): BaseMessage[] {
  // First pass: collect all tool call IDs and tool result IDs
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  let hasAnyToolCalls = false;

  for (const m of messages) {
    const type = m._getType();
    if (type === "ai") {
      const toolCalls = (m as { tool_calls?: Array<{ id?: string }> })
        .tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        hasAnyToolCalls = true;
        for (const tc of toolCalls) {
          if (tc.id) {
            toolCallIds.add(tc.id);
          }
        }
      }
    } else if (type === "tool") {
      const toolCallId = (m as { tool_call_id?: string }).tool_call_id;
      if (toolCallId) {
        toolResultIds.add(toolCallId);
      }
    }
  }

  // Special case: if there are NO tool-related messages at all (no tool calls
  // AND no tool results), pass through unchanged. This preserves backwards
  // compatibility with unit tests that don't use tools at all.
  if (!hasAnyToolCalls && toolResultIds.size === 0) {
    return messages;
  }

  // Find which IDs have complete pairs (both call and result)
  const validPairIds = new Set<string>();
  for (const id of toolCallIds) {
    if (toolResultIds.has(id)) {
      validPairIds.add(id);
    }
  }

  // Second pass: filter messages to keep only complete pairs
  return messages
    .map((m) => {
      const type = m._getType();

      // Filter tool messages: keep only those with matching calls
      if (type === "tool") {
        const toolCallId = (m as { tool_call_id?: string }).tool_call_id;
        return toolCallId && validPairIds.has(toolCallId) ? m : null;
      }

      // Filter tool calls from AI messages: keep only those with matching results
      if (type === "ai") {
        const toolCalls = (m as { tool_calls?: Array<{ id?: string }> })
          .tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          const validToolCalls = toolCalls.filter(
            (tc) => tc.id && validPairIds.has(tc.id),
          );

          // If all tool calls were filtered out, return the message without tool_calls.
          // IMPORTANT: when the assistant had no text preamble (content is ""), dropping
          // all tool calls would produce AIMessage({ content: "" }). The AI SDK translates
          // that to `content: []` in the Anthropic API payload, which Anthropic hard-rejects
          // with "The content field … is empty". Drop the whole message in that case —
          // the corresponding tool messages were also filtered (orphaned), so the history
          // stays structurally consistent.
          if (validToolCalls.length === 0) {
            const content = m.content;
            const textContent =
              typeof content === "string" ? content.trim() : "";
            if (textContent === "") return null;
            return new AIMessage({ content: content as never });
          }

          // If some tool calls remain, update the message
          if (validToolCalls.length !== toolCalls.length) {
            const content = m.content;
            return new AIMessage({
              content: content as never,
              tool_calls: validToolCalls.map((tc) => ({
                id: tc.id,
                name: (tc as { name?: string }).name ?? "unknown",
                args: (tc as { args?: Record<string, unknown> }).args ?? {},
              })),
            });
          }
        }
      }

      // Keep all other messages unchanged
      return m;
    })
    .filter((m): m is BaseMessage => m !== null);
}

/**
 * Converts LangChain BaseMessages to AI SDK ModelMessages.
 *
 * Preserves the assistant/tool pairing: an AIMessage that carries `tool_calls`
 * becomes an assistant message with `tool-call` parts, and a ToolMessage becomes
 * a `tool` role message with a matching `tool-result` part. This keeps the
 * message history provider-valid across multiple LLM nodes (the AI SDK rejects a
 * `tool` role that is not preceded by a matching assistant tool-call), so an
 * agent's tool reasoning survives across turns rather than being flattened to
 * anonymous user text. Multimodal parts are mapped so vision models still
 * receive actual images (Req 8.1, 8.4).
 *
 * IMPORTANT: This function also filters out orphaned tool call/result messages
 * to prevent validation errors from providers like AWS Bedrock. Bedrock requires:
 * 1. Every tool-call must have a corresponding tool-result
 * 2. Every tool-result must have a corresponding tool-call
 * 3. The conversation must not start with an assistant message containing tool-calls
 */
/**
 * Sanitises a tool name to the provider-accepted grammar `[A-Za-z0-9_-]+`.
 * Some providers (AWS Bedrock) reject any other character, so a stray
 * `server/tool` ref (with `/`) — whether replayed from an older conversation or
 * emitted by a confused model — would fail the whole request. Applied to a
 * tool-call and its matching tool-result alike; pairing is by `toolCallId`, so
 * renaming the display name is safe.
 */
function sanitizeProviderToolName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s.length > 0 ? s : "tool";
}

export function baseMessagesToModelMessages(
  messages: BaseMessage[],
): ModelMessage[] {
  // Filter orphaned tool calls/results before conversion
  const validMessages = filterOrphanedToolResults(messages);

  const result: ModelMessage[] = [];
  for (const m of validMessages) {
    const type = m._getType();
    const content = m.content;

    // Assistant message carrying structured tool calls → preserve them.
    if (type === "ai") {
      const toolCalls = (m as { tool_calls?: LcToolCall[] }).tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        const parts: Array<{ type: "text"; text: string } | AiToolCallPart> =
          [];
        const text = typeof content === "string" ? content : "";
        if (text.length > 0) parts.push({ type: "text", text });
        for (const tc of toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id ?? crypto.randomUUID(),
            toolName: sanitizeProviderToolName(tc.name),
            // Historical tool arguments may contain pre-DLP model output.
            // Pairing only requires id/name; never replay raw arguments.
            input: {},
          });
        }
        result.push({
          role: "assistant",
          content: parts,
        } as unknown as ModelMessage);
        continue;
      }
    }

    // Tool result message → matching `tool` role message.
    if (type === "tool") {
      const toolCallId =
        (m as { tool_call_id?: string }).tool_call_id ?? "unknown";
      const toolName = sanitizeProviderToolName(
        (m as { name?: string }).name ?? "unknown",
      );

      // Check if content is already an array (from MCP protocol)
      if (Array.isArray(content)) {
        // MCP protocol returns content as an array of content items
        // Each item has a type (text, image, resource, etc.) and content
        // Check if it's already in AI SDK tool-result format
        const hasToolResultType = content.every(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            (item.type === "tool-result" ||
              item.type === "tool-approval-response"),
        );

        if (hasToolResultType) {
          // Already in AI SDK format
          result.push({
            role: "tool",
            content: content as ToolContent,
          } as ModelMessage);
          continue;
        }

        const part: AiToolResultPart = {
          type: "tool-result",
          toolCallId,
          toolName,
          output: mcpToolResultToModelOutput(content),
        };
        result.push({
          role: "tool",
          content: [part],
        } as unknown as ModelMessage);
        continue;
      }

      // String content - handle the legacy path
      const raw =
        typeof content === "string" ? content : JSON.stringify(content);

      let parsedParts: unknown[] | undefined;
      let parsedMcpContent: unknown[] | undefined;
      try {
        const parsed = JSON.parse(raw);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (p) =>
              p !== null &&
              typeof p === "object" &&
              (p.type === "tool-result" || p.type === "tool-approval-response"),
          )
        ) {
          parsedParts = parsed;
        } else if (
          Array.isArray(parsed) &&
          parsed.some(
            (p) => p !== null && typeof p === "object" && p.type === "image",
          )
        ) {
          parsedMcpContent = parsed;
        }
      } catch {
        // Not a JSON array of tool result/approval or MCP content parts
      }

      if (parsedParts !== undefined) {
        result.push({
          role: "tool",
          content: parsedParts as ToolContent,
        } as ModelMessage);
        continue;
      }

      const part: AiToolResultPart = {
        type: "tool-result",
        toolCallId,
        toolName,
        output:
          parsedMcpContent !== undefined
            ? mcpToolResultToModelOutput(parsedMcpContent)
            : { type: "text", value: raw },
      };
      result.push({ role: "tool", content: [part] } as unknown as ModelMessage);
      continue;
    }

    const role =
      type === "ai" ? "assistant" : type === "system" ? "system" : "user";

    if (typeof content === "string") {
      // Guard: Anthropic rejects assistant messages with empty content (translates
      // to content:[]), so skip them. A non-assistant empty string is kept (e.g. a
      // user message with no text is unusual but not API-breaking).
      if (role === "assistant" && content === "") continue;
      result.push({ role, content } as ModelMessage);
      continue;
    }

    // Complex content array → AI SDK parts
    if (Array.isArray(content)) {
      const parts: Array<
        | { type: "text"; text: string }
        | { type: "file"; data: URL; mediaType: string }
      > = [];
      for (const part of content as LcContentPart[]) {
        if (part.type === "text") {
          parts.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          const data = part.image_url.url;
          const mediaType =
            part.mediaType ??
            /^data:(image\/[^;,]+)[;,]/i.exec(data)?.[1]?.toLowerCase() ??
            "image";
          parts.push({ type: "file", data: new URL(data), mediaType });
        }
      }
      // User messages support file parts; others get text only.
      if (role === "user") {
        result.push({ role: "user", content: parts });
      } else {
        const text = parts
          .map((p) => (p.type === "text" ? p.text : "[image]"))
          .join("\n");
        result.push({ role, content: text } as ModelMessage);
      }
      continue;
    }

    result.push({ role, content: String(content) } as ModelMessage);
  }

  return sanitizeToolResultModelMessages(result);
}

/**
 * Sentinel prefix that {@link injectReasoningToContent} (llm-factory) prepends
 * to every native-reasoning delta it rewrites into the OpenAI-compatible
 * `content` stream (LM Studio surfaces hidden reasoning via `reasoning`/
 * `reasoning_content`, which the AI SDK would otherwise ignore). The streaming
 * handler ({@link "./handlers/llm.js"}) recognises the sentinel and routes the
 * delta to the reasoning channel instead of the answer.
 *
 * The catch: the AI SDK ALSO concatenates those `content` deltas into the
 * assistant message it accumulates in `result.response.messages` — so the
 * persisted/replayed assistant content carries the model's chain-of-thought
 * PLUS raw NUL bytes (one `\x00r` per delta). Left intact this (a) is re-fed to
 * the model on later tool-loop steps and carried into downstream nodes, driving
 * degenerate repetition / empty-response failures with local thinking models,
 * and (b) corrupts any consumer that mishandles NUL bytes. The helpers below
 * strip it back out at the conversion + replay boundaries.
 */
export const REASONING_SENTINEL = "\x00r";

/** Removes all reasoning-sentinel markers from a text run (NUL-byte safe). */
export function stripReasoningSentinelMarkers(text: string): string {
  return text.includes(REASONING_SENTINEL)
    ? text.split(REASONING_SENTINEL).join("")
    : text;
}

/**
 * Strips the reasoning-sentinel pollution (see {@link REASONING_SENTINEL}) from
 * the assistant messages of a ModelMessage[] that the AI SDK replays to the
 * model across multi-step tool loops (via `prepareStep`). Reasoning that
 * preceded a tool call is dropped entirely (chain-of-thought is ephemeral and
 * must not be re-fed); a sentinel that survived into a plain answer turn has
 * only its NUL markers removed. Non-assistant messages and content without the
 * sentinel are returned untouched — a cheap no-op for native-reasoning models
 * and non-thinking models. Returns the SAME array reference when nothing
 * changed so callers can cheaply detect a no-op.
 */
export function sanitizeReasoningSentinelModelMessages(
  messages: ModelMessage[],
): ModelMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "assistant") return m;
    const content = m.content;
    if (typeof content === "string") {
      if (!content.includes(REASONING_SENTINEL)) return m;
      changed = true;
      return { ...m, content: stripReasoningSentinelMarkers(content) };
    }
    if (!Array.isArray(content)) return m;
    const hasToolCall = content.some(
      (p) => (p as { type?: string }).type === "tool-call",
    );
    let touched = false;
    const parts: unknown[] = [];
    for (const rawPart of content) {
      const part = rawPart as { type?: string; text?: string };
      if (
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes(REASONING_SENTINEL)
      ) {
        touched = true;
        // Reasoning before a tool call → drop the whole text part; otherwise
        // (answer turn) keep the visible answer minus the NUL markers.
        if (hasToolCall) continue;
        parts.push({ ...part, text: stripReasoningSentinelMarkers(part.text) });
        continue;
      }
      parts.push(rawPart);
    }
    if (!touched) return m;
    changed = true;
    return { ...m, content: parts } as ModelMessage;
  });
  return changed ? out : messages;
}

/**
 * Converts the AI SDK's structured response messages (assistant + tool messages
 * produced during a streamText agent loop) into LangChain BaseMessages,
 * preserving tool-call IDs, names and arguments so the history round-trips
 * faithfully on the next node. Returns undefined if nothing usable is present.
 *
 * Reasoning-sentinel pollution (see {@link REASONING_SENTINEL}) is stripped
 * here — the single boundary where AI SDK response messages become engine
 * BaseMessages — so neither the node's returned messages nor anything derived
 * from them (carryForward findings, downstream prompts, persisted history) ever
 * carries the model's chain-of-thought or raw NUL bytes.
 */
export function aiResponseMessagesToBaseMessages(
  raw: unknown[],
): BaseMessage[] | undefined {
  const out: BaseMessage[] = [];
  for (const entry of raw) {
    const msg = entry as { role?: string; content?: unknown };
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push(
          new AIMessage(
            stripLeakedContextEcho(
              stripReasoningSentinelMarkers(msg.content),
            ),
          ),
        );
        continue;
      }
      if (!Array.isArray(msg.content)) continue;
      let text = "";
      const toolCalls: LcToolCall[] = [];
      for (const rawPart of msg.content) {
        const part = rawPart as { type?: string };
        if (part.type === "text") {
          text += (rawPart as { text?: string }).text ?? "";
        } else if (part.type === "tool-call") {
          const tc = rawPart as AiToolCallPart;
          toolCalls.push({
            id: tc.toolCallId,
            name: tc.toolName,
            // Provider response messages contain the model's pre-DLP input.
            // Persist only the call identity; effective args are execution-local.
            args: {},
          });
        }
      }
      // Drop the reasoning the LM Studio shim rewrote into content: on a
      // tool-call turn the sentinel text is pre-tool chain-of-thought (drop it
      // whole, keep the tool call); on a plain answer turn strip the NUL markers
      // but keep the visible answer.
      if (text.includes(REASONING_SENTINEL)) {
        text = toolCalls.length > 0 ? "" : stripReasoningSentinelMarkers(text);
      }
      text = stripLeakedContextEcho(text);
      out.push(
        toolCalls.length > 0
          ? new AIMessage({ content: text, tool_calls: toolCalls })
          : new AIMessage(text),
      );
    } else if (msg.role === "tool") {
      const parts = Array.isArray(msg.content) ? msg.content : [];
      for (const rawPart of parts) {
        const part = rawPart as { type?: string };
        if (part.type === "tool-result") {
          const tr = rawPart as AiToolResultPart;
          const sanitizedOutput = sanitizeToolResultOutput(tr.output);
          // ai@6.x ToolResultOutput: { type: "text"|"json", value: string|JSONValue }
          const rawOutput = sanitizedOutput as
            | { type?: string; value?: unknown }
            | undefined;
          const content =
            rawOutput?.type === "text" && typeof rawOutput.value === "string"
              ? rawOutput.value
              : rawOutput?.type === "json"
                ? JSON.stringify(rawOutput.value)
                : JSON.stringify(sanitizedOutput);
          out.push(
            new ToolMessage({
              content,
              tool_call_id: tr.toolCallId,
              name: tr.toolName,
            }),
          );
        }
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Marks system message(s) AND the last user message before the final turn with
 * ephemeral `cache_control` breakpoints. Anthropic supports up to 4 cache
 * breakpoints per request. By placing breakpoints on:
 *   1. The system message (stable across turns — system prompt + tools).
 *   2. The penultimate user message (conversation history prefix that is
 *      identical when a user sends a follow-up within the same session).
 *
 * This maximises prompt-cache hit rate in multi-turn conversations: the system
 * prefix AND the accumulated history are both cached, so only the new turn's
 * messages (latest RAG context + user query) are billed as fresh input tokens.
 *
 * Returns the messages unchanged when there is no system message.
 * Pure — produces a shallow copy, never mutates.
 */
export function applyAnthropicPromptCache(
  messages: ModelMessage[],
): ModelMessage[] {
  if (messages.length === 0) return messages;

  // Find indices to mark with cache breakpoints.
  const breakpoints = new Set<number>();

  // Breakpoint 1: system message(s).
  for (const [i, m] of messages.entries()) {
    if (m.role === "system") {
      breakpoints.add(i);
      break; // Only mark the first (merged) system message.
    }
  }

  // Breakpoint 2: the last user message BEFORE the final user message.
  // This caches the conversation history up to (but not including) the
  // current turn, so follow-up turns hit the cache for the shared prefix.
  if (messages.length > 2) {
    let lastUserIdx = -1;
    let penultimateUserIdx = -1;
    for (const [i, m] of [...messages.entries()].reverse()) {
      if (m.role === "user") {
        if (lastUserIdx === -1) {
          lastUserIdx = i;
        } else {
          penultimateUserIdx = i;
          break;
        }
      }
    }
    if (penultimateUserIdx >= 0) {
      // Mark the message just BEFORE the final user turn as the cache boundary.
      // This ensures the entire prefix up to the last turn is cached.
      const boundaryIdx = lastUserIdx - 1;
      if (boundaryIdx > 0 && !breakpoints.has(boundaryIdx)) {
        breakpoints.add(boundaryIdx);
      }
    }
  }

  if (breakpoints.size === 0) return messages;

  return messages.map((m, i) => {
    if (!breakpoints.has(i)) return m;
    const existing = (m as { providerOptions?: Record<string, unknown> })
      .providerOptions;
    return {
      ...m,
      providerOptions: {
        ...existing,
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    } as ModelMessage;
  });
}

/**
 * Bedrock equivalent of {@link applyAnthropicPromptCache}. Places cache
 * breakpoints on the system message AND the conversation history boundary
 * (the message just before the final user turn). The AWS Bedrock Converse
 * provider reads cache breakpoints from `providerOptions.bedrock.cachePoint`.
 *
 * `ttl` selects the cache lifetime: "5m" (default) or "1h" (only Claude
 * Opus 4.5, Haiku 4.5 and Sonnet 4.5 support the 1-hour TTL).
 */
export function applyBedrockPromptCache(
  messages: ModelMessage[],
  ttl: "5m" | "1h" = "5m",
): ModelMessage[] {
  if (messages.length === 0) return messages;

  // Find indices to mark with cache breakpoints.
  const breakpoints = new Set<number>();

  // Breakpoint 1: system message.
  for (const [i, m] of messages.entries()) {
    if (m.role === "system") {
      breakpoints.add(i);
      break;
    }
  }

  // Breakpoint 2: conversation history boundary — the message just before
  // the final user turn (same logic as the Anthropic variant).
  if (messages.length > 2) {
    let lastUserIdx = -1;
    let penultimateUserIdx = -1;
    for (const [i, m] of [...messages.entries()].reverse()) {
      if (m.role === "user") {
        if (lastUserIdx === -1) {
          lastUserIdx = i;
        } else {
          penultimateUserIdx = i;
          break;
        }
      }
    }
    if (penultimateUserIdx >= 0) {
      const boundaryIdx = lastUserIdx - 1;
      if (boundaryIdx > 0 && !breakpoints.has(boundaryIdx)) {
        breakpoints.add(boundaryIdx);
      }
    }
  }

  if (breakpoints.size === 0) return messages;

  return messages.map((m, i) => {
    if (!breakpoints.has(i)) return m;
    const existing = (m as { providerOptions?: Record<string, unknown> })
      .providerOptions;
    return {
      ...m,
      providerOptions: {
        ...existing,
        bedrock: { cachePoint: { type: "default", ttl } },
      },
    } as ModelMessage;
  });
}

/**
 * Flattens AI SDK ModelMessages to a single text string for semantic-cache
 * embedding. Only textual content contributes; image/structured parts are
 * summarised so they still differentiate the key without bloating the embed.
 */
export function coreMessagesToText(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      lines.push(`${m.role}: ${content}`);
      continue;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const rawPart of content) {
        const part = rawPart as {
          type?: string;
          text?: string;
          mediaType?: string;
        };
        if (part.type === "text" && typeof part.text === "string") {
          parts.push(part.text);
        } else if (
          part.type === "file" &&
          (part.mediaType === "image" ||
            part.mediaType?.startsWith("image/"))
        ) {
          parts.push("[image]");
        } else if (part.type !== undefined) {
          parts.push(`[${part.type}]`);
        }
      }
      lines.push(`${m.role}: ${parts.join(" ")}`);
    }
  }
  return lines.join("\n");
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Chat Completions SSE → Anthropic Messages SSE (ADR 0038, §2).
 *
 * Reads the stream the unchanged chat pipeline produces and emits the
 * Anthropic event sequence:
 *
 *   message_start → (content_block_start → content_block_delta* →
 *   content_block_stop)* → message_delta → message_stop
 *
 * with `ping` after `message_start`. Text deltas open a `text` block, tool
 * call deltas a `tool_use` block whose arguments stream as
 * `input_json_delta`. An error frame of the chat stream becomes an Anthropic
 * `error` event and ends the stream. Reasoning deltas and other
 * non-standard fields are dropped: extended thinking is not part of this API
 * surface (requests asking for it are refused up front).
 */

import {
  newMessageId,
  stopReasonFor,
  usageFor,
  type AnthropicUsage,
} from "./translate.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

/** Stateful converter; feed it chat SSE text, collect Anthropic SSE text. */
export class MessagesStreamTranslator {
  private buffer = "";
  private started = false;
  private finished = false;
  /** Index and kind of the open content block, if any. */
  private open: { index: number; kind: "text" | "tool"; toolIndex?: number } | undefined;
  private nextIndex = 0;
  private finishReason: unknown;
  private usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  private readonly messageId = newMessageId();

  constructor(private readonly requestedModel: string) {}

  /** Feeds raw SSE text; returns the Anthropic SSE text that is ready. */
  push(text: string): string {
    this.buffer += text;
    let out = "";
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end === -1) break;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      out += this.handleEvent(raw);
      if (this.finished) break;
    }
    return out;
  }

  /** Closes the message at the end of the upstream stream. */
  end(): string {
    let out = "";
    if (this.buffer.trim() !== "" && !this.finished) {
      out += this.handleEvent(this.buffer);
      this.buffer = "";
    }
    return out + this.finish();
  }

  /** An error before or during the stream (e.g. a transport failure). */
  fail(message: string, type = "api_error"): string {
    if (this.finished) return "";
    this.finished = true;
    return this.start() + frame("error", { error: { type, message } });
  }

  private start(): string {
    if (this.started) return "";
    this.started = true;
    return (
      frame("message_start", {
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.requestedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }) + frame("ping", {})
    );
  }

  private closeBlock(): string {
    if (this.open === undefined) return "";
    const index = this.open.index;
    this.open = undefined;
    return frame("content_block_stop", { index });
  }

  private finish(): string {
    if (this.finished) return "";
    this.finished = true;
    return (
      this.start() +
      this.closeBlock() +
      frame("message_delta", {
        delta: { stop_reason: stopReasonFor(this.finishReason), stop_sequence: null },
        usage: this.usage,
      }) +
      frame("message_stop", {})
    );
  }

  private handleEvent(raw: string): string {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return "";
    const data = dataLines.join("\n");
    if (data === "[DONE]") return this.finish();
    // Opt-in harness progress and any other named side channel.
    if (event !== "message") return "";
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return "";
    }
    if (!isRecord(chunk)) return "";
    if (isRecord(chunk.error)) {
      const message =
        typeof chunk.error.message === "string" ? chunk.error.message : "Execution failed.";
      return this.fail(message);
    }
    let out = this.start();
    if (chunk.usage !== undefined) this.usage = usageFor(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) return out;
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.finishReason = choice.finish_reason;
    }
    const delta = isRecord(choice.delta) ? choice.delta : {};

    if (typeof delta.content === "string" && delta.content !== "") {
      if (this.open?.kind !== "text") {
        out += this.closeBlock();
        this.open = { index: this.nextIndex++, kind: "text" };
        out += frame("content_block_start", {
          index: this.open.index,
          content_block: { type: "text", text: "" },
        });
      }
      out += frame("content_block_delta", {
        index: this.open.index,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : {};
        const toolIndex = typeof call.index === "number" ? call.index : undefined;
        const startsNew =
          typeof call.id === "string" ||
          this.open?.kind !== "tool" ||
          (toolIndex !== undefined && toolIndex !== this.open.toolIndex);
        if (startsNew) {
          out += this.closeBlock();
          this.open = {
            index: this.nextIndex++,
            kind: "tool",
            ...(toolIndex !== undefined ? { toolIndex } : {}),
          };
          out += frame("content_block_start", {
            index: this.open.index,
            content_block: {
              type: "tool_use",
              id: typeof call.id === "string" ? call.id : `toolu_${crypto.randomUUID()}`,
              name: typeof fn.name === "string" ? fn.name : "",
              input: {},
            },
          });
        }
        if (typeof fn.arguments === "string" && fn.arguments !== "" && this.open !== undefined) {
          out += frame("content_block_delta", {
            index: this.open.index,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          });
        }
      }
    }
    return out;
  }
}

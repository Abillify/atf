// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * SSE Streamer — converts Graph Engine events into OpenAI-compatible SSE chunks
 * and writes them to the HTTP response stream.
 *
 * Supports SSE `id:` sequence numbers for `Last-Event-ID` based mid-stream
 * resume: when a `StreamBuffer` is passed at construction, every frame is
 * recorded into the buffer and prefixed with `id: <seqId>\n`.
 *
 */

import type { ToolCallChunk, Citation, StreamError } from "../types/openai.js";
import type { StreamBuffer } from "./stream-replay-buffer.js";

// ---------------------------------------------------------------------------
// Writer interface
// ---------------------------------------------------------------------------

/**
 * Minimal writer abstraction over Hono's SSE stream writer.
 * Using this interface instead of Hono's concrete type makes the streamer
 * easy to test with a plain mock.
 */
export interface SSEWriter {
  write(data: string): Promise<void>;
  flush?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ToolResultChunk
// ---------------------------------------------------------------------------

/**
 * Represents a completed tool invocation result sent as an SSE chunk.
 * `execution_time_seconds` MUST be rounded to 3 decimal places before use.
 */
export interface ToolResultChunk {
  /** Matches the `id` of the originating ToolCallChunk */
  tool_call_id: string;
  /** Arbitrary result payload from the MCP server */
  content: unknown;
  /**
   * Wall-clock execution time in seconds.
   * Rounded to 3 decimal places via `Math.round(t * 1000) / 1000`.
   */
  execution_time_seconds: number;
}

// ---------------------------------------------------------------------------
// SSE line-length limit
// ---------------------------------------------------------------------------

/**
 * Max characters of `content` per emitted SSE frame.
 *
 * aiohttp-based clients (Open WebUI) read the SSE stream line by line with a
 * hard 131072-byte (128 KiB) per-line cap; a single `data:` line above it
 * aborts the read with "Got more than 131072 bytes when reading". A generated
 * image arrives as a base64 data-URI that easily exceeds this when emitted in
 * one delta — e.g. a cache hit replaying a stored response, or any upstream
 * path that hands `sendToken` the whole payload at once.
 *
 * Splitting the content into <=60 000-char frames keeps each line (base64 is
 * 1 byte/char) around 60 KB after JSON framing, leaving generous headroom for
 * escaping/UTF-8 overhead. The client concatenates `delta.content` fragments,
 * so the reassembled message is identical. Matches the live media-streaming
 * chunk size (MEDIA_SSE_CHUNK_SIZE in agent-tools.ts).
 */
const MAX_CONTENT_CHARS_PER_FRAME = 60_000;

// ---------------------------------------------------------------------------
// SSEStreamer class
// ---------------------------------------------------------------------------

/**
 * Writes OpenAI-compatible SSE chunks to an SSEWriter.
 *
 * Design invariants:
 * - No internal buffering — every chunk is flushed immediately after writing.
 * - All methods are async and resolve only after the flush completes.
 * - `sendDone()` writes the literal string `data: [DONE]\n\n` (not JSON).
 */
export class SSEStreamer {
  private readonly writer: SSEWriter;
  private readonly buffer: StreamBuffer | undefined;

  constructor(writer: SSEWriter, buffer?: StreamBuffer) {
    this.writer = writer;
    this.buffer = buffer;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Write a raw SSE frame and flush immediately.
   * When a StreamBuffer is attached, the frame is recorded and prefixed with
   * an `id: <seqId>` line so clients can resume with `Last-Event-ID`.
   */
  private async writeRaw(raw: string): Promise<void> {
    let frame = raw;
    if (this.buffer !== undefined) {
      const seqId = this.buffer.record(raw);
      frame = `id: ${seqId}\n${raw}`;
    }
    await this.writer.write(frame);
    if (this.writer.flush) {
      await this.writer.flush();
    }
  }

  /**
   * Serialize `payload` to JSON, wrap in `data: ...\n\n`, then flush.
   */
  private async writeChunk(payload: unknown): Promise<void> {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    await this.writeRaw(frame);
  }

  // -------------------------------------------------------------------------
  // Public API — Requirements 6.1 – 6.6
  // -------------------------------------------------------------------------

  /**
   * Send a single LLM token as a streaming delta chunk.
   *
   * Format:
   * data: {"id":"<id>","object":"chat.completion.chunk","choices":[{"delta":{"content":"<token>"},"index":0}]}\n\n
   */
  async sendToken(id: string, model: string, content: string): Promise<void> {
    // Fast path: a normal token fits in a single frame.
    if (content.length <= MAX_CONTENT_CHARS_PER_FRAME) {
      await this.writeChunk(this.tokenChunk(id, model, content));
      return;
    }
    // Oversized content (e.g. a base64 image data-URI emitted in one delta):
    // split into multiple content frames so no single SSE line exceeds the
    // aiohttp 131072-byte per-line limit. The client concatenates the
    // `delta.content` fragments back into the original string.
    for (
      let offset = 0;
      offset < content.length;
      offset += MAX_CONTENT_CHARS_PER_FRAME
    ) {
      await this.writeChunk(
        this.tokenChunk(
          id,
          model,
          content.slice(offset, offset + MAX_CONTENT_CHARS_PER_FRAME),
        ),
      );
    }
  }

  /** Builds an OpenAI-compatible content-delta chunk. */
  private tokenChunk(id: string, model: string, content: string) {
    return {
      id,
      object: "chat.completion.chunk" as const,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
        },
      ],
    };
  }

  /**
   * Send a tool-call delta chunk in the OpenAI tool_calls format.
   *
   * Format:
   * data: {"id":"<generated>","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{...}]},"index":0}]}\n\n
   */
  async sendToolCallChunk(toolCall: ToolCallChunk): Promise<void> {
    const chunk = {
      id: crypto.randomUUID(),
      object: "chat.completion.chunk" as const,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                ...(toolCall.index !== undefined
                  ? { index: toolCall.index }
                  : {}),
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              },
            ],
          },
        },
      ],
    };
    await this.writeChunk(chunk);
  }

  /**
   * Send a tool-result chunk after a tool invocation completes.
   * `execution_time_seconds` is rounded to 3 decimal places.
   */
  async sendToolResultChunk(result: ToolResultChunk): Promise<void> {
    const roundedTime = Math.round(result.execution_time_seconds * 1000) / 1000;

    const chunk = {
      type: "tool_result",
      tool_call_id: result.tool_call_id,
      content: result.content,
      execution_time_seconds: roundedTime,
    };
    await this.writeChunk(chunk);
  }

  /**
   * Send a RAG citation as an SSE chunk.
   *
   * Format:
   * data: {"type":"citation","citation":{<citation fields>}}\n\n
   */
  async sendCitation(citation: Citation): Promise<void> {
    const chunk = {
      type: "citation",
      citation,
    };
    await this.writeChunk(chunk);
  }

  /**
   * Send a structured error chunk followed by nothing — caller must still
   * call `sendDone()` to terminate the stream.
   *
   * Format matches the design's error-chunk specification:
   * {id, object, choices[0].finish_reason="error", error: {message, type, details}}
   */
  async sendError(error: StreamError): Promise<void> {
    const chunk = {
      id: crypto.randomUUID(),
      object: "chat.completion.chunk" as const,
      choices: [
        {
          index: 0,
          delta: {
            content: null,
            tool_calls: null,
          },
          finish_reason: "error",
        },
      ],
      error: {
        message: error.message,
        type: "execution_error",
        details: error.details ?? {},
      },
    };
    await this.writeChunk(chunk);
  }

  /**
   * Send the terminal `[DONE]` frame to signal stream completion.
   *
   * This is a literal string — NOT a JSON-encoded value.
   */
  async sendDone(): Promise<void> {
    await this.writeRaw("data: [DONE]\n\n");
  }

  /**
   * Send the final finish chunk (finish_reason: "stop") with optional usage
   * stats, then send [DONE].
   *
   * Open WebUI and other OpenAI-compatible clients read token usage from the
   * chunk that carries finish_reason: "stop". Sending usage only in a
   * separate choices:[] chunk is not sufficient — those chunks are ignored
   * by clients that expect usage on the finish chunk.
   *
   * Emits TWO frames:
   *   1. finish chunk: choices[0].finish_reason="stop", usage if provided
   *   2. [DONE]
   */
  async sendFinish(
    id: string,
    model: string,
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    },
    finishReason: "stop" | "tool_calls" | "length" = "stop",
  ): Promise<void> {
    const chunk: Record<string, unknown> = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (usage !== undefined) {
      chunk.usage = usage;
    }
    await this.writeChunk(chunk);
    await this.writeRaw("data: [DONE]\n\n");
  }
}

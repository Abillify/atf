// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Chat Route — SSE Streaming & Replay
 *
 * Contains the SSE streaming path (stream: true), the idempotent replay
 * renderer, and the non-streaming response assembly.
 *
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  CitationSource,
  TokenUsage,
  MessageToolCall,
} from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import { SSEStreamer } from "../../streaming/sse-streamer.js";
import { splitChunkByFrameBytes } from "../../graph/exec-runtime.js";
import {
  harnessProgressSseFrame,
  registerHarnessProgressSink,
} from "../../graph/agent-harness/progress-event.js";
import { QueueOverflowError } from "../../graph/graph-engine/error-strategy.js";
import { inferenceStreamBuffer } from "../../streaming/stream-replay-buffer.js";
import type { IdempotencyRecord } from "../../graph/idempotency-store.js";
import type { FlowGuardrailOverride } from "../../graph/flow-guardrail-resolver.js";
import type { Metrics } from "../../observability/metrics.js";
import type { LlmStreamFallbackPolicy } from "../../llm-stream-fallback-policy.js";
import {
  allowsNonStreamingExceptionMaterialization,
  reportsStreamFallbacks,
  resolveLlmStreamFallbackPolicy,
} from "../../llm-stream-fallback-policy.js";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Idempotent replay
// ---------------------------------------------------------------------------

/**
 * Max characters per replayed SSE content frame. Stored responses may contain
 * base64 image data-URIs that exceed the 131072-byte per-line limit of
 * aiohttp-based clients (Open WebUI). Frames are split to match the live
 * media-streaming chunk size.
 */
const REPLAY_SSE_CHUNK_SIZE = 60_000;

/**
 * Renders a stored idempotency record in the transport the current request asks
 * for: replayed SSE stream or non-streaming JSON completion.
 */
export function renderIdempotentReplay(
  ctx: Context,
  record: IdempotencyRecord,
  stream: boolean,
): Response {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-replay-${crypto.randomUUID()}`;
  ctx.header("Idempotent-Replayed", "true");
  if (stream) {
    ctx.header("Content-Type", "text/event-stream");
    ctx.header("Cache-Control", "no-cache");
    return streamSSE(ctx, async (s: SSEStreamingApi) => {
      const text = record.responseText;
      const firstSize = Math.min(text.length, REPLAY_SSE_CHUNK_SIZE);
      await s.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: record.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: text.slice(0, firstSize) },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      for (
        let offset = firstSize;
        offset < text.length;
        offset += REPLAY_SSE_CHUNK_SIZE
      ) {
        await s.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: record.model,
            choices: [
              {
                index: 0,
                delta: {
                  content: text.slice(offset, offset + REPLAY_SSE_CHUNK_SIZE),
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
      }
      if (record.usage !== undefined) {
        await s.write(
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: record.model,
            choices: [],
            usage: record.usage,
          })}\n\n`,
        );
      }
      await s.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: record.model,
          choices: [
            { index: 0, delta: {}, finish_reason: record.finishReason },
          ],
        })}\n\n`,
      );
      await s.write("data: [DONE]\n\n");
    });
  }
  return ctx.json({
    id,
    object: "chat.completion",
    created,
    model: record.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: record.responseText },
        finish_reason: record.finishReason,
      },
    ],
    ...(record.usage !== undefined ? { usage: record.usage } : {}),
  });
}

// ---------------------------------------------------------------------------
// SSE streaming execution
// ---------------------------------------------------------------------------

export interface StreamingDeps {
  graphEngine: GraphEngineService;
  monitoring?: MonitoringServiceInterface;
  runtimeGuardrailOverride?: FlowGuardrailOverride;
  metrics?: Metrics;
  llmStreamFallbackPolicy?: LlmStreamFallbackPolicy;
  /**
   * Interval (ms) between SSE keepalive frames. When no chunk has been written
   * to the stream for this long, a lightweight SSE comment frame is emitted so
   * intermediate proxies and the client (Open WebUI) keep the connection open
   * during long silent phases — e.g. a slow local planner/worker LLM call
   * inside an agent-harness research flow. Comment frames
   * are ignored by OpenAI-compatible clients and never appear in the answer.
   * 0 (or undefined) disables the heartbeat. Default when omitted: 15000.
   */
  sseHeartbeatMs?: number;
}

/** Default SSE keepalive interval (ms) when not configured. */
const DEFAULT_SSE_HEARTBEAT_MS = 15_000;

export interface StreamingParams {
  ctx: Context;
  flowToRun: string;
  messages: ChatCompletionRequest["messages"];
  requestCtx: RequestContext;
  resolvedModel: string;
  finalize: (responseText: string, hadError: boolean) => Promise<void>;
  setRunUsage: (usage: TokenUsage) => void;
  /**
   * Send structured harness progress as `event: atf.progress` frames. Opt-in
   * per request (see `harnessProgressRequested`); without it the stream
   * carries only OpenAI-compatible chunks.
   */
  progressEvents?: boolean;
}

/**
 * Executes the SSE streaming path: opens the SSE stream, runs the flow, and
 * streams chunks as they arrive.
 */
export function executeStreaming(
  deps: StreamingDeps,
  params: StreamingParams,
): Response {
  const {
    ctx,
    flowToRun,
    messages,
    requestCtx,
    resolvedModel,
    finalize,
    setRunUsage,
    progressEvents = false,
  } = params;
  const { graphEngine, monitoring, runtimeGuardrailOverride } = deps;
  const heartbeatMs = deps.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;

  ctx.header("Content-Type", "text/event-stream");
  ctx.header("X-Accel-Buffering", "no");
  ctx.header("Cache-Control", "no-cache");

  return streamSSE(ctx, async (stream: SSEStreamingApi) => {
    // Serialize every write through a single promise chain so the heartbeat
    // timer and the flow's chunk writes never interleave bytes on the wire.
    // `lastWriteAt` tracks the most recent successful write so the heartbeat
    // only fires during genuine idle gaps.
    let writeChain: Promise<void> = Promise.resolve();
    let lastWriteAt = Date.now();
    let streamClosed = false;
    const serializedWrite = (data: string): Promise<void> => {
      writeChain = writeChain.then(async () => {
        await stream.write(data);
        lastWriteAt = Date.now();
      });
      return writeChain;
    };

    const writer = {
      write: serializedWrite,
    };

    // Structured harness progress travels on its own SSE event, but only for
    // clients that asked for it: OpenAI SDKs pass every `data:` frame on as a
    // completion chunk regardless of the event name, and a frame without
    // `choices` breaks typical client code. The debug trace and async jobs
    // record progress either way.
    const unregisterProgress = progressEvents
      ? registerHarnessProgressSink(requestCtx.executionId, (progress) => {
          serializedWrite(harnessProgressSseFrame(progress)).catch(() => {});
        })
      : () => {};

    // Open a replay buffer for this execution so reconnecting clients
    // can resume mid-stream with Last-Event-ID.
    const execBuffer = inferenceStreamBuffer.open(requestCtx.executionId);

    // Check for a resume request
    const lastEventIdHeader =
      ctx.req.header("Last-Event-ID") ?? ctx.req.query("lastEventId");
    const resumeAfterSeq =
      lastEventIdHeader !== undefined && lastEventIdHeader !== ""
        ? parseInt(lastEventIdHeader, 10)
        : undefined;

    // If we have a buffer AND a valid resume point, replay missed frames.
    // Routed through serializedWrite so it shares the single write chain (the
    // heartbeat below observes these writes via lastWriteAt). May `return`
    // early on a sealed buffer — no heartbeat is running yet, so nothing leaks.
    if (resumeAfterSeq !== undefined && !Number.isNaN(resumeAfterSeq)) {
      const existingBuf = inferenceStreamBuffer.get(requestCtx.executionId);
      if (existingBuf !== undefined) {
        for (const frame of existingBuf.getFramesSince(resumeAfterSeq)) {
          await serializedWrite(`id: ${frame.seqId}\n${frame.raw}`);
        }
        if (existingBuf.sealed) return;
      }
    }

    // SSE keepalive: while the flow is silent (e.g. a slow agent-harness
    // planner/worker LLM call), emit a comment frame so proxies and the client
    // don't drop the connection on an idle-read timeout before the server-side
    // execution timeout is even reached. Comment lines (starting with `:`) are
    // ignored by OpenAI-compatible SSE clients and carry no content. Created
    // after the early-return resume path so the timer is always cleared by the
    // finally block below.
    const heartbeat =
      heartbeatMs > 0
        ? setInterval(() => {
            if (streamClosed) return;
            if (Date.now() - lastWriteAt < heartbeatMs) return;
            void serializedWrite(": keepalive\n\n").catch(() => {
              streamClosed = true;
            });
          }, heartbeatMs)
        : undefined;
    if (heartbeat !== undefined && typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }

    const streamer = new SSEStreamer(writer, execBuffer);
    const collected: string[] = [];
    let streamErrored = false;
    let sawToolCalls = false;

    try {
      await graphEngine.executeFlow(
        flowToRun,
        messages,
        requestCtx,
        async (chunk: ChatCompletionChunk): Promise<void> => {
          const choice = chunk.choices[0];

          if (choice?.finish_reason === "error") {
            streamErrored = true;
            const chunkWithError = chunk as ChatCompletionChunk & {
              error?: {
                message: string;
                type: string;
                details?: Record<string, unknown>;
              };
            };
            if (chunkWithError.error) {
              await streamer.sendError({
                message: chunkWithError.error.message,
                type: "execution_error",
                details: chunkWithError.error.details,
              });
            }
          } else if (
            choice?.delta?.tool_calls &&
            choice.delta.tool_calls.length > 0
          ) {
            const toolCall = choice.delta.tool_calls[0];
            if (toolCall) {
              sawToolCalls = true;
              await streamer.sendToolCallChunk({
                id: toolCall.id,
                type: "function",
                ...(toolCall.index !== undefined
                  ? { index: toolCall.index }
                  : {}),
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              });
            }
          } else if (
            choice?.delta?.content != null &&
            choice.delta.content !== ""
          ) {
            collected.push(choice.delta.content);
            await streamer.sendToken(
              chunk.id,
              chunk.model,
              choice.delta.content,
            );
          } else {
            // Raw pass-through for non-content/tool-call chunks (sources,
            // reasoning_content, groundedness, approval_required, …). Guard the
            // aiohttp 131072-byte per-line cap here at the single choke point
            // every such frame passes through: a chunk over the budget is split
            // into equivalent sub-frames (sources re-batched by index; a string
            // delta cut into client-concatenated slices) so no `data:` line can
            // abort Open WebUI's read with "Got more than 131072 bytes".
            for (const part of splitChunkByFrameBytes(chunk)) {
              await serializedWrite(`data: ${JSON.stringify(part)}\n\n`);
            }
          }
        },
        async (usage): Promise<void> => {
          setRunUsage(usage);
          try {
            await streamer.sendFinish(
              `chatcmpl-${requestCtx.executionId}`,
              resolvedModel,
              usage,
              sawToolCalls ? "tool_calls" : "stop",
            );
          } catch {
            /* client disconnected before finish chunk */
          }
        },
        monitoring,
        runtimeGuardrailOverride,
      );
      await finalize(collected.join(""), streamErrored);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await streamer.sendError({ message, type: "execution_error" });
      await streamer.sendDone();
      await finalize(collected.join(""), true);
    } finally {
      streamClosed = true;
      unregisterProgress();
      if (heartbeat !== undefined) clearInterval(heartbeat);
      inferenceStreamBuffer.seal(requestCtx.executionId);
    }
  });
}

// ---------------------------------------------------------------------------
// Non-streaming execution
// ---------------------------------------------------------------------------

export interface NonStreamingResult {
  response: ChatCompletionResponse;
}

/**
 * Executes the non-streaming path: runs the flow, collects all chunks, and
 * returns a single ChatCompletionResponse.
 */
export async function executeNonStreaming(
  deps: StreamingDeps,
  params: Omit<StreamingParams, "ctx" | "setRunUsage"> & {
    setRunUsage: (usage: TokenUsage) => void;
  },
): Promise<ChatCompletionResponse> {
  const {
    flowToRun,
    messages,
    requestCtx,
    resolvedModel,
    finalize,
    setRunUsage,
  } = params;
  const {
    graphEngine,
    monitoring,
    runtimeGuardrailOverride,
    metrics,
  } = deps;
  const fallbackPolicy = resolveLlmStreamFallbackPolicy(
    deps.llmStreamFallbackPolicy,
  );

  const collectedContent: string[] = [];
  const toolCallAccumulator = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();
  // Citation sources arrive on otherwise-empty chunks (the streaming path
  // forwards them to the client's source panel). The non-streaming response
  // must carry the same list, or every `[n]` in the answer is unresolvable.
  // Keyed by index: a re-emission with the same index is an evidence merge,
  // so the newest payload wins.
  const sourceByIndex = new Map<number, CitationSource>();
  let hasError = false;
  let finalUsage: TokenUsage | undefined;

  try {
    await graphEngine.executeFlow(
      flowToRun,
      messages,
      requestCtx,
      async (chunk: ChatCompletionChunk): Promise<void> => {
        const choice = chunk.choices[0];

        // Process tool calls first
        if (choice?.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
          for (const tc of choice.delta.tool_calls) {
            const key = tc.id ?? `tool-${tc.index ?? 0}`;
            const existing = toolCallAccumulator.get(key);

            if (existing) {
              existing.arguments += tc.function.arguments ?? "";
              if (tc.function.name && !existing.name) {
                existing.name = tc.function.name;
              }
            } else {
              toolCallAccumulator.set(key, {
                id: tc.id ?? key,
                name: tc.function.name ?? "",
                arguments: tc.function.arguments ?? "",
              });
            }
          }
        }

        // Process content
        if (choice?.delta?.content != null && choice.delta.content !== "") {
          collectedContent.push(choice.delta.content);
        }

        // Collect citation sources carried on no-op chunks (see above).
        // Only the indexed CitationRegistry format is kept: the legacy
        // merged-sources envelope (`{ source: {name,url}, document[] }`,
        // emitted once at flow end) has no `[n]` index and cannot be
        // resolved by the client's citation filter — including it would
        // add unresolvable entries to the response.
        if (chunk.sources !== undefined && chunk.sources.length > 0) {
          for (const source of chunk.sources) {
            if (typeof source.index === "number")
              sourceByIndex.set(source.index, source);
          }
        }

        // Check for error finish_reason
        if (choice?.finish_reason === "error") {
          hasError = true;
        }
      },
      async (usage): Promise<void> => {
        finalUsage = usage;
        setRunUsage(usage);
      },
      monitoring,
      runtimeGuardrailOverride,
    );
  } catch (err) {
    // Saturation is not a flow failure and must not be reported as one: turning
    // it into `[Error: …]` assistant content would answer HTTP 200 with a
    // fabricated message and give the client no reason to retry. Re-thrown so
    // the route can map it to 503 + Retry-After. (No response bytes have been
    // written yet on this path, so changing the status is still possible.)
    if (err instanceof QueueOverflowError) {
      await finalize("", true);
      throw err;
    }
    if (!allowsNonStreamingExceptionMaterialization(fallbackPolicy)) {
      await finalize("", true);
      throw err;
    }
    if (reportsStreamFallbacks(fallbackPolicy)) {
      metrics?.recordCounter("aiperator_stream_fallback_total", {
        kind: "route",
        reason: "non_streaming_exception_materialization",
      });
    }
    hasError = true;
    const message = err instanceof Error ? err.message : String(err);
    collectedContent.push(`[Error: ${message}]`);
  }

  await finalize(collectedContent.join(""), hasError);

  // Convert accumulated tool calls to the final format
  const collectedToolCalls: MessageToolCall[] = Array.from(
    toolCallAccumulator.values(),
  ).map((tc) => ({
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: tc.arguments,
    },
  }));
  const hasToolCalls = collectedToolCalls.length > 0;

  return {
    // Derived from the execution id, NOT a fresh UUID. The streaming path
    // already answered with `chatcmpl-<executionId>`; the non-streaming path
    // used an unrelated random id, so a non-streamed answer could not be tied
    // back to `GET /monitoring/debug/:executionId` afterwards. Every flow that
    // runs with `stream: false` (generators, batch consumers) was therefore
    // undiagnosable from the response alone.
    id: `chatcmpl-${requestCtx.executionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resolvedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: collectedContent.join(""),
          ...(hasToolCalls ? { tool_calls: collectedToolCalls } : {}),
        },
        finish_reason: hasError
          ? "error"
          : hasToolCalls
            ? "tool_calls"
            : "stop",
      },
    ],
    ...(finalUsage !== undefined ? { usage: finalUsage } : {}),
    ...(sourceByIndex.size > 0
      ? {
          sources: [...sourceByIndex.values()].sort((a, b) => a.index - b.index),
        }
      : {}),
  };
}

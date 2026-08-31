// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Responses API — typed SSE streaming
 *
 * Runs a flow and emits the OpenAI Responses API streaming event sequence
 * (`response.created` → `response.output_text.delta` … → `response.completed`).
 * Mirrors the Chat streaming path in `src/routes/chat/streaming.ts` but speaks
 * the Responses event protocol instead of `chat.completion.chunk` frames.
 *
 * No `any` at module boundaries.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import type {
  ChatCompletionChunk,
  MessageToolCall,
  TokenUsage,
} from "../../types/openai.js";
import type { RequestContext } from "../../types/monitoring.js";
import type { MonitoringServiceInterface } from "../../monitoring/monitoring-service.js";
import type { GraphEngineService } from "../../graph/graph-engine.js";
import type { FlowGuardrailOverride } from "../../graph/flow-guardrail-resolver.js";
import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesOutputItem,
} from "../../types/responses.js";
import {
  baseResponseFields,
  buildOutputItems,
  newMessageId,
  toResponsesUsage,
} from "./translate.js";

export interface ResponsesStreamingDeps {
  graphEngine: GraphEngineService;
  monitoring?: MonitoringServiceInterface;
  runtimeGuardrailOverride?: FlowGuardrailOverride;
}

export interface ResponsesStreamingParams {
  ctx: Context;
  req: ResponsesRequest;
  responseId: string;
  flowToRun: string;
  messages: import("../../types/openai.js").ChatMessage[];
  requestCtx: RequestContext;
  resolvedModel: string;
  finalize: (responseText: string, hadError: boolean) => Promise<void>;
  setRunUsage: (usage: TokenUsage) => void;
}

/**
 * Executes the flow and streams Responses API events. Text is streamed as
 * `response.output_text.delta`; any tool calls the model emits are surfaced as
 * `function_call` output items in the terminal `response.completed` event.
 */
export function executeResponsesStreaming(
  deps: ResponsesStreamingDeps,
  params: ResponsesStreamingParams,
): Response {
  const {
    ctx,
    req,
    responseId,
    flowToRun,
    messages,
    requestCtx,
    resolvedModel,
    finalize,
    setRunUsage,
  } = params;
  const { graphEngine, monitoring, runtimeGuardrailOverride } = deps;

  ctx.header("Content-Type", "text/event-stream");
  ctx.header("X-Accel-Buffering", "no");
  ctx.header("Cache-Control", "no-cache");

  const createdAt = Math.floor(Date.now() / 1000);
  const messageId = newMessageId();
  const base = baseResponseFields(req);

  const skeleton = (
    status: ResponsesResponse["status"],
    output: ResponsesOutputItem[],
    usage?: TokenUsage,
  ): ResponsesResponse => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    model: resolvedModel,
    output,
    output_text: output
      .filter((i): i is Extract<ResponsesOutputItem, { type: "message" }> =>
        i.type === "message",
      )
      .flatMap((m) => m.content.map((c) => c.text))
      .join(""),
    error: null,
    incomplete_details: null,
    ...base,
    ...(usage !== undefined ? { usage: toResponsesUsage(usage) } : {}),
  });

  return streamSSE(ctx, async (stream: SSEStreamingApi) => {
    let seq = 0;
    const emit = async (event: ResponsesStreamEvent): Promise<void> => {
      await stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event),
      });
    };

    const collected: string[] = [];
    const toolCallAcc = new Map<
      string,
      { id: string; name: string; arguments: string }
    >();
    let contentStarted = false;
    let errored = false;
    let finalUsage: TokenUsage | undefined;

    const startMessageItem = async (): Promise<void> => {
      if (contentStarted) return;
      contentStarted = true;
      await emit({
        type: "response.output_item.added",
        sequence_number: seq++,
        output_index: 0,
        item: {
          type: "message",
          id: messageId,
          status: "incomplete",
          role: "assistant",
          content: [],
        },
      });
      await emit({
        type: "response.content_part.added",
        sequence_number: seq++,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    };

    try {
      // response.created + response.in_progress
      await emit({
        type: "response.created",
        sequence_number: seq++,
        response: skeleton("in_progress", []),
      });
      await emit({
        type: "response.in_progress",
        sequence_number: seq++,
        response: skeleton("in_progress", []),
      });

      await graphEngine.executeFlow(
        flowToRun,
        messages,
        requestCtx,
        async (chunk: ChatCompletionChunk): Promise<void> => {
          const choice = chunk.choices[0];
          if (choice?.finish_reason === "error") {
            errored = true;
            return;
          }
          if (choice?.delta?.tool_calls && choice.delta.tool_calls.length > 0) {
            for (const tc of choice.delta.tool_calls) {
              const key = tc.id ?? `tool-${tc.index ?? 0}`;
              const existing = toolCallAcc.get(key);
              if (existing) {
                existing.arguments += tc.function.arguments ?? "";
                if (tc.function.name && !existing.name)
                  existing.name = tc.function.name;
              } else {
                toolCallAcc.set(key, {
                  id: tc.id ?? key,
                  name: tc.function.name ?? "",
                  arguments: tc.function.arguments ?? "",
                });
              }
            }
            return;
          }
          if (choice?.delta?.content != null && choice.delta.content !== "") {
            await startMessageItem();
            collected.push(choice.delta.content);
            await emit({
              type: "response.output_text.delta",
              sequence_number: seq++,
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: choice.delta.content,
            });
          }
        },
        async (usage): Promise<void> => {
          finalUsage = usage;
          setRunUsage(usage);
        },
        monitoring,
        runtimeGuardrailOverride,
      );

      const fullText = collected.join("");
      const toolCalls: MessageToolCall[] = [...toolCallAcc.values()].map(
        (tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }),
      );

      // Close out the text message item (only when one was opened).
      if (contentStarted) {
        await emit({
          type: "response.output_text.done",
          sequence_number: seq++,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text: fullText,
        });
        await emit({
          type: "response.content_part.done",
          sequence_number: seq++,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: fullText, annotations: [] },
        });
        await emit({
          type: "response.output_item.done",
          sequence_number: seq++,
          output_index: 0,
          item: {
            type: "message",
            id: messageId,
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: fullText, annotations: [] }],
          },
        });
      }

      const output = buildOutputItems(fullText, toolCalls, messageId);
      const final = skeleton(errored ? "failed" : "completed", output, finalUsage);
      if (errored) {
        final.error = { code: "server_error", message: fullText || "error" };
        await emit({
          type: "response.failed",
          sequence_number: seq++,
          response: final,
        });
      } else {
        await emit({
          type: "response.completed",
          sequence_number: seq++,
          response: final,
        });
      }
      await finalize(fullText, errored);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await emit({
        type: "error",
        sequence_number: seq++,
        code: "server_error",
        message,
      });
      await finalize(collected.join(""), true);
    }
  });
}

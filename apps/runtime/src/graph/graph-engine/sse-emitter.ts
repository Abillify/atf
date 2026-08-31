// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Streams token/reasoning deltas as SSE chunks for one flow execution, and
 * owns the per-node state that only this concern needs (chunk-id assignment,
 * optional output-guardrail buffering). Extracted from
 * `_executeFlowInternal` (handler-factories.ts) — unlike the tool-tracking /
 * node-monitoring / debug-trace machinery it replaces, this state is not
 * shared with anything else in that method, so it lifts out cleanly.
 */
import type { ChatCompletionChunk } from "../../types/openai.js";
import type { OutputGuardrail, GuardrailStream } from "../output-guardrails.js";
import { makeTokenChunk, makeReasoningChunk } from "../exec-runtime.js";

const REASONING_CHUNK_SIZE = 60_000;

export class SseEmitter {
  private readonly nodeChunkIds = new Map<string, string>();
  private readonly reasoningChunkIds = new Map<string, string>();
  private readonly guardStreams = new Map<string, GuardrailStream>();

  constructor(
    private readonly onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
    private readonly model: string,
    private readonly guardrail: OutputGuardrail | undefined,
  ) {}

  /** Streams an LLM token delta, through the output guardrail when configured. */
  onToken = async (nodeId: string, token: string): Promise<void> => {
    let chunkId = this.nodeChunkIds.get(nodeId);
    if (chunkId === undefined) {
      chunkId = crypto.randomUUID();
      this.nodeChunkIds.set(nodeId, chunkId);
    }
    if (this.guardrail !== undefined) {
      let gs = this.guardStreams.get(nodeId);
      if (gs === undefined) {
        gs = this.guardrail.createStream();
        this.guardStreams.set(nodeId, gs);
      }
      const safe = gs.push(token);
      if (safe.length > 0)
        await this.onChunk(makeTokenChunk(chunkId, this.model, safe));
      return;
    }
    await this.onChunk(makeTokenChunk(chunkId, this.model, token));
  };

  /**
   * Reasoning tokens (<think>...</think>) emitted as reasoning_content — Open
   * WebUI displays these in a collapsible "Thinking" block.
   */
  onReasoning = async (nodeId: string, token: string): Promise<void> => {
    let chunkId = this.reasoningChunkIds.get(nodeId);
    if (chunkId === undefined) {
      chunkId = crypto.randomUUID();
      this.reasoningChunkIds.set(nodeId, chunkId);
    }
    for (
      let offset = 0;
      offset < token.length;
      offset += REASONING_CHUNK_SIZE
    ) {
      await this.onChunk(
        makeReasoningChunk(
          chunkId,
          this.model,
          token.slice(offset, offset + REASONING_CHUNK_SIZE),
        ),
      );
    }
  };

  /** Emits a single reasoning_content chunk summarising an internal step. */
  emitReasoningStep = async (text: string): Promise<void> => {
    const id = crypto.randomUUID();
    for (
      let offset = 0;
      offset < text.length;
      offset += REASONING_CHUNK_SIZE
    ) {
      await this.onChunk(
        makeReasoningChunk(
          id,
          this.model,
          text.slice(offset, offset + REASONING_CHUNK_SIZE),
        ),
      );
    }
  };

  /**
   * Flushes a node's buffered guardrail tail (if any) as a final token chunk
   * and returns the guardrail's finding counts for the caller to record —
   * called from node-end handling, which owns metrics recording.
   */
  flushGuardrailForNode = async (
    nodeId: string,
  ): Promise<Record<string, number>> => {
    const gs = this.guardStreams.get(nodeId);
    if (gs === undefined) return {};
    const tail = gs.flush();
    if (tail.length > 0) {
      const chunkId = this.nodeChunkIds.get(nodeId) ?? crypto.randomUUID();
      await this.onChunk(makeTokenChunk(chunkId, this.model, tail));
    }
    const findings = gs.getFindings();
    this.guardStreams.delete(nodeId);
    return findings;
  };
}

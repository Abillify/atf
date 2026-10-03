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
import type { RefHandleRegistry } from "../ref-handles.js";
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
    /**
     * Optional run-scoped ref-handle registry (see `ref-handles.ts`). When a
     * flow opts in (`config.refHandles`), the MODEL reads short handles where
     * a long document reference belongs — but the USER must always see the
     * real reference. Every token/reasoning delta is therefore unmapped back
     * to real references here, with a small hold-back so a handle split across
     * two deltas is still caught.
     */
    private readonly refHandles: RefHandleRegistry | undefined,
  ) {}

  /** Streams an LLM token delta, through the output guardrail when configured. */
  onToken = async (nodeId: string, token: string): Promise<void> => {
    let chunkId = this.nodeChunkIds.get(nodeId);
    if (chunkId === undefined) {
      chunkId = crypto.randomUUID();
      this.nodeChunkIds.set(nodeId, chunkId);
    }
    const safe =
      this.refHandles !== undefined
        ? this.refHandles.unmapStreamText("token", nodeId, token)
        : token;
    if (safe.length === 0) return;
    if (this.guardrail !== undefined) {
      let gs = this.guardStreams.get(nodeId);
      if (gs === undefined) {
        gs = this.guardrail.createStream();
        this.guardStreams.set(nodeId, gs);
      }
      const guarded = gs.push(safe);
      if (guarded.length > 0)
        await this.onChunk(makeTokenChunk(chunkId, this.model, guarded));
      return;
    }
    await this.onChunk(makeTokenChunk(chunkId, this.model, safe));
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
    const unmapped =
      this.refHandles !== undefined
        ? this.refHandles.unmapStreamText("reasoning", nodeId, token)
        : token;
    if (unmapped.length === 0) return;
    for (
      let offset = 0;
      offset < unmapped.length;
      offset += REASONING_CHUNK_SIZE
    ) {
      await this.onChunk(
        makeReasoningChunk(
          chunkId,
          this.model,
          unmapped.slice(offset, offset + REASONING_CHUNK_SIZE),
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

  /**
   * Releases the ref-handle hold-back tail of a finished node (a trailing
   * `K3` that never completed into a handle, or a handle that ended the
   * answer). MUST run BEFORE {@link flushGuardrailForNode} so the released
   * text still passes through the guardrail stream, whose own tail flush
   * follows. The tail is already handle-unmapped, so it is emitted through
   * the guardrail directly — re-entering {@link onToken} would feed it back
   * into the hold-back and strand it. Called from node-end handling.
   */
  flushRefHandlesForNode = async (nodeId: string): Promise<void> => {
    if (this.refHandles === undefined) return;
    // Reasoning first: chronologically it precedes the answer tokens.
    const reasoningTail = this.refHandles.unmapStreamText(
      "reasoning",
      nodeId,
      "",
      true,
    );
    if (reasoningTail.length > 0) {
      const chunkId =
        this.reasoningChunkIds.get(nodeId) ?? crypto.randomUUID();
      await this.onChunk(
        makeReasoningChunk(chunkId, this.model, reasoningTail),
      );
    }
    const tail = this.refHandles.unmapStreamText("token", nodeId, "", true);
    if (tail.length === 0) return;
    const chunkId = this.nodeChunkIds.get(nodeId) ?? crypto.randomUUID();
    if (this.guardrail !== undefined) {
      let gs = this.guardStreams.get(nodeId);
      if (gs === undefined) {
        gs = this.guardrail.createStream();
        this.guardStreams.set(nodeId, gs);
      }
      const safe = gs.push(tail);
      if (safe.length > 0)
        await this.onChunk(makeTokenChunk(chunkId, this.model, safe));
      return;
    }
    await this.onChunk(makeTokenChunk(chunkId, this.model, tail));
  };
}

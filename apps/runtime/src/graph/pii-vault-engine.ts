// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PII vault engine decorator (`src/graph/pii-vault-engine.ts`)
 *
 * Wraps a {@link GraphEngineService} so the reversible PII tokenization vault
 * (`pii-vault.ts`) sits transparently around EVERY call path that reaches the
 * engine — SSE streaming, non-streaming, async jobs, replay, triggers, MCP —
 * without touching any of those call sites individually:
 *
 *   ingress:  ChatMessage[] text content is tokenized before `executeFlow`
 *             delegates to the real engine, so no node handler, LLM provider,
 *             or MCP tool ever sees the raw PII.
 *   egress:   every `onChunk` the real engine emits has its `delta.content`
 *             detokenized (streaming-safe — a placeholder split across two
 *             chunks is still caught) before the caller's `onChunk` sees it,
 *             so the end user gets their real data back.
 *   cleanup:  the vault's mapping for the execution is released once the run
 *             finishes (`onDone`) or throws, so nothing outlives the request
 *             that created it.
 *
 * This is the ONLY integration point required — decorate the engine once in
 * bootstrap and every consumer (chat routes, triggers, replay, MCP server)
 * gets the vault for free.
 *
 * No `any` at module boundaries.
 */

import type {
  GraphEngineService,
  CompiledAgentGraph,
} from "./graph-engine/state.js";
import type { RequestContext } from "../types/monitoring.js";
import type {
  ChatMessage,
  ChatCompletionChunk,
  ContentBlock,
  TokenUsage,
} from "../types/openai.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { FlowGuardrailOverride } from "./flow-guardrail-resolver.js";
import type { FlowDefinition } from "../types/flow.js";
import type { PiiVault } from "./pii-vault.js";
import {
  scanAttachmentBlock,
  type MultimodalOptions,
} from "./pii-image-scanner.js";

/**
 * Tokenizes the text content of every message (string content and text content
 * blocks) and, when a multimodal control is active, applies it to image/file
 * attachment blocks before they reach the provider (ADR-0016).
 */
async function tokenizeMessages(
  vault: PiiVault,
  executionId: string,
  tenantId: string | undefined,
  messages: readonly ChatMessage[],
  flowId: string,
  multimodal?: MultimodalOptions,
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  const multimodalActive =
    multimodal !== undefined && multimodal.mode !== "off";
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      out.push({
        ...msg,
        content: await vault.tokenize(executionId, tenantId, msg.content, flowId),
      });
      continue;
    }
    if (Array.isArray(msg.content)) {
      const blocks: ContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          blocks.push({
            type: "text",
            text: await vault.tokenize(executionId, tenantId, block.text, flowId),
          });
        } else if (multimodalActive) {
          // Image / file attachment — one-way control (strip, redact, or
          // describe), since pixels cannot be reversibly tokenized like text.
          const { block: scanned, action } = await scanAttachmentBlock(
            block,
            multimodal,
          );
          if (action === "described" && scanned.type === "text") {
            // The vision description is routed through the SAME text
            // tokenization as normal content, so any PII it contains is redacted
            // before the downstream provider ever sees it.
            blocks.push({
              type: "text",
              text: await vault.tokenize(
                executionId,
                tenantId,
                scanned.text,
                flowId,
              ),
            });
          } else {
            blocks.push(scanned);
          }
        } else {
          blocks.push(block);
        }
      }
      out.push({ ...msg, content: blocks });
      continue;
    }
    out.push(msg);
  }
  return out;
}

/**
 * Wraps `engine` so every {@link GraphEngineService.executeFlow} call tokenizes
 * inbound message text and detokenizes outbound chunk content through `vault`.
 * All other methods delegate unchanged.
 */
export function withPiiVault(
  engine: GraphEngineService,
  vault: PiiVault,
  multimodal?: MultimodalOptions,
): GraphEngineService {
  return {
    buildGraph(
      flow: FlowDefinition,
      knownToolIds?: Set<string>,
    ): CompiledAgentGraph {
      return engine.buildGraph(flow, knownToolIds);
    },

    async executeFlow(
      flowId: string,
      messages: ChatMessage[],
      ctx: RequestContext,
      onChunk: (chunk: ChatCompletionChunk) => Promise<void>,
      onDone: (usage: TokenUsage) => Promise<void>,
      monitoring?: MonitoringServiceInterface,
      guardrailOverride?: FlowGuardrailOverride,
      onFinalResponse?: (response: string) => void | Promise<void>,
    ): Promise<void> {
      const executionId = ctx.executionId;
      const tenantId = ctx.clientId;

      const tokenizedMessages = await tokenizeMessages(
        vault,
        executionId,
        tenantId,
        messages,
        flowId,
        multimodal,
      );

      const detokStream = vault.createDetokenizeStream(executionId);
      const wrappedOnChunk = async (
        chunk: ChatCompletionChunk,
      ): Promise<void> => {
        const firstChoice = chunk.choices[0];
        const content = firstChoice?.delta?.content;
        if (typeof content === "string" && content.length > 0 && firstChoice !== undefined) {
          const safe = await detokStream.push(content);
          if (safe.length === 0) return; // buffered — nothing safe to emit yet
          await onChunk({
            ...chunk,
            choices: [
              {
                ...firstChoice,
                delta: { ...firstChoice.delta, content: safe },
              },
              ...chunk.choices.slice(1),
            ],
          });
          return;
        }
        await onChunk(chunk);
      };

      let flushed = false;
      const flushRemainder = async (): Promise<void> => {
        if (flushed) return;
        flushed = true;
        const remainder = await detokStream.flush();
        if (remainder.length > 0) {
          await onChunk({
            id: `pii-vault-flush-${executionId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: flowId,
            choices: [
              { index: 0, delta: { content: remainder }, finish_reason: null },
            ],
          });
        }
      };

      try {
        await engine.executeFlow(
          flowId,
          tokenizedMessages,
          ctx,
          wrappedOnChunk,
          async (usage) => {
            await flushRemainder();
            await onDone(usage);
          },
          monitoring,
          guardrailOverride,
          onFinalResponse === undefined
            ? undefined
            : async (response) => {
                await onFinalResponse(
                  await vault.detokenize(executionId, response),
                );
              },
        );
      } finally {
        await flushRemainder();
        await vault.release(executionId);
      }
    },

    invalidateCache(flowId: string): void {
      engine.invalidateCache(flowId);
    },

    hasCapacity(): boolean {
      return engine.hasCapacity();
    },

    getQueueState() {
      return engine.getQueueState();
    },

    ...(engine.setDebugStore !== undefined
      ? { setDebugStore: engine.setDebugStore.bind(engine) }
      : {}),
    ...(engine.setToolAuthzEngine !== undefined
      ? { setToolAuthzEngine: engine.setToolAuthzEngine.bind(engine) }
      : {}),
    ...(engine.setCompliancePolicy !== undefined
      ? { setCompliancePolicy: engine.setCompliancePolicy.bind(engine) }
      : {}),
  };
}

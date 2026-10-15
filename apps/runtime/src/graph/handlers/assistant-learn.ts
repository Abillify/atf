// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Built-in `assistant-learn` node type.
 *
 * Terminal node of an assistant flow. Records what happened in the turn, settles any
 * skill canary that has reached a verdict, and offers the turn to the learning-pass
 * scheduler.
 *
 * ## Why this is a node and not an engine hook
 *
 * The facts it records — round-trip depth, tool count, whether the user aborted —
 * are knowable at the end of the graph and nowhere earlier. Putting the recording in
 * an engine lifecycle hook would mean re-deriving them from node events, which is the
 * multi-signal inference this design exists to avoid. As a node it reads the state
 * the graph already carries.
 *
 * ## Why it never fails the turn
 *
 * Everything here is bookkeeping that happens after the user's answer has streamed.
 * A failure costs a missed learning opportunity and one uncounted canary sample, both
 * invisible; failing the turn at this point would discard an answer the user already
 * received.
 */
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { NodeHandlerRegistration } from "../node-handler-registry.js";
import type { FlowNode } from "../../types/flow.js";
import { getRuntime, lastUserQuery } from "../exec-runtime.js";
import { assistantMemoryScope } from "../memory-store.js";
import type { AgentState } from "../graph-engine.js";
import { resolveAssistantScope, type TurnTrigger } from "../../assistants/types.js";
import { countModelIterations } from "../../assistants/review-gating.js";

const configSchema = z.object({
  /**
   * Whether to offer the turn to the learning scheduler. False for flows that should
   * record facts and settle canaries but never capture procedures.
   */
  learn: z.boolean().optional(),
});

/** Reads a string array out of the request params, tolerating absence. */
function readIdList(requestParams: Record<string, unknown> | undefined, key: string): string[] {
  const raw = requestParams?.[key];
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Counts tool calls in the turn.
 *
 * Read from the accumulated tool results rather than from a counter incremented
 * along the way: the results are the record of what actually completed, and a
 * counter would drift whenever a path was added that dispatched a tool without
 * incrementing it.
 */
function countToolCalls(state: AgentState): number {
  return state.toolResults.length;
}

function cleanPreferenceName(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();
  if (!/^[\p{L}][\p{L}'’-]{1,39}$/u.test(cleaned)) return undefined;
  return `${cleaned[0]?.toLocaleUpperCase("de-DE") ?? ""}${cleaned.slice(1)}`;
}

export function extractExplicitAssistantPreferences(text: string): {
  preferredUserName?: string;
  assistantName?: string;
} {
  const preferredUserMatch = text.match(
    /(?:nenn|nenne|ruf|rufe|sprich)\s+mich(?:\s+bitte)?(?:\s+mit)?\s+([\p{L}'’-]+)/iu,
  );
  const assistantNameMatch =
    text.match(/(?:ich\s+)?(?:nenne|nenn)\s+dich(?:\s+bitte)?\s+([\p{L}'’-]+)/iu) ??
    text.match(/kann\s+ich\s+dich\s+([\p{L}'’-]+)\s+nennen/iu) ??
    text.match(/du\s+hei(?:ß|ss)t(?:\s+ab\s+jetzt)?\s+([\p{L}'’-]+)/iu);

  const preferredUserName = preferredUserMatch?.[1]
    ? cleanPreferenceName(preferredUserMatch[1])
    : undefined;
  const assistantName = assistantNameMatch?.[1]
    ? cleanPreferenceName(assistantNameMatch[1])
    : undefined;
  return {
    ...(preferredUserName !== undefined ? { preferredUserName } : {}),
    ...(assistantName !== undefined ? { assistantName } : {}),
  };
}

function contentToTranscriptText(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Best-effort tool result serialisation: transcript durability must not depend on a connector's result shape. */
function toolResultToTranscriptText(result: unknown): string {
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function createAssistantLearnNodeHandler(
  node: FlowNode,
): (state: AgentState, config?: LangGraphRunnableConfig) => Promise<Partial<AgentState>> {
  const nodeConfig = configSchema.parse(node.config ?? {});

  return async (state, config): Promise<Partial<AgentState>> => {
    const runtime = getRuntime(config);
    if (runtime === undefined) return { currentNodeId: node.id };
    runtime.onNodeStart(node.id);

    const assistants = runtime.assistants;
    if (assistants === undefined) return { currentNodeId: node.id };

    const ctx = state.context;
    // The ALREADY-RESOLVED id, written back onto the shared context by the
    // `assistant-context` node. Re-deriving it here from the client's input and the
    // node's own default would let the two nodes disagree about which assistant the
    // turn belonged to, and the bookkeeping would then be filed against the wrong one.
    const rawAssistantId = ctx.requestParams?.assistant_id;
    const resolution = resolveAssistantScope({
      userId: ctx.userId ?? ctx.userEmail,
      assistantId: typeof rawAssistantId === "string" ? rawAssistantId : undefined,
      tenantId: ctx.clientId,
    });
    if (!resolution.ok) {
      // Two ways to get here: the context node reported the reason already, or this
      // flow has no context node at all. The second is a wiring mistake that would
      // otherwise look like "learning is enabled but never learns", so it is stated
      // rather than passed over.
      runtime.onNodeIo?.(node.id, {
        response:
          `No assistant scope on this turn (${resolution.reason}), so nothing was ` +
          "recorded. An `assistant-learn` node requires an `assistant-context` node " +
          "earlier in the flow.",
      });
      return { currentNodeId: node.id };
    }
    const scope = resolution.scope;

    // Explicit naming instructions are durable user intent, not a heuristic
    // learning opportunity. Persist them synchronously so the next turn cannot
    // forget a promise the assistant just made.
    const preferences = extractExplicitAssistantPreferences(lastUserQuery(state));
    // A shadow/replay re-run must not write the original turn's preferences again.
    if (runtime.ctx.suppressSideEffects === true) {
      return { currentNodeId: node.id };
    }
    try {
      if (preferences.assistantName !== undefined) {
        await assistants.stores.assistants.update(scope, {
          displayName: preferences.assistantName,
        });
      }
      if (
        preferences.preferredUserName !== undefined &&
        runtime.memoryStore !== undefined
      ) {
        await runtime.memoryStore.remember(
          assistantMemoryScope(scope),
          `The user wants to be addressed by the name ${preferences.preferredUserName}.`,
          { kind: "preference", id: "preferred-user-name" },
        );
      }
    } catch (err) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "assistant_preference_persist_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const trigger =
      typeof ctx.requestParams?.trigger === "string"
        ? (ctx.requestParams.trigger as TurnTrigger)
        : "user";
    const modelIterations = countModelIterations(
      state.messages.map((message) => ({
        // LangChain messages expose their role through `_getType()`; the learning
        // gate counts assistant round trips, which is the depth signal.
        role: message._getType() === "ai" ? "assistant" : message._getType(),
      })),
    );
    const errored = state.errors.length > 0;
    const canarySkillIds = readIdList(ctx.requestParams, "assistant_canary_skill_ids");
    const shownMessageIds = readIdList(ctx.requestParams, "assistant_shown_message_ids");
    const usedSkillIds = readIdList(ctx.requestParams, "assistant_used_skill_ids");

    // Finish the append-only workspace transcript before optional learning
    // bookkeeping. The user message was durably written by assistant-context
    // before the LLM/tool loop; here we add the final response and completed
    // tool results, which gives restarts an auditable, resumable history even
    // in deployments without Postgres.
    const conversationId = ctx.chatId ?? ctx.sessionId ?? ctx.executionId;
    const finalAssistantMessage = [...state.messages]
      .reverse()
      .find((message) => message._getType() === "ai");
    if (finalAssistantMessage !== undefined) {
      let persistedAssistantEvent: Awaited<ReturnType<NonNullable<typeof assistants.stores.transcripts>["append"]>> | undefined;
      try {
        persistedAssistantEvent = await assistants.stores.transcripts?.append(scope, {
          executionId: ctx.executionId,
          conversationId,
          role: "assistant",
          content: contentToTranscriptText(finalAssistantMessage.content),
        });
      } catch (error) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "assistant_transcript_completion_persist_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      if (persistedAssistantEvent !== undefined) {
        try {
          await assistants.indexSessionDocument({
            scope,
            conversationId,
            documentId: persistedAssistantEvent.id,
            content: persistedAssistantEvent.content,
            kind: "event",
            sequence: persistedAssistantEvent.sequence ?? 0,
            token: ctx.ssoToken,
          });
        } catch (error) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "assistant_transcript_completion_projection_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    try {
      for (const result of state.toolResults) {
        await assistants.stores.transcripts?.append(scope, {
          executionId: ctx.executionId,
          conversationId,
          role: "tool",
          content: toolResultToTranscriptText(result),
        });
      }
    } catch (error) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "assistant_transcript_tool_persist_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await assistants.recordTurn({
        scope,
        executionId: ctx.executionId,
        trigger,
        modelIterations,
        toolCalls: countToolCalls(state),
        // A turn with a recorded error did not succeed even if it produced text.
        succeeded: !errored,
        // An abort surfaces as a cancelled run rather than an error entry; the flow
        // deadline signal is the only reliable indicator available here.
        aborted: runtime.signal?.aborted === true && !errored,
        errored,
        canarySkillIds,
        shownMessageIds,
        usedSkillIds,
      });

      // Settled after the outcome is recorded so the newest sample counts toward the
      // verdict. Settling first would decide on stale statistics.
      await assistants.settleCanaries(scope);

      if (nodeConfig.learn !== false && assistants.learningEnabled) {
        const scheduler = runtime.assistantReviewScheduler;
        if (scheduler !== undefined) {
          const assistant = await assistants.stores.assistants.get(scope);
          scheduler.schedule({
            scope,
            conversationKey: ctx.chatId ?? ctx.sessionId ?? ctx.executionId,
            executionId: ctx.executionId,
            turn: {
              modelIterations,
              aborted: runtime.signal?.aborted === true && !errored,
              errored,
              trigger,
              reviewed: false,
            },
            // Rendered lazily by the runner from the stored transcript, so the
            // scheduler holds an id rather than a full transcript for up to the idle
            // window.
            transcript: "",
            autonomy: assistant?.autonomy ?? "supervised",
          });
        }
      }

      runtime.onNodeIo?.(node.id, {
        response: JSON.stringify({
          modelIterations,
          toolCalls: countToolCalls(state),
          errored,
          canarySkills: canarySkillIds.length,
        }),
      });
    } catch (err) {
      // Bookkeeping runs after the user's answer has streamed. Failing here would
      // discard an answer they already have.
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "assistant_turn_record_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return { currentNodeId: node.id };
  };
}

export const nodeType: NodeHandlerRegistration = {
  type: "assistant-learn",
  emitsLifecycle: true,
  factory: (node) => createAssistantLearnNodeHandler(node),
  configSchema,
};

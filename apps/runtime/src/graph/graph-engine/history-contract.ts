// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Threaded-history contract (`src/graph/graph-engine/history-contract.ts`)
 *
 * ## The contract
 *
 * `AgentStateAnnotation.messages` uses an APPEND-ONLY reducer
 * (`left.concat(right)`). In threaded mode (a `conversation_id` is present and a
 * checkpointer is configured) the engine therefore starts each turn from the
 * PERSISTED conversation and appends whatever the request carries.
 *
 * That leaves two mutually exclusive client behaviours, and the engine has to
 * work correctly under both:
 *
 *   1. **Delta client** — sends only the new user message each turn. The
 *      persisted checkpoint is the single source of truth. Nothing to reconcile.
 *   2. **Full-history client** — resends the whole visible transcript every turn
 *      (Open WebUI and the OpenAI SDKs do this; it is the default OpenAI
 *      Chat-Completions shape). Appending that verbatim duplicated every earlier
 *      turn on each request, so history grew quadratically and the model saw the
 *      same user/assistant pair two, three or more times. A model that sees its
 *      own earlier question repeated in the transcript reasonably concludes the
 *      question is still open and asks it again — which is exactly how a coach
 *      flow ends up repeating itself.
 *
 * This module makes the contract explicit and enforces it in ONE place:
 * **the persisted checkpoint always wins; only the genuinely new tail of the
 * request is appended.** Both client shapes then behave identically, and a
 * duplicate submit of an unchanged transcript appends nothing at all instead of
 * corrupting the thread.
 *
 * ## Why a prefix walk rather than a set difference
 *
 * A set difference would silently drop a legitimately repeated message (a user
 * who really does send "ja" twice) and would also resurrect messages from the
 * middle of a transcript the client has since edited. The reconciliation is
 * therefore an ORDER-PRESERVING prefix walk: incoming messages are matched
 * forward against the persisted transcript, and the first message that does not
 * match ends the walk — everything from there on is treated as new. That keeps
 * the operation deterministic, idempotent for an unchanged transcript, and safe
 * when the persisted side contains messages the client never saw (RAG system
 * blocks, tool results, summaries).
 *
 * No `any` at module boundaries.
 */

import type { BaseMessage } from "@langchain/core/messages";

/** Outcome of reconciling a request transcript against a persisted thread. */
export interface ReconciledHistory {
  /**
   * The messages to hand to the graph as `initialState.messages`. Either the
   * full incoming list (nothing was persisted yet / nothing matched) or its
   * unmatched tail.
   */
  messages: BaseMessage[];
  /** How many messages the request carried. */
  incoming: number;
  /** How many messages were already present in the checkpoint and dropped. */
  dropped: number;
  /**
   * True when the request carried nothing beyond what was already persisted —
   * i.e. a repeated submit of an unchanged transcript. The turn still runs (the
   * persisted last user message is the query), but no history is appended.
   */
  duplicateTurn: boolean;
}

/**
 * Builds the comparison key for one message.
 *
 * Role plus textual content is what identifies a conversation turn across the
 * client/checkpoint boundary: LangChain message instances are recreated per
 * request, so object identity and any `id` the SDK assigns are useless here.
 * Tool linkage is folded in so two structurally different tool interactions
 * cannot collide on their text alone.
 */
function fingerprint(message: BaseMessage): string {
  const role = message._getType();
  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
  const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  const toolPart =
    typeof toolCallId === "string"
      ? `\u0000tc:${toolCallId}`
      : Array.isArray(toolCalls) && toolCalls.length > 0
        ? `\u0000tcs:${JSON.stringify(
            toolCalls.map((c) => {
              const call = c as { name?: unknown; args?: unknown };
              return {
                name: typeof call.name === "string" ? call.name : "",
                args: call.args ?? null,
              };
            }),
          )}`
        : "";
  return `${role}\u0000${content.trim()}${toolPart}`;
}

/**
 * Reconciles a request transcript against the persisted thread transcript.
 *
 * @param persisted - Messages already in the checkpoint for this thread. Pass an
 *   empty array for a fresh thread.
 * @param incoming  - Messages the request carried, in request order.
 */
export function reconcileThreadedHistory(
  persisted: readonly BaseMessage[],
  incoming: readonly BaseMessage[],
): ReconciledHistory {
  if (persisted.length === 0 || incoming.length === 0) {
    return {
      messages: [...incoming],
      incoming: incoming.length,
      dropped: 0,
      duplicateTurn: false,
    };
  }

  // Pre-compute the persisted fingerprints once: the walk is O(n·m) in the worst
  // case, but the cursor only ever moves forward, so in practice it is linear.
  const persistedKeys = persisted.map(fingerprint);

  let cursor = 0;
  let firstNewIndex = incoming.length;
  for (let i = 0; i < incoming.length; i++) {
    const target = fingerprint(incoming[i] as BaseMessage);
    let matchedAt = -1;
    for (let j = cursor; j < persistedKeys.length; j++) {
      if (persistedKeys[j] === target) {
        matchedAt = j;
        break;
      }
    }
    if (matchedAt === -1) {
      // First message the persisted transcript does not account for: this and
      // everything after it is the new tail.
      firstNewIndex = i;
      break;
    }
    cursor = matchedAt + 1;
  }

  const tail = incoming.slice(firstNewIndex);
  return {
    messages: tail,
    incoming: incoming.length,
    dropped: incoming.length - tail.length,
    duplicateTurn: tail.length === 0,
  };
}

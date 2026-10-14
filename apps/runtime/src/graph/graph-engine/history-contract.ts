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
 * A duplicate submit whose last message is the thread's latest user turn
 * (double submit, "regenerate") is additionally REPLAYED from the start of that
 * turn: the engine forks from the checkpoint taken right before the user
 * message (see {@link planDuplicateTurnRegenerate} and
 * {@link findRegenerateBaseCheckpoint}), so the new answer replaces the old one
 * instead of being generated on top of it.
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
   * i.e. a repeated submit of an unchanged transcript. No history is appended.
   * The last persisted message is then typically the OLD assistant answer, not
   * the query: continuing on top of it would show the model its own previous
   * answer as the latest turn. The engine therefore regenerates the turn from
   * its start (see {@link planDuplicateTurnRegenerate}) instead of continuing
   * on the old answer.
   */
  duplicateTurn: boolean;
  /**
   * Persisted index the LAST incoming message was matched to, `-1` when no
   * incoming message matched (fresh thread, empty request, or the very first
   * incoming message is already new).
   */
  lastMatchedPersistedIndex: number;
}

/** Decision whether a duplicate turn is regenerated from its start. */
export type DuplicateTurnRegeneratePlan =
  | {
      kind: "regenerate";
      /** Persisted index of the user message whose turn is regenerated. */
      userIndex: number;
    }
  | {
      kind: "keep";
      reason:
        | "not_duplicate"
        | "last_incoming_not_user"
        | "not_latest_user_turn"
        | "nothing_to_replace";
    };

/** One checkpoint of a thread's history, as seen by the regenerate search. */
export interface RegenerateCheckpointCandidate {
  checkpointId: string;
  /** LangGraph checkpoint metadata `source` (`"input"`, `"loop"`, …). */
  source: string | undefined;
  messages: readonly BaseMessage[];
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
      lastMatchedPersistedIndex: -1,
    };
  }

  // Pre-compute the persisted fingerprints once: the walk is O(n·m) in the worst
  // case, but the cursor only ever moves forward, so in practice it is linear.
  const persistedKeys = persisted.map(fingerprint);

  let cursor = 0;
  let lastMatchedPersistedIndex = -1;
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
    lastMatchedPersistedIndex = matchedAt;
  }

  const tail = incoming.slice(firstNewIndex);
  return {
    messages: tail,
    incoming: incoming.length,
    dropped: incoming.length - tail.length,
    duplicateTurn: tail.length === 0,
    lastMatchedPersistedIndex,
  };
}

/**
 * Decides whether a duplicate turn is regenerated from its start.
 *
 * Regenerating means: fork from the checkpoint right before the repeated user
 * message and run the turn again, so the new answer REPLACES the old one in the
 * active thread. The messages reducer is append-only, so filtering the old
 * answer out of the prompt alone would still append a second answer to the
 * same turn; the fork keeps the thread consistent instead.
 *
 * Guard rails (anything else keeps today's behaviour):
 *   - the request must be a duplicate turn at all;
 *   - its last message must be a user message (a resent transcript ending on
 *     the assistant answer is not a regenerate request);
 *   - that message must have matched the LATEST user message of the thread, so
 *     a delta client repeating an older message ("ja") can never rewind later
 *     turns;
 *   - something must follow the user message, otherwise there is nothing to
 *     replace (the turn aborted before writing anything).
 *
 * Known limitation: a delta client (only the new message per request) that
 * sends the same short reply twice in a row as a REAL new turn — e.g. "ja"
 * after `[…, u:"ja", a:"Soll ich zusätzlich X prüfen?"]` — is indistinguishable
 * from a double submit. The previous answer is then replaced instead of
 * answered (before this regenerate path the new message was silently dropped
 * and the turn ran on the old answer; both are wrong, the ambiguity is in
 * {@link reconcileThreadedHistory}). Full-history clients are unaffected,
 * because their request then ends on a new, unmatched tail.
 *
 * @param persisted  - Messages in the latest checkpoint of the thread.
 * @param incoming   - Messages the request carried, in request order.
 * @param reconciled - Result of {@link reconcileThreadedHistory} for the same pair.
 */
export function planDuplicateTurnRegenerate(
  persisted: readonly BaseMessage[],
  incoming: readonly BaseMessage[],
  reconciled: ReconciledHistory,
): DuplicateTurnRegeneratePlan {
  if (!reconciled.duplicateTurn) return { kind: "keep", reason: "not_duplicate" };
  const lastIncoming = incoming[incoming.length - 1];
  if (lastIncoming === undefined || lastIncoming._getType() !== "human") {
    return { kind: "keep", reason: "last_incoming_not_user" };
  }
  let latestUserIndex = -1;
  for (let j = persisted.length - 1; j >= 0; j--) {
    if ((persisted[j] as BaseMessage)._getType() === "human") {
      latestUserIndex = j;
      break;
    }
  }
  if (
    latestUserIndex === -1 ||
    reconciled.lastMatchedPersistedIndex !== latestUserIndex
  ) {
    return { kind: "keep", reason: "not_latest_user_turn" };
  }
  if (latestUserIndex >= persisted.length - 1) {
    return { kind: "keep", reason: "nothing_to_replace" };
  }
  return { kind: "regenerate", userIndex: latestUserIndex };
}

/**
 * Finds the checkpoint a regenerated turn forks from.
 *
 * That is the `source: "input"` checkpoint of the repeated turn: the state
 * right before the user message was appended, i.e. exactly the persisted
 * prefix `persisted[0..userIndex)`. Forking there with the user message as
 * input takes the same path as a brand-new turn.
 *
 * @param persisted  - Messages in the latest checkpoint of the thread.
 * @param userIndex  - Persisted index of the repeated user message.
 * @param candidates - Checkpoints of the thread, NEWEST FIRST.
 * @returns The checkpoint id, or `undefined` when no candidate matches.
 */
export function findRegenerateBaseCheckpoint(
  persisted: readonly BaseMessage[],
  userIndex: number,
  candidates: Iterable<RegenerateCheckpointCandidate>,
): string | undefined {
  const prefixKeys = persisted.slice(0, userIndex).map(fingerprint);
  for (const candidate of candidates) {
    if (candidate.source !== "input") continue;
    if (candidate.messages.length !== userIndex) continue;
    let matches = true;
    for (let i = 0; i < userIndex; i++) {
      if (fingerprint(candidate.messages[i] as BaseMessage) !== prefixKeys[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return candidate.checkpointId;
  }
  return undefined;
}

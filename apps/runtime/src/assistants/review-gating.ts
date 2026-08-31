// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Learning-pass gating (`src/assistants/review-gating.ts`)
 *
 * Decides whether a finished turn is worth a learning pass. Pure — no clock, no
 * I/O — so the policy can be read as a policy.
 *
 * This is the highest-leverage part of the self-improvement loop. A learning pass
 * costs a model round trip and can produce a permanent change to a prompt, so
 * running it on every turn is both expensive and actively harmful: most turns
 * teach nothing, and a system that captures from all of them fills up with
 * restatements of its own defaults.
 *
 * ## The signals, and why each one
 *
 * **Depth.** Fewer than {@link MIN_MODEL_ITERATIONS} assistant round trips means
 * the turn went straight through. A turn that went straight through has, by
 * construction, no recovery technique to extract.
 *
 * **Errored is excluded.** A turn that failed because a provider timed out or a
 * transport broke contains environment noise, not learnable technique. Worse, the
 * learning pass would run against the same provider and likely hit the same
 * failure.
 *
 * **Aborted is INCLUDED.** This is the non-obvious one. A user who stopped the
 * turn was usually watching it go wrong — that is precisely where corrective
 * evidence lives. Excluding aborted turns along with errored ones (the intuitive
 * grouping, since both are "unsuccessful") discards the richest source.
 *
 * **Background triggers are excluded.** A learning pass triggered by its own
 * output, or by a scheduled run, creates a feedback loop: the assistant learns
 * from itself learning, and the captured procedures drift away from anything a
 * user asked for.
 *
 * **Pending-proposal pressure.** Past {@link MAX_PENDING_PROPOSALS} undecided
 * proposals, capture stops. An assistant with a hundred pending proposals does not
 * need a hundred and one; it needs a human.
 *
 * No `any` at module boundaries.
 */

import {
  MAX_PENDING_PROPOSALS,
  type AssistantAutonomy,
  type AssistantTurnRecord,
  type TurnTrigger,
} from "./types.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Minimum assistant round trips in a turn before it is considered deep enough to
 * hold a reusable technique.
 *
 * Ten. Chosen to sit well above ordinary tool-assisted answers (which land at two
 * to four) so the bar selects turns where the model genuinely worked at something.
 */
export const MIN_MODEL_ITERATIONS = 10;

/** Triggers whose turns are never learned from. See the module note. */
const BLOCKED_TRIGGERS: ReadonlySet<TurnTrigger> = new Set<TurnTrigger>([
  // The learning pass itself. Learning from learning is a feedback loop.
  "learning",
  // Scheduled work is the assistant's own routine, not a user interaction.
  "schedule",
  // A turn triggered by another assistant's message carries foreign, untrusted
  // content as its premise; capturing from it would let one assistant write into
  // another's permanent prompt.
  "message",
]);

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/** Why a turn was not scheduled for a learning pass. */
export type ReviewSkipReason =
  | "learning-disabled"
  | "already-reviewed"
  | "errored-turn"
  | "blocked-trigger"
  | "below-depth-bar"
  | "pending-proposal-limit"
  | "assistant-inactive";

export type ReviewGateDecision =
  | { review: true /** Depth that qualified the turn, for the prompt. */; modelIterations: number }
  | { review: false; reason: ReviewSkipReason; detail: string };

export interface ReviewGateInput {
  turn: Pick<
    AssistantTurnRecord,
    "modelIterations" | "aborted" | "errored" | "trigger" | "reviewed"
  >;
  autonomy: AssistantAutonomy;
  assistantActive: boolean;
  /** Undecided proposals this assistant already has. */
  pendingProposals: number;
  /** Operator/user switch. When false, no learning happens at all. */
  learningEnabled: boolean;
  /** Override for the depth bar. Tests and tuning only. */
  minModelIterations?: number;
  /** Override for the pending cap. */
  maxPendingProposals?: number;
}

/**
 * Whether an autonomy level permits learning at all.
 *
 * Every level does, including `supervised`. Learning only ever *proposes* — the
 * pass cannot apply anything (see `experience-review.ts`, which grants it a
 * proposal-only budget), so capturing under supervision is safe and is in fact
 * the point: a supervised assistant accumulates suggestions for its user to
 * approve. Autonomy governs whether proposals AUTO-APPLY, which is a separate
 * decision made at apply time.
 */
export function autonomyAllowsLearning(_autonomy: AssistantAutonomy): boolean {
  return true;
}

/**
 * Whether a learned proposal may be applied without a human decision.
 *
 * Only `autonomous`. `assisted` deliberately does not: it grants background tool
 * use (the user consented to the assistant acting for them) which is a different
 * question from letting it rewrite its own instructions unattended.
 */
export function autonomyAllowsAutoApply(autonomy: AssistantAutonomy): boolean {
  return autonomy === "autonomous";
}

/** Decides whether a finished turn should get a learning pass. */
export function decideReviewGate(input: ReviewGateInput): ReviewGateDecision {
  if (!input.learningEnabled) {
    return {
      review: false,
      reason: "learning-disabled",
      detail: "Self-improvement is disabled for this deployment or assistant.",
    };
  }
  if (!input.assistantActive) {
    return {
      review: false,
      reason: "assistant-inactive",
      detail: "The assistant is suspended or archived.",
    };
  }
  if (input.turn.reviewed) {
    return {
      review: false,
      reason: "already-reviewed",
      detail: "This turn was already reviewed.",
    };
  }

  // Errored before aborted, deliberately: a turn can be both (a provider failure
  // the user then stopped), and in that case the environment noise dominates.
  if (input.turn.errored) {
    return {
      review: false,
      reason: "errored-turn",
      detail:
        "The turn failed for environmental reasons (provider or transport). That is noise, " +
        "not learnable technique, and a review would likely hit the same failure.",
    };
  }

  if (BLOCKED_TRIGGERS.has(input.turn.trigger)) {
    return {
      review: false,
      reason: "blocked-trigger",
      detail:
        `Turns triggered by "${input.turn.trigger}" are not learned from: learning from the ` +
        "assistant's own background work forms a feedback loop, and message-triggered turns " +
        "carry another assistant's untrusted content as their premise.",
    };
  }

  const minIterations = input.minModelIterations ?? MIN_MODEL_ITERATIONS;
  if (input.turn.modelIterations < minIterations) {
    return {
      review: false,
      reason: "below-depth-bar",
      detail:
        `The turn used ${input.turn.modelIterations} model round trips, below the bar of ${minIterations}. ` +
        "A turn that went straight through has no recovery technique to extract.",
    };
  }

  const maxPending = input.maxPendingProposals ?? MAX_PENDING_PROPOSALS;
  if (input.pendingProposals >= maxPending) {
    return {
      review: false,
      reason: "pending-proposal-limit",
      detail:
        `This assistant already has ${input.pendingProposals} undecided proposals (limit ${maxPending}). ` +
        "Capture pauses until some are decided.",
    };
  }

  // Aborted turns reach here on purpose — see the module note.
  return { review: true, modelIterations: input.turn.modelIterations };
}

// ---------------------------------------------------------------------------
// Turn fact extraction
// ---------------------------------------------------------------------------

/**
 * Counts assistant round trips in a message list.
 *
 * Exported because the caller records this as a turn fact rather than deriving it
 * later: the number is the learning gate's primary signal, and reconstructing it
 * from node events afterwards produces a different answer as soon as a sibling
 * node path changes.
 */
export function countModelIterations(messages: readonly { role?: string }[]): number {
  return messages.reduce((count, message) => count + (message.role === "assistant" ? 1 : 0), 0);
}

/**
 * Slices the message list down to the current turn.
 *
 * The learning pass must see one turn, not the whole conversation: a long thread
 * would blow the transcript budget and dilute the evidence with unrelated work.
 * The turn starts at the LAST user message.
 */
export function currentTurnMessages<T extends { role?: string }>(messages: readonly T[]): T[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index);
  }
  return [...messages];
}

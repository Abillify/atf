// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Learning-pass scheduler (`src/assistants/experience-review.ts`)
 *
 * Runs the post-turn learning pass at a moment when it costs the user nothing.
 *
 * ## Why it is scheduled and not inline
 *
 * A learning pass is a model round trip. Running it inside the turn adds its
 * latency to every deep answer, and running it immediately after still competes
 * with the user's next message. So it is armed on an idle timer and re-armed by
 * any further activity in the same conversation: the pass fires only once the
 * conversation has actually gone quiet.
 *
 * ## The three guards
 *
 * **Idle re-arming.** Each new turn in a conversation pushes the timer out. A user
 * in a rapid back-and-forth never triggers a pass mid-conversation.
 *
 * **A single in-flight latch.** One pass at a time, process-wide. Without it a
 * deployment with many assistants going quiet together would fire dozens of model
 * calls at once — an idle-triggered thundering herd, which is the worst possible
 * time to spend provider quota because nothing is waiting on it.
 *
 * **A bounded pending map.** Capped, oldest-evicted. A pass that never gets to run
 * must not keep a conversation's transcript alive indefinitely.
 *
 * ## Proposal-only budget
 *
 * The pass is granted a budget of exactly one proposal mutation and no ability to
 * apply, reject, or touch a live skill. That is what makes it safe to run it
 * against untrusted transcript content: even a fully successful injection can only
 * produce one pending proposal, which is then scanned and awaits a decision.
 *
 * No `any` at module boundaries.
 */

import type { Logger } from "../observability/logger.js";
import {
  autonomyAllowsAutoApply,
  decideReviewGate,
  type ReviewGateInput,
} from "./review-gating.js";
import type { AssistantScope, AssistantTurnRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Quiet period after the last turn before a pass may fire. */
export const REVIEW_IDLE_MS = 30_000;

/** Re-arm delay when the pass could not run (busy latch, still active). */
export const REVIEW_RETRY_IDLE_MS = 30_000;

/** Hard ceiling on one pass. */
export const REVIEW_TIMEOUT_MS = 120_000;

/**
 * Conversations that may be waiting for a pass at once.
 *
 * Thirty-two. Beyond this the oldest is dropped: the transcript it holds is a
 * bounded but non-trivial amount of memory, and a pass that has been waiting
 * behind thirty others is reviewing stale evidence anyway.
 */
export const MAX_PENDING_REVIEWS = 32;

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/** Everything a pass needs, captured at turn end. */
export interface ReviewCandidate {
  scope: AssistantScope;
  /** Conversation this turn belonged to. Keys the pending map and the timer. */
  conversationKey: string;
  executionId: string;
  turn: Pick<
    AssistantTurnRecord,
    "modelIterations" | "aborted" | "errored" | "trigger" | "reviewed"
  >;
  /** Rendered transcript of the turn. Bounded by the caller. */
  transcript: string;
  /** Autonomy at turn time, deciding whether a resulting proposal auto-applies. */
  autonomy: ReviewGateInput["autonomy"];
}

/** What the runner does with a candidate. Injected so the scheduler has no I/O. */
export type ReviewRunner = (candidate: ReviewCandidate) => Promise<void>;

/**
 * Late-bound eligibility check.
 *
 * Separate from the gate because two of its inputs — the pending-proposal count
 * and whether the assistant is still active — can change between arming the timer
 * and its firing thirty seconds later. Reading them at arm time would decide on
 * stale state.
 */
export type ReviewPreflight = (candidate: ReviewCandidate) => Promise<ReviewGateInput | undefined>;

export interface ReviewSchedulerDeps {
  runReview: ReviewRunner;
  preflight: ReviewPreflight;
  /** True while the conversation is still producing turns. */
  isConversationActive?: (conversationKey: string) => boolean;
  logger?: Logger;
  /** Injected timers so tests need no real waiting. */
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  idleMs?: number;
  retryIdleMs?: number;
  maxPending?: number;
}

interface PendingReview {
  candidate: ReviewCandidate;
  /**
   * Incremented on each re-arm. A timer callback compares it against the current
   * value and returns if they differ, so a superseded timer that already fired
   * cannot run a stale candidate.
   */
  generation: number;
  timer?: unknown;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Arms, re-arms, and fires learning passes. */
export class ExperienceReviewScheduler {
  private readonly pending = new Map<string, PendingReview>();
  private inFlight = false;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly idleMs: number;
  private readonly retryIdleMs: number;
  private readonly maxPending: number;

  constructor(private readonly deps: ReviewSchedulerDeps) {
    this.setTimer =
      deps.setTimer ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        // Unref so a pending learning pass never keeps the process alive on
        // shutdown; the work is discretionary by definition.
        (timer as unknown as { unref?: () => void }).unref?.();
        return timer;
      });
    this.clearTimer =
      deps.clearTimer ??
      ((timer) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      });
    this.idleMs = deps.idleMs ?? REVIEW_IDLE_MS;
    this.retryIdleMs = deps.retryIdleMs ?? REVIEW_RETRY_IDLE_MS;
    this.maxPending = deps.maxPending ?? MAX_PENDING_REVIEWS;
  }

  /**
   * Offers a finished turn for review.
   *
   * Always re-arms an existing pending review for the same conversation, even when
   * this particular turn is not itself a candidate: quiet time must follow ALL
   * later activity in the conversation, not just the last learnable turn.
   */
  schedule(candidate: ReviewCandidate): void {
    const key = candidate.conversationKey;
    const existing = this.pending.get(key);

    if (existing !== undefined) {
      // An errored turn from the same execution invalidates the evidence we were
      // holding: the run we wanted to learn from ended in environment noise.
      if (candidate.turn.errored && candidate.executionId === existing.candidate.executionId) {
        this.cancel(key);
        return;
      }
      this.arm(key, existing, this.idleMs);
    }

    // Cheap local rejections happen here; the full gate runs in preflight at fire
    // time, because its inputs can change while the timer waits.
    if (candidate.turn.errored || candidate.turn.reviewed) return;

    const decision = decideReviewGate({
      turn: candidate.turn,
      autonomy: candidate.autonomy,
      assistantActive: true,
      pendingProposals: 0,
      learningEnabled: true,
    });
    if (!decision.review) {
      this.deps.logger?.debug("Learning pass not scheduled", {
        assistantId: candidate.scope.assistantId,
        reason: decision.reason,
      });
      return;
    }

    if (existing === undefined && this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next();
      if (!oldest.done) this.cancel(oldest.value);
    }

    const entry: PendingReview = existing ?? { candidate, generation: 0 };
    // The newest qualifying turn replaces the held evidence: later evidence from
    // the same conversation is strictly more relevant.
    entry.candidate = candidate;
    this.pending.set(key, entry);
    this.arm(key, entry, this.idleMs);
    this.deps.logger?.debug("Learning pass scheduled", {
      assistantId: candidate.scope.assistantId,
      iterations: candidate.turn.modelIterations,
      aborted: candidate.turn.aborted,
    });
  }

  private arm(key: string, entry: PendingReview, delayMs: number): void {
    if (entry.timer !== undefined) this.clearTimer(entry.timer);
    entry.generation += 1;
    const generation = entry.generation;
    entry.timer = this.setTimer(() => {
      void this.fire(key, entry, generation);
    }, delayMs);
  }

  private async fire(key: string, entry: PendingReview, generation: number): Promise<void> {
    // Superseded while the timer was pending.
    if (this.pending.get(key) !== entry || entry.generation !== generation) {
      return;
    }
    entry.timer = undefined;

    if (this.deps.isConversationActive?.(key) === true) {
      this.arm(key, entry, this.retryIdleMs);
      return;
    }
    // The latch, not a queue: waiting passes re-arm rather than piling up, so a
    // burst of simultaneously-idle assistants is spread out instead of arriving as
    // one wave of model calls.
    if (this.inFlight) {
      this.arm(key, entry, this.retryIdleMs);
      return;
    }

    this.inFlight = true;
    try {
      const gateInput = await this.deps.preflight(entry.candidate);
      if (gateInput === undefined) {
        this.cancel(key);
        return;
      }
      const decision = decideReviewGate(gateInput);
      if (!decision.review) {
        this.deps.logger?.debug("Learning pass dropped at preflight", {
          assistantId: entry.candidate.scope.assistantId,
          reason: decision.reason,
        });
        this.cancel(key);
        return;
      }
      // Re-check after the awaits: the entry may have been superseded or cancelled
      // while preflight was in flight.
      if (this.pending.get(key) !== entry || entry.generation !== generation) {
        return;
      }
      await this.deps.runReview(entry.candidate);
      if (this.pending.get(key) === entry && entry.generation === generation) {
        this.cancel(key);
      }
    } catch (err) {
      this.deps.logger?.warn("Learning pass failed", {
        assistantId: entry.candidate.scope.assistantId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Re-arm rather than drop: the failure may have been transient, and the
      // evidence is still valid. A permanently failing pass re-arms forever but
      // fires at most once per retry window, which is bounded and visible in the
      // log rather than silently losing the capability.
      if (this.pending.get(key) === entry) {
        this.arm(key, entry, this.retryIdleMs);
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** Drops a pending review and its timer. */
  cancel(conversationKey: string): void {
    const entry = this.pending.get(conversationKey);
    if (entry === undefined) return;
    if (entry.timer !== undefined) this.clearTimer(entry.timer);
    this.pending.delete(conversationKey);
  }

  /** Drops every pending review. Called on shutdown and by tests. */
  clear(): void {
    for (const key of [...this.pending.keys()]) this.cancel(key);
  }

  /** Number of conversations awaiting a pass. */
  size(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Auto-apply
// ---------------------------------------------------------------------------

/** What should happen to a proposal a learning pass just produced. */
export type CaptureDisposition =
  | { action: "await-decision"; reason: string }
  | { action: "apply-as-canary"; reason: string };

/**
 * Decides whether a freshly captured proposal auto-applies.
 *
 * Auto-apply always goes through a CANARY, never straight to full injection, even
 * at `autonomous`. The reason is that the safety scan proves a procedure is not
 * dangerous, which is a different claim from it being useful — and a useless
 * procedure injected into every turn costs prompt budget and misdirects the model
 * indefinitely. The canary is what turns "not dangerous" into "actually helps".
 */
export function decideCaptureDisposition(params: {
  autonomy: ReviewGateInput["autonomy"];
  scanClean: boolean;
  autonomousCapture: boolean;
}): CaptureDisposition {
  if (!params.scanClean) {
    return {
      action: "await-decision",
      reason: "The safety scan did not pass, so the proposal cannot be applied automatically.",
    };
  }
  if (!params.autonomousCapture) {
    return {
      action: "await-decision",
      reason: "The proposal was authored by a person, so the decision stays with a person.",
    };
  }
  if (!autonomyAllowsAutoApply(params.autonomy)) {
    return {
      action: "await-decision",
      reason:
        `Autonomy is "${params.autonomy}", which does not permit applying a learned procedure ` +
        "without a decision. The proposal is waiting for its user.",
    };
  }
  return {
    action: "apply-as-canary",
    reason:
      "Applied as a canary: the scan shows it is safe, and the canary establishes whether it actually helps.",
  };
}

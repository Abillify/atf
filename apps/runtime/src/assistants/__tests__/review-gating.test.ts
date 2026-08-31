// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Learning-pass gating.
 *
 * The load-bearing assertion here is that an ABORTED turn is eligible while an
 * ERRORED one is not. Grouping them together (both are "unsuccessful") is the
 * intuitive reading and would discard the richest source of corrective evidence,
 * so it is pinned by a test rather than left to a comment.
 */
import { describe, expect, test } from "bun:test";
import {
  MIN_MODEL_ITERATIONS,
  autonomyAllowsAutoApply,
  autonomyAllowsLearning,
  countModelIterations,
  currentTurnMessages,
  decideReviewGate,
  type ReviewGateInput,
} from "../review-gating.js";

function gate(overrides: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return {
    turn: {
      modelIterations: 12,
      aborted: false,
      errored: false,
      trigger: "user",
      reviewed: false,
    },
    autonomy: "supervised",
    assistantActive: true,
    pendingProposals: 0,
    learningEnabled: true,
    ...overrides,
  };
}

describe("aborted versus errored", () => {
  test("an aborted turn IS reviewed", () => {
    // A user who stopped the turn was usually watching it go wrong. That is where
    // corrective evidence lives.
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: 14,
          aborted: true,
          errored: false,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    expect(decision.review).toBe(true);
  });

  test("an errored turn is NOT reviewed", () => {
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: 14,
          aborted: false,
          errored: true,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    expect(decision).toMatchObject({ review: false, reason: "errored-turn" });
  });

  test("a turn that is both errored and aborted counts as errored", () => {
    // Environment noise dominates: a provider failure the user then stopped
    // teaches nothing about technique.
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: 14,
          aborted: true,
          errored: true,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    expect(decision).toMatchObject({ review: false, reason: "errored-turn" });
  });
});

describe("depth bar", () => {
  test("a shallow turn is skipped", () => {
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: MIN_MODEL_ITERATIONS - 1,
          aborted: false,
          errored: false,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    expect(decision).toMatchObject({
      review: false,
      reason: "below-depth-bar",
    });
  });

  test("exactly at the bar qualifies", () => {
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: MIN_MODEL_ITERATIONS,
          aborted: false,
          errored: false,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    expect(decision.review).toBe(true);
  });
});

describe("blocked triggers", () => {
  test.each(["learning", "schedule", "message"] as const)("%s is never learned from", (trigger) => {
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: 20,
          aborted: false,
          errored: false,
          trigger,
          reviewed: false,
        },
      }),
    );
    expect(decision).toMatchObject({
      review: false,
      reason: "blocked-trigger",
    });
  });

  test.each(["user", "api"] as const)("%s is eligible", (trigger) => {
    const decision = decideReviewGate(
      gate({
        turn: {
          modelIterations: 20,
          aborted: false,
          errored: false,
          trigger,
          reviewed: false,
        },
      }),
    );
    expect(decision.review).toBe(true);
  });
});

describe("other refusals", () => {
  test("learning can be switched off entirely", () => {
    expect(decideReviewGate(gate({ learningEnabled: false }))).toMatchObject({
      review: false,
      reason: "learning-disabled",
    });
  });

  test("an inactive assistant does not learn", () => {
    expect(decideReviewGate(gate({ assistantActive: false }))).toMatchObject({
      review: false,
      reason: "assistant-inactive",
    });
  });

  test("an already-reviewed turn is not reviewed twice", () => {
    expect(
      decideReviewGate(
        gate({
          turn: {
            modelIterations: 20,
            aborted: false,
            errored: false,
            trigger: "user",
            reviewed: true,
          },
        }),
      ),
    ).toMatchObject({ review: false, reason: "already-reviewed" });
  });

  test("capture pauses at the pending-proposal cap", () => {
    // An assistant with a backlog of undecided proposals needs a human, not
    // another proposal.
    expect(decideReviewGate(gate({ pendingProposals: 32 }))).toMatchObject({
      review: false,
      reason: "pending-proposal-limit",
    });
  });
});

describe("autonomy", () => {
  test.each(["supervised", "assisted", "autonomous"] as const)(
    "%s may learn (learning only proposes)",
    (autonomy) => {
      expect(autonomyAllowsLearning(autonomy)).toBe(true);
      expect(decideReviewGate(gate({ autonomy })).review).toBe(true);
    },
  );

  test("only autonomous may auto-apply", () => {
    // `assisted` grants background TOOL use, which is a different question from
    // letting the assistant rewrite its own instructions unattended.
    expect(autonomyAllowsAutoApply("supervised")).toBe(false);
    expect(autonomyAllowsAutoApply("assisted")).toBe(false);
    expect(autonomyAllowsAutoApply("autonomous")).toBe(true);
  });
});

describe("turn fact extraction", () => {
  test("counts assistant messages only", () => {
    expect(
      countModelIterations([
        { role: "user" },
        { role: "assistant" },
        { role: "tool" },
        { role: "assistant" },
      ]),
    ).toBe(2);
  });

  test("the turn starts at the last user message", () => {
    const messages = [
      { role: "user", id: 1 },
      { role: "assistant", id: 2 },
      { role: "user", id: 3 },
      { role: "assistant", id: 4 },
    ];
    expect(currentTurnMessages(messages).map((m) => m.id)).toEqual([3, 4]);
  });

  test("with no user message the whole list is the turn", () => {
    const messages = [{ role: "assistant", id: 1 }];
    expect(currentTurnMessages(messages)).toEqual(messages);
  });
});

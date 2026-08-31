// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Learning-pass scheduler — idle re-arming, the single-flight latch, bounds, and
 * the auto-apply disposition.
 *
 * Timers are injected, so these run instantly and deterministically rather than
 * waiting out a 30-second idle window.
 */
import { describe, expect, test } from "bun:test";
import {
  ExperienceReviewScheduler,
  decideCaptureDisposition,
  type ReviewCandidate,
} from "../experience-review.js";
import type { ReviewGateInput } from "../review-gating.js";

const SCOPE = { tenantId: "_", userId: "u@example.com", assistantId: "molty" };

function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    scope: SCOPE,
    conversationKey: "conv-1",
    executionId: "exec-1",
    turn: {
      modelIterations: 12,
      aborted: false,
      errored: false,
      trigger: "user",
      reviewed: false,
    },
    transcript: "[user]\nDo the thing\n\n[assistant]\nDone.",
    autonomy: "autonomous",
    ...overrides,
  };
}

/** Controllable timer queue so the tests never actually wait. */
function timerHarness() {
  let nextId = 1;
  const queued = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    setTimer: (callback: () => void, delayMs: number): unknown => {
      const id = nextId++;
      queued.set(id, { callback, delayMs });
      return id;
    },
    clearTimer: (timer: unknown): void => {
      queued.delete(timer as number);
    },
    /** Fires every currently queued timer. */
    async flush(): Promise<void> {
      const pending = [...queued.entries()];
      queued.clear();
      for (const [, entry] of pending) entry.callback();
      // Let the async fire() body settle.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    delays(): number[] {
      return [...queued.values()].map((e) => e.delayMs);
    },
    count(): number {
      return queued.size;
    },
  };
}

function passingPreflight(
  overrides: Partial<ReviewGateInput> = {},
): (c: ReviewCandidate) => Promise<ReviewGateInput | undefined> {
  return async (c) => ({
    turn: c.turn,
    autonomy: c.autonomy,
    assistantActive: true,
    pendingProposals: 0,
    learningEnabled: true,
    ...overrides,
  });
}

describe("scheduling", () => {
  test("a qualifying turn is armed", () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {},
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    expect(scheduler.size()).toBe(1);
    expect(timers.count()).toBe(1);
  });

  test("a non-qualifying turn is not armed", () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {},
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(
      candidate({
        turn: {
          modelIterations: 2,
          aborted: false,
          errored: false,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    expect(scheduler.size()).toBe(0);
  });

  test("a later turn re-arms rather than queueing a second pass", () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {},
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate({ executionId: "exec-1" }));
    scheduler.schedule(candidate({ executionId: "exec-2" }));
    // Quiet time must follow ALL later activity in the conversation.
    expect(scheduler.size()).toBe(1);
    expect(timers.count()).toBe(1);
  });

  test("a shallow later turn still pushes the timer out", async () => {
    const timers = timerHarness();
    const runs: string[] = [];
    const scheduler = new ExperienceReviewScheduler({
      runReview: async (c) => {
        runs.push(c.executionId);
      },
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate({ executionId: "deep" }));
    // Shallow: not a candidate itself, but it IS activity.
    scheduler.schedule(
      candidate({
        executionId: "shallow",
        turn: {
          modelIterations: 1,
          aborted: false,
          errored: false,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    await timers.flush();
    // The deep turn's evidence is still what gets reviewed.
    expect(runs).toEqual(["deep"]);
  });

  test("an errored turn from the same execution cancels the pending review", () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {},
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate({ executionId: "exec-1" }));
    scheduler.schedule(
      candidate({
        executionId: "exec-1",
        turn: {
          modelIterations: 12,
          aborted: false,
          errored: true,
          trigger: "user",
          reviewed: false,
        },
      }),
    );
    // The run we wanted to learn from ended in environment noise.
    expect(scheduler.size()).toBe(0);
  });
});

describe("firing", () => {
  test("the pass runs when the conversation is quiet", async () => {
    const timers = timerHarness();
    const runs: ReviewCandidate[] = [];
    const scheduler = new ExperienceReviewScheduler({
      runReview: async (c) => {
        runs.push(c);
      },
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    await timers.flush();
    expect(runs.length).toBe(1);
    expect(scheduler.size()).toBe(0);
  });

  test("an active conversation re-arms instead of running", async () => {
    const timers = timerHarness();
    let ran = 0;
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {
        ran += 1;
      },
      preflight: passingPreflight(),
      isConversationActive: () => true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    await timers.flush();
    expect(ran).toBe(0);
    // Re-armed, not dropped.
    expect(scheduler.size()).toBe(1);
    expect(timers.count()).toBe(1);
  });

  test("preflight can drop a candidate that became ineligible while waiting", async () => {
    const timers = timerHarness();
    let ran = 0;
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {
        ran += 1;
      },
      // The pending-proposal count and active status can change during the idle
      // window, which is why they are read here and not at arm time.
      preflight: passingPreflight({ pendingProposals: 99 }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    await timers.flush();
    expect(ran).toBe(0);
    expect(scheduler.size()).toBe(0);
  });

  test("preflight returning undefined drops the candidate", async () => {
    const timers = timerHarness();
    let ran = 0;
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {
        ran += 1;
      },
      preflight: async () => undefined,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    await timers.flush();
    expect(ran).toBe(0);
    expect(scheduler.size()).toBe(0);
  });

  test("a failing pass re-arms rather than losing the capability", async () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {
        throw new Error("provider unavailable");
      },
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    await timers.flush();
    expect(scheduler.size()).toBe(1);
    expect(timers.count()).toBe(1);
  });
});

describe("single-flight latch", () => {
  test("only one pass runs at a time across conversations", async () => {
    const timers = timerHarness();
    let concurrent = 0;
    let maxConcurrent = 0;
    let release: (() => void) | undefined;
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        concurrent -= 1;
      },
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate({ conversationKey: "a", executionId: "e-a" }));
    scheduler.schedule(candidate({ conversationKey: "b", executionId: "e-b" }));
    expect(scheduler.size()).toBe(2);

    await timers.flush();
    // The second conversation must have re-armed rather than started a parallel
    // model call — an idle-triggered thundering herd is the worst time to spend
    // provider quota, because nothing is waiting on it.
    expect(maxConcurrent).toBe(1);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.count()).toBeGreaterThanOrEqual(1);
  });
});

describe("bounds", () => {
  test("the pending map is capped and evicts the oldest", () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {},
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      maxPending: 3,
    });
    for (let index = 0; index < 5; index += 1) {
      scheduler.schedule(
        candidate({
          conversationKey: `conv-${index}`,
          executionId: `exec-${index}`,
        }),
      );
    }
    expect(scheduler.size()).toBe(3);
  });

  test("clear drops everything", () => {
    const timers = timerHarness();
    const scheduler = new ExperienceReviewScheduler({
      runReview: async () => {},
      preflight: passingPreflight(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.schedule(candidate());
    scheduler.clear();
    expect(scheduler.size()).toBe(0);
    expect(timers.count()).toBe(0);
  });
});

describe("capture disposition", () => {
  test("an unclean scan never auto-applies", () => {
    expect(
      decideCaptureDisposition({
        autonomy: "autonomous",
        scanClean: false,
        autonomousCapture: true,
      }).action,
    ).toBe("await-decision");
  });

  test("a human-authored proposal keeps a human decision", () => {
    expect(
      decideCaptureDisposition({
        autonomy: "autonomous",
        scanClean: true,
        autonomousCapture: false,
      }).action,
    ).toBe("await-decision");
  });

  test.each(["supervised", "assisted"] as const)("%s autonomy waits for a decision", (autonomy) => {
    expect(
      decideCaptureDisposition({
        autonomy,
        scanClean: true,
        autonomousCapture: true,
      }).action,
    ).toBe("await-decision");
  });

  test("autonomous auto-applies AS A CANARY, never straight to full injection", () => {
    // The scan proves a procedure is not dangerous. That is a different claim from
    // it being useful, and a useless procedure in every prompt costs budget and
    // misdirects the model indefinitely.
    const disposition = decideCaptureDisposition({
      autonomy: "autonomous",
      scanClean: true,
      autonomousCapture: true,
    });
    expect(disposition.action).toBe("apply-as-canary");
  });
});

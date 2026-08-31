// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for mergeHarnessProgress (src/graph/agent-harness.ts).
 *
 * Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent
 *
 * Validates: Requirements 10.1, 10.2
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  mergeHarnessProgress,
  type HarnessProgress,
  type Task,
  type TaskStatus,
  type StopReason,
} from "../agent-harness.js";

/** `mergeHarnessProgress`, asserting a merge always happens for defined inputs. */
function mergeDefined(
  left: HarnessProgress | undefined,
  right: HarnessProgress | undefined,
): HarnessProgress {
  const merged = mergeHarnessProgress(left, right);
  if (merged === undefined) throw new Error("expected a merged progress");
  return merged;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbTaskStatus: fc.Arbitrary<TaskStatus> = fc.constantFrom(
  "pending",
  "in-progress",
  "completed",
  "failed",
);

const arbStopReason: fc.Arbitrary<StopReason> = fc.constantFrom(
  "completed",
  "no-tasks",
  "iteration-limit",
  "cost-limit",
  "time-limit",
  "planning-failure",
  "exhausted",
);

const arbTaskId: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom("t", "a", "b", "c", "d", "0", "1", "2", "3", "4", "5"),
    minLength: 1,
    maxLength: 4,
  })
  .map((s) => `t${s}`);

const arbTask: fc.Arbitrary<Task> = fc.record({
  id: arbTaskId,
  description: fc.string({ minLength: 1, maxLength: 30 }),
  target: fc.string({
    unit: fc.constantFrom("w", "o", "r", "k", "e", "1", "2"),
    minLength: 1,
    maxLength: 8,
  }),
  status: arbTaskStatus,
  result: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  error: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});

/** Generate a list of tasks with unique ids. */
const arbUniqueTasks: fc.Arbitrary<Task[]> = fc
  .array(arbTask, { minLength: 0, maxLength: 6 })
  .map((tasks) => {
    const seen = new Set<string>();
    return tasks.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  });

const arbHarnessProgress: fc.Arbitrary<HarnessProgress> = fc
  .record({
    tasks: arbUniqueTasks,
    iterations: fc.nat({ max: 100 }),
    cost: fc.double({ min: 0, max: 1000, noNaN: true }),
    stopReason: fc.option(arbStopReason, { nil: undefined }),
    partial: fc.option(fc.boolean(), { nil: undefined }),
    statusMessage: fc.option(fc.string({ maxLength: 30 }), { nil: undefined }),
    droppedTargets: fc.option(
      fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 5 }),
      { nil: undefined },
    ),
  })
  .map((r) => {
    const base: HarnessProgress = {
      tasks: r.tasks,
      iterations: r.iterations,
      cost: r.cost,
    };
    if (r.stopReason !== undefined) base.stopReason = r.stopReason;
    if (r.partial !== undefined) base.partial = r.partial;
    if (r.statusMessage !== undefined) base.statusMessage = r.statusMessage;
    if (r.droppedTargets !== undefined) base.droppedTargets = r.droppedTargets;
    return base;
  });

const arbOptionalProgress: fc.Arbitrary<HarnessProgress | undefined> =
  fc.option(arbHarnessProgress, { nil: undefined });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent", () => {
  test("merge-by-id: tasks with the same id take the right value", () => {
    // Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent
    fc.assert(
      fc.property(arbHarnessProgress, arbHarnessProgress, (left, right) => {
        const merged = mergeDefined(left, right);

        // For every task in right, the merged result must contain the right's version
        for (const rTask of right.tasks) {
          const found = merged.tasks.find((t) => t.id === rTask.id);
          expect(found).toEqual(rTask);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("new ids from right are appended to the merged result", () => {
    // Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent
    fc.assert(
      fc.property(arbHarnessProgress, arbHarnessProgress, (left, right) => {
        const merged = mergeDefined(left, right);

        // All ids from left and right must be present in the merged tasks
        const leftIds = new Set(left.tasks.map((t) => t.id));
        const rightIds = new Set(right.tasks.map((t) => t.id));
        const mergedIds = new Set(merged.tasks.map((t) => t.id));

        for (const id of leftIds) {
          expect(mergedIds.has(id)).toBe(true);
        }
        for (const id of rightIds) {
          expect(mergedIds.has(id)).toBe(true);
        }

        // The total unique ids should be the union
        const expectedSize = new Set([...leftIds, ...rightIds]).size;
        expect(merged.tasks.length).toBe(expectedSize);
      }),
      { numRuns: 200 },
    );
  });

  test("scalar fields (iterations, costUsd) always take the right value", () => {
    // Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent
    fc.assert(
      fc.property(arbHarnessProgress, arbHarnessProgress, (left, right) => {
        const merged = mergeDefined(left, right);

        expect(merged.iterations).toBe(right.iterations);
        expect(merged.cost).toBe(right.cost);

        // Optional scalar fields take right's value when defined
        if (right.stopReason !== undefined) {
          expect(merged.stopReason).toBe(right.stopReason);
        } else {
          expect(merged.stopReason).toBeUndefined();
        }

        if (right.partial !== undefined) {
          expect(merged.partial).toBe(right.partial);
        } else {
          expect(merged.partial).toBeUndefined();
        }

        if (right.statusMessage !== undefined) {
          expect(merged.statusMessage).toBe(right.statusMessage);
        } else {
          expect(merged.statusMessage).toBeUndefined();
        }

        if (right.droppedTargets !== undefined) {
          expect(merged.droppedTargets).toEqual(right.droppedTargets);
        } else {
          expect(merged.droppedTargets).toBeUndefined();
        }
      }),
      { numRuns: 200 },
    );
  });

  test("idempotent: merge(merge(a,b),b) deep equals merge(a,b)", () => {
    // Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent
    fc.assert(
      fc.property(arbOptionalProgress, arbOptionalProgress, (a, b) => {
        const mergeOnce = mergeHarnessProgress(a, b);
        const mergeTwice = mergeHarnessProgress(mergeOnce, b);

        expect(mergeTwice).toEqual(mergeOnce);
      }),
      { numRuns: 200 },
    );
  });

  test("right === undefined is identity (returns left unchanged)", () => {
    // Feature: agent-harness-node, Property 22: Progress reducer merges incrementally and is idempotent
    fc.assert(
      fc.property(arbOptionalProgress, (left) => {
        const merged = mergeHarnessProgress(left, undefined);
        expect(merged).toBe(left);
      }),
      { numRuns: 100 },
    );
  });
});

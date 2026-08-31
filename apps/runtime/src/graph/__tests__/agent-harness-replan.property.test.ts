// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for mergeReplan (src/graph/agent-harness.ts).
 *
 * Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks
 *
 * Validates: Requirements 4.4
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { mergeReplan, type Task, type TaskStatus } from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbTaskStatus: fc.Arbitrary<TaskStatus> = fc.constantFrom(
  "pending",
  "in-progress",
  "completed",
  "failed",
);

const arbTarget: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom("w", "o", "r", "k", "e", "1", "2"),
  minLength: 1,
  maxLength: 8,
});

/** Generate a task with a given id and status. */
function arbTaskWith(
  id: string,
  status: fc.Arbitrary<TaskStatus>,
): fc.Arbitrary<Task> {
  return fc.record({
    id: fc.constant(id),
    description: fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((description) => description.trim().length > 0),
    target: arbTarget,
    status,
    result: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    error: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
  });
}

/** Generate a task list with unique sequential ids and mixed statuses. */
const arbCurrentTasks: fc.Arbitrary<Task[]> = fc
  .nat({ max: 8 })
  .chain((n): fc.Arbitrary<Task[]> => {
    if (n === 0) return fc.constant([] as Task[]);
    const arbs = Array.from({ length: n }, (_, i) =>
      arbTaskWith(`t${i + 1}`, arbTaskStatus),
    );
    return fc.tuple(...(arbs as [fc.Arbitrary<Task>, ...fc.Arbitrary<Task>[]]));
  })
  .map((t) => (Array.isArray(t) ? t : []));

/** Generate replan tasks with unique ids starting from a given offset. */
function arbReplanTasks(offset: number): fc.Arbitrary<Task[]> {
  return fc
    .nat({ max: 6 })
    .chain((n): fc.Arbitrary<Task[]> => {
      if (n === 0) return fc.constant([] as Task[]);
      const arbs = Array.from({ length: n }, (_, i) =>
        arbTaskWith(`r${offset + i + 1}`, fc.constant("pending" as TaskStatus)),
      );
      return fc.tuple(
        ...(arbs as [fc.Arbitrary<Task>, ...fc.Arbitrary<Task>[]]),
      );
    })
    .map((t) => (Array.isArray(t) ? t : []));
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks", () => {
  test("all completed/failed tasks from currentTasks appear unchanged in the result", () => {
    // Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks
    fc.assert(
      fc.property(arbCurrentTasks, arbReplanTasks(100), (current, replan) => {
        const result = mergeReplan(current, replan);

        const settled = current.filter(
          (t) => t.status === "completed" || t.status === "failed",
        );

        // Every settled task must appear in the result, deep equal
        for (const s of settled) {
          const found = result.find((t) => t.id === s.id);
          expect(found).toEqual(s);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("no pending/in-progress tasks from currentTasks appear in the result", () => {
    // Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks
    fc.assert(
      fc.property(arbCurrentTasks, arbReplanTasks(100), (current, replan) => {
        const result = mergeReplan(current, replan);

        const unsettled = current.filter(
          (t) => t.status === "pending" || t.status === "in-progress",
        );

        const resultIds = new Set(result.map((t) => t.id));

        for (const u of unsettled) {
          expect(resultIds.has(u.id)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("all replanTasks appear after settled tasks in the result", () => {
    // Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks
    fc.assert(
      fc.property(arbCurrentTasks, arbReplanTasks(100), (current, replan) => {
        const result = mergeReplan(current, replan);

        const settledCount = current.filter(
          (t) => t.status === "completed" || t.status === "failed",
        ).length;

        // Re-plan tasks occupy the new pending region and receive contiguous
        // visible steps after the settled history.
        const replanRegion = result.slice(settledCount);
        expect(replanRegion).toEqual(
          replan.map((task, index) => ({
            ...task,
            displayStep: settledCount + index + 1,
            replanned: true,
          })),
        );
      }),
      { numRuns: 200 },
    );
  });

  test("result length equals count of settled in currentTasks + replanTasks.length", () => {
    // Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks
    fc.assert(
      fc.property(arbCurrentTasks, arbReplanTasks(100), (current, replan) => {
        const result = mergeReplan(current, replan);

        const settledCount = current.filter(
          (t) => t.status === "completed" || t.status === "failed",
        ).length;

        expect(result.length).toBe(settledCount + replan.length);
      }),
      { numRuns: 200 },
    );
  });

  test("settled tasks preserve their original relative order", () => {
    // Feature: agent-harness-node, Property 11: Re-plan preserves settled tasks
    fc.assert(
      fc.property(arbCurrentTasks, arbReplanTasks(100), (current, replan) => {
        const result = mergeReplan(current, replan);

        const settledFromCurrent = current.filter(
          (t) => t.status === "completed" || t.status === "failed",
        );
        const settledInResult = result.slice(0, settledFromCurrent.length);

        // Order must be preserved
        expect(settledInResult).toEqual(settledFromCurrent);
      }),
      { numRuns: 200 },
    );
  });
});

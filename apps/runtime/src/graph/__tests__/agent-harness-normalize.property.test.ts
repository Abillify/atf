// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Property tests for normalize (src/graph/agent-harness.ts).
 *
 * Feature: agent-harness-node, Property 5: Every task targets an allowlisted node
 * Feature: agent-harness-node, Property 6: Initial task-list invariant
 *
 * Validates: Requirements 2.4, 3.1, 3.2
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { normalize } from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a non-empty target name (simulates a valid node ID). */
const arbTargetName: fc.Arbitrary<string> = fc
  .string({
    unit: fc.constantFrom("a", "b", "c", "d", "e", "f", "w", "x", "1", "2", "3", "-"),
    minLength: 1,
    maxLength: 10,
  })
  .filter((s) => s.trim().length > 0);

/** Generate a non-empty description string. */
const arbDescription: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 40,
});

/** Generate a non-empty validTargets array with unique entries. */
const arbValidTargets: fc.Arbitrary<string[]> = fc
  .array(arbTargetName, { minLength: 1, maxLength: 8 })
  .map((targets) => [...new Set(targets)]);

/**
 * Generate a plan response item — the target may or may not be in validTargets.
 * We use a mix of valid targets and random "outside" targets to exercise filtering.
 */
function arbPlanResponse(validTargets: fc.Arbitrary<string[]>) {
  return validTargets.chain((vt) => {
    // For each item, randomly pick either a valid target or an invalid one
    const arbTarget = fc.oneof(
      { weight: 3, arbitrary: fc.constantFrom(...vt) },
      { weight: 2, arbitrary: arbTargetName },
    );
    const arbItem = fc.record({
      description: arbDescription,
      target: arbTarget,
    });
    return fc.tuple(
      fc.constant(vt),
      fc.array(arbItem, { minLength: 0, maxLength: 10 }),
    );
  });
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("Feature: agent-harness-node, Property 5: Every task targets an allowlisted node", () => {
  test("every retained task's target is in the validated allowlist even when the Planner names outside targets", () => {
    // Feature: agent-harness-node, Property 5: Every task targets an allowlisted node
    // **Validates: Requirements 2.4**
    fc.assert(
      fc.property(
        arbPlanResponse(arbValidTargets),
        ([validTargets, planResponse]) => {
          const tasks = normalize(planResponse, validTargets);
          const validSet = new Set(validTargets);

          for (const task of tasks) {
            expect(validSet.has(task.target)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("tasks with targets not in validTargets are dropped", () => {
    // Feature: agent-harness-node, Property 5: Every task targets an allowlisted node
    // **Validates: Requirements 2.4**
    fc.assert(
      fc.property(
        arbPlanResponse(arbValidTargets),
        ([validTargets, planResponse]) => {
          const tasks = normalize(planResponse, validTargets);
          const validSet = new Set(validTargets);

          // Count how many input items have valid targets
          const expectedCount = planResponse.filter((item) =>
            validSet.has(item.target),
          ).length;
          expect(tasks.length).toBe(expectedCount);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("if all plan targets are outside the allowlist, result is empty", () => {
    // Feature: agent-harness-node, Property 5: Every task targets an allowlisted node
    // **Validates: Requirements 2.4**
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            description: arbDescription,
            target: fc.constant("zzz-never-valid"),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (planResponse) => {
          const validTargets = ["alpha", "beta", "gamma"];
          const tasks = normalize(planResponse, validTargets);
          expect(tasks.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Feature: agent-harness-node, Property 6: Initial task-list invariant", () => {
  test("every retained task has a non-empty description, status pending, and an allowlisted target", () => {
    // Feature: agent-harness-node, Property 6: Initial task-list invariant
    // **Validates: Requirements 3.1, 3.2**
    fc.assert(
      fc.property(
        arbPlanResponse(arbValidTargets),
        ([validTargets, planResponse]) => {
          const tasks = normalize(planResponse, validTargets);
          const validSet = new Set(validTargets);

          for (const task of tasks) {
            // Non-empty description
            expect(task.description.length).toBeGreaterThan(0);
            // Status is pending
            expect(task.status).toBe("pending");
            // Target is in allowlist
            expect(validSet.has(task.target)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("every retained task has a valid sequential id pattern (t1, t2, ...)", () => {
    // Feature: agent-harness-node, Property 6: Initial task-list invariant
    // **Validates: Requirements 3.1, 3.2**
    fc.assert(
      fc.property(
        arbPlanResponse(arbValidTargets),
        ([validTargets, planResponse]) => {
          const tasks = normalize(planResponse, validTargets);

          for (const [i, task] of tasks.entries()) {
            expect(task.id).toBe(`t${i + 1}`);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("descriptions in the output match the corresponding valid input items in order", () => {
    // Feature: agent-harness-node, Property 6: Initial task-list invariant
    // **Validates: Requirements 3.1, 3.2**
    fc.assert(
      fc.property(
        arbPlanResponse(arbValidTargets),
        ([validTargets, planResponse]) => {
          const tasks = normalize(planResponse, validTargets);
          const validSet = new Set(validTargets);

          // Filter input to only valid items and compare descriptions
          const expectedItems = planResponse.filter((item) =>
            validSet.has(item.target),
          );
          expect(tasks.length).toBe(expectedItems.length);

          for (const [i, task] of tasks.entries()) {
            const expectedItem = expectedItems[i];
            if (expectedItem === undefined) throw new Error(`expected item at index ${i}`);
            expect(task.description).toBe(expectedItem.description);
            expect(task.target).toBe(expectedItem.target);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

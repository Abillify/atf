// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for mergeReplan (src/graph/agent-harness.ts).
 *
 * Validates: Requirements 4.4
 */

import { describe, it, expect } from "bun:test";
import { mergeReplan, renderTaskList, type Task } from "../agent-harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    description: `Task ${overrides.id}`,
    target: "worker-a",
    status: "pending",
    ...overrides,
  };
}

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("mergeReplan", () => {
  describe("preserves settled tasks", () => {
    it("keeps completed tasks unchanged", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed", result: "done" }),
        makeTask({ id: "t2", status: "pending" }),
      ];
      const replan: Task[] = [
        makeTask({ id: "t3", status: "pending", description: "new work" }),
      ];

      const result = mergeReplan(current, replan);
      expect(result[0]).toEqual(current[0]);
    });

    it("keeps failed tasks unchanged", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "failed", error: "timeout" }),
        makeTask({ id: "t2", status: "pending" }),
      ];
      const replan: Task[] = [makeTask({ id: "t3", status: "pending" })];

      const result = mergeReplan(current, replan);
      expect(result[0]).toEqual(current[0]);
    });

    it("preserves order of multiple settled tasks", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed", result: "a" }),
        makeTask({ id: "t2", status: "failed", error: "b" }),
        makeTask({ id: "t3", status: "completed", result: "c" }),
        makeTask({ id: "t4", status: "pending" }),
      ];
      const replan: Task[] = [makeTask({ id: "t5", status: "pending" })];

      const result = mergeReplan(current, replan);
      expect(at(result, 0).id).toBe("t1");
      expect(at(result, 1).id).toBe("t2");
      expect(at(result, 2).id).toBe("t3");
      expect(at(result, 0).status).toBe("completed");
      expect(at(result, 1).status).toBe("failed");
      expect(at(result, 2).status).toBe("completed");
    });
  });

  describe("replaces pending region", () => {
    it("removes pending tasks from current", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "pending" }),
        makeTask({ id: "t3", status: "pending" }),
      ];
      const replan: Task[] = [
        makeTask({ id: "t4", status: "pending", description: "replanned" }),
      ];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(2);
      expect(result.find((t) => t.id === "t2")).toBeUndefined();
      expect(result.find((t) => t.id === "t3")).toBeUndefined();
    });

    it("removes in-progress tasks from current", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "in-progress" }),
      ];
      const replan: Task[] = [makeTask({ id: "t5", status: "pending" })];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(2);
      expect(result.find((t) => t.id === "t2")).toBeUndefined();
      expect(at(result, 1).id).toBe("t5");
    });

    it("appends replanTasks after settled tasks", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "failed" }),
        makeTask({ id: "t3", status: "pending" }),
      ];
      const replan: Task[] = [
        makeTask({ id: "t10", status: "pending", description: "first new" }),
        makeTask({ id: "t11", status: "pending", description: "second new" }),
      ];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(4);
      expect(at(result, 0).id).toBe("t1");
      expect(at(result, 1).id).toBe("t2");
      expect(at(result, 2).id).toBe("t10");
      expect(at(result, 3).id).toBe("t11");
    });
  });

  describe("edge cases", () => {
    it("returns only replan tasks when no settled tasks exist", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "pending" }),
        makeTask({ id: "t2", status: "in-progress" }),
      ];
      const replan: Task[] = [makeTask({ id: "t3", status: "pending" })];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(1);
      expect(at(result, 0).id).toBe("t3");
    });

    it("returns only settled tasks when replan is empty", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "pending" }),
      ];
      const replan: Task[] = [];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(1);
      expect(at(result, 0).id).toBe("t1");
    });

    it("returns empty array when no settled tasks and empty replan", () => {
      const current: Task[] = [makeTask({ id: "t1", status: "pending" })];
      const replan: Task[] = [];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(0);
    });

    it("handles empty current tasks", () => {
      const current: Task[] = [];
      const replan: Task[] = [makeTask({ id: "t1", status: "pending" })];

      const result = mergeReplan(current, replan);
      expect(result).toHaveLength(1);
      expect(at(result, 0).id).toBe("t1");
    });

    it("handles both arrays empty", () => {
      const result = mergeReplan([], []);
      expect(result).toHaveLength(0);
    });

    it("does not mutate the input arrays", () => {
      const current: Task[] = [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "pending" }),
      ];
      const replan: Task[] = [makeTask({ id: "t3", status: "pending" })];
      const currentCopy = [...current];
      const replanCopy = [...replan];

      mergeReplan(current, replan);

      expect(current).toEqual(currentCopy);
      expect(replan).toEqual(replanCopy);
    });
  });
});

describe("re-plan presentation", () => {
  it("keeps the visible sequence while marking a new technical task id as replanned", () => {
    const current: Task[] = [
      makeTask({ id: "t1", displayStep: 1, status: "completed" }),
      makeTask({ id: "t2", displayStep: 2, status: "pending" }),
    ];
    const replanned = mergeReplan(current, [
      makeTask({
        id: "t3",
        displayStep: 1,
        status: "pending",
        description: "weiter recherchieren",
      }),
    ]);

    expect(at(replanned, 1)).toMatchObject({
      id: "t3",
      displayStep: 2,
      replanned: true,
    });
    expect(renderTaskList(replanned)).toContain(
      "○ t3 · step 2 (replanned): weiter recherchieren → worker-a",
    );
  });
});

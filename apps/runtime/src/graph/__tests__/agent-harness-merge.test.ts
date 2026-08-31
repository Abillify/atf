// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for mergeHarnessProgress (src/graph/agent-harness.ts).
 *
 * Validates: Requirements 10.1, 10.2
 */

import { describe, it, expect } from "bun:test";
import {
  mergeHarnessProgress,
  type HarnessProgress,
  type Task,
} from "../agent-harness.js";

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

function makeProgress(
  overrides: Partial<HarnessProgress> = {},
): HarnessProgress {
  return {
    tasks: [],
    iterations: 0,
    cost: 0,
    ...overrides,
  };
}

/** mergeHarnessProgress for two defined inputs — the result is never undefined. */
function mergeDefined(
  left: HarnessProgress,
  right: HarnessProgress,
): HarnessProgress {
  const merged = mergeHarnessProgress(left, right);
  if (merged === undefined) throw new Error("expected a merged progress");
  return merged;
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("mergeHarnessProgress", () => {
  describe("identity / undefined handling", () => {
    it("returns left when right is undefined", () => {
      const left = makeProgress({ iterations: 3 });
      expect(mergeHarnessProgress(left, undefined)).toBe(left);
    });

    it("returns right when left is undefined", () => {
      const right = makeProgress({ iterations: 5 });
      expect(mergeHarnessProgress(undefined, right)).toBe(right);
    });

    it("returns undefined when both are undefined", () => {
      expect(mergeHarnessProgress(undefined, undefined)).toBeUndefined();
    });
  });

  describe("task merging by id", () => {
    it("replaces left tasks with same id from right", () => {
      const left = makeProgress({
        tasks: [
          makeTask({ id: "t1", status: "pending" }),
          makeTask({ id: "t2", status: "in-progress" }),
        ],
      });
      const right = makeProgress({
        tasks: [
          makeTask({ id: "t1", status: "completed", result: "done" }),
          makeTask({ id: "t2", status: "failed", error: "timeout" }),
        ],
      });

      const merged = mergeDefined(left, right);
      expect(merged.tasks).toHaveLength(2);
      expect(merged.tasks[0]).toEqual(
        makeTask({ id: "t1", status: "completed", result: "done" }),
      );
      expect(merged.tasks[1]).toEqual(
        makeTask({ id: "t2", status: "failed", error: "timeout" }),
      );
    });

    it("appends new ids from right preserving order", () => {
      const left = makeProgress({
        tasks: [makeTask({ id: "t1" }), makeTask({ id: "t2" })],
      });
      const right = makeProgress({
        tasks: [makeTask({ id: "t3", description: "new task" })],
      });

      const merged = mergeDefined(left, right);
      expect(merged.tasks).toHaveLength(3);
      const [task1, task2, task3] = merged.tasks;
      if (task1 === undefined || task2 === undefined || task3 === undefined) {
        throw new Error("expected three merged tasks");
      }
      expect(task1.id).toBe("t1");
      expect(task2.id).toBe("t2");
      expect(task3.id).toBe("t3");
      expect(task3.description).toBe("new task");
    });

    it("replaces existing and appends new in one merge", () => {
      const left = makeProgress({
        tasks: [
          makeTask({ id: "t1", status: "pending" }),
          makeTask({ id: "t2", status: "pending" }),
        ],
      });
      const right = makeProgress({
        tasks: [
          makeTask({ id: "t2", status: "completed", result: "ok" }),
          makeTask({ id: "t3", status: "pending" }),
        ],
      });

      const merged = mergeDefined(left, right);
      expect(merged.tasks).toHaveLength(3);
      const [task1, task2, task3] = merged.tasks;
      if (task1 === undefined || task2 === undefined || task3 === undefined) {
        throw new Error("expected three merged tasks");
      }
      expect(task1.id).toBe("t1");
      expect(task1.status).toBe("pending"); // unchanged from left
      expect(task2.id).toBe("t2");
      expect(task2.status).toBe("completed"); // replaced by right
      expect(task3.id).toBe("t3");
    });

    it("handles empty task arrays", () => {
      const left = makeProgress({ tasks: [makeTask({ id: "t1" })] });
      const right = makeProgress({ tasks: [] });

      const merged = mergeDefined(left, right);
      // Left tasks remain since right didn't replace them
      expect(merged.tasks).toHaveLength(1);
      const firstTask = merged.tasks[0];
      if (firstTask === undefined) throw new Error("expected a first task");
      expect(firstTask.id).toBe("t1");
    });
  });

  describe("scalar field handling", () => {
    it("takes iterations from right", () => {
      const left = makeProgress({ iterations: 3 });
      const right = makeProgress({ iterations: 7 });
      const merged = mergeDefined(left, right);
      expect(merged.iterations).toBe(7);
    });

    it("takes costUsd from right", () => {
      const left = makeProgress({ cost: 1.5 });
      const right = makeProgress({ cost: 3.2 });
      const merged = mergeDefined(left, right);
      expect(merged.cost).toBe(3.2);
    });

    it("takes stopReason from right when defined", () => {
      const left = makeProgress({});
      const right = makeProgress({ stopReason: "iteration-limit" });
      const merged = mergeDefined(left, right);
      expect(merged.stopReason).toBe("iteration-limit");
    });

    it("does not carry stopReason from left when right has none", () => {
      const left = makeProgress({ stopReason: "completed" });
      const right = makeProgress({});
      const merged = mergeDefined(left, right);
      expect(merged.stopReason).toBeUndefined();
    });

    it("takes partial from right when defined", () => {
      const left = makeProgress({ partial: false });
      const right = makeProgress({ partial: true });
      const merged = mergeDefined(left, right);
      expect(merged.partial).toBe(true);
    });

    it("takes statusMessage from right when defined", () => {
      const left = makeProgress({ statusMessage: "old" });
      const right = makeProgress({ statusMessage: "new status" });
      const merged = mergeDefined(left, right);
      expect(merged.statusMessage).toBe("new status");
    });

    it("takes droppedTargets from right when defined", () => {
      const left = makeProgress({ droppedTargets: ["x"] });
      const right = makeProgress({ droppedTargets: ["y", "z"] });
      const merged = mergeDefined(left, right);
      expect(merged.droppedTargets).toEqual(["y", "z"]);
    });

    it("omits optional fields when right does not define them", () => {
      const left = makeProgress({
        stopReason: "completed",
        partial: false,
        statusMessage: "done",
        droppedTargets: ["a"],
      });
      const right = makeProgress({ iterations: 5, cost: 2.0 });
      const merged = mergeDefined(left, right);
      expect(merged.stopReason).toBeUndefined();
      expect(merged.partial).toBeUndefined();
      expect(merged.statusMessage).toBeUndefined();
      expect(merged.droppedTargets).toBeUndefined();
    });
  });
});

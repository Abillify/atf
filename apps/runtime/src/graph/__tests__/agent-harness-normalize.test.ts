// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Unit tests for normalize (src/graph/agent-harness.ts).
 *
 * Validates: Requirements 3.1, 3.2, 2.4
 */

import { describe, test, expect } from "bun:test";
import { normalize } from "../agent-harness.js";

/** The element at `i`, asserting it exists. */
function at<T>(arr: readonly T[], i: number): T {
  const item = arr[i];
  if (item === undefined) throw new Error(`expected an element at index ${i}`);
  return item;
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("normalize(planResponse, validTargets)", () => {
  test("maps valid plan items to Task objects with sequential ids and pending status", () => {
    const planResponse = [
      { description: "Summarize the document", target: "summarizer" },
      { description: "Translate to German", target: "translator" },
      { description: "Review output", target: "reviewer" },
    ];
    const validTargets = ["summarizer", "translator", "reviewer"];

    const result = normalize(planResponse, validTargets);

    expect(result).toEqual([
      {
        id: "t1",
        displayStep: 1,
        description: "Summarize the document",
        target: "summarizer",
        status: "pending",
      },
      {
        id: "t2",
        displayStep: 2,
        description: "Translate to German",
        target: "translator",
        status: "pending",
      },
      {
        id: "t3",
        displayStep: 3,
        description: "Review output",
        target: "reviewer",
        status: "pending",
      },
    ]);
  });

  test("drops tasks whose target is not in validTargets", () => {
    const planResponse = [
      { description: "Valid task", target: "worker-a" },
      { description: "Invalid task", target: "unknown-node" },
      { description: "Another valid", target: "worker-b" },
    ];
    const validTargets = ["worker-a", "worker-b"];

    const result = normalize(planResponse, validTargets);

    expect(result).toEqual([
      {
        id: "t1",
        displayStep: 1,
        description: "Valid task",
        target: "worker-a",
        status: "pending",
      },
      {
        id: "t2",
        displayStep: 2,
        description: "Another valid",
        target: "worker-b",
        status: "pending",
      },
    ]);
  });

  test("assigns stable sequential ids only to retained tasks (dropped tasks don't consume ids)", () => {
    const planResponse = [
      { description: "First", target: "invalid-1" },
      { description: "Second", target: "valid-node" },
      { description: "Third", target: "invalid-2" },
      { description: "Fourth", target: "valid-node" },
    ];
    const validTargets = ["valid-node"];

    const result = normalize(planResponse, validTargets);

    expect(result).toHaveLength(2);
    expect(at(result, 0).id).toBe("t1");
    expect(at(result, 1).id).toBe("t2");
  });

  test("returns empty array when all targets are invalid", () => {
    const planResponse = [
      { description: "Task A", target: "missing-a" },
      { description: "Task B", target: "missing-b" },
    ];
    const validTargets = ["worker-x"];

    const result = normalize(planResponse, validTargets);

    expect(result).toEqual([]);
  });

  test("returns empty array for empty planResponse", () => {
    const result = normalize([], ["worker-a", "worker-b"]);
    expect(result).toEqual([]);
  });

  test("returns empty array when validTargets is empty", () => {
    const planResponse = [{ description: "Some task", target: "worker-a" }];
    const result = normalize(planResponse, []);
    expect(result).toEqual([]);
  });

  test("preserves original order of retained tasks", () => {
    const planResponse = [
      { description: "C task", target: "node-c" },
      { description: "A task", target: "node-a" },
      { description: "B task", target: "node-b" },
    ];
    const validTargets = ["node-a", "node-b", "node-c"];

    const result = normalize(planResponse, validTargets);

    expect(at(result, 0).description).toBe("C task");
    expect(at(result, 1).description).toBe("A task");
    expect(at(result, 2).description).toBe("B task");
  });

  test("all retained tasks have status 'pending'", () => {
    const planResponse = [
      { description: "Task 1", target: "w1" },
      { description: "Task 2", target: "w2" },
    ];
    const validTargets = ["w1", "w2"];

    const result = normalize(planResponse, validTargets);

    for (const task of result) {
      expect(task.status).toBe("pending");
    }
  });

  test("handles duplicate targets in plan (same target used multiple times)", () => {
    const planResponse = [
      { description: "First call to worker", target: "worker" },
      { description: "Second call to worker", target: "worker" },
    ];
    const validTargets = ["worker"];

    const result = normalize(planResponse, validTargets);

    expect(result).toHaveLength(2);
    expect(at(result, 0).id).toBe("t1");
    expect(at(result, 0).description).toBe("First call to worker");
    expect(at(result, 1).id).toBe("t2");
    expect(at(result, 1).description).toBe("Second call to worker");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import {
  ExecutionBudget,
  ExecutionBudgetExceededError,
  isExecutionBudgetExceededError,
} from "../execution-budget.js";

describe("ExecutionBudget", () => {
  test("token budget: check passes below limit and throws once reached", () => {
    const budget = new ExecutionBudget({ maxTokens: 100 });
    budget.addTokens(80);
    // 80 < 100 → the next call may still start.
    expect(() => budget.check("tokens")).not.toThrow();
    budget.addTokens(80);
    // 160 >= 100 → the next call is prevented.
    expect(() => budget.check("tokens")).toThrow(ExecutionBudgetExceededError);
    try {
      budget.check("tokens");
      expect.unreachable("expected check to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionBudgetExceededError);
      expect(isExecutionBudgetExceededError(err)).toBe(true);
      const exceeded = err as ExecutionBudgetExceededError;
      expect(exceeded.kind).toBe("tokens");
      expect(exceeded.limit).toBe(100);
      expect(exceeded.used).toBe(160);
      expect(exceeded.message).toBe(
        "Execution budget tokens exceeded: 160/100",
      );
    }
  });

  test("tool-call budget: third call prevented at limit 2", () => {
    const budget = new ExecutionBudget({ maxToolCalls: 2 });
    expect(() => budget.check("toolCalls")).not.toThrow();
    budget.addToolCall();
    expect(() => budget.check("toolCalls")).not.toThrow();
    budget.addToolCall();
    expect(() => budget.check("toolCalls")).toThrow(
      ExecutionBudgetExceededError,
    );
  });

  test("wall-clock budget with fake clock", () => {
    let nowMs = 1_000;
    const budget = new ExecutionBudget({ maxWallMs: 5_000 }, () => nowMs);
    expect(() => budget.check("wallMs")).not.toThrow();
    nowMs = 3_000;
    expect(budget.usedWallMs).toBe(2_000);
    expect(() => budget.check("wallMs")).not.toThrow();
    nowMs = 6_000;
    expect(budget.usedWallMs).toBe(5_000);
    expect(() => budget.check("wallMs")).toThrow(ExecutionBudgetExceededError);
  });

  test("unset dimensions are no-ops and non-positive increments ignored", () => {
    const budget = new ExecutionBudget({ maxTokens: 10 });
    // Dimensions without a limit never throw.
    expect(() => budget.check("toolCalls")).not.toThrow();
    expect(() => budget.check("wallMs")).not.toThrow();
    budget.addToolCall();
    budget.addToolCall();
    expect(() => budget.check("toolCalls")).not.toThrow();
    // Non-positive token increments do not move the counter.
    budget.addTokens(0);
    budget.addTokens(-5);
    expect(budget.usedTokens).toBe(0);
    expect(() => budget.check("tokens")).not.toThrow();
  });

  test("isExecutionBudgetExceededError recognises only budget errors", () => {
    const budget = new ExecutionBudget({ maxTokens: 1 });
    budget.addTokens(5);
    let caught: unknown;
    try {
      budget.check("tokens");
    } catch (err) {
      caught = err;
    }
    expect(isExecutionBudgetExceededError(caught)).toBe(true);
    expect(isExecutionBudgetExceededError(new Error("boom"))).toBe(false);
    expect(isExecutionBudgetExceededError(undefined)).toBe(false);
    expect(isExecutionBudgetExceededError(null)).toBe(false);
  });
});

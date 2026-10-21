// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-execution budgets (flow-level `budgets` block).
 *
 * One {@link ExecutionBudget} instance lives on the `ExecRuntime` for the
 * lifetime of a single flow execution. Counters are fed at the token and
 * tool-call accumulation sites; {@link ExecutionBudget.check} is called
 * BEFORE the next LLM or tool call — a call already in flight is never
 * aborted. When a limit is reached a call throws
 * {@link ExecutionBudgetExceededError}, which the engine catches to finish
 * the execution gracefully with `finishReason: "budget_exceeded"` (the text
 * produced so far is returned, no 500).
 *
 * Distinct from the transaction-level `BudgetExceededError` in
 * `src/transaction/budget.ts`, which bounds a transaction coordinator's
 * dimensions — the two must not be conflated.
 */

import type { FlowExecutionBudget } from "../types/flow.js";

/** Budget dimension that a check enforces. */
export type ExecutionBudgetKind = "tokens" | "toolCalls" | "wallMs";

/**
 * Thrown by {@link ExecutionBudget.check} when a dimension's limit is
 * reached. Carries the dimension, the configured limit and the usage
 * observed at check time for the diagnostic text.
 */
export class ExecutionBudgetExceededError extends Error {
  constructor(
    readonly kind: ExecutionBudgetKind,
    readonly limit: number,
    readonly used: number,
  ) {
    super(`Execution budget ${kind} exceeded: ${used}/${limit}`);
    this.name = "ExecutionBudgetExceededError";
  }
}

/**
 * Recognizes a per-execution budget failure even when an SDK or transport
 * has copied the error into a plain object and lost its prototype (same
 * duck-typing pattern as `isBudgetExceededError` for transaction budgets).
 */
export function isExecutionBudgetExceededError(
  error: unknown,
): error is ExecutionBudgetExceededError {
  if (error instanceof ExecutionBudgetExceededError) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    name?: unknown;
    message?: unknown;
    kind?: unknown;
    limit?: unknown;
    used?: unknown;
  };
  return (
    candidate.name === "ExecutionBudgetExceededError" &&
    typeof candidate.message === "string" &&
    candidate.message.startsWith("Execution budget ") &&
    (candidate.kind === "tokens" ||
      candidate.kind === "toolCalls" ||
      candidate.kind === "wallMs") &&
    typeof candidate.limit === "number" &&
    typeof candidate.used === "number"
  );
}

/**
 * Counters and limits for one flow execution.
 *
 * The wall-clock origin is the construction time (i.e. the start of the
 * execution); the clock is injectable so tests can advance time without
 * sleeping.
 */
export class ExecutionBudget {
  private readonly maxTokens?: number;
  private readonly maxToolCalls?: number;
  private readonly maxWallMs?: number;
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private tokens = 0;
  private toolCalls = 0;

  constructor(
    limits: FlowExecutionBudget,
    /** Injectable clock (e.g. `() => fakeNow`); defaults to `Date.now`. */
    now: () => number = Date.now,
  ) {
    this.maxTokens = limits.maxTokens;
    this.maxToolCalls = limits.maxToolCalls;
    this.maxWallMs = limits.maxWallMs;
    this.now = now;
    this.startedAtMs = now();
  }

  /** Adds tokens consumed by a completed LLM call. */
  addTokens(n: number): void {
    if (n > 0) this.tokens += n;
  }

  /** Records one MCP/tool call against the tool-call budget. */
  addToolCall(): void {
    this.toolCalls += 1;
  }

  /** Sum of prompt + completion tokens observed so far. */
  get usedTokens(): number {
    return this.tokens;
  }

  /** Number of tool calls observed so far. */
  get usedToolCalls(): number {
    return this.toolCalls;
  }

  /** Wall-clock milliseconds since the execution started. */
  get usedWallMs(): number {
    return this.now() - this.startedAtMs;
  }

  /**
   * Throws {@link ExecutionBudgetExceededError} when the given dimension's
   * limit is reached or exceeded; a no-op when the dimension has no limit.
   * Call this BEFORE starting the next LLM or tool call.
   */
  check(kind: ExecutionBudgetKind): void {
    if (kind === "tokens" && this.maxTokens !== undefined) {
      if (this.tokens >= this.maxTokens) {
        throw new ExecutionBudgetExceededError("tokens", this.maxTokens, this.tokens);
      }
      return;
    }
    if (kind === "toolCalls" && this.maxToolCalls !== undefined) {
      if (this.toolCalls >= this.maxToolCalls) {
        throw new ExecutionBudgetExceededError(
          "toolCalls",
          this.maxToolCalls,
          this.toolCalls,
        );
      }
      return;
    }
    if (kind === "wallMs" && this.maxWallMs !== undefined) {
      const used = this.usedWallMs;
      if (used >= this.maxWallMs) {
        throw new ExecutionBudgetExceededError("wallMs", this.maxWallMs, used);
      }
    }
  }
}

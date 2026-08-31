// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tests for the safe condition expression evaluator.
 *
 * Validates: Requirements 3.8 (routing conditions evaluated safely, no eval)
 */

import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import {
  evaluateConditionExpression,
  isPotentiallyCatastrophicRegex,
} from "../condition-evaluator.js";

describe("evaluateConditionExpression — literals", () => {
  test("boolean literals", () => {
    expect(evaluateConditionExpression("true", {})).toBe(true);
    expect(evaluateConditionExpression("false", {})).toBe(false);
  });

  test("numeric comparisons", () => {
    expect(evaluateConditionExpression("1 < 2", {})).toBe(true);
    expect(evaluateConditionExpression("2 <= 2", {})).toBe(true);
    expect(evaluateConditionExpression("3 > 5", {})).toBe(false);
    expect(evaluateConditionExpression("5 >= 5", {})).toBe(true);
    expect(evaluateConditionExpression("3 == 3", {})).toBe(true);
    expect(evaluateConditionExpression("3 != 4", {})).toBe(true);
  });

  test("string comparisons", () => {
    expect(evaluateConditionExpression("'a' == 'a'", {})).toBe(true);
    expect(evaluateConditionExpression('"x" != "y"', {})).toBe(true);
  });
});

describe("evaluateConditionExpression — context access", () => {
  test("reads top-level context values", () => {
    expect(evaluateConditionExpression("count == 3", { count: 3 })).toBe(true);
    expect(evaluateConditionExpression("count > 1", { count: 3 })).toBe(true);
  });

  test("reads nested dot-path values", () => {
    const ctx = { last: { type: "ai", len: 10 } };
    expect(evaluateConditionExpression("last.type == 'ai'", ctx)).toBe(true);
    expect(evaluateConditionExpression("last.len >= 10", ctx)).toBe(true);
  });

  test("missing path resolves to null (no throw)", () => {
    expect(evaluateConditionExpression("a.b.c == 1", {})).toBe(false);
    expect(evaluateConditionExpression("missing == null", {})).toBe(true);
  });
});

describe("evaluateConditionExpression — boolean logic", () => {
  test("and / or / not", () => {
    expect(evaluateConditionExpression("true && true", {})).toBe(true);
    expect(evaluateConditionExpression("true && false", {})).toBe(false);
    expect(evaluateConditionExpression("false || true", {})).toBe(true);
    expect(evaluateConditionExpression("!false", {})).toBe(true);
    expect(evaluateConditionExpression("!(1 > 2)", {})).toBe(true);
  });

  test("precedence: && binds tighter than ||", () => {
    // false && false || true  →  (false && false) || true  →  true
    expect(evaluateConditionExpression("false && false || true", {})).toBe(
      true,
    );
  });

  test("parentheses override precedence", () => {
    expect(evaluateConditionExpression("false && (false || true)", {})).toBe(
      false,
    );
  });

  test("realistic routing expression", () => {
    const ctx = { hasErrors: false, messageCount: 2, lastMessageType: "ai" };
    expect(
      evaluateConditionExpression(
        "hasErrors == false && messageCount > 1 && lastMessageType == 'ai'",
        ctx,
      ),
    ).toBe(true);
  });
});

describe("evaluateConditionExpression — safety", () => {
  test("returns false on syntax errors instead of throwing", () => {
    expect(evaluateConditionExpression("@#$%", {})).toBe(false);
    expect(evaluateConditionExpression("1 +", {})).toBe(false);
    expect(evaluateConditionExpression("(((", {})).toBe(false);
  });

  test("=~ matches a simple case-insensitive pattern", () => {
    expect(
      evaluateConditionExpression("text =~ 'foo|bar'", { text: "a BAR b" }),
    ).toBe(true);
    expect(
      evaluateConditionExpression("text =~ 'foo|bar'", { text: "nothing" }),
    ).toBe(false);
  });

  test("=~ rejects an over-long regex source (ReDoS guard)", () => {
    const longSource = "a".repeat(300); // > MAX_REGEX_SOURCE_LENGTH (200)
    const expr = `text =~ '${longSource}'`;
    // Fails closed (false), does not throw or hang.
    expect(evaluateConditionExpression(expr, { text: "aaaa" })).toBe(false);
  });

  test("=~ terminates quickly on a catastrophic-backtracking pattern", () => {
    // A classic evil regex is now REJECTED statically (returns false) instead
    // of being run against a merely length-bounded subject — a length cap does
    // not bound exponential blow-up.
    const ctx = { text: `${"a".repeat(5000)}!` };
    const start = Date.now();
    const result = evaluateConditionExpression("text =~ '(a+)+$'", ctx);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    // Rejected before matching → returns essentially instantly.
    expect(elapsed).toBeLessThan(1000);
  });

  test("isPotentiallyCatastrophicRegex flags known-dangerous shapes", () => {
    for (const bad of [
      "(a+)+$",
      "(a*)*",
      "(a+)*",
      "([a-z]+)+",
      "(?:ab+)+",
      "(a+){2,}", // unbounded outer
      "(\\w+\\s)+", // body ends in a literal — the classic missed case
      "(\\d+,)+",
      "(a+b)+",
      "(a{2,})+", // inner {n,} unbounded
      "(x|x)*",
      ".*.*.*",
    ]) {
      expect(isPotentiallyCatastrophicRegex(bad)).toBe(true);
    }
  });

  test("isPotentiallyCatastrophicRegex allows benign patterns", () => {
    for (const ok of [
      "foo|bar",
      "^gpt-",
      "\\d{3}-\\d{4}",
      "[A-Za-z0-9_]+",
      "hello world",
      "(cat|dog|bird)",
      "(\\d+){1,3}", // BOUNDED outer quantifier — polynomial, not catastrophic
      "(abc){2,5}",
    ]) {
      expect(isPotentiallyCatastrophicRegex(ok)).toBe(false);
    }
  });

  test("=~ still matches a benign quantified pattern", () => {
    expect(
      evaluateConditionExpression("text =~ '^gpt-[0-9]+'", { text: "gpt-4" }),
    ).toBe(true);
  });

  test("cannot access globals or call functions (no eval)", () => {
    // These would be code execution under eval; here they are parse errors → false
    expect(evaluateConditionExpression("process.exit(1)", {})).toBe(false);
    expect(evaluateConditionExpression("globalThis", {})).toBe(false);
    expect(evaluateConditionExpression("constructor", {})).toBe(false);
  });

  test("does not expose object values (collapse to null)", () => {
    const ctx = { obj: { secret: "x" } };
    // obj resolves to null (not the object) so comparison is false
    expect(evaluateConditionExpression("obj == null", ctx)).toBe(true);
  });
});

describe("evaluateConditionExpression — property: never throws", () => {
  test("any string input returns a boolean, never throws", () => {
    fc.assert(
      fc.property(fc.string(), (expr) => {
        const result = evaluateConditionExpression(expr, { x: 1, y: "a" });
        expect(typeof result).toBe("boolean");
      }),
      { numRuns: 200 },
    );
  });

  test("any context object is handled safely", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string(),
          fc.oneof(fc.integer(), fc.string(), fc.boolean()),
        ),
        (ctx) => {
          const result = evaluateConditionExpression("x == 1 || y == 'a'", ctx);
          expect(typeof result).toBe("boolean");
        },
      ),
      { numRuns: 100 },
    );
  });
});

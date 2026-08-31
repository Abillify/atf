// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { evaluateAssertion, formatReport, runEval, type EvalDataset, type FlowExecutor } from "../eval-runner.js";

describe("evaluateAssertion", () => {
  const context = { text: "Hello World", latencyMs: 100, cost: 0.001 };
  it("contains (case-insensitive by default)", () => {
    expect(evaluateAssertion({ type: "contains", value: "hello" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "contains", value: "hello", caseSensitive: true }, context).passed).toBe(false);
  });
  it("notContains", () => {
    expect(evaluateAssertion({ type: "notContains", value: "xyz" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "notContains", value: "world" }, context).passed).toBe(false);
  });
  it("equals (trimmed)", () => {
    expect(evaluateAssertion({ type: "equals", value: "Hello World" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "equals", value: "nope" }, context).passed).toBe(false);
  });
  it("regex", () => {
    expect(evaluateAssertion({ type: "regex", pattern: "^Hello" }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "regex", pattern: "[" }, context).passed).toBe(false);
  });
  it("maxLatencyMs / maxCost", () => {
    expect(evaluateAssertion({ type: "maxLatencyMs", value: 200 }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "maxLatencyMs", value: 50 }, context).passed).toBe(false);
    expect(evaluateAssertion({ type: "maxCost", value: 0.01 }, context).passed).toBe(true);
    expect(evaluateAssertion({ type: "maxCost", value: 0.0001 }, context).passed).toBe(false);
  });
});

describe("runEval", () => {
  const dataset: EvalDataset = { name: "demo", cases: [
    { id: "greeting", flow: "f1", messages: [{ role: "user", content: "hi" }], assert: [{ type: "contains", value: "hello" }] },
    { id: "math", flow: "f1", messages: [{ role: "user", content: "2+2" }], assert: [{ type: "equals", value: "4" }] },
  ] };
  it("aggregates pass/fail, cost and latency", async () => {
    const executor: FlowExecutor = async (_flow, messages) => {
      const first = messages[0];
      if (first === undefined) throw new Error("expected a first message");
      return { text: first.content === "hi" ? "hello there" : "5", cost: 0.002 };
    };
    const report = await runEval(dataset, executor);
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.passRate).toBe(0.5);
    expect(report.totalCost).toBeCloseTo(0.004, 6);
    expect(report.cases.find((value) => value.id === "math")?.passed).toBe(false);
  });
  it("captures executor errors as failed cases", async () => {
    const report = await runEval(dataset, async () => { throw new Error("boom"); }, { concurrency: 1 });
    expect(report.passed).toBe(0);
    expect(report.cases[0]?.error).toBe("boom");
  });
  it("formats a readable report", async () => {
    const report = await runEval(dataset, async () => ({ text: "hello", cost: 0 }));
    expect(formatReport(report)).toContain("Eval: demo");
    expect(formatReport(report)).toContain("PASS");
  });
});

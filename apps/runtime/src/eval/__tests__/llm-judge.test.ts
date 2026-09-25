// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, it } from "bun:test";
import { formatReport, runEval, type EvalDataset, type FlowExecutor, type Judge } from "../eval-runner.js";
import { createLlmJudge } from "../llm-judge.js";

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`expected an element at index ${index}`);
  return value;
}
const executor = (text: string): FlowExecutor => async () => ({ text });
const dataset = (criteria: string, threshold?: number): EvalDataset => ({
  name: "judge-test",
  cases: [{
    id: "c1",
    flow: "f",
    messages: [{ role: "user", content: "hi" }],
    assert: [{ type: "llmJudge", criteria, ...(threshold === undefined ? {} : { threshold }) }],
  }],
});

describe("runEval with llmJudge", () => {
  it("passes when the judge score meets the threshold and records the score", async () => {
    const judge: Judge = async () => ({ score: 0.9, reasoning: "good" });
    const report = await runEval(dataset("is it helpful?"), executor("a helpful answer"), { judge });
    expect(report.passed).toBe(1);
    expect(at(report.cases, 0).score).toBe(0.9);
    expect(report.avgScore).toBe(0.9);
  });
  it("fails when the score is below the threshold and surfaces the reasoning", async () => {
    const judge: Judge = async () => ({ score: 0.3, reasoning: "off topic" });
    const report = await runEval(dataset("is it helpful?", 0.7), executor("nope"), { judge });
    expect(report.failed).toBe(1);
    expect(at(at(report.cases, 0).assertions, 0).detail).toContain("off topic");
    expect(formatReport(report)).toContain("avg score");
  });
  it("fails llmJudge assertions when no judge is configured", async () => {
    const report = await runEval(dataset("is it helpful?"), executor("x"));
    expect(report.failed).toBe(1);
    expect(at(at(report.cases, 0).assertions, 0).detail).toContain("requires a judge");
  });
  it("respects a per-assertion threshold override", async () => {
    const judge: Judge = async () => ({ score: 0.6, reasoning: "ok" });
    expect((await runEval(dataset("crit", 0.5), executor("x"), { judge })).passed).toBe(1);
    expect((await runEval(dataset("crit", 0.8), executor("x"), { judge })).failed).toBe(1);
  });
  it("clamps out-of-range judge scores into [0,1]", async () => {
    const judge: Judge = async () => ({ score: 1.5, reasoning: "too high" });
    expect(at((await runEval(dataset("crit"), executor("x"), { judge })).cases, 0).score).toBe(1);
  });
  it("combines judge and non-judge assertions in one case", async () => {
    const judge: Judge = async () => ({ score: 0.95, reasoning: "great" });
    const mixed: EvalDataset = { cases: [{
      id: "mix",
      flow: "f",
      messages: [{ role: "user", content: "hi" }],
      assert: [{ type: "contains", value: "Paris" }, { type: "llmJudge", criteria: "accurate?" }],
    }] };
    const report = await runEval(mixed, executor("The capital is Paris."), { judge });
    expect(report.passed).toBe(1);
    expect(at(report.cases, 0).score).toBe(0.95);
  });
});

describe("createLlmJudge", () => {
  const input = { criteria: "helpful?", response: "Paris.", messages: [{ role: "user" as const, content: "Capital of France?" }] };
  // Any object with doGenerate counts as an AI SDK model; `generate` is stubbed.
  const aiModel = { doGenerate: async () => ({}) } as unknown;

  it("judges with an AI SDK model (what createLlmProvider returns)", async () => {
    const calls: string[] = [];
    const judge = createLlmJudge(aiModel, {
      generate: async ({ prompt }) => {
        calls.push(prompt);
        return { text: '{"score": 0.8, "reasoning": "correct and short"}' };
      },
    });
    expect(await judge(input)).toEqual({ score: 0.8, reasoning: "correct and short" });
    expect(calls[0]).toContain("Paris.");
  });

  it("ignores a <think> block before the verdict", async () => {
    const judge = createLlmJudge(aiModel, {
      generate: async () => ({ text: '<think>score: 0 maybe?</think>\n{"score": 0.9, "reasoning": "fine"}' }),
    });
    expect((await judge(input)).score).toBe(0.9);
  });

  it("still supports a legacy { invoke } model and the plain `score: x` form", async () => {
    const judge = createLlmJudge({ invoke: async () => ({ content: "Score: 0.6 — mostly right" }) });
    expect((await judge(input)).score).toBe(0.6);
  });

  it("throws instead of scoring 0 when the reply has no score", async () => {
    const judge = createLlmJudge(aiModel, { generate: async () => ({ text: "I think it is good." }) });
    await expect(judge(input)).rejects.toThrow("no score");
  });

  it("throws instead of scoring 0 without a usable model", async () => {
    await expect(createLlmJudge({})(input)).rejects.toThrow("No compatible judge model");
  });

  it("an unusable judge becomes a judge error in the eval, not a 0 score", async () => {
    const report = await runEval(dataset("crit"), executor("x"), { judge: createLlmJudge({}) });
    expect(at(report.cases, 0).score).toBeUndefined();
    expect(at(at(report.cases, 0).assertions, 0).detail).toContain("judge error");
  });
});

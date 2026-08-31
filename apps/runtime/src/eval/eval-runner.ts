// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { ChatMessage, TokenUsage } from "../types/openai.js";

export type EvalMessage = ChatMessage;

export type Assertion =
  | { type: "contains"; value: string; caseSensitive?: boolean }
  | { type: "notContains"; value: string; caseSensitive?: boolean }
  | { type: "equals"; value: string }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "maxLatencyMs"; value: number }
  | { type: "maxCost"; value: number }
  | { type: "llmJudge"; criteria: string; threshold?: number };

/** Caller-supplied evaluation case. Legacy `expected` cases remain supported. */
export interface EvalCase {
  id: string;
  messages: EvalMessage[];
  flow?: string;
  assert?: Assertion[];
  expected?: string;
  metadata?: Record<string, unknown>;
}

export interface EvalDataset {
  name?: string;
  cases: EvalCase[];
}

export interface FlowExecutionResult {
  text?: string;
  response?: string;
  usage?: TokenUsage;
  latencyMs?: number;
  cost?: number;
}

export type FlowExecutor = (
  flowId: string,
  messages: EvalMessage[],
  metadata?: Record<string, unknown>,
) => Promise<FlowExecutionResult>;

export interface JudgeInput {
  criteria: string;
  response: string;
  messages: EvalMessage[];
  expected?: string;
}

export interface JudgeVerdict {
  score: number;
  reasoning?: string;
}

export type Judge = (input: JudgeInput) => Promise<JudgeVerdict>;

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail?: string;
  score?: number;
}

export interface CaseResult {
  id: string;
  flow?: string;
  responseText: string;
  score?: number;
  passed: boolean;
  assertions: AssertionResult[];
  error?: string;
  latencyMs: number;
  cost: number;
}

export interface EvalReport {
  name: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  avgScore?: number;
  avgLatencyMs: number;
  totalCost: number;
  cases: CaseResult[];
}

export function evaluateAssertion(
  assertion: Assertion,
  ctx: { text: string; latencyMs: number; cost: number },
): AssertionResult {
  const fail = (detail: string): AssertionResult => ({ assertion, passed: false, detail });
  const pass = (): AssertionResult => ({ assertion, passed: true });

  switch (assertion.type) {
    case "contains": {
      const haystack = assertion.caseSensitive ? ctx.text : ctx.text.toLowerCase();
      const needle = assertion.caseSensitive ? assertion.value : assertion.value.toLowerCase();
      return haystack.includes(needle)
        ? pass()
        : fail(`expected text to contain "${assertion.value}"`);
    }
    case "notContains": {
      const haystack = assertion.caseSensitive ? ctx.text : ctx.text.toLowerCase();
      const needle = assertion.caseSensitive ? assertion.value : assertion.value.toLowerCase();
      return !haystack.includes(needle)
        ? pass()
        : fail(`expected text NOT to contain "${assertion.value}"`);
    }
    case "equals":
      return ctx.text.trim() === assertion.value.trim()
        ? pass()
        : fail("response did not equal expected value");
    case "regex": {
      try {
        return new RegExp(assertion.pattern, assertion.flags).test(ctx.text)
          ? pass()
          : fail(`text did not match /${assertion.pattern}/`);
      } catch {
        return fail(`invalid regex /${assertion.pattern}/${assertion.flags ?? ""}`);
      }
    }
    case "maxLatencyMs":
      return ctx.latencyMs <= assertion.value
        ? pass()
        : fail(`latency ${ctx.latencyMs}ms exceeded ${assertion.value}ms`);
    case "maxCost":
      return ctx.cost <= assertion.value
        ? pass()
        : fail(`cost $${ctx.cost.toFixed(6)} exceeded $${assertion.value}`);
    case "llmJudge":
      return fail("llmJudge assertion requires a judge (none configured)");
  }
}

export interface RunOptions {
  concurrency?: number;
  judge?: Judge;
  judgeThreshold?: number;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}

async function runCase(
  executor: FlowExecutor,
  evalCase: EvalCase,
  options: RunOptions,
): Promise<CaseResult> {
  const started = Date.now();
  const flow = evalCase.flow ?? "";
  try {
    const output = await executor(flow, evalCase.messages, evalCase.metadata);
    const responseText = output.response ?? output.text ?? "";
    const latencyMs = output.latencyMs ?? Date.now() - started;
    const cost = output.cost ?? 0;
    const assertions: AssertionResult[] = [];
    const judgeScores: number[] = [];

    for (const assertion of evalCase.assert ?? []) {
      if (assertion.type !== "llmJudge") {
        assertions.push(evaluateAssertion(assertion, { text: responseText, latencyMs, cost }));
        continue;
      }
      if (options.judge === undefined) {
        assertions.push({
          assertion,
          passed: false,
          detail: "llmJudge assertion requires a judge (none configured)",
        });
        continue;
      }
      try {
        const verdict = await options.judge({
          criteria: assertion.criteria,
          response: responseText,
          messages: evalCase.messages,
          ...(evalCase.expected === undefined ? {} : { expected: evalCase.expected }),
        });
        const score = clampScore(verdict.score);
        const threshold = assertion.threshold ?? options.judgeThreshold ?? 0.7;
        judgeScores.push(score);
        assertions.push({
          assertion,
          passed: score >= threshold,
          score,
          ...(score < threshold
            ? { detail: `judge score ${score.toFixed(2)} < ${threshold} — ${verdict.reasoning ?? "no reasoning"}` }
            : {}),
        });
      } catch (error) {
        assertions.push({
          assertion,
          passed: false,
          detail: `judge error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    // Preserve ATF's original judge behavior for legacy cases without assertions.
    if ((evalCase.assert?.length ?? 0) === 0 && options.judge !== undefined) {
      try {
        const verdict = await options.judge({
          criteria: "Compare the response with the expected outcome.",
          response: responseText,
          messages: evalCase.messages,
          ...(evalCase.expected === undefined ? {} : { expected: evalCase.expected }),
        });
        const score = clampScore(verdict.score);
        judgeScores.push(score);
        assertions.push({
          assertion: {
            type: "llmJudge",
            criteria: "Compare the response with the expected outcome.",
            threshold: 0.5,
          },
          passed: score >= 0.5,
          score,
          ...(score < 0.5 ? { detail: verdict.reasoning ?? "judge rejected response" } : {}),
        });
      } catch (error) {
        assertions.push({
          assertion: { type: "llmJudge", criteria: "Compare the response with the expected outcome.", threshold: 0.5 },
          passed: false,
          detail: `judge error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const score = judgeScores.length === 0
      ? undefined
      : Math.round((judgeScores.reduce((sum, value) => sum + value, 0) / judgeScores.length) * 1000) / 1000;
    return {
      id: evalCase.id,
      ...(evalCase.flow === undefined ? {} : { flow }),
      responseText,
      ...(score === undefined ? {} : { score }),
      passed: assertions.every((result) => result.passed),
      assertions,
      latencyMs,
      cost,
    };
  } catch (error) {
    return {
      id: evalCase.id,
      ...(evalCase.flow === undefined ? {} : { flow }),
      responseText: "",
      passed: false,
      assertions: [],
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
      cost: 0,
    };
  }
}

export async function runEval(
  dataset: EvalDataset,
  executor: FlowExecutor,
  options: RunOptions = {},
): Promise<EvalReport> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const cases: CaseResult[] = new Array(dataset.cases.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      const evalCase = dataset.cases[index];
      if (evalCase === undefined) return;
      cases[index] = await runCase(executor, evalCase, options);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, dataset.cases.length) }, worker),
  );

  const passed = cases.filter((entry) => entry.passed).length;
  const scores = cases.flatMap((entry) => entry.score === undefined ? [] : [entry.score]);
  const avgScore = scores.length === 0
    ? undefined
    : Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000;
  const totalCost = cases.reduce((sum, entry) => sum + entry.cost, 0);
  const avgLatencyMs = cases.length === 0
    ? 0
    : cases.reduce((sum, entry) => sum + entry.latencyMs, 0) / cases.length;

  return {
    name: dataset.name ?? "eval",
    total: cases.length,
    passed,
    failed: cases.length - passed,
    passRate: cases.length === 0 ? 1 : passed / cases.length,
    ...(avgScore === undefined ? {} : { avgScore }),
    avgLatencyMs: Math.round(avgLatencyMs * 100) / 100,
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    cases,
  };
}

export function formatReport(report: EvalReport): string {
  const lines = [`Eval: ${report.name}`];
  const score = report.avgScore === undefined
    ? ""
    : `, avg score ${(report.avgScore * 100).toFixed(1)}%`;
  lines.push(
    `  ${report.passed}/${report.total} passed (${(report.passRate * 100).toFixed(1)}%) — ` +
      `avg ${report.avgLatencyMs}ms, total cost $${report.totalCost.toFixed(6)}${score}`,
  );
  for (const result of report.cases) {
    const caseScore = result.score === undefined ? "" : ` score=${(result.score * 100).toFixed(0)}%`;
    lines.push(
      `  [${result.passed ? "PASS" : "FAIL"}] ${result.id}${result.flow === undefined ? "" : ` (${result.flow})`} — ${result.latencyMs}ms${caseScore}`,
    );
    if (result.error !== undefined) lines.push(`         error: ${result.error}`);
    for (const assertion of result.assertions) {
      if (!assertion.passed) {
        lines.push(`         ✗ ${assertion.assertion.type}: ${assertion.detail ?? "failed"}`);
      }
    }
  }
  return lines.join("\n");
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { ChatMessage, TokenUsage } from "../types/openai.js";
import { formatCostWithCurrency } from "../util/currency.js";

export type EvalMessage = ChatMessage;

export type Assertion =
  | { type: "contains"; value: string; caseSensitive?: boolean }
  | { type: "notContains"; value: string; caseSensitive?: boolean }
  | { type: "equals"; value: string }
  | { type: "regex"; pattern: string; flags?: string }
  | { type: "maxLatencyMs"; value: number }
  | { type: "maxCost"; value: number }
  /**
   * Structured check of a JSON answer: `path` addresses a value in the
   * response parsed as JSON (`$.a.b[0].c`, `$["key"]`; no filters or wildcards).
   * With `equals` the value must deep-equal it, with `matches` its string form
   * must match the regex; with neither it only has to exist.
   */
  | { type: "jsonPath"; path: string; equals?: unknown; matches?: string; flags?: string }
  /**
   * The flow called tool `name` (a full ref `server/tool` or the bare tool
   * name) at least `min` (default 1) and at most `max` times. `max: 0` asserts
   * the tool was NOT called. Needs the executor to report its tool calls;
   * without them the assertion fails rather than passes by default.
   */
  | { type: "toolCalled"; name: string; min?: number; max?: number }
  /** Total tokens (prompt + completion) of the run stay at or below `value`. */
  | { type: "maxTokens"; value: number }
  /**
   * The execution's finish reason equals `equals` or differs from
   * `notEquals` (exactly one of the two). Needs the executor to report a
   * finish reason; without one the assertion fails rather than passes.
   */
  | { type: "finishReason"; equals?: string; notEquals?: string }
  /**
   * The execution trace recorded no diagnostic with `code`. Needs the
   * executor to report diagnostics; without them the assertion fails
   * rather than passes by default.
   */
  | { type: "noDiagnostic"; code: string }
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
  /** Tool refs in call order (`server/tool`), for `toolCalled` assertions. */
  toolCalls?: string[];
  /** Finish reason of the execution (from the debug trace), when reported. */
  finishReason?: string;
  /** Diagnostic codes recorded during the execution, in trace order. */
  diagnostics?: string[];
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

/**
 * Regex assertions match at most this many characters of the model output: the
 * pattern is an operator's, the text is not, and an unbounded input turns a
 * slow pattern into a stuck eval run.
 */
export const EVAL_REGEX_MAX_INPUT_CHARS = 100_000;

function regexInput(text: string): string {
  return text.length > EVAL_REGEX_MAX_INPUT_CHARS ? text.slice(0, EVAL_REGEX_MAX_INPUT_CHARS) : text;
}

/** What an assertion can look at. Trace fields are absent when the executor reports none. */
export interface AssertionContext {
  text: string;
  latencyMs: number;
  cost: number;
  toolCalls?: readonly string[];
  totalTokens?: number;
  finishReason?: string;
  diagnostics?: readonly string[];
}
const MAX_JSON_SCAN_CHARS = 1_000_000;
/** The answer parsed as JSON: the whole text, else the first fenced code block. */
function parseJsonAnswer(text: string): { ok: true; value: unknown } | { ok: false } {
  const bounded = text.length > MAX_JSON_SCAN_CHARS ? text.slice(0, MAX_JSON_SCAN_CHARS) : text;
  const candidates = [bounded.trim()];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(bounded);
  if (fence?.[1] !== undefined) candidates.push(fence[1].trim());
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* try the next candidate */
    }
  }
  return { ok: false };
}
/** `$.a.b[0].c` and `$["k"]`; anything else (filters, wildcards, `..`) is rejected. */
export function parseJsonPath(path: string): Array<string | number> | undefined {
  if (!path.startsWith("$")) return undefined;
  const segments: Array<string | number> = [];
  let rest = path.slice(1);
  while (rest.length > 0) {
    const key = /^\.([A-Za-z_][\w-]*)/.exec(rest);
    const index = /^\[(\d+)\]/.exec(rest);
    const quoted = /^\[(?:"([^"]*)"|'([^']*)')\]/.exec(rest);
    if (key?.[1] !== undefined) {
      segments.push(key[1]);
      rest = rest.slice(key[0].length);
    } else if (index?.[1] !== undefined) {
      segments.push(Number(index[1]));
      rest = rest.slice(index[0].length);
    } else if (quoted !== null) {
      segments.push(quoted[1] ?? quoted[2] ?? "");
      rest = rest.slice(quoted[0].length);
    } else {
      return undefined;
    }
  }
  return segments;
}
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function toolMatches(called: string, wanted: string): boolean {
  return called === wanted || called.endsWith(`/${wanted}`);
}
export function evaluateAssertion(
  assertion: Assertion,
  ctx: AssertionContext,
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
        return new RegExp(assertion.pattern, assertion.flags).test(regexInput(ctx.text))
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
        : fail(
            `cost ${formatCostWithCurrency(ctx.cost)} exceeded ${formatCostWithCurrency(assertion.value)}`,
          );
    case "jsonPath": {
      const segments = parseJsonPath(assertion.path);
      if (segments === undefined) return fail(`unsupported JSON path "${assertion.path}"`);
      const parsed = parseJsonAnswer(ctx.text);
      if (!parsed.ok) return fail("response is not JSON");
      let current: unknown = parsed.value;
      for (const segment of segments) {
        if (current === null || typeof current !== "object") return fail(`no value at ${assertion.path}`);
        const container = current as Record<string | number, unknown>;
        if (!Object.hasOwn(container, segment)) {
          return fail(`no value at ${assertion.path}`);
        }
        current = container[segment];
      }
      if ("equals" in assertion && assertion.equals !== undefined) {
        return jsonEqual(current, assertion.equals)
          ? pass()
          : fail(`${assertion.path} was ${JSON.stringify(current)}, expected ${JSON.stringify(assertion.equals)}`);
      }
      if (assertion.matches !== undefined) {
        try {
          return new RegExp(assertion.matches, assertion.flags).test(regexInput(String(current)))
            ? pass()
            : fail(`${assertion.path} did not match /${assertion.matches}/`);
        } catch {
          return fail(`invalid regex /${assertion.matches}/${assertion.flags ?? ""}`);
        }
      }
      return pass();
    }
    case "toolCalled": {
      if (ctx.toolCalls === undefined) {
        return fail("the executor did not report tool calls, so toolCalled cannot be checked");
      }
      const count = ctx.toolCalls.filter((called) => toolMatches(called, assertion.name)).length;
      const min = assertion.min ?? (assertion.max === 0 ? 0 : 1);
      if (count < min) return fail(`${assertion.name} was called ${count}x, expected at least ${min}`);
      if (assertion.max !== undefined && count > assertion.max) {
        return fail(`${assertion.name} was called ${count}x, expected at most ${assertion.max}`);
      }
      return pass();
    }
    case "maxTokens": {
      if (ctx.totalTokens === undefined) {
        return fail("the executor did not report token usage, so maxTokens cannot be checked");
      }
      return ctx.totalTokens <= assertion.value
        ? pass()
        : fail(`${ctx.totalTokens} tokens exceeded ${assertion.value}`);
    }
    case "finishReason": {
      if (ctx.finishReason === undefined) return fail("no finish reason available");
      if (assertion.equals !== undefined) {
        return ctx.finishReason === assertion.equals
          ? pass()
          : fail(`finish reason was "${ctx.finishReason}", expected "${assertion.equals}"`);
      }
      return ctx.finishReason !== assertion.notEquals
        ? pass()
        : fail(`finish reason was "${ctx.finishReason}", expected anything but "${assertion.notEquals}"`);
    }
    case "noDiagnostic": {
      if (ctx.diagnostics === undefined) return fail("no trace diagnostics available");
      return ctx.diagnostics.includes(assertion.code)
        ? fail(`diagnostic "${assertion.code}" was reported`)
        : pass();
    }
    case "llmJudge":
      return fail("llmJudge assertion requires a judge (none configured)");
  }
}

export interface RunOptions {
  concurrency?: number;
  judge?: Judge;
  judgeThreshold?: number;
}

function totalTokensOf(usage: TokenUsage | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const parts = [usage.prompt_tokens, usage.completion_tokens].filter((n): n is number => typeof n === "number");
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined;
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
        assertions.push(
          evaluateAssertion(assertion, {
            text: responseText,
            latencyMs,
            cost,
            ...(output.toolCalls !== undefined ? { toolCalls: output.toolCalls } : {}),
            ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
            ...(output.diagnostics !== undefined ? { diagnostics: output.diagnostics } : {}),
            ...(totalTokensOf(output.usage) !== undefined
              ? { totalTokens: totalTokensOf(output.usage) as number }
              : {}),
          }),
        );
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
      `avg ${report.avgLatencyMs}ms, total cost ${formatCostWithCurrency(report.totalCost)}${score}`,
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

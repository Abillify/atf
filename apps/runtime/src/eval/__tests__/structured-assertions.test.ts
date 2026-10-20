// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
/**
 * Structured eval assertions (P1-P9): jsonPath, toolCalled, maxTokens next to the
 * existing contains/regex/..., usable in dataset cases AND matrix tasks.
 * Additive: a case or task with only a free-text `expected` is unchanged.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { evaluateAssertion, parseJsonPath, runEval, type Assertion } from "../eval-runner.js";
import { parseTaskAssertions } from "../assertion-schema.js";
import {
  EvalMatrixService,
  InMemoryEvalMatrixRunStore,
} from "../eval-matrix.js";
import { createEvalRunsRouter } from "../../routes/eval-runs.js";
import { createEvalRunHistory } from "../eval-run-history.js";

const ctx = (over: Partial<Parameters<typeof evaluateAssertion>[1]> = {}) => ({
  text: "",
  latencyMs: 10,
  cost: 0,
  ...over,
});
const check = (assertion: Assertion, over = {}) => evaluateAssertion(assertion, ctx(over));

describe("parseJsonPath", () => {
  test("accepts dotted, indexed and quoted paths", () => {
    expect(parseJsonPath("$")).toEqual([]);
    expect(parseJsonPath("$.a.b[0].c")).toEqual(["a", "b", 0, "c"]);
    expect(parseJsonPath('$["key with space"][2]')).toEqual(["key with space", 2]);
  });
  test("rejects filters, wildcards and recursive descent", () => {
    for (const bad of ["a.b", "$..a", "$.a[*]", "$.a[?(@.x)]", "$.a b"]) {
      expect(parseJsonPath(bad)).toBeUndefined();
    }
  });
});

describe("jsonPath assertion", () => {
  const answer = JSON.stringify({ status: "ok", items: [{ id: 7, name: "Anna" }], n: 3 });
  test("equals, matches and existence on a JSON answer", () => {
    expect(check({ type: "jsonPath", path: "$.status", equals: "ok" }, { text: answer }).passed).toBe(true);
    expect(check({ type: "jsonPath", path: "$.items[0].id", equals: 7 }, { text: answer }).passed).toBe(true);
    expect(check({ type: "jsonPath", path: "$.items[0].name", matches: "^An" }, { text: answer }).passed).toBe(true);
    expect(check({ type: "jsonPath", path: "$.n" }, { text: answer }).passed).toBe(true);
    const wrong = check({ type: "jsonPath", path: "$.status", equals: "failed" }, { text: answer });
    expect(wrong.passed).toBe(false);
    expect(wrong.detail).toContain('"ok"');
  });
  test("a missing value fails; so does an unsupported path or a non-JSON answer", () => {
    expect(check({ type: "jsonPath", path: "$.nope" }, { text: answer }).passed).toBe(false);
    expect(check({ type: "jsonPath", path: "$.items[3]" }, { text: answer }).passed).toBe(false);
    expect(check({ type: "jsonPath", path: "$..x" }, { text: answer }).detail).toContain("unsupported");
    expect(check({ type: "jsonPath", path: "$.a" }, { text: "just words" }).detail).toBe("response is not JSON");
  });
  test("reads the first fenced JSON block of a prose answer", () => {
    const text = 'Here you go:\n```json\n{"ok": true}\n```\nbye';
    expect(check({ type: "jsonPath", path: "$.ok", equals: true }, { text }).passed).toBe(true);
  });
  test("does not walk the prototype chain", () => {
    expect(check({ type: "jsonPath", path: "$.constructor" }, { text: "{}" }).passed).toBe(false);
  });
});

describe("toolCalled assertion", () => {
  const calls = ["vectorsearch/search", "vectorsearch/search", "gate/get_orders"];
  test("counts calls by full ref or bare tool name", () => {
    expect(check({ type: "toolCalled", name: "vectorsearch/search" }, { toolCalls: calls }).passed).toBe(true);
    expect(check({ type: "toolCalled", name: "get_orders" }, { toolCalls: calls }).passed).toBe(true);
    expect(check({ type: "toolCalled", name: "search", min: 2, max: 2 }, { toolCalls: calls }).passed).toBe(true);
    expect(check({ type: "toolCalled", name: "search", max: 1 }, { toolCalls: calls }).passed).toBe(false);
    expect(check({ type: "toolCalled", name: "delete_order" }, { toolCalls: calls }).passed).toBe(false);
  });
  test("max: 0 asserts the tool was NOT called", () => {
    expect(check({ type: "toolCalled", name: "delete_order", max: 0 }, { toolCalls: calls }).passed).toBe(true);
    expect(check({ type: "toolCalled", name: "get_orders", max: 0 }, { toolCalls: calls }).passed).toBe(false);
  });
  test("fails closed when the executor reported no tool calls", () => {
    const result = check({ type: "toolCalled", name: "x", max: 0 });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("did not report tool calls");
  });
});

describe("maxTokens assertion", () => {
  test("compares the total, and fails closed without usage", () => {
    expect(check({ type: "maxTokens", value: 100 }, { totalTokens: 100 }).passed).toBe(true);
    expect(check({ type: "maxTokens", value: 100 }, { totalTokens: 101 }).passed).toBe(false);
    expect(check({ type: "maxTokens", value: 100 }).detail).toContain("did not report token usage");
  });
});

describe("dataset runs", () => {
  test("toolCalled and maxTokens use what the executor reports; legacy cases are unchanged", async () => {
    const report = await runEval(
      {
        name: "mixed",
        cases: [
          {
            id: "structured",
            messages: [{ role: "user", content: "hi" }],
            flow: "f",
            assert: [
              { type: "toolCalled", name: "search" },
              { type: "maxTokens", value: 50 },
              { type: "jsonPath", path: "$.ok", equals: true },
            ],
          },
          { id: "legacy", messages: [{ role: "user", content: "hi" }], flow: "f", expected: "ok" },
        ],
      },
      async () => ({
        response: '{"ok":true}',
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        toolCalls: ["vectorsearch/search"],
      }),
    );
    expect(report.cases.find((c) => c.id === "structured")?.passed).toBe(true);
    expect(report.cases.find((c) => c.id === "legacy")).toBeDefined();
  });
});

describe("parseTaskAssertions", () => {
  test("absent is fine; bounded, typed and strict otherwise", () => {
    expect(parseTaskAssertions(undefined)).toEqual({ ok: true, assertions: [] });
    expect(parseTaskAssertions([{ type: "contains", value: "x" }, { type: "toolCalled", name: "s", max: 0 }]).ok).toBe(true);
    for (const bad of [
      "contains",
      [{ type: "unknown" }],
      [{ type: "llmJudge", criteria: "good" }],
      [{ type: "regex", pattern: "(" }],
      [{ type: "regex", pattern: "a", flags: "x" }],
      [{ type: "jsonPath", path: "$..a" }],
      [{ type: "maxTokens", value: -1 }],
      [{ type: "contains", value: "x", extra: 1 }],
      Array.from({ length: 21 }, () => ({ type: "contains", value: "x" })),
    ]) {
      expect(parseTaskAssertions(bad).ok).toBe(false);
    }
  });
});

describe("matrix grading", () => {
  async function runMatrix(task: Record<string, unknown>, response: string, toolCalls: string[] = []) {
    const graphEngine = {
      executeFlow: async (
        _flow: string,
        _messages: unknown,
        _context: unknown,
        _onChunk: unknown,
        onUsage: (u: unknown) => Promise<void>,
        _monitoring: unknown,
        _x: unknown,
        onFinal: (r: string) => Promise<void>,
      ) => {
        await onUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        await onFinal(response);
      },
    };
    const debugTraceStore = {
      getTrace: () => ({
        flow_version: "1.0.0",
        context: { trace_id: "trace-1" },
        nodes: [{ cost: 0, tool_calls: toolCalls.map((name) => ({ id: name, name, arguments: {}, result: null })) }],
      }),
    };
    const store = new InMemoryEvalMatrixRunStore();
    const service = new EvalMatrixService({
      store,
      graphEngine: graphEngine as never,
      flowRegistry: { get: () => ({}), list: () => [] } as never,
      debugTraceStore: debugTraceStore as never,
    });
    const started = await service.start({ name: "m", tasks: [task as never], flows: ["f"], createdBy: "t" });
    for (let i = 0; i < 100; i += 1) {
      const run = await store.get(started.id);
      if (run?.status === "completed" || run?.status === "failed") {
        const error = run.cells.find((cell) => cell.error !== undefined)?.error;
        if (error !== undefined) throw new Error(`matrix cell failed: ${error}`);
        return run;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("matrix did not finish");
  }

  test("assertions alone decide the cell, with the per-assertion results kept", async () => {
    const run = await runMatrix(
      {
        id: "t1",
        prompt: "p",
        assert: [
          { type: "jsonPath", path: "$.status", equals: "ok" },
          { type: "toolCalled", name: "search" },
          { type: "maxTokens", value: 20 },
        ],
      },
      '{"status":"ok"}',
      ["vectorsearch/search"],
    );
    const cell = run.cells[0];
    expect(cell?.passed).toBe(true);
    expect(cell?.score).toBe(1);
    expect(cell?.assertions?.map((a) => a.passed)).toEqual([true, true, true]);
  });

  test("one failing assertion fails the cell and lowers the score", async () => {
    const run = await runMatrix(
      { id: "t2", prompt: "p", assert: [{ type: "contains", value: "ok" }, { type: "toolCalled", name: "delete", max: 0 }] },
      "ok",
      ["gate/delete"],
    );
    expect(run.cells[0]?.passed).toBe(false);
    expect(run.cells[0]?.score).toBe(0.5);
  });

  test("expected + assert: both must hold; expected-only tasks behave as before", async () => {
    const both = await runMatrix(
      { id: "t3", prompt: "p", expected: "the answer is forty two", assert: [{ type: "contains", value: "forty" }] },
      "the answer is forty two",
    );
    expect(both.cells[0]?.passed).toBe(true);
    const assertFails = await runMatrix(
      { id: "t4", prompt: "p", expected: "the answer is forty two", assert: [{ type: "contains", value: "banana" }] },
      "the answer is forty two",
    );
    expect(assertFails.cells[0]?.passed).toBe(false);
    const legacy = await runMatrix({ id: "t5", prompt: "p", expected: "the answer is forty two" }, "the answer is forty two");
    expect(legacy.cells[0]?.passed).toBe(true);
    expect(legacy.cells[0]?.assertions).toBeUndefined();
  });
});

describe("POST /admin/eval/matrix-runs validation", () => {
  const started: unknown[] = [];
  const app = new Hono().route(
    "/",
    createEvalRunsRouter({
      history: createEvalRunHistory(),
      matrix: {
        start: async (input: unknown) => {
          started.push(input);
          return { id: "run-1" };
        },
      } as never,
    }),
  );
  const post = (body: unknown) =>
    app.request("/admin/eval/matrix-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("accepts a task with assertions and no expected answer", async () => {
    const res = await post({ name: "n", flows: ["f"], tasks: [{ prompt: "p", assert: [{ type: "contains", value: "x" }] }] });
    expect(res.status).toBeLessThan(300);
    expect((started.at(-1) as { tasks: Array<{ assert?: unknown[]; expected?: string }> }).tasks[0]?.assert).toHaveLength(1);
    expect((started.at(-1) as { tasks: Array<{ expected?: string }> }).tasks[0]?.expected).toBeUndefined();
  });

  test("still accepts the legacy prompt/expected pair", async () => {
    const res = await post({ name: "n", flows: ["f"], tasks: [{ prompt: "p", expected: "e" }] });
    expect(res.status).toBeLessThan(300);
  });

  test("rejects a task with neither, and a malformed assertion with its reason", async () => {
    expect((await post({ name: "n", flows: ["f"], tasks: [{ prompt: "p" }] })).status).toBe(400);
    const bad = await post({ name: "n", flows: ["f"], tasks: [{ id: "t9", prompt: "p", assert: [{ type: "regex", pattern: "(" }] }] });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain("task t9: assert[0]");
  });
});

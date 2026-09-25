// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { checkExpression, markSelection, proposeExpression, type ExpressionCopilotInput } from "../expression-copilot.js";

/** A model that answers with the given proposals in turn and records the prompts. */
function fakeModel(answers: Array<{ expression: string; explanation: string } | "throw">) {
  const prompts: string[] = [];
  let i = 0;
  const model = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-expr",
    doGenerate: async (opts: { prompt: unknown }) => {
      prompts.push(JSON.stringify(opts.prompt));
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a === "throw" || a === undefined) throw new Error("provider down");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(a) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      };
    },
    doStream: async () => {
      throw new Error("not used");
    },
  } as unknown as LanguageModel;
  return { model, prompts };
}

const ctx = { constants: { budget: 300 }, env: { FLOW_PUBLIC_REGION: "eu" } };

const input = (over: Partial<ExpressionCopilotInput> = {}): ExpressionCopilotInput => ({
  kind: "condition",
  current: "classification.route == 'INKASSO'",
  instruction: "auch BETRIEB zulassen",
  vocabulary: [
    {
      title: "Node results",
      entries: [
        { ref: "node.triage.classification.route", value: "BETRIEB", description: "route as triage set it" },
        { ref: "context.userName", unavailable: "only in prompts" },
      ],
    },
  ],
  variables: { max_tokens: 1000 },
  ...over,
});

describe("checkExpression (engine checks)", () => {
  test("conditions are parsed by the condition evaluator, after load-time replacement", () => {
    expect(checkExpression("condition", "classification.route == 'A' || lastMessageText =~ 'x'", {}, false, ctx)).toBeNull();
    expect(checkExpression("condition", "messageCount < {{const.budget}}", {}, false, ctx)).toBeNull();
    expect(checkExpression("condition", "route ==", {}, false, ctx)).toMatch(/Invalid condition/);
  });

  test("calculations and references must resolve", () => {
    expect(checkExpression("vars", "{{= round(vars.max_tokens / 3) }}", { max_tokens: 1000 }, false, ctx)).toBeNull();
    expect(checkExpression("vars", "{{= vars.nope * 2 }}", {}, false, ctx)).toMatch(/Unknown variable/);
    expect(checkExpression("vars", "{{const.missing}}", {}, false, ctx)).toMatch(/Unknown constant/);
  });

  test("run-time placeholders are rejected where the field resolves at load time only", () => {
    expect(checkExpression("vars", "{{context.userName}}", {}, false, ctx)).toMatch(/resolved when the flow loads/);
    expect(checkExpression("vars", "{{context.userName}}", {}, true, ctx)).toBeNull();
    expect(checkExpression("template", "Hallo {{context.userName}}", {}, false, ctx)).toBeNull();
    expect(checkExpression("template", "{{invented.thing}}", {}, false, ctx)).toMatch(/Unknown placeholder root/);
  });
});

describe("proposeExpression", () => {
  test("returns a checked proposal and gives the model grammar, data and current value", async () => {
    const { model, prompts } = fakeModel([
      { expression: "classification.route == 'INKASSO' || classification.route == 'BETRIEB'", explanation: "BETRIEB ergänzt." },
    ]);
    const r = await proposeExpression(input(), model, { context: ctx });
    expect(r).toEqual({
      ok: true,
      expression: "classification.route == 'INKASSO' || classification.route == 'BETRIEB'",
      explanation: "BETRIEB ergänzt.",
      changed: true,
    });
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("FIELD KIND: condition expression");
    expect(prompt).toContain("node.triage.classification.route = \\\"BETRIEB\\\"");
    expect(prompt).toContain("not usable here: context.userName");
    expect(prompt).toContain("classification.route == 'INKASSO'");
  });

  test("an invalid proposal gets one repair round with the problem", async () => {
    const { model, prompts } = fakeModel([
      { expression: "classification.route ==", explanation: "x" },
      { expression: "classification.route == 'BETRIEB'", explanation: "fixed" },
    ]);
    const r = await proposeExpression(input(), model, { context: ctx });
    expect(r.ok && r.expression).toBe("classification.route == 'BETRIEB'");
    expect(prompts[1]).toContain("That value is not valid: Invalid condition");
  });

  test("still invalid after the repair round → a clear failure", async () => {
    const { model } = fakeModel([{ expression: "{{= vars.nope }}", explanation: "x" }]);
    const r = await proposeExpression(input({ kind: "vars", current: "" }), model, { context: ctx });
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Unknown variable") });
  });

  test("a model error is reported, not thrown", async () => {
    const { model } = fakeModel(["throw"]);
    const r = await proposeExpression(input(), model, { context: ctx });
    expect(r.ok).toBe(false);
  });
});

describe("cursor / selection", () => {
  test("marks the caret or the selected range, clamped to the value", () => {
    expect(markSelection("ab", { start: 1, end: 1 }).text).toBe("a⟦CURSOR⟧b");
    expect(markSelection("abcd", { start: 3, end: 1 }).text).toBe("a⟦SELECTION⟧bc⟦/SELECTION⟧d");
    expect(markSelection("ab", { start: 9, end: 9 }).text).toBe("ab⟦CURSOR⟧");
    expect(markSelection("ab", undefined)).toEqual({ text: "ab" });
  });

  test("the prompt carries the selection and echoed marks are stripped from the proposal", async () => {
    const { model, prompts } = fakeModel([
      { expression: "classification.route == 'BETRIEB'⟦CURSOR⟧", explanation: "ok" },
    ]);
    const current = "classification.route == 'INKASSO'";
    const res = await proposeExpression(
      input({ current, selection: { start: current.indexOf("'"), end: current.length } }),
      model,
      { context: ctx },
    );
    expect(prompts[0]).toContain("⟦SELECTION⟧'INKASSO'⟦/SELECTION⟧");
    expect(prompts[0]).toContain("marks the text the user selected");
    expect(res).toMatchObject({ ok: true, expression: "classification.route == 'BETRIEB'" });
  });
});

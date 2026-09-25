// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FlowDefinition } from "../../../types/flow.js";
import { validateFlow } from "../../flow-validator.js";
import {
  loadFlowConstants,
  publicEnv,
  resetFlowConstants,
  setFlowConstantsDir,
} from "../flow-constants.js";
import { applyFlowVariables } from "../normalize.js";
import { ExpressionError, evaluateExpression, expressionReferences } from "../variable-expressions.js";
import { evaluateFlowVariables, type VariableContext } from "../variable-values.js";

const ctx: VariableContext = {
  constants: { company: "Abillify", max_tokens: 40000, limits: { hard: 100 } },
  env: { FLOW_PUBLIC_REGION: "eu-central-1" },
};

const noRefs = (): unknown => {
  throw new ExpressionError("no refs");
};

afterEach(() => resetFlowConstants());

describe("evaluateExpression", () => {
  test("arithmetic with precedence, parentheses and unary minus", () => {
    expect(evaluateExpression("1 + 2 * 3", noRefs)).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3", noRefs)).toBe(9);
    expect(evaluateExpression("-4 + 10 % 3", noRefs)).toBe(-3);
    expect(evaluateExpression("7 / 2", noRefs)).toBe(3.5);
  });

  test("strings, comparisons, logic and the ternary", () => {
    expect(evaluateExpression("'a' + 1", noRefs)).toBe("a1");
    expect(evaluateExpression("2 >= 2 && !(1 == 2)", noRefs)).toBe(true);
    expect(evaluateExpression("3 > 2 ? 'big' : 'small'", noRefs)).toBe("big");
  });

  test("functions", () => {
    expect(evaluateExpression("round(10 / 3, 2)", noRefs)).toBe(3.33);
    expect(evaluateExpression("max(1, 5, 3) + min(4, 2)", noRefs)).toBe(7);
    expect(evaluateExpression("upper(concat('a', 'b'))", noRefs)).toBe("AB");
    expect(evaluateExpression("coalesce('', 'x')", noRefs)).toBe("x");
    expect(evaluateExpression("number('12') + 1", noRefs)).toBe(13);
  });

  test("references go through the lookup; a-1 is a subtraction", () => {
    expect(evaluateExpression("vars.a-1", (p) => (p === "vars.a" ? 5 : undefined))).toBe(4);
    expect(expressionReferences("round(vars.a / const.b) + env.FLOW_PUBLIC_X")).toEqual([
      "vars.a",
      "const.b",
      "env.FLOW_PUBLIC_X",
    ]);
  });

  test("errors are ExpressionErrors with a readable message", () => {
    expect(() => evaluateExpression("1 / 0", noRefs)).toThrow("Division by zero.");
    expect(() => evaluateExpression("1 +", noRefs)).toThrow(ExpressionError);
    expect(() => evaluateExpression("process.exit(1)", noRefs)).toThrow(/Unknown function/);
    expect(() => evaluateExpression("'abc' * 2", noRefs)).toThrow(/not a number/);
  });
});

describe("evaluateFlowVariables", () => {
  test("resolves variables in dependency order, keeping exact types", () => {
    const { values, errors } = evaluateFlowVariables(
      {
        half: "{{= vars.total / 2 }}",
        total: "{{const.max_tokens}}",
        label: "{{const.company}} ({{env.FLOW_PUBLIC_REGION}})",
        hard: "{{const.limits.hard}}",
        greeting: "Hi {{vars.label}}, answer {{classification.intent}}",
      },
      undefined,
      ctx,
    );
    expect(errors).toEqual([]);
    expect(values).toEqual({
      half: 20000,
      total: 40000,
      label: "Abillify (eu-central-1)",
      hard: 100,
      // Runtime templates stay untouched.
      greeting: "Hi Abillify (eu-central-1), answer {{classification.intent}}",
    });
  });

  test("request overrides are literals, but dependents see them", () => {
    const { values } = evaluateFlowVariables(
      { total: 100, half: "{{= vars.total / 2 }}" },
      { total: 10, injected: "{{= 1 + 1 }}", sneaky: "{{env.FLOW_PUBLIC_REGION}}" },
      ctx,
    );
    expect(values["half"]).toBe(5);
    expect(values["injected"]).toBe("{{= 1 + 1 }}");
    expect(values["sneaky"]).toBe("{{env.FLOW_PUBLIC_REGION}}");
  });

  test("env outside the FLOW_PUBLIC_ allowlist is never read", () => {
    const { values, errors } = evaluateFlowVariables(
      { key: "{{env.OPENAI_API_KEY}}" },
      undefined,
      { constants: {}, env: { OPENAI_API_KEY: "sk-secret" } as Record<string, string> },
    );
    expect(values["key"]).toBe("{{env.OPENAI_API_KEY}}");
    expect(errors[0]?.message).toMatch(/only variables named FLOW_PUBLIC_\*/);
    expect(publicEnv({ OPENAI_API_KEY: "x", FLOW_PUBLIC_A: "a" })).toEqual({ FLOW_PUBLIC_A: "a" });
  });

  test("reports cycles, unknown references and calculation errors per variable", () => {
    const { errors } = evaluateFlowVariables(
      { a: "{{vars.b}}", b: "{{vars.a}}", c: "{{const.nope}}", d: "{{= 1 / 0 }}", e: "{{vars.missing}}" },
      undefined,
      ctx,
    );
    const byName = Object.fromEntries(errors.map((e) => [e.name, e.message]));
    expect(byName["a"]).toMatch(/Circular reference: a → b → a/);
    expect(byName["c"]).toMatch(/Unknown constant "const.nope"/);
    expect(byName["d"]).toBe("Division by zero.");
    expect(byName["e"]).toMatch(/Unknown variable "vars.missing"/);
  });

  test("plain values pass through without work", () => {
    const declared = { a: 1, b: "x" };
    expect(evaluateFlowVariables(declared, { c: 2 }, ctx)).toEqual({
      values: { a: 1, b: "x", c: 2 },
      errors: [],
    });
  });
});

describe("constants file + integration", () => {
  const flow = (variables: Record<string, unknown>): FlowDefinition =>
    ({
      id: "f",
      name: "F",
      variables,
      nodes: [{ id: "a", type: "llm", config: { maxTokens: "{{vars.half}}", note: "{{vars.label}}" } }],
      edges: [],
    }) as unknown as FlowDefinition;

  test("constants.yaml is read, and applyFlowVariables substitutes evaluated values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-constants-"));
    fs.writeFileSync(path.join(dir, "constants.yaml"), "constants:\n  budget: 300\n  company: ACME\n");
    expect(loadFlowConstants(dir)).toEqual({ budget: 300, company: "ACME" });
    setFlowConstantsDir(dir);
    const resolved = applyFlowVariables(
      flow({ half: "{{= const.budget / 3 }}", label: "{{const.company}}" }),
    );
    expect(resolved.nodes[0]?.config).toEqual({ maxTokens: 100, note: "ACME" });
    // An override of an input re-evaluates its dependents.
    const overridden = applyFlowVariables(
      flow({ total: 90, half: "{{= vars.total / 3 }}", label: "x" }),
      { total: 30 },
    );
    expect(overridden.nodes[0]?.config).toEqual({ maxTokens: 10, note: "x" });
  });

  test("the validator reports variable errors with their path", () => {
    const report = validateFlow(flow({ half: "{{= vars.total / }}", label: "{{env.SECRET}}" }));
    expect(report.valid).toBe(false);
    expect(report.errors.map((e) => e.path)).toEqual(["variables.half", "variables.label"]);
  });

  test("constants, env and calculations work directly in node and edge values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flow-constants-"));
    fs.writeFileSync(path.join(dir, "constants.yaml"), "constants:\n  budget: 300\n");
    setFlowConstantsDir(dir);
    const bare = {
      id: "f",
      name: "F",
      nodes: [
        {
          id: "a",
          type: "llm",
          llm: { provider: "openai", model: "m", parameters: { maxTokens: "{{= const.budget * 2 }}" } },
          systemPrompt: "Budget {{const.budget}} for {{context.userName}}",
        },
      ],
      edges: [{ source: "a", target: "a", conditions: "messageCount < {{const.budget}}" }],
    } as unknown as FlowDefinition;
    const resolved = applyFlowVariables(bare); // no variables at all
    expect(resolved.nodes[0]?.llm?.parameters?.maxTokens).toBe(600);
    // Runtime placeholders stay for the run.
    expect(resolved.nodes[0]?.systemPrompt).toBe("Budget 300 for {{context.userName}}");
    expect(resolved.edges[0]?.conditions).toBe("messageCount < 300");
  });

  test("the validator reports unresolved node placeholders with their path", () => {
    const report = validateFlow({
      id: "f",
      name: "F",
      nodes: [{ id: "a", type: "llm", config: { note: "{{const.nope}} / {{vars.fromRequest}}", n: "{{= 1 / 0 }}" } }],
      edges: [],
    });
    expect(report.errors.map((e) => [e.path, e.message])).toEqual([
      ["nodes[0](a).config.note", '{{const.nope}}: Unknown constant "const.nope" (flows/constants.yaml).'],
      ["nodes[0](a).config.n", "{{= 1 / 0 }}: Division by zero."],
    ]);
    expect(report.warnings.map((w) => w.path)).toContain("nodes[0](a).config.note");
  });
});

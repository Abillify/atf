// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pins the flow reference data (flow-reference-data.ts) to the engine code it
 * describes, and checks the generated docs/FLOWS.md covers every source entry.
 * When one of these fails, the engine changed: update the reference data and
 * run `bun run flow-reference`.
 */

import { describe, expect, test } from "bun:test";
import type { AgentExecutionContext } from "../../types/monitoring.js";
import { resolveContextPlaceholders } from "../exec-runtime.js";
import { EXPRESSION_FUNCTIONS } from "../flow-parser/variable-expressions.js";
import {
  CALCULATION_FUNCTIONS,
  CONDITION_FIELDS,
  LLM_PARAMETERS,
  TEMPLATE_PLACEHOLDERS,
} from "../flow-reference-data.js";
import { buildFlowReferenceMarkdown } from "../flow-reference.js";
import { buildConditionContext } from "../graph-engine/node-config.js";
import type { AgentState } from "../graph-engine/state.js";
import { COMMON_CONFIG_FIELDS, NODE_TYPE_CATALOG } from "../node-type-catalog.js";

const rootOf = (path: string): string => path.split(/[.[]/)[0] ?? path;

describe("flow reference data matches the engine", () => {
  test("calculation functions are exactly the evaluator's functions", () => {
    const documented = CALCULATION_FUNCTIONS.map((f) => f.text.replace("()", "")).sort();
    expect(documented).toEqual([...EXPRESSION_FUNCTIONS].sort());
  });

  test("condition fields are exactly what buildConditionContext exposes", () => {
    const state = {
      messages: [],
      errors: [],
      toolResults: [],
      turns: [],
      context: {},
    } as unknown as AgentState;
    const exposed = Object.keys(buildConditionContext(state)).sort();
    const documented = [
      ...new Set(CONDITION_FIELDS.flatMap((g) => g.symbols.map((s) => rootOf(s.path)))),
    ].sort();
    expect(documented).toEqual(exposed);
  });

  test("every prompt placeholder renders in a system prompt", () => {
    const ctx = {
      ssoToken: "",
      executionId: "exec-1",
      userName: "Erika",
      userEmail: "e@example.com",
      userId: "u-1",
      role: "user",
      groups: ["staff"],
      plan: "pro",
      language: "de",
      clientId: "c",
      chatId: "chat",
      claims: { sub: "s" },
      requestParams: { x: "y" },
    } as unknown as AgentExecutionContext;
    const turn = { triage: { classification: { route: "A" } } };
    for (const group of TEMPLATE_PLACEHOLDERS.filter((g) => g.scopes.includes("prompt"))) {
      for (const s of group.symbols) {
        const path = s.path
          .replace("<id>", "triage")
          .replace("<field>", "route")
          .replace("<n>", "0")
          .replace("claims.<name>", "claims.sub")
          .replace("requestParams.<name>", "requestParams.x");
        const out = resolveContextPlaceholders(`{{${path}}}`, ctx, { node: turn, turn: [turn] } as never);
        expect({ path, rendered: out !== "" && !out?.includes("{{") }).toEqual({ path, rendered: true });
      }
    }
  });

  test("context placeholders name real request-context fields", () => {
    // Compile-time check: every documented context field is a key of the context.
    const known: Array<keyof AgentExecutionContext> = [
      "userName",
      "userEmail",
      "userId",
      "role",
      "groups",
      "plan",
      "language",
      "clientId",
      "chatId",
      "executionId",
      "claims",
      "requestParams",
    ];
    const documented = TEMPLATE_PLACEHOLDERS.flatMap((g) => g.symbols)
      .filter((s) => s.path.startsWith("context."))
      .map((s) => s.path.split(".")[1]);
    expect([...new Set(documented)].sort()).toEqual([...known].sort());
  });

  test("the documented llm parameters include the schema-validated ones", () => {
    const keys = LLM_PARAMETERS.map((p) => p.key);
    expect(keys).toContain("temperature");
    expect(keys).toContain("maxTokens");
  });
});

describe("docs/FLOWS.md content", () => {
  const md = buildFlowReferenceMarkdown();

  test("has a section per node type and a row per config key", () => {
    for (const doc of NODE_TYPE_CATALOG) {
      expect(md).toContain(`### \`${doc.type}\` — ${doc.title}`);
      for (const f of doc.config) expect(md).toContain(`\`${f.key}\``);
    }
    for (const f of COMMON_CONFIG_FIELDS) expect(md).toContain(`\`${f.key}\``);
  });

  test("covers placeholders, functions and schema descriptions", () => {
    for (const g of TEMPLATE_PLACEHOLDERS) for (const s of g.symbols) expect(md).toContain(`{{${s.path}}}`);
    for (const f of CALCULATION_FUNCTIONS) expect(md).toContain(f.label);
    expect(md).toContain("Unique flow id; also the model name clients request.");
  });

  test("is deterministic", () => {
    expect(buildFlowReferenceMarkdown()).toBe(md);
  });
});

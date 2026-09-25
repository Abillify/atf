// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Expression copilot — the assistant inside the Studio's expression builder.
 *
 * Writes or changes ONE field value (a condition, a prompt/tool-argument
 * template, or a load-time value) from a natural-language instruction. It is
 * given exactly what the builder offers for that field — variables, constants,
 * public env, node results, request/user data, run state, with pinned sample
 * values and the reason where an entry does not work — plus the grammar from
 * the flow reference data (operators, functions, rules).
 *
 * The proposal is checked with the engine's own code before it is returned
 * (condition parser, calculation evaluator, placeholder roots), with one
 * repair round that feeds the problem back to the model. Nothing is applied:
 * the builder shows a diff and the operator accepts or discards it.
 */

import type { LanguageModel } from "ai";
import { generateObject, jsonSchema } from "ai";
import { validateConditionExpression } from "./condition-evaluator.js";
import {
  CALCULATION_FUNCTIONS,
  CALCULATION_OPERATORS,
  CONDITION_OPERATORS,
  PLACEHOLDER_SCOPES,
  VARIABLE_REFERENCES,
} from "./flow-reference-data.js";
import {
  checkLoadTimePlaceholders,
  createLoadTimeResolver,
  currentVariableContext,
  evaluateFlowVariables,
  type VariableContext,
} from "./flow-parser/variable-values.js";

export type ExpressionKind = "template" | "condition" | "vars";

export interface VocabularyEntry {
  /** What to write, e.g. `{{node.triage.classification.route}}` or `lastMessageText`. */
  ref: string;
  description?: string;
  /** Value in the pinned run / current value (shown to the model as an example). */
  value?: unknown;
  /** Present when the entry does not work in this field. */
  unavailable?: string;
}

export interface VocabularyGroup {
  title: string;
  entries: VocabularyEntry[];
}

export interface ExpressionCopilotInput {
  kind: ExpressionKind;
  /** The field's current value (may be empty). */
  current: string;
  instruction: string;
  /** Field name for context, e.g. "Condition of triage → answer". */
  field?: string;
  vocabulary: VocabularyGroup[];
  /** The flow's variables — load-time references in the proposal are checked against them. */
  variables?: Record<string, unknown>;
  /** A `vars` field that may also hold run-time placeholders (a variable value). */
  runtimeAllowed?: boolean;
  /**
   * Where the user is in the field: the caret (`start === end`) or the
   * selected range, as character offsets into `current`. "Here" / "this"
   * in the instruction refers to it.
   */
  selection?: { start: number; end: number };
}

const CARET = "⟦CURSOR⟧";
const SEL_OPEN = "⟦SELECTION⟧";
const SEL_CLOSE = "⟦/SELECTION⟧";

/** The current value with the caret / selection marked, plus how to read the marks. */
export function markSelection(
  current: string,
  selection: { start: number; end: number } | undefined,
): { text: string; note?: string } {
  if (selection === undefined) return { text: current };
  const clamp = (n: number) => Math.max(0, Math.min(current.length, Math.floor(n)));
  const start = clamp(Math.min(selection.start, selection.end));
  const end = clamp(Math.max(selection.start, selection.end));
  if (start === end) {
    return {
      text: current.slice(0, start) + CARET + current.slice(start),
      note: `${CARET} marks the user's cursor (not part of the value). If the instruction adds something without saying where ("here", "insert …"), put it at the cursor.`,
    };
  }
  return {
    text: current.slice(0, start) + SEL_OPEN + current.slice(start, end) + SEL_CLOSE + current.slice(end),
    note: `${SEL_OPEN}…${SEL_CLOSE} marks the text the user selected (the marks are not part of the value). The instruction refers to this part: change only it unless the instruction clearly asks for more.`,
  };
}

/** Marks the model may echo back by mistake. */
const stripMarks = (s: string): string => s.split(CARET).join("").split(SEL_OPEN).join("").split(SEL_CLOSE).join("");

export type ExpressionCopilotResult =
  | { ok: true; expression: string; explanation: string; changed: boolean }
  | { ok: false; message: string };

interface Proposal {
  expression: string;
  explanation: string;
}

const PROPOSAL_SCHEMA = jsonSchema<Proposal>({
  type: "object",
  properties: {
    expression: {
      type: "string",
      description: "The COMPLETE new field value (not a fragment).",
    },
    explanation: {
      type: "string",
      description: "One or two sentences: what the expression does / what changed.",
    },
  },
  required: ["expression", "explanation"],
  additionalProperties: false,
});

const RUNTIME_ROOTS = new Set(["query", "classLabel", "classification", "context", "now", "node", "turn"]);
const LOAD_TIME_ROOTS = new Set(["vars", "const", "env"]);

function grammarFor(kind: ExpressionKind, runtimeAllowed: boolean): string {
  const ops = (list: typeof CONDITION_OPERATORS): string =>
    list.map((o) => `  ${o.text.trim()}  — ${o.description}`).join("\n");
  const loadTime = [
    "Load-time references (replaced when the flow loads):",
    ...VARIABLE_REFERENCES.map((r) => `  ${r.key}  — ${r.description}`),
    "Calculation operators (inside {{= … }}):",
    ops(CALCULATION_OPERATORS.filter((o) => !o.text.startsWith("{{="))),
    "Calculation functions:",
    ...CALCULATION_FUNCTIONS.map((f) => `  ${f.label}  — ${f.description}`),
  ].join("\n");
  if (kind === "condition") {
    return [
      "FIELD KIND: condition expression (edge / parallel condition), evaluated by a safe evaluator on every run.",
      "Write identifiers bare (classification.route, node.triage.classification.x, lastMessageText, groups, claims.sub, params.x). Strings in single quotes. No {{ }} around run-state names.",
      "Flow variables/constants are NOT identifiers here: write them as {{vars.x}} / {{const.x}}; they are replaced textually when the flow loads, so quote text values: '{{vars.x}}'.",
      "Node ids containing '-' cannot be used in conditions.",
      "Operators and helpers:",
      ops(CONDITION_OPERATORS),
      "An empty expression means: always follow the edge.",
    ].join("\n");
  }
  if (kind === "template") {
    return [
      "FIELD KIND: text with placeholders (system prompt or tool arguments).",
      "Run-time placeholders are written {{path}} and filled on every run:",
      ...Object.entries(PLACEHOLDER_SCOPES).map(([k, v]) => `  ${k === "prompt" ? "prompts" : "tool args"}: ${v}`),
      "Check each entry's note for where it renders (some only in tool arguments, some only in prompts).",
      loadTime,
      "A calculation cannot read run-time values.",
    ].join("\n");
  }
  return [
    runtimeAllowed
      ? "FIELD KIND: value of a flow variable. Load-time references and calculations are evaluated when the flow loads; run-time placeholders ({{context.x}}, {{node.…}}) are kept and rendered where the variable is used."
      : "FIELD KIND: plain value, resolved ONCE when the flow loads. Only load-time references and calculations work here — NO run-time placeholders ({{context.*}}, {{node.*}}, {{classification.*}}, {{query}}, {{now.*}}).",
    loadTime,
    "If the whole value is one placeholder or one calculation, the result keeps its type (a number stays a number).",
  ].join("\n");
}

const SYSTEM_PROMPT = `You write field values for an LLM-orchestration flow editor: conditions, \
templates and calculated values. You are given the field kind with its exact grammar, the field's \
current value, and the data the field can use — with example values from a recorded run where \
available and a note on entries that do NOT work in this field.

Rules:
- Return the COMPLETE new value in "expression". When changing an existing value, keep everything \
the instruction does not ask to change (wording, formatting, JSON structure, line breaks).
- Use ONLY references from the provided data, spelled exactly as given ("ref"). Never invent \
variables, constants, node ids or fields; never use an entry marked unavailable.
- Follow the grammar of the field kind strictly. Do not add explanations or markdown to "expression".
- If the instruction cannot be fulfilled with the available data, return the current value unchanged \
and say why in "explanation".
- "explanation": one or two short sentences in the language of the instruction.`;

function describeVocabulary(groups: VocabularyGroup[]): string {
  const lines: string[] = [];
  let count = 0;
  for (const g of groups) {
    const usable = g.entries.filter((e) => e.unavailable === undefined);
    const blocked = g.entries.filter((e) => e.unavailable !== undefined);
    if (usable.length === 0 && blocked.length === 0) continue;
    lines.push(`${g.title}:`);
    for (const e of usable) {
      if (count++ > 400) break;
      const value = e.value !== undefined ? ` = ${JSON.stringify(e.value).slice(0, 120)}` : "";
      lines.push(`  ${e.ref}${value}${e.description ? `  — ${e.description.slice(0, 160)}` : ""}`);
    }
    if (blocked.length > 0) {
      lines.push(`  (not usable here: ${blocked.slice(0, 12).map((e) => e.ref).join(", ")}${blocked.length > 12 ? ", …" : ""} — ${blocked[0]?.unavailable ?? ""})`);
    }
  }
  return lines.join("\n");
}

/** Checks a proposal with the engine's own code; returns the problem or null. */
export function checkExpression(
  kind: ExpressionKind,
  expression: string,
  variables: Record<string, unknown>,
  runtimeAllowed: boolean,
  context: VariableContext = currentVariableContext(),
): string | null {
  // Load-time references must resolve (unknown constants, env outside the
  // allowlist, calculation errors). Unknown variables count here too: the
  // copilot must only use variables that exist.
  const issues = checkLoadTimePlaceholders({ variables, nodes: [{ value: expression }] }, context);
  if (issues.length > 0) return issues.map((i) => i.message).join("; ");

  const roots = [...expression.matchAll(/\{\{\s*(?!=)([\w-]+)/g)].map((m) => m[1] ?? "");
  const unknown = roots.filter((r) => !RUNTIME_ROOTS.has(r) && !LOAD_TIME_ROOTS.has(r));
  if (unknown.length > 0) {
    return `Unknown placeholder root(s): ${[...new Set(unknown)].join(", ")}. Use only references from the provided data.`;
  }
  if (kind === "vars" && !runtimeAllowed) {
    const runtime = roots.filter((r) => RUNTIME_ROOTS.has(r));
    if (runtime.length > 0) {
      return `This field is resolved when the flow loads; run-time placeholders (${[...new Set(runtime)].join(", ")}) do not work here.`;
    }
  }
  if (kind === "condition") {
    // Conditions see load-time references already replaced.
    const { values } = evaluateFlowVariables(variables, undefined, context);
    const resolved = createLoadTimeResolver(values, context, () => {})(expression);
    const text = typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    if (text.trim() === "") return null;
    const v = validateConditionExpression(text);
    if (!v.valid) return `Invalid condition: ${v.error}`;
  }
  return null;
}

export async function proposeExpression(
  input: ExpressionCopilotInput,
  model: LanguageModel,
  options: { timeoutMs?: number; context?: VariableContext } = {},
): Promise<ExpressionCopilotResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 90_000);
  const runtimeAllowed = input.runtimeAllowed === true;
  const variables = input.variables ?? {};
  const marked = markSelection(input.current, input.selection);
  const userPrompt = [
    grammarFor(input.kind, runtimeAllowed),
    "",
    "DATA THIS FIELD CAN USE:",
    describeVocabulary(input.vocabulary),
    "",
    `FIELD: ${input.field ?? "(unnamed)"}`,
    "CURRENT VALUE:",
    input.current === "" && marked.note === undefined ? "(empty)" : marked.text.slice(0, 8000),
    ...(marked.note !== undefined ? [marked.note] : []),
    "",
    `INSTRUCTION: ${input.instruction.trim().slice(0, 2000)}`,
  ].join("\n");
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: userPrompt },
  ];
  try {
    for (let round = 0; round < 2; round++) {
      let proposal: Proposal;
      try {
        const { object } = await generateObject({
          model,
          schema: PROPOSAL_SCHEMA,
          system: SYSTEM_PROMPT,
          messages,
          abortSignal: controller.signal,
          temperature: 0.1,
        });
        proposal = object;
      } catch (err) {
        return { ok: false, message: `Copilot request failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const expression = stripMarks(proposal.expression);
      const problem = checkExpression(input.kind, expression, variables, runtimeAllowed, options.context);
      if (problem === null) {
        return {
          ok: true,
          expression,
          explanation: proposal.explanation,
          changed: expression !== input.current,
        };
      }
      if (round === 1) {
        return { ok: false, message: `The proposal is not valid: ${problem}` };
      }
      messages.push(
        { role: "assistant", content: JSON.stringify(proposal) },
        { role: "user", content: `That value is not valid: ${problem}\nReturn a corrected complete value.` },
      );
    }
    return { ok: false, message: "No proposal." };
  } finally {
    clearTimeout(timer);
  }
}

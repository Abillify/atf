// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Builds `docs/FLOWS.md`, the complete flow configuration reference, from the
 * sources the engine and the Studio already use — nothing in it is written by
 * hand:
 *
 *   - structural fields, bounds and descriptions: the Zod flow schema (via the
 *     same JSON Schema export as `schemas/flow.schema.json`)
 *   - node types and their settings: `node-type-catalog.ts` (also the Studio's
 *     settings forms and node docs)
 *   - `llm` block, placeholders, conditions, variables, calculations, flows
 *     directory: `flow-reference-data.ts` (also served to the Studio)
 *
 * Pure — no file I/O; `scripts/generate-flow-reference.ts` writes/checks it.
 */

import { buildFlowJsonSchema } from "./flow-parser/json-schema-export.js";
import {
  CALCULATION_FUNCTIONS,
  CALCULATION_OPERATORS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  FLOWS_DIR_ENTRIES,
  LLM_BLOCK_FIELDS,
  LLM_PARAMETERS,
  PLACEHOLDER_SCOPES,
  type PlaceholderGroup,
  type ReferenceField,
  type ReferenceOperator,
  TEMPLATE_PLACEHOLDERS,
  VARIABLE_REFERENCES,
} from "./flow-reference-data.js";
import {
  COMMON_CONFIG_FIELDS,
  type ConfigField,
  NODE_TYPE_CATALOG,
  type NodeTypeDoc,
} from "./node-type-catalog.js";

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
};

/** Escapes a table cell (pipes, newlines). */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function table(head: string[], rows: string[][]): string[] {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ];
}

function range(min: number | undefined, max: number | undefined, unit = ""): string {
  if (min === undefined && max === undefined) return "";
  if (min !== undefined && max !== undefined) return ` ${min}–${max}${unit}`;
  return min !== undefined ? ` ≥ ${min}${unit}` : ` ≤ ${max}${unit}`;
}

/** Short type text for a JSON Schema node, e.g. "integer 0–100", "list of string (≤ 50)". */
function schemaType(s: JsonSchema): string {
  if (s.enum) return `one of ${s.enum.map((v) => `\`${String(v)}\``).join(", ")}`;
  if (s.anyOf) return [...new Set(s.anyOf.map(schemaType))].join(" or ");
  const t = Array.isArray(s.type) ? s.type.join("/") : (s.type ?? "any");
  if (t === "array") {
    const inner = s.items ? schemaType(s.items) : "any";
    const bounds =
      s.minItems !== undefined && s.minItems > 0
        ? range(s.minItems, s.maxItems)
        : s.maxItems !== undefined
          ? ` (≤ ${s.maxItems})`
          : "";
    return `list of ${inner}${bounds}`;
  }
  if (t === "string") {
    if (s.minLength === 1 && s.maxLength === undefined) return "non-empty string";
    return `string${range(s.minLength, s.maxLength, " chars")}`;
  }
  if (t === "number" || t === "integer") return `${t}${range(s.minimum, s.maximum)}`;
  return t;
}

function schemaRows(s: JsonSchema, skip: string[] = []): string[][] {
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {})
    .filter(([k]) => !skip.includes(k))
    .map(([k, p]) => [
      `\`${k}\``,
      schemaType(p),
      required.has(k) ? "yes" : "no",
      p.description ?? "",
    ]);
}

function configType(f: ConfigField): string {
  switch (f.kind) {
    case "enum":
      return `one of ${(f.options ?? []).map((o) => `\`${o}\``).join(", ")}`;
    case "number":
      return `${f.integer ? "integer" : "number"}${range(f.min, f.max)}`;
    case "string-list":
      return "list of string";
    case "tool-list":
      return "list of tool ids";
    case "node-ref":
      return "node id";
    case "node-list":
      return "list of node ids";
    case "condition":
      return "condition expression";
    case "llm":
      return "model (`llm` block)";
    case "text":
      return "string (multi-line)";
    default:
      return f.kind;
  }
}

function formatDefault(v: unknown): string {
  if (v === undefined) return "—";
  if (typeof v === "string" && /\s/.test(v) && !/^[\w-]+$/.test(v)) return v; // a sentence
  return `\`${typeof v === "string" ? v : JSON.stringify(v)}\``;
}

/** Config fields as rows; object sub-fields are flattened as `parent.child`. */
function configRows(fields: ConfigField[], prefix = ""): string[][] {
  const rows: string[][] = [];
  for (const f of fields) {
    const key = `${prefix}${f.key}`;
    const extra = f.example !== undefined && f.kind !== "object" ? ` Example: \`${JSON.stringify(f.example)}\`.` : "";
    rows.push([
      `\`${key}\`${f.required ? " (required)" : ""}`,
      configType(f),
      formatDefault(f.default),
      `${f.description}${extra}`,
    ]);
    if (f.fields) rows.push(...configRows(f.fields, `${key}.`));
  }
  return rows;
}

function referenceRows(fields: ReferenceField[]): string[][] {
  return fields.map((f) => [
    `\`${f.key}\``,
    f.type ?? "",
    `${f.description}${f.example !== undefined ? ` Example: \`${JSON.stringify(f.example)}\`.` : ""}`,
  ]);
}

/** Operators as written in a flow (the editor's button label may differ, e.g. `and` for `&&`). */
function operatorRows(ops: ReferenceOperator[]): string[][] {
  return ops.map((o) => [`\`${o.text.trim()}\``, o.description]);
}

/** Functions by signature (`round(x, digits)`), not by the inserted `round()`. */
function functionRows(fns: ReferenceOperator[]): string[][] {
  return fns.map((f) => [`\`${f.label}\``, f.description]);
}

function placeholderRows(groups: PlaceholderGroup[], withScope: boolean): string[][] {
  return groups.flatMap((g) =>
    g.symbols.map((s) => [
      `\`${withScope ? `{{${s.path}}}` : s.path}\``,
      g.title,
      ...(withScope ? [g.scopes.map((sc) => (sc === "prompt" ? "prompts" : "tool args")).join(", ")] : []),
      s.description,
    ]),
  );
}

const anchor = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function nodeTypeSection(doc: NodeTypeDoc): string[] {
  const out: string[] = [`### \`${doc.type}\` — ${doc.title}`, "", doc.summary, ""];
  for (const para of doc.description.split(/\n\n+/)) out.push(para, "");
  if (doc.whenToUse.length > 0) {
    out.push("**When to use**", "", ...doc.whenToUse.map((w) => `- ${w}`), "");
  }
  if (doc.topLevel.length > 0) {
    out.push(
      "**Node fields**",
      "",
      ...table(
        ["Field", "Use", "Meaning for this type"],
        doc.topLevel.map((t) => [`\`${t.key}\``, t.usage, t.description]),
      ),
      "",
    );
  }
  out.push(`**Settings (\`config\`)**`, "");
  if (doc.config.length === 0) out.push("No type-specific settings.", "");
  else out.push(...table(["Key", "Type", "Default", "Description"], configRows(doc.config)), "");
  for (const ex of doc.examples) {
    out.push(`**Example: ${ex.title}**`, "", "```yaml", ex.yaml.trimEnd(), "```", "");
  }
  if (doc.notes.length > 0) out.push("**Notes**", "", ...doc.notes.map((n) => `- ${n}`), "");
  return out;
}

export function buildFlowReferenceMarkdown(): string {
  const schema = buildFlowJsonSchema() as JsonSchema;
  const node = schema.properties?.nodes?.items ?? {};
  const edge = schema.properties?.edges?.items ?? {};
  const override = node.properties?.overrides?.items ?? {};
  const classifier = node.properties?.classifierSchema ?? {};

  const nodeTypeTitle = (d: NodeTypeDoc): string => `\`${d.type}\` — ${d.title}`;
  const lines: string[] = [
    "# Flow reference",
    "",
    "Generated by `bun run flow-reference` from the flow schema, the node type catalog and the flow reference data in `apps/runtime/src/graph/`. Do not edit manually — change the source and regenerate. The same sources drive the Studio's settings forms, node docs and expression builder, and `schemas/flow.schema.json`.",
    "",
    "Examples and a walkthrough: [`deploy/examples/flows/`](../deploy/examples/flows/). Validate a flow offline with `bun run scripts/cli.ts validate <file>` in `apps/runtime`.",
    "",
    "## Contents",
    "",
    "- [Flows directory](#flows-directory)",
    "- [Flow fields](#flow-fields)",
    "- [Node fields](#node-fields)",
    "- [The `llm` block](#the-llm-block)",
    "- [Settings on every node](#settings-on-every-node)",
    "- [Node types](#node-types)",
    ...NODE_TYPE_CATALOG.map((d) => `  - [${nodeTypeTitle(d)}](#${anchor(nodeTypeTitle(d))})`),
    "- [Edges and conditions](#edges-and-conditions)",
    "- [Runtime placeholders](#runtime-placeholders)",
    "- [Variables, constants and calculations](#variables-constants-and-calculations)",
    "",
    "## Flows directory",
    "",
    "Everything lives in `FLOWS_DIR`:",
    "",
    ...table(["Entry", "Meaning"], FLOWS_DIR_ENTRIES.map((e) => [`\`${e.key}\``, e.description])),
    "",
    "The smallest valid flow:",
    "",
    "```yaml",
    "id: my-flow",
    "name: My Flow",
    "nodes:",
    "  - id: answer",
    "    type: llm",
    "edges: []",
    "```",
    "",
    "## Flow fields",
    "",
    ...table(["Field", "Type", "Required", "Description"], schemaRows(schema)),
    "",
    "Keys starting with `_` (`_comment`, `_comment_tools`, …) are annotations on flows, nodes, edges and overrides; the parser ignores them. Any other unknown key is an error in `schemas/flow.schema.json`, which editors can use to validate flow files as you type (it describes the file form, including `llm.shortcut` and flows whose nodes come from `metadata.$include`).",
    "",
    "## Node fields",
    "",
    "Fields every node can carry. Which of them a node type uses is listed with the type.",
    "",
    ...table(["Field", "Type", "Required", "Description"], schemaRows(node)),
    "",
    "`classifierSchema`:",
    "",
    ...table(["Field", "Type", "Required", "Description"], schemaRows(classifier)),
    "",
    "Entries of `overrides`:",
    "",
    ...table(["Field", "Type", "Required", "Description"], schemaRows(override)),
    "",
    "## The `llm` block",
    "",
    "Either a shortcut or an explicit provider and model:",
    "",
    "```yaml",
    "llm: { shortcut: fast-pool }",
    "llm: { provider: eu-openai, model: a-chat-model, parameters: { temperature: 0.2 } }",
    "```",
    "",
    ...table(["Field", "Type", "Description"], referenceRows(LLM_BLOCK_FIELDS)),
    "",
    "`parameters`:",
    "",
    ...table(["Key", "Type", "Description"], referenceRows(LLM_PARAMETERS)),
    "",
    "## Settings on every node",
    "",
    "These `config` keys apply to every node type.",
    "",
    ...table(["Key", "Type", "Default", "Description"], configRows(COMMON_CONFIG_FIELDS)),
    "",
    "## Node types",
    "",
    ...table(
      ["Type", "Summary"],
      NODE_TYPE_CATALOG.map((d) => [`[\`${d.type}\`](#${anchor(nodeTypeTitle(d))})`, d.summary]),
    ),
    "",
    "Any other `type` resolves through the plugin node-handler registry.",
    "",
    ...NODE_TYPE_CATALOG.flatMap(nodeTypeSection),
    "## Edges and conditions",
    "",
    ...table(["Field", "Type", "Required", "Description"], schemaRows(edge)),
    "",
    "A condition is an expression over the run state. It is evaluated by a safe evaluator — no code execution; anything outside the grammar is a validation error. The same grammar is used for `parallelNodes` conditions and the `whenClaim`/`whenParam` of overrides (there over claims and request parameters).",
    "",
    "What a condition can read:",
    "",
    ...table(["Name", "Group", "Description"], placeholderRows(CONDITION_FIELDS, false)),
    "",
    "Operators and helpers (plus array index `x[0]`, numbers, `+ -`):",
    "",
    ...table(["Operator", "Meaning"], operatorRows(CONDITION_OPERATORS)),
    "",
    "## Runtime placeholders",
    "",
    "`{{path}}` placeholders filled in on every run. Where they work:",
    "",
    ...Object.entries(PLACEHOLDER_SCOPES).map(
      ([k, v]) => `- **${k === "prompt" ? "prompts" : "tool args"}** — ${v}`,
    ),
    "",
    "A known root with a missing value renders empty. An unknown root stays as written in prompts and renders empty in tool arguments.",
    "",
    ...table(["Placeholder", "Group", "Available in", "Description"], placeholderRows(TEMPLATE_PLACEHOLDERS, true)),
    "",
    "## Variables, constants and calculations",
    "",
    "`variables` holds named values; a request can override them. Load-time references — variables, constants, allowlisted environment values and calculations — work in variable values and in any node or edge value. They are resolved when the flow loads and again per request when variables are overridden:",
    "",
    "```yaml",
    "variables:",
    "  model_main: fast-pool",
    '  max_tokens: "{{const.answer_max_tokens}}"',
    '  max_tokens_draft: "{{= round(vars.max_tokens / 4) }}"',
    '  region: "{{env.FLOW_PUBLIC_REGION}}"',
    "```",
    "",
    ...table(["Reference", "Description"], VARIABLE_REFERENCES.map((r) => [`\`${r.key}\``, r.description])),
    "",
    "Rules:",
    "",
    "- A value that is exactly one placeholder keeps the referenced value's type (a number stays a number); inside longer text it is inserted as text.",
    "- Cycles, unknown constants, environment variables outside `FLOW_PUBLIC_*`, and calculation errors are validation errors (`variables.<name>`, or the node/edge path). An undeclared `{{vars.*}}` in a node or edge is a warning.",
    "- Variables supplied with a request are literals: they are never evaluated, but variables that reference them are.",
    "- Runtime placeholders (`{{context.*}}`, `{{classification.*}}`, …) are left for the run; a calculation cannot read them.",
    "",
    "Calculation operators:",
    "",
    ...table(["Operator", "Meaning"], operatorRows(CALCULATION_OPERATORS)),
    "",
    "Calculation functions:",
    "",
    ...table(["Function", "Meaning"], functionRows(CALCULATION_FUNCTIONS)),
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

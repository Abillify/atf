// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Formula support for the Studio (`src/lib/formula.ts`).
 *
 * Two kinds of "formulas" exist in a flow:
 *
 *  - **template** — text with `{{path}}` placeholders the runtime fills in
 *    (prompts, tool arguments, messages): `{{vars.*}}`, `{{query}}`,
 *    `{{classification.*}}`, `{{node.<id>.classification.*}}`,
 *    `{{turn[n].<id>.classification.*}}`, `{{context.*}}`, `{{now.*}}`.
 *  - **condition** — a boolean expression evaluated by the runtime's safe
 *    evaluator (edge conditions, `when` rules): identifiers such as
 *    `classification.route`, `messageCount`, `params.x`, operators and a few
 *    string methods.
 *
 * This module builds the vocabulary offered by the formula editor from the
 * flow on the canvas, finds the paths an expression references, and renders a
 * template preview. Conditions are evaluated by the runtime itself
 * (`POST /flows/expressions/evaluate`) so the preview matches a real run.
 */

import type { FlowReference } from "./node-types";
import type { FlowDefinition, FlowNode } from "../types/flow";

/**
 * `vars`: a plain field where only flow variables are substituted (they are
 * replaced in every string when the flow loads) — labels, models, numbers, …
 */
export type FormulaKind = "template" | "condition" | "vars";

export interface FormulaSymbol {
  /** Path as written in a condition / inside `{{ }}` in a template. */
  path: string;
  label?: string;
  description: string;
  /** Example value used to pre-fill the preview. */
  example?: unknown;
  /** Not usable in this kind of formula (shown with a reason). */
  unavailable?: string;
  /** Literal text to insert instead of the `{{path}}` placeholder (e.g. a shortcut name). */
  insert?: string;
  /** Text to insert when the caret sits inside a `{{= … }}` calculation. */
  calcInsert?: string;
  /** Picking it replaces the whole field value (a shortcut, a model id). */
  replace?: boolean;
}

/** True when `caret` is inside an unclosed `{{= … }}` calculation of `text`. */
export function insideCalculation(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  return before.lastIndexOf("{{=") > before.lastIndexOf("}}");
}

export interface FormulaGroup {
  title: string;
  symbols: FormulaSymbol[];
}

export interface FormulaOperator {
  text: string;
  label: string;
  description: string;
}

/** The values `{{now.*}}` would render right now (runtime uses Europe/Berlin). */
export function nowValues(date = new Date()): Record<string, string> {
  const tz = "Europe/Berlin";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const d = `${parts.year}-${parts.month}-${parts.day}`;
  const t = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  return {
    date: d,
    time: t,
    datetime: `${d} ${t}`,
    weekday: new Intl.DateTimeFormat("de-DE", { timeZone: tz, weekday: "long" }).format(date),
    iso: date.toISOString(),
    timezone: tz,
  };
}

function schemaFields(node: FlowNode): string[] {
  const props = (node.classifierSchema?.schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const outProps = ((node.config?.["outputSchema"] as { schema?: { properties?: Record<string, unknown> } } | undefined)?.schema)?.properties;
  return Object.keys({ ...(props ?? {}), ...(outProps ?? {}) });
}

function transformFields(node: FlowNode): string[] {
  const out: string[] = [];
  const derive = node.config?.["derive"];
  if (Array.isArray(derive)) {
    for (const rule of derive as Array<{ lookup?: Record<string, Record<string, unknown>>; default?: Record<string, unknown> }>) {
      for (const row of Object.values(rule.lookup ?? {})) out.push(...Object.keys(row ?? {}));
      out.push(...Object.keys(rule.default ?? {}));
    }
  }
  const extract = node.config?.["extract"];
  if (Array.isArray(extract)) {
    for (const rule of extract as Array<{ target?: unknown }>) {
      if (typeof rule.target === "string") out.push(rule.target);
    }
  }
  return out;
}

function exampleFor(schemaNode: unknown): unknown {
  const s = schemaNode as { enum?: unknown[]; type?: string } | undefined;
  if (Array.isArray(s?.enum) && s.enum.length > 0) return s.enum[0];
  if (s?.type === "boolean") return true;
  if (s?.type === "number" || s?.type === "integer") return 1;
  return undefined;
}

const SAFE_IDENT = /^[A-Za-z_]\w*$/;

/** Everything the formula editor offers for this flow. */
export function buildVocabulary(
  def: Pick<FlowDefinition, "nodes" | "variables">,
  kind: FormulaKind,
  reference?: Pick<FlowReference, "placeholders" | "conditionFields">,
): FormulaGroup[] {
  const groups: FormulaGroup[] = [];
  const cond = kind === "condition";

  const vars = Object.entries(def.variables ?? {}).filter(([k]) => !k.startsWith("_"));
  if (kind === "vars") {
    return vars.length > 0
      ? [
          {
            title: "Flow variables",
            symbols: vars.map(([k, v]) => ({
              path: `vars.${k}`,
              description: `Replaced when the flow loads. Value: ${JSON.stringify(v)}`,
              example: v,
            })),
          },
        ]
      : [];
  }
  if (vars.length > 0) {
    groups.push({
      title: "Flow variables",
      symbols: vars.map(([k, v]) => ({
        path: `vars.${k}`,
        description: `Replaced when the flow loads${cond ? " (textually — quote it for a string: '{{vars." + k + "}}')" : ""}. Value: ${JSON.stringify(v)}`,
        example: v,
      })),
    });
  }

  // Classification fields from classifier schemas, llm output schemas and transforms.
  const classFields = new Map<string, { from: string; example?: unknown }>();
  for (const n of def.nodes) {
    const props = (n.classifierSchema?.schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    for (const f of schemaFields(n)) classFields.set(f, { from: n.id, example: exampleFor(props[f]) });
    if (n.type === "transform") for (const f of transformFields(n)) classFields.set(f, { from: n.id });
  }
  // Runtime: prompts render only context/now/node/turn; classLabel and
  // classification.* are filled in tool arguments.
  const toolOnly = cond ? "" : " (tool arguments only)";
  groups.push({
    title: "Classification (this turn)",
    symbols: [
      {
        path: "classLabel",
        description: `Value of the classifier's classKey field.${toolOnly}`,
        example: "INKASSO",
      },
      ...[...classFields.entries()].map(([f, info]) => ({
        path: `classification.${f}`,
        description: `Set by ${info.from}.${toolOnly}`,
        ...(info.example !== undefined ? { example: info.example } : {}),
      })),
    ],
  });

  const classifiers = def.nodes.filter((n) => schemaFields(n).length > 0);
  if (classifiers.length > 0) {
    const perNode: FormulaSymbol[] = [];
    for (const n of classifiers) {
      const unsafe = cond && !SAFE_IDENT.test(n.id)
        ? "Node ids with hyphens can't be used in conditions (they work in templates)."
        : undefined;
      for (const f of schemaFields(n)) {
        perNode.push({
          path: `node.${n.id}.classification.${f}`,
          description: `${f} as ${n.id} set it in this run (even if a later classifier overwrote classification.${f}).`,
          ...(unsafe ? { unavailable: unsafe } : {}),
        });
        perNode.push({
          path: `turn[1].${n.id}.classification.${f}`,
          description: `${f} from ${n.id} in the PREVIOUS turn (turn[2] = two turns ago).`,
          ...(unsafe ? { unavailable: unsafe } : {}),
        });
      }
    }
    groups.push({ title: "Per node / earlier turns", symbols: perNode });
  }

  // Static entries come from the runtime's reference data (the same data
  // docs/FLOWS.md is generated from). Generic classification entries are
  // replaced by the concrete fields collected from this flow above.
  const isDynamic = (path: string): boolean =>
    /^(classLabel|classification\.|node\.|turn\[)/.test(path);
  const now = nowValues();
  const staticGroups = (cond ? reference?.conditionFields : reference?.placeholders) ?? [];
  for (const g of staticGroups) {
    const symbols = g.symbols
      .filter((sym) => !isDynamic(sym.path))
      .map((sym) => {
        const only =
          cond || g.scopes.length !== 1
            ? ""
            : g.scopes[0] === "prompt"
              ? " (system prompts only)"
              : " (tool arguments only)";
        const nowKey = sym.path.startsWith("now.") ? sym.path.slice(4) : undefined;
        const example = nowKey !== undefined ? now[nowKey] : sym.example;
        return {
          path: sym.path,
          description: `${sym.description}${only}`,
          ...(example !== undefined ? { example } : {}),
        };
      });
    if (symbols.length > 0) groups.push({ title: g.title, symbols });
  }
  return groups;
}

const KEYWORDS = new Set(["true", "false", "null"]);
const METHODS = new Set(["includes", "contains", "startsWith", "endsWith", "length"]);

/** Paths an expression / template reads, in order of first appearance. */
export function referencedPaths(text: string, kind: FormulaKind): string[] {
  const out: string[] = [];
  const add = (p: string): void => {
    if (!out.includes(p)) out.push(p);
  };
  if (kind !== "condition") {
    for (const m of text.matchAll(/\{\{\s*([\w.\-[\]]+)\s*\}\}/g)) add(m[1]!);
    return out;
  }
  // Strip string literals, then collect dotted identifiers.
  const code = text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  for (const m of code.matchAll(/[A-Za-z_][\w]*(?:\[\d+\])?(?:\.[A-Za-z_][\w-]*(?:\[\d+\])?)*/g)) {
    let path = m[0];
    if (KEYWORDS.has(path)) continue;
    const segs = path.split(".");
    while (segs.length > 1 && METHODS.has(segs[segs.length - 1]!.replace(/\[\d+\]$/, ""))) segs.pop();
    path = segs.join(".");
    add(path);
  }
  return out;
}

function splitPath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const seg of path.split(".")) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(seg);
    if (!m) {
      out.push(seg);
      continue;
    }
    out.push(m[1]!);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of splitPath(path)) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** Immutable set of a (possibly nested / indexed) path. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segs = splitPath(path);
  const root: Record<string, unknown> = structuredClone(obj);
  let cur: Record<string | number, unknown> = root;
  segs.forEach((seg, i) => {
    if (i === segs.length - 1) {
      cur[seg] = value;
      return;
    }
    const next = cur[seg];
    if (next === null || typeof next !== "object") cur[seg] = typeof segs[i + 1] === "number" ? [] : {};
    cur = cur[seg] as Record<string | number, unknown>;
  });
  return root;
}

/** Parses a preview input: numbers, booleans, null and JSON literals, else text. */
export function parseSampleValue(raw: string): unknown {
  const t = raw.trim();
  if (t === "") return undefined;
  if (/^(true|false|null)$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || /^[[{"]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Renders a template for the preview: `{{vars.*}}` from the flow, `{{now.*}}`
 * from the clock, everything else from the sample. Unresolved placeholders are
 * rendered empty (like tool arguments at runtime) and reported.
 */
export function renderTemplatePreview(
  text: string,
  sample: Record<string, unknown>,
  variables: Record<string, unknown> | undefined,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const scope = { ...sample, vars: { ...(variables ?? {}), ...((sample["vars"] as object) ?? {}) }, now: nowValues() };
  const rendered = text.replace(/\{\{\s*([\w.\-[\]]+)\s*\}\}/g, (_m, path: string) => {
    const v = getPath(scope, path);
    if (v === undefined || v === null) {
      if (!unresolved.includes(path)) unresolved.push(path);
      return "";
    }
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  return { text: rendered, unresolved };
}

/** Pre-filled preview values for the referenced paths (from vocabulary examples). */
export function defaultSample(paths: string[], groups: FormulaGroup[]): Record<string, unknown> {
  let sample: Record<string, unknown> = {};
  const examples = new Map(groups.flatMap((g) => g.symbols).map((s) => [s.path, s.example]));
  for (const p of paths) {
    if (p.startsWith("vars.") || p.startsWith("now.")) continue;
    const ex = examples.get(p);
    if (ex !== undefined) sample = setPath(sample, p, ex);
  }
  return sample;
}

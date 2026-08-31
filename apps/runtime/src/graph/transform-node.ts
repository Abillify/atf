// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Transform node handler (`src/graph/transform-node.ts`)
 *
 * A `transform` node deterministically derives extra `classification` fields
 * from existing ones via static lookup tables declared entirely in the flow
 * YAML (`config.derive`). It runs no LLM and contains no domain knowledge — the
 * mapping data lives in the flow definition, not in this code.
 *
 * Extracted from the former monolithic `node-handlers.ts` (ADR-0004: shrink the
 * engine's god-module by moving self-contained handlers into their own files).
 * Behaviour is unchanged; `node-handlers.ts` re-exports
 * {@link createTransformNodeHandler} for backward compatibility.
 *
 * No `any` at module boundaries.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { FlowNode } from "../types/flow.js";
import { isPotentiallyCatastrophicRegex } from "./condition-evaluator.js";
import { getRuntime, lastUserQuery } from "./exec-runtime.js";
import type { AgentState } from "./graph-engine.js";

/**
 * One derivation rule for a `transform` node: read the `from` field off the
 * current classification, look its value up in `lookup`, and write the matched
 * row's field/value pairs back onto the classification.
 */
export interface TransformDeriveRule {
  /** Classification field whose value keys into `lookup`. */
  from: string;
  /** Lookup table: source value -> derived field/value pairs. */
  lookup: Record<string, Record<string, string>>;
  /**
   * Optional row applied when the source value is missing or not found. When
   * omitted, every field that appears anywhere in `lookup` is set to "" so the
   * derived shape stays stable regardless of which row matched.
   */
  default?: Record<string, string>;
}

/**
 * A bounded regex capture rule for a `transform` node. `from: query` uses the
 * last user message; every other value reads a field from `classification`.
 * A non-match, invalid expression, or missing capture always writes "".
 */
export interface TransformExtractRule {
  from: string;
  pattern: string;
  target: string;
  group: number;
}

const MAX_EXTRACT_PATTERN_LENGTH = 200;
const MAX_EXTRACT_INPUT_LENGTH = 2_000;

/**
 * Parses and validates a `transform` node's `config.derive` into rules. Invalid
 * or missing config yields an empty rule list (the node becomes a no-op).
 */
export function parseTransformRules(node: FlowNode): TransformDeriveRule[] {
  const raw = (node.config as { derive?: unknown } | undefined)?.derive;
  if (!Array.isArray(raw)) return [];
  const rules: TransformDeriveRule[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const from = e.from;
    const lookup = e.lookup;
    if (typeof from !== "string" || from.length === 0) continue;
    if (lookup === null || typeof lookup !== "object") continue;
    const rule: TransformDeriveRule = {
      from,
      lookup: lookup as Record<string, Record<string, string>>,
    };
    if (e.default !== null && typeof e.default === "object") {
      rule.default = e.default as Record<string, string>;
    }
    rules.push(rule);
  }
  return rules;
}

/** Parses bounded regex-capture rules from `config.extract`. */
export function parseTransformExtractRules(
  node: FlowNode,
): TransformExtractRule[] {
  const raw = (node.config as { extract?: unknown } | undefined)?.extract;
  if (!Array.isArray(raw)) return [];
  const rules: TransformExtractRule[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const { from, pattern, target } = e;
    const group = e.group ?? 1;
    if (
      typeof from !== "string" ||
      from.length === 0 ||
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.length > MAX_EXTRACT_PATTERN_LENGTH ||
      isPotentiallyCatastrophicRegex(pattern) ||
      typeof target !== "string" ||
      target.length === 0 ||
      typeof group !== "number" ||
      !Number.isInteger(group) ||
      group < 0 ||
      group > 20
    ) {
      continue;
    }
    try {
      new RegExp(pattern, "iu");
      rules.push({ from, pattern, target, group });
    } catch {
      // Invalid flow configuration must fail closed at execution even if it was
      // introduced after validation; the target will be blanked by the caller.
    }
  }
  return rules;
}

/** Applies a single derivation rule to a classification object (mutates it). */
export function applyTransformRule(
  classification: Record<string, unknown>,
  rule: TransformDeriveRule,
): void {
  const sourceValue = classification[rule.from];
  const key = typeof sourceValue === "string" ? sourceValue : "";
  const row = key.length > 0 ? rule.lookup[key] : undefined;

  if (row !== undefined) {
    for (const [field, value] of Object.entries(row)) {
      classification[field] = value;
    }
    return;
  }

  if (rule.default !== undefined) {
    for (const [field, value] of Object.entries(rule.default)) {
      classification[field] = value;
    }
    return;
  }

  // No match and no default: blank out every field the table could produce so
  // downstream `{{classification.<field>}}` refs and `<field> != ''` conditions
  // always see a defined value.
  const allFields = new Set<string>();
  for (const r of Object.values(rule.lookup)) {
    for (const f of Object.keys(r)) allFields.add(f);
  }
  for (const field of allFields) classification[field] = "";
}

/** Applies one bounded regex capture and fails closed by writing an empty value. */
export function applyTransformExtractRule(
  classification: Record<string, unknown>,
  rule: TransformExtractRule,
  query: string,
): void {
  const source =
    rule.from === "query"
      ? query
      : typeof classification[rule.from] === "string"
        ? String(classification[rule.from])
        : "";
  if (source.length === 0) {
    classification[rule.target] = "";
    return;
  }
  try {
    const match = new RegExp(rule.pattern, "iu").exec(
      source.slice(0, MAX_EXTRACT_INPUT_LENGTH),
    );
    const value = match?.[rule.group];
    classification[rule.target] = typeof value === "string" ? value : "";
  } catch {
    classification[rule.target] = "";
  }
}

/**
 * A `transform` node deterministically derives extra `classification` fields
 * from existing ones via static lookup tables declared entirely in the flow
 * YAML (`config.derive`). It runs no LLM and contains no domain knowledge — the
 * mapping data lives in the flow definition, not in this code.
 *
 * Typical use: a classifier emits a single canonical key (e.g. `client`) and a
 * downstream `transform` node expands it into the per-collection tag fields the
 * `ragProfiles` reference (`clientClientdocs`, `clientTaiga`, …). A transform
 * can additionally extract a bounded regex capture from the request, such as a
 * concrete ticket ID, without involving an LLM. Placing both rules in YAML
 * keeps domain policy out of runtime code.
 *
 * The full (existing + derived) classification is returned because the
 * `classification` channel uses LastValue (replace) semantics.
 */
export function createTransformNodeHandler(
  node: FlowNode,
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Partial<AgentState> {
  const rules = parseTransformRules(node);
  const extractRules = parseTransformExtractRules(node);
  return (state, config) => {
    const runtime = getRuntime(config);
    runtime?.onNodeStart(node.id);

    if (rules.length === 0 && extractRules.length === 0)
      return { currentNodeId: node.id };

    const inputClassification: Record<string, unknown> = {
      ...(state.classification ?? {}),
    };
    const classification: Record<string, unknown> = { ...inputClassification };
    for (const rule of rules) applyTransformRule(classification, rule);
    const query = lastUserQuery(state);
    for (const rule of extractRules)
      applyTransformExtractRule(classification, rule, query);

    // Surface the before/after classification to the live monitoring dashboard
    // so the transform node shows what it derived.
    runtime?.onNodeIo?.(node.id, {
      prompt: JSON.stringify(inputClassification),
      response: JSON.stringify(classification),
    });

    return { currentNodeId: node.id, classification };
  };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Classification access (`src/graph/classification-access.ts`)
 *
 * Non-destructive, per-node and per-turn access to `classifier` node output.
 *
 * WHY: the `classification` / `classLabel` state channels use LastValue
 * (replace) semantics — a second classifier in the same run overwrites the
 * first, and a new conversation turn overwrites the previous one. Those two
 * channels remain the convenient "most recent classifier" pointers that all
 * existing routing/rag/override consumers read. On top of them this module adds
 * a `turns` channel that NEVER loses a classifier's output:
 *
 *   turns: TurnSnapshot[]              // chronological, one snapshot per turn
 *   TurnSnapshot = { [nodeId]: { classification, classLabel } }
 *
 * From it we derive two namespaces exposed to condition expressions, rag
 * `select`/`when` rules, tool args and system-prompt templates:
 *
 *   node.<nodeId>.classification.<field>        // this run's classifier output
 *   turn[<n>].<nodeId>.classification.<field>   // n turns ago (0 = current)
 *
 * Example: `turn[1].triage.classification.route` yields the route the `triage`
 * classifier produced in the PREVIOUS run of the same conversation.
 *
 * No `any` at module boundaries.
 */

/** One classifier node's output, as stored per node id. */
export interface NodeClassification {
  classification: Record<string, unknown>;
  classLabel: string;
}

/** All classifier outputs produced during a single run/turn, keyed by node id. */
export type TurnSnapshot = Record<string, NodeClassification>;

/**
 * Appends a classifier node's output to the per-turn history and returns the
 * NEW `turns` array (the `turns` channel uses replace semantics, so the handler
 * computes the full next value from `state.turns`).
 *
 * Turn-boundary detection without any explicit marker: a classifier node runs
 * at most once per run (the graph is a DAG; classifiers are not agent-harness
 * delegation targets). So if the current (last) snapshot ALREADY holds this
 * node id, we must have crossed into a new conversation turn (the checkpointer
 * restored the previous turn's snapshot) — start a fresh snapshot. Otherwise we
 * merge into the current one alongside any earlier classifier of this turn.
 */
export function appendNodeClassification(
  turns: TurnSnapshot[] | undefined,
  nodeId: string,
  classification: Record<string, unknown>,
  classLabel: string,
): TurnSnapshot[] {
  const list: TurnSnapshot[] = Array.isArray(turns) ? turns.slice() : [];
  let last = list.length > 0 ? list[list.length - 1] : undefined;
  if (
    last === undefined ||
    Object.hasOwn(last, nodeId)
  ) {
    last = {};
    list.push(last);
  }
  list[list.length - 1] = {
    ...last,
    [nodeId]: { classification, classLabel },
  };
  return list;
}

/**
 * Builds the `node` and `turn` namespaces from the per-turn history.
 *   - `node`  → the CURRENT run's snapshot (`{ [nodeId]: {classification, classLabel} }`).
 *   - `turn`  → snapshots most-recent-first: `turn[0]` = current run,
 *               `turn[1]` = previous run, `turn[2]` = two runs ago, …
 */
export function buildClassificationNamespaces(
  turns: TurnSnapshot[] | undefined,
): { node: TurnSnapshot; turn: TurnSnapshot[] } {
  const list: TurnSnapshot[] = Array.isArray(turns) ? turns : [];
  const currentIdx = list.length - 1;
  const node: TurnSnapshot = list[currentIdx] ?? {};
  const turn: TurnSnapshot[] = list.toReversed();
  return { node, turn };
}

// ---------------------------------------------------------------------------
// Path resolution for dotted paths with `[n]` indices and hyphenated segments
// ---------------------------------------------------------------------------

/** A resolved path segment: an object key or a numeric array index. */
type PathToken = string | number;

/**
 * Tokenises a dotted access path into keys and numeric indices. Supports
 * hyphenated identifiers (node ids like `refine-client`) and array subscripts:
 *   "turn[1].triage.classification.route"  → ["turn", 1, "triage", "classification", "route"]
 *   "node.refine-client.classification.client" → ["node", "refine-client", "classification", "client"]
 */
export function tokenizePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const part of path.split(".")) {
    if (part.length === 0) continue;
    const m = /^([\w-]*)((?:\[\d+\])*)$/.exec(part);
    if (m === null) {
      tokens.push(part);
      continue;
    }
    if (m[1] !== undefined && m[1].length > 0) tokens.push(m[1]);
    const idxPart = m[2] ?? "";
    const idxRe = /\[(\d+)\]/g;
    for (const im of idxPart.matchAll(idxRe)) tokens.push(Number(im[1]));
  }
  return tokens;
}

/** Walks `root` following pre-tokenised path segments. Returns undefined on miss. */
export function resolveTokens(root: unknown, tokens: PathToken[]): unknown {
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof t === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}

/** Resolves a full dotted/indexed path against a root context object. */
export function resolveStatePath(root: unknown, path: string): unknown {
  return resolveTokens(root, tokenizePath(path));
}

/**
 * Placeholder pattern for runtime templates. Accepts dotted paths, hyphens and
 * `[n]` subscripts, e.g. `{{turn[1].triage.classification.route}}`.
 */
export const TEMPLATE_PLACEHOLDER_RE = /\{\{\s*([\w.\-[\]]+)\s*\}\}/g;

/**
 * Aggressive renderer for tool/rag args: replaces EVERY `{{path}}` placeholder,
 * substituting an empty string when the path resolves to null/undefined. Used
 * where a leftover placeholder would be meaningless (e.g. a rag `tag` filter).
 */
export function renderTemplateAggressive(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_PLACEHOLDER_RE, (_match, path: string) => {
    const val = resolveStatePath(context, path);
    return val === undefined || val === null ? "" : String(val);
  });
}

/**
 * Conservative renderer for system prompts: only replaces placeholders whose
 * FIRST segment names a known root (e.g. `context`, `now`, `node`, `turn`).
 * A placeholder for an unknown root is left intact (so unrelated `{{…}}` text
 * is not swallowed). A known root with a missing sub-path resolves to an empty
 * string, matching the graceful-degradation behaviour of prompt templating.
 */
export function renderTemplateNamespaced(
  template: string,
  roots: Record<string, unknown>,
): string {
  return template.replace(
    TEMPLATE_PLACEHOLDER_RE,
    (match, path: string): string => {
      const tokens = tokenizePath(path);
      const root = tokens[0];
      if (typeof root !== "string" || !(root in roots)) return match;
      const val = resolveTokens(roots[root], tokens.slice(1));
      return val === undefined || val === null ? "" : String(val);
    },
  );
}

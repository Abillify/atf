// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow Parser — Normalization and Include Resolution
 *
 * Handles pre-validation transformations:
 * 1. Prompt file includes — `#[[file:<relPath>]]`
 * 2. Sub-flow includes — `metadata.$include.subflows`
 * 3. Variable resolution — `{{vars.<name>}}`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FlowDefinition } from "../../types/flow.js";
import { parseFlowFile } from "../../util/parse-flow-file.js";
import { VAR_PLACEHOLDER_RE } from "./validate.js";

// ---------------------------------------------------------------------------
// Prompt File Includes
// ---------------------------------------------------------------------------

/**
 * Pattern for prompt file includes: `#[[file:relative/path.md]]`
 * Captured group 1 is the relative path.
 */
const PROMPT_INCLUDE_RE = /#\[\[file:([^\]]+)\]\]/g;

/**
 * Resolves `#[[file:<relPath>]]` markers inside a single string.
 * `relPath` is resolved relative to `flowsDir`.
 * Nested includes in the loaded file are resolved recursively up to `maxDepth`.
 */
function resolvePromptString(
  text: string,
  flowsDir: string,
  fileName: string,
  depth: number,
  maxDepth: number,
): string {
  if (depth > maxDepth) return text;
  return text.replace(PROMPT_INCLUDE_RE, (_match, relPath: string) => {
    const absPath = path.resolve(flowsDir, relPath.trim());
    try {
      const included = fs.readFileSync(absPath, "utf-8");
      return resolvePromptString(
        included,
        flowsDir,
        relPath.trim(),
        depth + 1,
        maxDepth,
      );
    } catch (err) {
      process.stderr.write(
        `${JSON.stringify({
          level: "warn",
          component: "flow-parser",
          fileName,
          reason: `Prompt include not found: "${relPath}"`,
          details: err instanceof Error ? err.message : String(err),
        })}\n`,
      );
      return "";
    }
  });
}

/**
 * Walks all `systemPrompt` fields in a raw flow object (nodes + overrides)
 * and resolves any `#[[file:...]]` markers in-place.
 */
function resolvePromptIncludes(
  raw: Record<string, unknown>,
  flowsDir: string,
  fileName: string,
): void {
  const nodes = raw.nodes;
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const n = node as Record<string, unknown>;

    if (typeof n.systemPrompt === "string") {
      n.systemPrompt = resolvePromptString(
        n.systemPrompt,
        flowsDir,
        fileName,
        0,
        5,
      );
    }

    const overrides = n.overrides;
    if (Array.isArray(overrides)) {
      for (const override of overrides) {
        if (typeof override !== "object" || override === null) continue;
        const o = override as Record<string, unknown>;
        if (typeof o.systemPrompt === "string") {
          o.systemPrompt = resolvePromptString(
            o.systemPrompt,
            flowsDir,
            fileName,
            0,
            5,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-flow Includes
// ---------------------------------------------------------------------------

/**
 * Shape of the `metadata.$include` object in a flow JSON file.
 */
interface FlowIncludeDirective {
  subflows?: string[];
}

/**
 * Reads, parses and resolves a sub-flow JSON file.
 * Returns its nodes and edges arrays, or empty arrays on any error.
 */
function loadSubflowRaw(
  absPath: string,
  flowsDir: string,
  parentFileName: string,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
): { nodes: unknown[]; edges: unknown[] } {
  const empty = { nodes: [], edges: [] };
  if (depth > maxDepth) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        fileName: parentFileName,
        reason: `Sub-flow include depth limit (${maxDepth}) reached, skipping: "${absPath}"`,
      })}\n`,
    );
    return empty;
  }
  if (visited.has(absPath)) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        fileName: parentFileName,
        reason: `Circular sub-flow include detected, skipping: "${absPath}"`,
      })}\n`,
    );
    return empty;
  }
  visited.add(absPath);

  let raw: Record<string, unknown>;
  try {
    raw = parseFlowFile(absPath) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        fileName: parentFileName,
        reason: `Failed to read sub-flow: "${absPath}"`,
        details: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
    return empty;
  }

  resolvePromptIncludes(raw, flowsDir, absPath);
  resolveSubflowIncludes(raw, flowsDir, absPath, depth + 1, maxDepth, visited);

  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const edges = Array.isArray(raw.edges) ? raw.edges : [];
  return { nodes, edges };
}

/**
 * Processes `metadata.$include.subflows` in a raw flow object.
 * Merges sub-flow nodes (parent wins on duplicate IDs) and edges.
 * Strips the `$include` key from metadata.
 *
 * `origins`, when provided, is populated with `nodeId -> relPath` for every
 * node merged in **at this call's direct level** (`depth` is whatever the
 * caller passed — callers that care about origins only pass `origins` for
 * their own top-level call, so a node's origin is always the direct
 * `$include.subflows` entry the requested flow declared, even if that
 * included file itself nests further includes — those nested merges still
 * happen structurally but are not separately attributed). This is what lets
 * `POST /flows/write` write a saved flow's nodes back to the sub-flow file
 * they came from instead of flattening everything into the parent file —
 * see `resolveFlowIncludes` below and `src/routes/flows.ts`.
 */
function resolveSubflowIncludes(
  raw: Record<string, unknown>,
  flowsDir: string,
  fileName: string,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
  origins?: Record<string, string>,
): void {
  const metadata = raw.metadata;
  if (typeof metadata !== "object" || metadata === null) return;
  const meta = metadata as Record<string, unknown>;

  const includeDirective = meta.$include;
  if (typeof includeDirective !== "object" || includeDirective === null) return;

  const directive = includeDirective as FlowIncludeDirective;
  const subflowPaths = directive.subflows;

  delete meta.$include;

  if (!Array.isArray(subflowPaths) || subflowPaths.length === 0) return;

  const parentNodes: unknown[] = Array.isArray(raw.nodes)
    ? raw.nodes
    : [];
  const parentEdges: unknown[] = Array.isArray(raw.edges)
    ? raw.edges
    : [];
  raw.nodes = parentNodes;
  raw.edges = parentEdges;

  const existingNodeIds = new Set<string>(
    parentNodes
      .filter(
        (n): n is Record<string, unknown> =>
          typeof n === "object" && n !== null,
      )
      .map((n) => n.id)
      .filter((id): id is string => typeof id === "string"),
  );

  for (const relPath of subflowPaths) {
    if (typeof relPath !== "string") continue;
    const absPath = path.resolve(flowsDir, relPath.trim());
    const { nodes: subNodes, edges: subEdges } = loadSubflowRaw(
      absPath,
      flowsDir,
      fileName,
      depth,
      maxDepth,
      visited,
    );

    for (const node of subNodes) {
      if (typeof node !== "object" || node === null) continue;
      const n = node as Record<string, unknown>;
      const id = n.id;
      if (typeof id !== "string") continue;
      if (existingNodeIds.has(id)) {
        process.stderr.write(
          `${JSON.stringify({
            level: "warn",
            component: "flow-parser",
            fileName,
            reason: `Sub-flow node ID "${id}" already exists in parent flow — skipping sub-flow node`,
            subflow: relPath,
          })}\n`,
        );
        continue;
      }
      existingNodeIds.add(id);
      parentNodes.push(node);
      if (depth === 0 && origins !== undefined) {
        origins[id] = relPath.trim();
      }
    }

    for (const edge of subEdges) {
      parentEdges.push(edge);
    }
  }
}

// ---------------------------------------------------------------------------
// Variable Resolution
// ---------------------------------------------------------------------------

/**
 * Pattern for variable references: `{{vars.<dotted.name>}}`.
 */
const VAR_REF_RE = /\{\{\s*vars\.([\w.-]+)\s*\}\}/g;

/**
 * Builds a recursive `{{vars.<name>}}` resolver bound to a variable map.
 */
function createVariableResolver(
  varMap: Record<string, unknown>,
  onUnknown: (name: string) => void,
): (value: unknown) => unknown {
  const lookup = (dotted: string): unknown => {
    const segments = dotted.split(".");
    let cur: unknown = varMap;
    for (const seg of segments) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
  };

  const resolveString = (s: string): unknown => {
    const exact = VAR_PLACEHOLDER_RE.exec(s);
    if (exact !== null) {
      const name = exact[1] ?? "";
      const val = lookup(name);
      if (val === undefined) {
        onUnknown(name);
        return s;
      }
      return val;
    }
    return s.replace(VAR_REF_RE, (match, name: string) => {
      const val = lookup(name);
      if (val === undefined) {
        onUnknown(name);
        return match;
      }
      return typeof val === "object" && val !== null
        ? JSON.stringify(val)
        : String(val);
    });
  };

  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return resolveString(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        obj[key] = walk(obj[key]);
      }
      return obj;
    }
    return value;
  };

  return walk;
}

/**
 * Resolves `{{vars.<name>}}` references in the `nodes` and `edges` of a raw flow
 * object (pre-validation) using `raw.variables` merged with optional overrides.
 * Mutates `raw` in place.
 */
export function resolveRawFlowVariables(
  raw: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
  fileName: string,
): void {
  const declared = raw.variables;
  const baseVars =
    typeof declared === "object" &&
    declared !== null &&
    !Array.isArray(declared)
      ? (declared as Record<string, unknown>)
      : {};
  const effective = { ...baseVars, ...(overrides ?? {}) };
  if (Object.keys(effective).length === 0) return;

  const warnUnknown = (name: string): void => {
    process.stderr.write(
      `${JSON.stringify({
        level: "warn",
        component: "flow-parser",
        fileName,
        reason: `Unknown flow variable referenced: "${name}" — leaving placeholder unresolved`,
      })}\n`,
    );
  };

  const walk = createVariableResolver(effective, warnUnknown);
  if (Array.isArray(raw.nodes)) {
    raw.nodes = raw.nodes.map(walk);
  }
  if (Array.isArray(raw.edges)) {
    raw.edges = raw.edges.map(walk);
  }
}

// ---------------------------------------------------------------------------
// Variable resolution + memoisation
// ---------------------------------------------------------------------------

/**
 * Per-flow memo of resolved variants, keyed by the effective variable set.
 *
 * ## Why this is memoised
 *
 * `applyFlowVariables` runs on EVERY request and `structuredClone`s the entire
 * flow. Every production flow here declares `variables`, so the fast path never
 * applies, and production flows may be large (for example, 658 lines /
 * ~42 KB). The clone was therefore pure per-request overhead for a result that
 * is identical across requests: the function is pure in
 * (flow, effective variables).
 *
 * ## Why a WeakMap keyed by the flow OBJECT
 *
 * Invalidation comes for free. The registry holds one object per flow id and
 * replaces it on hot-reload, so a changed file yields a new key and the stale
 * memo becomes unreachable — no explicit cache-busting to forget, and no way for
 * an edited flow to keep serving its old resolution.
 *
 * A useful side effect: the resolved flow now has a STABLE identity across
 * requests, which is what makes the checksum memo in `graph-engine/compile.ts`
 * effective (it is a WeakMap on the same object).
 */
const variantMemo = new WeakMap<
  FlowDefinition,
  Map<string, FlowDefinition>
>();

/**
 * Bound on distinct variable sets memoised per flow. A request may supply
 * `variableOverrides`, so an adversarial or simply varied caller could otherwise
 * grow this without limit. Oldest-first eviction (insertion-ordered Map).
 */
const MAX_VARIANTS_PER_FLOW = 64;

/** Deterministic key for a variable set — key order must not create a miss. */
function variableSetKey(vars: Record<string, unknown>): string {
  const keys = Object.keys(vars).sort();
  return JSON.stringify(keys.map((k) => [k, vars[k]]));
}

/**
 * Returns a FlowDefinition with all `{{vars.<name>}}` references resolved
 * against the flow's declared `variables` merged with the supplied overrides.
 *
 * The input flow is not mutated. Unknown variable references are left as-is.
 *
 * Memoised per (flow object, effective variable set) — see {@link variantMemo}.
 * The returned object must therefore be treated as **read-only**: it is shared
 * across every request resolving to the same variable set. Nothing in the engine
 * mutates a flow definition (the graph compiler only reads it), and the previous
 * behaviour of handing out a fresh clone each time was accidental rather than
 * relied upon.
 */
export function applyFlowVariables(
  flow: FlowDefinition,
  overrides?: Record<string, unknown>,
): FlowDefinition {
  const baseVars = flow.variables ?? {};
  const effective = { ...baseVars, ...(overrides ?? {}) };
  if (Object.keys(effective).length === 0) return flow;

  const key = variableSetKey(effective);
  let variants = variantMemo.get(flow);
  if (variants === undefined) {
    variants = new Map();
    variantMemo.set(flow, variants);
  }
  const hit = variants.get(key);
  if (hit !== undefined) return hit;

  const clone = structuredClone(flow) as FlowDefinition & {
    nodes: unknown[];
    edges: unknown[];
  };
  const walk = createVariableResolver(effective, () => {});
  clone.nodes = (clone.nodes as unknown[]).map(walk) as FlowDefinition["nodes"];
  clone.edges = (clone.edges as unknown[]).map(walk) as FlowDefinition["edges"];

  while (variants.size >= MAX_VARIANTS_PER_FLOW) {
    const oldest = variants.keys().next().value;
    if (oldest === undefined) break;
    variants.delete(oldest);
  }
  variants.set(key, clone);
  return clone;
}

/**
 * Entry point: applies all include resolution to a raw parsed flow object
 * before it reaches schema validation.
 *
 * Order:
 *   1. Prompt includes (`#[[file:...]]`)
 *   2. Sub-flow includes (`metadata.$include.subflows`)
 *
 * After merging, records which sub-flow file each merged-in node came from
 * as `metadata.$includeOrigins` (`nodeId -> relPath`) — a read/write-time-only
 * bookkeeping field, never itself persisted to a flow file. It lets the
 * editor (`GET /flows/:id` → Studio builder → `POST /flows/write`) round-trip
 * an `$include`-composed flow without flattening the sub-flow's nodes back
 * into the parent file on every save; see `src/routes/flows.ts`. Omitted
 * entirely when the flow uses no includes, so every flow that doesn't use
 * this feature is completely unaffected.
 *
 * Note: `{{vars.<name>}}` references are intentionally NOT resolved here.
 */
export function resolveFlowIncludes(
  raw: Record<string, unknown>,
  flowsDir: string,
  fileName: string,
): void {
  resolvePromptIncludes(raw, flowsDir, fileName);
  const origins: Record<string, string> = {};
  resolveSubflowIncludes(raw, flowsDir, fileName, 0, 3, new Set<string>(), origins);
  if (Object.keys(origins).length > 0) {
    const metadata = raw.metadata;
    const meta =
      typeof metadata === "object" && metadata !== null
        ? (metadata as Record<string, unknown>)
        : {};
    meta.$includeOrigins = origins;
    raw.metadata = meta;
  }
}

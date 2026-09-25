// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sub-flow extraction (`src/graph/sub-flow.ts`)
 *
 * Builds a runnable {@link FlowDefinition} containing only a chosen subset of a
 * flow's nodes — a "sub-section" — so the optimizer/eval harness can evaluate
 * (and optimize) just part of a flow instead of always running it end-to-end.
 *
 * Why this matters: a big flow may have an expensive upstream classifier or
 * retrieval stage that is irrelevant to the node you're tuning. Extracting the
 * relevant slice makes each eval iteration cheaper, faster, and lower-variance
 * (fewer upstream sources of noise), and lets an operator ask "is just this
 * part of the flow the problem?".
 *
 * Semantics (important):
 *   - The scope is a set of node ids. Only edges whose BOTH endpoints are in
 *     scope are kept — edges leaving the scope are pruned, so a scoped node
 *     that pointed downstream simply becomes terminal in the sub-flow.
 *   - The sub-flow's ENTRY node is the scoped node with no in-scope predecessor
 *     (or an explicitly provided `entryNodeId`). It is placed first so the
 *     graph engine's "first node is the entry" rule selects it. The entry node
 *     therefore receives the ORIGINAL execution input directly — so partial
 *     evaluation is meaningful when the scope is anchored at (or near) a point
 *     that naturally consumes the raw input. Evaluating a deep mid-graph slice
 *     with raw input is allowed but the caller owns that interpretation.
 *   - `parallel` children pointing outside the scope are pruned.
 *
 * The result is validated with {@link validateFlow}; an invalid slice throws a
 * descriptive error rather than being silently mis-evaluated. Pure (no I/O)
 * apart from throwing. No `any` at module boundaries.
 */

import type { FlowDefinition, FlowNode } from "../types/flow.js";
import { parallelChildId } from "../types/flow.js";
import { inlineNodes } from "./edge-rules.js";
import { validateFlow } from "./flow-validator.js";

export interface ExtractSubFlowOptions {
  /**
   * Force a specific entry node (must be in scope). When omitted the entry is
   * inferred as the scoped node with no incoming in-scope edge.
   */
  entryNodeId?: string;
  /** Known MCP tool ids, forwarded to validation for tool-ref warnings. */
  knownToolIds?: ReadonlySet<string>;
}

export class SubFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubFlowError";
  }
}

/** Short, stable id suffix for a scope (bounded length). */
function scopeIdSuffix(scopeNodeIds: string[]): string {
  const joined = [...scopeNodeIds].sort().join("+");
  if (joined.length <= 60) return joined;
  // Long scopes: hash to keep the id manageable while staying deterministic.
  let h = 0;
  for (let i = 0; i < joined.length; i++) {
    h = (Math.imul(31, h) + joined.charCodeAt(i)) | 0;
  }
  return `${scopeNodeIds.length}nodes-${(h >>> 0).toString(36)}`;
}

/**
 * Extracts a sub-flow containing exactly the nodes in `scopeNodeIds`.
 *
 * @throws {SubFlowError} when the scope is empty, references unknown nodes, has
 *   no resolvable single entry, or the resulting slice fails flow validation.
 */
export function extractSubFlow(
  flow: FlowDefinition,
  scopeNodeIds: string[],
  options: ExtractSubFlowOptions = {},
): FlowDefinition {
  if (scopeNodeIds.length === 0) {
    throw new SubFlowError("scopeNodeIds must not be empty");
  }
  const scope = new Set(scopeNodeIds);

  // All scoped ids must exist in the flow.
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  for (const id of scope) {
    if (!byId.has(id)) {
      throw new SubFlowError(
        `scope node "${id}" does not exist in flow "${flow.id}"`,
      );
    }
  }

  // Keep only edges fully inside the scope.
  const edges = flow.edges.filter(
    (e) => scope.has(e.source) && scope.has(e.target),
  );

  // Determine the entry node.
  const inScopeTargets = new Set(edges.map((e) => e.target));
  // Nodes that run inside another node (parallel children, harness workers)
  // are never an entry — they are not graph nodes of their own.
  const inline = inlineNodes(
    flow.nodes.filter((n) => scope.has(n.id)),
    edges,
  );
  const candidates = [...scope].filter((id) => !inScopeTargets.has(id) && !inline.has(id));

  let entryNodeId: string;
  if (options.entryNodeId !== undefined) {
    if (!scope.has(options.entryNodeId)) {
      throw new SubFlowError(
        `entryNodeId "${options.entryNodeId}" is not in the scope`,
      );
    }
    entryNodeId = options.entryNodeId;
  } else if (candidates.length === 1 && candidates[0] !== undefined) {
    entryNodeId = candidates[0];
  } else if (candidates.length === 0) {
    // Every scoped node is a target of another scoped node → the slice is a
    // cycle or has no source. Fall back to the first scoped node in flow order.
    const first = flow.nodes.find((n) => scope.has(n.id));
    if (first === undefined) {
      throw new SubFlowError("could not resolve an entry node for the scope");
    }
    entryNodeId = first.id;
  } else {
    throw new SubFlowError(
      `ambiguous entry: scope has ${candidates.length} nodes with no in-scope predecessor (${candidates.join(", ")}). ` +
        `Pass entryNodeId to disambiguate.`,
    );
  }

  // Rebuild nodes: entry first (engine treats the first node as the entry when
  // there is no explicit start edge), then the rest in original order. Prune
  // parallel children that fall outside the scope.
  const ordered: FlowNode[] = [];
  const pushNode = (node: FlowNode): void => {
    if (node.type === "parallel" && node.parallelNodes !== undefined) {
      const kept = node.parallelNodes.filter((c) =>
        scope.has(parallelChildId(c)),
      );
      ordered.push({ ...node, parallelNodes: kept });
    } else {
      ordered.push({ ...node });
    }
  };

  const entryNode = byId.get(entryNodeId);
  if (entryNode === undefined) {
    // Unreachable: entryNodeId is always a member of `scope`, and every scope
    // node was validated above to exist in `flow.nodes` (hence in `byId`).
    throw new SubFlowError(`entry node "${entryNodeId}" not found in flow`);
  }
  pushNode(entryNode);
  for (const node of flow.nodes) {
    if (node.id === entryNodeId) continue;
    if (scope.has(node.id)) pushNode(node);
  }

  const subFlow: FlowDefinition = {
    ...flow,
    id: `${flow.id}@scope/${scopeIdSuffix(scopeNodeIds)}`,
    nodes: ordered,
    edges,
  };

  const report = validateFlow(subFlow, options.knownToolIds);
  if (!report.valid) {
    const detail = report.errors
      .map((e) => `${e.path}: ${e.message}`)
      .join("; ");
    throw new SubFlowError(
      `extracted sub-flow is invalid: ${detail || "unknown validation error"}`,
    );
  }

  return subFlow;
}

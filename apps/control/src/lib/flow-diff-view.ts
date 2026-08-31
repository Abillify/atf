// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * flow-diff-view — projects a backend `FlowDiff` (id-level added/removed/
 * changed lists, see `src/graph/flow-diff.ts`) onto the Studio builder's
 * canvas so a version comparison is visible AT A GLANCE on the graph itself,
 * not only as a text list (FlowDiffPanel remains available for the precise
 * field-level detail).
 *
 * Pure and framework-free — no React/ReactFlow imports — so it is
 * unit-testable like the rest of `lib/flow-graph.ts`.
 */

import type { FlowDefinition, FlowDiff } from "../types/flow";
import { flowToGraph, type RFNode, type RFEdge } from "./flow-graph";

export type DiffStatus = "added" | "removed" | "changed";

export interface DiffInfo {
  status: DiffStatus;
  changedFields?: string[];
}

/** A removed node re-created for display, positioned per the "from" version's own layout. Never interactive. */
export interface GhostRFNode extends RFNode {
  draggable: false;
  selectable: false;
  connectable: false;
}

export interface DiffOverlay {
  /** Diff status for nodes that still exist in the current canvas (added/changed). */
  nodeDiff: Map<string, DiffInfo>;
  /** Diff status for edges that still exist in the current canvas (added/changed). */
  edgeDiff: Map<string, DiffInfo>;
  /** Removed nodes, synthesized for display only — not part of the editable graph. */
  ghostNodes: GhostRFNode[];
  /** Removed edges, synthesized for display only (both endpoints resolved to a real or ghost node). */
  ghostEdges: RFEdge[];
}

/**
 * Parses a `flow-diff.ts` edge key (`source->target` or `source->target#id`)
 * back to its endpoints. Node ids are never expected to contain `->` or `#`
 * (both are rejected by flow ids elsewhere in the app), so a first-match split
 * is unambiguous in practice.
 */
export function parseEdgeKey(key: string): { source: string; target: string } {
  const withoutId = key.split("#")[0] ?? key;
  const arrow = withoutId.indexOf("->");
  if (arrow === -1) return { source: withoutId, target: "" };
  return {
    source: withoutId.slice(0, arrow),
    target: withoutId.slice(arrow + 2),
  };
}

/**
 * Builds the canvas overlay for a `FlowDiff` between `fromDef` (the older
 * side) and the current live canvas (`toNodes`/`toEdges`).
 *
 * Matching an edge-diff entry back to a rendered `RFEdge` is done by
 * (source, target) pair rather than the full key (which may carry an id
 * suffix) — flows very rarely have more than one edge between the same pair,
 * and this overlay is an at-a-glance aid, not the precise audit trail (that's
 * `FlowDiffPanel`'s job).
 */
export function buildDiffOverlay(
  fromDef: FlowDefinition,
  toNodes: RFNode[],
  toEdges: RFEdge[],
  diff: FlowDiff,
): DiffOverlay {
  const nodeDiff = new Map<string, DiffInfo>();
  for (const id of diff.nodes.added) nodeDiff.set(id, { status: "added" });
  for (const nc of diff.nodes.changed) {
    nodeDiff.set(nc.id, { status: "changed", changedFields: nc.changedFields });
  }

  const findEdgeId = (source: string, target: string): string | undefined =>
    toEdges.find((e) => e.source === source && e.target === target)?.id;

  const edgeDiff = new Map<string, DiffInfo>();
  for (const key of diff.edges.added) {
    const { source, target } = parseEdgeKey(key);
    const id = findEdgeId(source, target);
    if (id !== undefined) edgeDiff.set(id, { status: "added" });
  }
  for (const ec of diff.edges.changed) {
    const { source, target } = parseEdgeKey(ec.key);
    const id = findEdgeId(source, target);
    if (id !== undefined) {
      edgeDiff.set(id, { status: "changed", changedFields: ec.changedFields });
    }
  }

  // Ghost nodes: removed nodes, positioned per the "from" version's own layout.
  const fromGraph = flowToGraph(fromDef);
  const removedIds = new Set(diff.nodes.removed);
  const ghostNodes: GhostRFNode[] = fromGraph.nodes
    .filter((n) => removedIds.has(n.id))
    .map((n) => ({
      ...n,
      draggable: false,
      selectable: false,
      connectable: false,
    }));

  // Ghost edges: removed edges, only when both endpoints resolve to a real
  // (current) or ghost (removed) node — otherwise there's nowhere to draw them.
  const resolvable = (id: string): boolean =>
    toNodes.some((n) => n.id === id) || ghostNodes.some((n) => n.id === id);

  const ghostEdges: RFEdge[] = diff.edges.removed
    .map((key) => {
      const { source, target } = parseEdgeKey(key);
      return { key, source, target };
    })
    .filter(({ source, target }) => resolvable(source) && resolvable(target))
    .map(({ key, source, target }) => ({
      id: `ghost-${key}`,
      source,
      target,
      data: {},
    }));

  return { nodeDiff, edgeDiff, ghostNodes, ghostEdges };
}

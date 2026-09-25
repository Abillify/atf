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
import {
  flowToGraph,
  layoutEditorGraph,
  type RFNode,
  type RFEdge,
} from "./flow-graph";

export type DiffStatus = "added" | "removed" | "changed";

export interface DiffInfo {
  status: DiffStatus;
  changedFields?: string[];
}

/**
 * A display-only node that is not part of the editable graph. Never interactive.
 * `removed` (default): a node of the compared "from" version that is gone now.
 * `added`: a node a Copilot proposal would add (see `buildProposalOverlay`).
 */
export interface GhostRFNode extends RFNode {
  draggable: false;
  selectable: false;
  connectable: false;
  ghostKind?: "removed" | "added";
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

/**
 * Canvas overlay for a Copilot PROPOSAL — the opposite direction of
 * `buildDiffOverlay`: `from` is the current canvas, `to` is the proposed flow,
 * which is not on the canvas yet. So:
 *
 *  - nodes the proposal adds become green "added" ghosts, placed where the
 *    proposed graph's hierarchical layout puts them, shifted to line up with
 *    the existing nodes' real positions;
 *  - nodes it removes / changes are badged in place (they are still on the
 *    canvas until the proposal is accepted);
 *  - edges it adds are drawn as ghost edges between real or ghost nodes;
 *    edges it removes are badged in place.
 */
export function buildProposalOverlay(
  currentNodes: RFNode[],
  currentEdges: RFEdge[],
  proposed: FlowDefinition,
  diff: FlowDiff,
): DiffOverlay {
  const nodeDiff = new Map<string, DiffInfo>();
  for (const id of diff.nodes.removed) nodeDiff.set(id, { status: "removed" });
  for (const nc of diff.nodes.changed) {
    nodeDiff.set(nc.id, { status: "changed", changedFields: nc.changedFields });
  }

  const onCanvas = new Map(currentNodes.map((n) => [n.id, n]));
  const addedIds = new Set(diff.nodes.added.filter((id) => !onCanvas.has(id)));

  // Where would the proposal's own layout put everything? Align it to the
  // canvas by the average offset of nodes that exist on both sides.
  const layout = layoutEditorGraph(
    proposed.nodes,
    proposed.edges.map((e) => ({ source: e.source, target: e.target, label: e.label ?? e.conditions })),
  );
  let dx = 0;
  let dy = 0;
  let shared = 0;
  for (const [id, pos] of Object.entries(layout)) {
    const real = onCanvas.get(id);
    if (!real) continue;
    dx += real.position.x - pos.x;
    dy += real.position.y - pos.y;
    shared++;
  }
  if (shared > 0) {
    dx /= shared;
    dy /= shared;
  }

  const ghostNodes: GhostRFNode[] = proposed.nodes
    .filter((n) => addedIds.has(n.id))
    .map((n) => {
      const pos = layout[n.id] ?? { x: 0, y: 0 };
      return {
        id: n.id,
        type: "flowNode" as const,
        position: { x: pos.x + dx, y: pos.y + dy },
        data: { flowNode: n },
        draggable: false,
        selectable: false,
        connectable: false,
        ghostKind: "added" as const,
      };
    });

  const drawable = (id: string): boolean => onCanvas.has(id) || addedIds.has(id);
  const findEdgeId = (source: string, target: string): string | undefined =>
    currentEdges.find((e) => e.source === source && e.target === target)?.id;

  const edgeDiff = new Map<string, DiffInfo>();
  for (const key of diff.edges.removed) {
    const { source, target } = parseEdgeKey(key);
    const id = findEdgeId(source, target);
    if (id !== undefined) edgeDiff.set(id, { status: "removed" });
  }
  for (const ec of diff.edges.changed) {
    const { source, target } = parseEdgeKey(ec.key);
    const id = findEdgeId(source, target);
    if (id !== undefined) edgeDiff.set(id, { status: "changed", changedFields: ec.changedFields });
  }

  const ghostEdges: RFEdge[] = diff.edges.added
    .map((key) => ({ key, ...parseEdgeKey(key) }))
    .filter(({ source, target }) => drawable(source) && drawable(target))
    .map(({ key, source, target }) => {
      const e = proposed.edges.find((x) => x.source === source && x.target === target);
      const label = e?.label ?? e?.conditions;
      return {
        id: `ghost-added-${key}`,
        source,
        target,
        ...(label ? { label } : {}),
        data: { ghostKind: "added" },
      };
    });

  return { nodeDiff, edgeDiff, ghostNodes, ghostEdges };
}

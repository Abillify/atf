// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Start and End of a flow, as the Studio canvas draws them. Neither is a node
 * of the flow definition; they make the compiler's implicit rules visible
 * (graph-engine/compile.ts):
 *
 *  - Entry: the FIRST node of the flow.
 *  - Exit: a node with no outgoing edge ends the run; so does a node whose
 *    outgoing edges are all conditional when none of them matches.
 *
 * (The compiler would also honour `__start__`/`__end__` edges, but the flow
 * parser rejects edges to ids that are not nodes, so flows can't contain them.)
 */

import { inlineNodes, type EdgeLike, type NodeLike } from "./edge-rules";

export const START_ID = "__start__";
export const END_ID = "__end__";
/** Ids of the request/response boundary events in the monitoring stream. */
export const REQUEST_EVENT_ID = "__request__";
export const RESPONSE_EVENT_ID = "__response__";

export const isBoundaryId = (id: string): boolean => id === START_ID || id === END_ID;

/**
 * Id prefix of the canvas' implicit start/end links (display-only, drawn by
 * FlowCanvas). The property panel recognises these ids to show the run's
 * entry/exit data flow, which belongs to no edge of the definition.
 */
export const BOUNDARY_EDGE_PREFIX = "boundary:";

export const boundaryStartEdgeId = (nodeId: string): string =>
  `${BOUNDARY_EDGE_PREFIX}start-${nodeId}`;

export const boundaryEndEdgeId = (nodeId: string): string =>
  `${BOUNDARY_EDGE_PREFIX}end-${nodeId}`;

/** Which implicit link an id denotes, or null for a definition edge. */
export function parseBoundaryEdgeId(
  id: string,
): { kind: "start" | "end"; nodeId: string } | null {
  if (!id.startsWith(BOUNDARY_EDGE_PREFIX)) return null;
  const rest = id.slice(BOUNDARY_EDGE_PREFIX.length);
  if (rest.startsWith("start-")) return { kind: "start", nodeId: rest.slice("start-".length) };
  if (rest.startsWith("end-")) return { kind: "end", nodeId: rest.slice("end-".length) };
  return null;
}

export interface FlowExit {
  nodeId: string;
  /** `last`: no outgoing edge. `nomatch`: only conditional edges, none matched. */
  kind: "last" | "nomatch";
}

export interface FlowBoundaries {
  /** The node runs start at (none for an empty flow). */
  entryId: string | null;
  /** Nodes after which the run can end. */
  exits: FlowExit[];
}

const conditional = (e: EdgeLike): boolean => (e.conditions ?? "").trim().length > 0;

export function flowBoundaries(nodes: NodeLike[], edges: EdgeLike[]): FlowBoundaries {
  const inline = inlineNodes(nodes, edges);
  const outgoing = new Map<string, EdgeLike[]>();
  for (const e of edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);

  const exits: FlowExit[] = [];
  for (const n of nodes) {
    if (inline.has(n.id)) continue;
    const out = outgoing.get(n.id) ?? [];
    if (out.length === 0) exits.push({ nodeId: n.id, kind: "last" });
    else if (out.every(conditional)) exits.push({ nodeId: n.id, kind: "nomatch" });
  }
  return { entryId: nodes[0]?.id ?? null, exits };
}

/** Why `nodeId` can't be made the entry by moving it to the front, or null. */
export function entryProblem(
  nodes: NodeLike[],
  edges: EdgeLike[],
  nodeId: string,
  origins: Record<string, string> = {},
): string | null {
  if (!nodes.some((n) => n.id === nodeId)) return "The start must connect to a node of this flow.";
  const inline = inlineNodes(nodes, edges).get(nodeId);
  if (inline) return `“${nodeId}” runs inside “${inline.owner}” and can't be the entry.`;
  if (origins[nodeId] !== undefined) {
    return `“${nodeId}” is saved in the sub-flow ${origins[nodeId]} — the entry must be a node of the main flow file.`;
  }
  return null;
}

/** Moves `nodeId` to the front: the compiler starts at the first node. */
export function withEntryFirst<T extends { id: string }>(nodes: T[], nodeId: string): T[] {
  const i = nodes.findIndex((n) => n.id === nodeId);
  if (i <= 0) return nodes;
  return [nodes[i] as T, ...nodes.slice(0, i), ...nodes.slice(i + 1)];
}

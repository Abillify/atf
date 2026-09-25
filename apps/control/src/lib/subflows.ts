// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Sub-flows in the Studio: files under FLOWS_DIR/subflows/ merged into a flow
 * via `metadata.$include.subflows`. On the canvas every node carries its
 * origin (`$includeOrigins`); this module lists/loads sub-flow files and
 * computes the coloured boxes that group a sub-flow's nodes.
 */

import { backendUrl } from "./backend-url";
import type { FlowDefinition } from "../types/flow";
import type { RFNode, RFEdge } from "./flow-graph";

export interface SubflowInfo {
  /** Relative to the flows directory, e.g. `subflows/_retrieval.yaml`. */
  path: string;
  name?: string;
  description?: string;
  nodeIds: string[];
  edgeCount: number;
  /** Flows that include it. */
  usedBy: string[];
}

export interface SubflowContent {
  path: string;
  nodes: FlowDefinition["nodes"];
  edges: FlowDefinition["edges"];
  /** Edge key (`id` or `source->target`) → file, for edges that belong to the sub-flow. */
  edgeOrigins: Record<string, string>;
}

const headers = (token: string | undefined): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

export async function fetchSubflows(token: string | undefined): Promise<SubflowInfo[]> {
  const resp = await fetch(backendUrl("/flows/subflows"), { headers: headers(token) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return ((await resp.json()) as { subflows: SubflowInfo[] }).subflows;
}

export async function fetchSubflowContent(path: string, token: string | undefined): Promise<SubflowContent> {
  const resp = await fetch(backendUrl(`/flows/subflows/content?path=${encodeURIComponent(path)}`), {
    headers: headers(token),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as SubflowContent;
}

/** `subflows/<name>.yaml` from a user-typed name (letters, digits, `-`, `_` — no dots, so no `..`). */
export function subflowPathFor(name: string): string | null {
  const clean = name
    .trim()
    .replace(/\.(ya?ml|json)$/i, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean ? `subflows/${clean}.yaml` : null;
}

/** Display name of a sub-flow path: the file name. */
export const subflowLabel = (path: string): string => path.replace(/^subflows\//, "");

/** Stable colour per sub-flow (index into {@link SUBFLOW_COLORS}). */
export function subflowColorIndex(path: string, all: string[]): number {
  const sorted = [...new Set(all)].sort();
  const i = sorted.indexOf(path);
  return (i < 0 ? 0 : i) % SUBFLOW_COLORS.length;
}

/** Box styles (border / background / label) per colour slot. */
export const SUBFLOW_COLORS = [
  { box: "border-teal-400/70 bg-teal-50/60 dark:bg-teal-950/25", label: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200" },
  { box: "border-violet-400/70 bg-violet-50/60 dark:bg-violet-950/25", label: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200" },
  { box: "border-amber-400/70 bg-amber-50/60 dark:bg-amber-950/25", label: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  { box: "border-sky-400/70 bg-sky-50/60 dark:bg-sky-950/25", label: "bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200" },
  { box: "border-rose-400/70 bg-rose-50/60 dark:bg-rose-950/25", label: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200" },
  { box: "border-emerald-400/70 bg-emerald-50/60 dark:bg-emerald-950/25", label: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200" },
];

export interface SubflowBox {
  path: string;
  nodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Padding around the grouped nodes, and room for the label above them. */
export const BOX_PAD = 18;
export const BOX_LABEL = 26;

/**
 * One box per sub-flow around its nodes (canvas coordinates). Node sizes come
 * from React Flow's measurement when available, else the fallback size.
 */
export function subflowBoxes(
  nodes: Array<{ id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number } }>,
  origins: Record<string, string>,
  fallback: { width: number; height: number },
): SubflowBox[] {
  const byPath = new Map<string, typeof nodes>();
  for (const n of nodes) {
    const p = origins[n.id];
    if (p === undefined) continue;
    byPath.set(p, [...(byPath.get(p) ?? []), n]);
  }
  const boxes: SubflowBox[] = [];
  for (const [path, members] of byPath) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of members) {
      const w = n.measured?.width ?? fallback.width;
      const h = n.measured?.height ?? fallback.height;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + h);
    }
    boxes.push({
      path,
      nodeIds: members.map((n) => n.id),
      x: minX - BOX_PAD,
      y: minY - BOX_PAD - BOX_LABEL,
      width: maxX - minX + 2 * BOX_PAD,
      height: maxY - minY + 2 * BOX_PAD + BOX_LABEL,
    });
  }
  return boxes.sort((a, b) => a.path.localeCompare(b.path));
}

/** The sub-flow whose box contains `point` (for drops onto a box), if any. */
export function subflowAt(point: { x: number; y: number }, boxes: SubflowBox[]): string | undefined {
  // Smallest containing box wins (boxes may overlap).
  return boxes
    .filter((b) => point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height)
    .sort((a, b) => a.width * a.height - b.width * b.height)[0]?.path;
}

// ---------------------------------------------------------------------------
// Sub-flow groups on the canvas — a sub-flow is the set of nodes sharing one
// `$includeOrigins` value, plus the edges the runtime writes back into that
// file. These pure helpers let the Studio treat a whole sub-flow as one unit
// (select / move / delete / save / reset) without duplicating the runtime's
// include bookkeeping.
// ---------------------------------------------------------------------------

/**
 * Bookkeeping key of an edge for `$includeEdgeOrigins`, matching the runtime's
 * `includeEdgeKey` (normalize.ts): the real `id`, or `source->target` for an
 * edge whose id is only canvas-synthetic. Both endpoints must be known.
 */
export function edgeOriginKey(edge: RFEdge): string {
  return edge.data?.syntheticId ? `${edge.source}->${edge.target}` : edge.id;
}

/** Node ids that belong to the sub-flow file `path` (its `$includeOrigins` group). */
export function subflowNodeIds(origins: Record<string, string>, path: string): string[] {
  return Object.entries(origins)
    .filter(([, p]) => p === path)
    .map(([id]) => id);
}

/**
 * The edges that belong to sub-flow `path`, mirroring how the runtime's
 * `splitByIncludeOrigin` buckets them: an edge recorded in `$includeEdgeOrigins`
 * for this file, or one whose both endpoints are tagged with this file. A
 * cross-boundary edge (endpoints in different files, or only one tagged) stays
 * with the parent and is not part of the sub-flow.
 */
export function subflowEdges(
  edges: RFEdge[],
  origins: Record<string, string>,
  edgeOrigins: Record<string, string>,
  path: string,
): RFEdge[] {
  const inFile = new Set(subflowNodeIds(origins, path));
  return edges.filter((e) => {
    const recorded = edgeOrigins[edgeOriginKey(e)];
    if (recorded !== undefined) return recorded === path;
    return inFile.has(e.source) && inFile.has(e.target);
  });
}

/** Sub-flow file paths present on the canvas, sorted, deduplicated. */
export function subflowPaths(origins: Record<string, string>): string[] {
  return [...new Set(Object.values(origins))].sort();
}

export interface SubflowGroup {
  path: string;
  nodes: RFNode[];
  /** Edges written back into this file (see {@link subflowEdges}). */
  edges: RFEdge[];
}

/** The full canvas slice of one sub-flow: its nodes and its edges. */
export function subflowGroup(
  nodes: RFNode[],
  edges: RFEdge[],
  origins: Record<string, string>,
  edgeOrigins: Record<string, string>,
  path: string,
): SubflowGroup {
  const ids = new Set(subflowNodeIds(origins, path));
  return {
    path,
    nodes: nodes.filter((n) => ids.has(n.id)),
    edges: subflowEdges(edges, origins, edgeOrigins, path),
  };
}

/**
 * Moves every node of sub-flow `path` by `(dx, dy)`. Returns a new node array;
 * nodes of other sub-flows and the parent are untouched. Used to drag a whole
 * group.
 */
export function moveSubflow(
  nodes: RFNode[],
  origins: Record<string, string>,
  path: string,
  dx: number,
  dy: number,
): RFNode[] {
  const ids = new Set(subflowNodeIds(origins, path));
  if (ids.size === 0 || (dx === 0 && dy === 0)) return nodes;
  return nodes.map((n) =>
    ids.has(n.id)
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
      : n,
  );
}

export interface RemoveSubflowResult {
  nodes: RFNode[];
  edges: RFEdge[];
  origins: Record<string, string>;
  edgeOrigins: Record<string, string>;
  removedNodeIds: string[];
}

/**
 * Removes a whole sub-flow from the current flow: drops its nodes, the edges
 * that belong to it AND any edge touching a removed node, and clears its
 * `$includeOrigins` / `$includeEdgeOrigins` bookkeeping. The sub-flow FILE is
 * not touched — on save the runtime simply drops the file from
 * `metadata.$include.subflows` because nothing references it anymore.
 */
export function removeSubflow(
  nodes: RFNode[],
  edges: RFEdge[],
  origins: Record<string, string>,
  edgeOrigins: Record<string, string>,
  path: string,
): RemoveSubflowResult {
  const removedNodeIds = subflowNodeIds(origins, path);
  const drop = new Set(removedNodeIds);
  const nextNodes = nodes.filter((n) => !drop.has(n.id));
  const nextEdges = edges.filter((e) => !drop.has(e.source) && !drop.has(e.target));
  const survivingKeys = new Set(nextEdges.map(edgeOriginKey));
  const nextOrigins = Object.fromEntries(
    Object.entries(origins).filter(([id]) => !drop.has(id)),
  );
  // Keep only edge-origin entries whose edge still exists and isn't this file.
  const nextEdgeOrigins = Object.fromEntries(
    Object.entries(edgeOrigins).filter(
      ([key, p]) => p !== path && survivingKeys.has(key),
    ),
  );
  return {
    nodes: nextNodes,
    edges: nextEdges,
    origins: nextOrigins,
    edgeOrigins: nextEdgeOrigins,
    removedNodeIds,
  };
}

/**
 * The `{ nodes, edges }` fragment to write into a sub-flow file, in the same
 * shape `GET /flows/subflows/content` returns and `POST /flows/subflows/write`
 * accepts. Strips the canvas-only synthetic edge ids so an id-less sub-flow
 * edge stays id-less in its file.
 */
export function subflowFragment(group: SubflowGroup): {
  nodes: FlowDefinition["nodes"];
  edges: FlowDefinition["edges"];
} {
  return {
    nodes: group.nodes.map((n) => n.data.flowNode),
    edges: group.edges.map((e) => ({
      ...(e.data?.extra ?? {}),
      ...(e.data?.syntheticId ? {} : { id: e.id }),
      source: e.source,
      target: e.target,
      ...(e.data?.conditions !== undefined && e.data.conditions.length > 0
        ? { conditions: e.data.conditions }
        : {}),
      ...(e.label !== undefined && e.label !== e.data?.conditions
        ? { label: e.label }
        : {}),
    })),
  };
}

/**
 * Writes a single sub-flow file (`POST /flows/subflows/write`) — independent of
 * the parent flow. Resolves to the file's new content hash.
 */
export async function writeSubflowContent(
  path: string,
  fragment: { nodes: FlowDefinition["nodes"]; edges: FlowDefinition["edges"] },
  token: string | undefined,
): Promise<{ hash: string }> {
  const resp = await fetch(backendUrl("/flows/subflows/write"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers(token) },
    body: JSON.stringify({ path, nodes: fragment.nodes, edges: fragment.edges }),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as { hash: string };
}

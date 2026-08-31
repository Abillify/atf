// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow version diff (`src/graph/flow-diff.ts`)
 *
 * Computes a structural diff between two {@link FlowDefinition}s — typically two
 * published versions of the same flow, or a draft vs. its published version. It
 * answers "what actually changed between v3 and v4?" so a reviewer can approve a
 * publish/rollback with confidence instead of eyeballing raw JSON.
 *
 * The diff is structural and stable: nodes are keyed by id, edges by a
 * source→target(+id) key, and per-entity changes list exactly which top-level
 * fields differ. Pure — no I/O — so it is trivially unit-testable and is reused
 * by both the `/flows/:id/diff` route and (potentially) the editor UI.
 *
 * No `any` at module boundaries.
 */

import type { FlowDefinition, FlowNode, FlowEdge } from "../types/flow.js";

export interface FieldChange<T = unknown> {
  from: T;
  to: T;
}

export interface NodeChange {
  id: string;
  /** Top-level node fields that differ (e.g. "llm", "tools", "config"). */
  changedFields: string[];
}

export interface EdgeChange {
  /** Stable edge key: `source->target` (with id suffix when present). */
  key: string;
  changedFields: string[];
}

export interface FlowDiff {
  /** True when anything at all differs. */
  changed: boolean;
  name?: FieldChange<string>;
  description?: FieldChange<string | undefined>;
  metadataChanged: boolean;
  nodes: {
    added: string[];
    removed: string[];
    changed: NodeChange[];
  };
  edges: {
    added: string[];
    removed: string[];
    changed: EdgeChange[];
  };
  /** One-line human-readable summary. */
  summary: string;
}

/** Stable key for an edge (id when present, else source→target). */
export function edgeKey(e: FlowEdge): string {
  const base = `${e.source}->${e.target}`;
  return e.id !== undefined && e.id.length > 0 ? `${base}#${e.id}` : base;
}

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Top-level node fields compared by the diff. */
const NODE_FIELDS: ReadonlyArray<keyof FlowNode> = [
  "type",
  "label",
  "llm",
  "tools",
  "config",
  "classifierSchema",
  "systemPrompt",
  "overrides",
  "parallelNodes",
];

function changedNodeFields(a: FlowNode, b: FlowNode): string[] {
  const changed: string[] = [];
  for (const f of NODE_FIELDS) {
    if (stable(a[f]) !== stable(b[f])) changed.push(f);
  }
  return changed;
}

const EDGE_FIELDS: ReadonlyArray<keyof FlowEdge> = [
  "source",
  "target",
  "conditions",
  "label",
];

function changedEdgeFields(a: FlowEdge, b: FlowEdge): string[] {
  const changed: string[] = [];
  for (const f of EDGE_FIELDS) {
    if (stable(a[f]) !== stable(b[f])) changed.push(f);
  }
  return changed;
}

/**
 * Diffs definition `a` (the "from" / older) against `b` (the "to" / newer).
 * Pure.
 */
export function diffFlows(a: FlowDefinition, b: FlowDefinition): FlowDiff {
  // --- nodes (keyed by id) ---
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));
  const nodesAdded: string[] = [];
  const nodesRemoved: string[] = [];
  const nodesChanged: NodeChange[] = [];
  for (const id of bNodes.keys()) if (!aNodes.has(id)) nodesAdded.push(id);
  for (const id of aNodes.keys()) if (!bNodes.has(id)) nodesRemoved.push(id);
  for (const [id, an] of aNodes) {
    const bn = bNodes.get(id);
    if (bn === undefined) continue;
    const fields = changedNodeFields(an, bn);
    if (fields.length > 0) nodesChanged.push({ id, changedFields: fields });
  }

  // --- edges (keyed by source->target[#id]) ---
  const aEdges = new Map(a.edges.map((e) => [edgeKey(e), e]));
  const bEdges = new Map(b.edges.map((e) => [edgeKey(e), e]));
  const edgesAdded: string[] = [];
  const edgesRemoved: string[] = [];
  const edgesChanged: EdgeChange[] = [];
  for (const k of bEdges.keys()) if (!aEdges.has(k)) edgesAdded.push(k);
  for (const k of aEdges.keys()) if (!bEdges.has(k)) edgesRemoved.push(k);
  for (const [k, ae] of aEdges) {
    const be = bEdges.get(k);
    if (be === undefined) continue;
    const fields = changedEdgeFields(ae, be);
    if (fields.length > 0) edgesChanged.push({ key: k, changedFields: fields });
  }

  // --- scalar / metadata ---
  const name = a.name !== b.name ? { from: a.name, to: b.name } : undefined;
  const description =
    (a.description ?? undefined) !== (b.description ?? undefined)
      ? { from: a.description, to: b.description }
      : undefined;
  const metadataChanged = stable(a.metadata) !== stable(b.metadata);

  const changed =
    name !== undefined ||
    description !== undefined ||
    metadataChanged ||
    nodesAdded.length > 0 ||
    nodesRemoved.length > 0 ||
    nodesChanged.length > 0 ||
    edgesAdded.length > 0 ||
    edgesRemoved.length > 0 ||
    edgesChanged.length > 0;

  const parts: string[] = [];
  if (nodesAdded.length) parts.push(`+${nodesAdded.length} node(s)`);
  if (nodesRemoved.length) parts.push(`-${nodesRemoved.length} node(s)`);
  if (nodesChanged.length) parts.push(`~${nodesChanged.length} node(s)`);
  if (edgesAdded.length) parts.push(`+${edgesAdded.length} edge(s)`);
  if (edgesRemoved.length) parts.push(`-${edgesRemoved.length} edge(s)`);
  if (edgesChanged.length) parts.push(`~${edgesChanged.length} edge(s)`);
  if (name) parts.push("name");
  if (description) parts.push("description");
  if (metadataChanged) parts.push("metadata");
  const summary = changed ? parts.join(", ") : "no changes";

  return {
    changed,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    metadataChanged,
    nodes: { added: nodesAdded, removed: nodesRemoved, changed: nodesChanged },
    edges: { added: edgesAdded, removed: edgesRemoved, changed: edgesChanged },
    summary,
  };
}

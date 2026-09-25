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

/** One changed value inside a node/edge/metadata, addressed by its path. */
export interface ValueChange {
  /** Dotted path with array indices, e.g. `config.routing.candidates[1].shortcut`. */
  path: string;
  kind: "added" | "removed" | "changed";
  /** Absent for `added`. */
  from?: unknown;
  /** Absent for `removed`. */
  to?: unknown;
}

export interface NodeChange {
  id: string;
  /** Top-level node fields that differ (e.g. "llm", "tools", "config"). */
  changedFields: string[];
  /** Every changed value, down to the leaves (capped, see {@link MAX_DETAILS}). */
  details?: ValueChange[];
}

export interface EdgeChange {
  /** Stable edge key: `source->target` (with id suffix when present). */
  key: string;
  changedFields: string[];
  details?: ValueChange[];
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
  /** Full definitions of added/removed nodes and edges (by id / edge key). */
  values?: {
    nodes: { added: Record<string, FlowNode>; removed: Record<string, FlowNode> };
    edges: { added: Record<string, FlowEdge>; removed: Record<string, FlowEdge> };
  };
  /** Changed values inside `metadata` (when {@link FlowDiff.metadataChanged}). */
  metadataDetails?: ValueChange[];
}

/** Cap per entity: a reviewer needs the changes, not a dump of a rewritten config. */
export const MAX_DETAILS = 200;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Leaf-level differences between two values. Objects are compared key by key,
 * arrays index by index (extra entries are added/removed); anything else that
 * differs is one `changed` entry. Pure.
 */
export function diffValues(a: unknown, b: unknown, path = "", out: ValueChange[] = []): ValueChange[] {
  if (out.length >= MAX_DETAILS) return out;
  const at = (key: string | number): string =>
    typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`;
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const inA = a[key] !== undefined;
      const inB = b[key] !== undefined;
      if (inA && !inB) out.push({ path: at(key), kind: "removed", from: a[key] });
      else if (!inA && inB) out.push({ path: at(key), kind: "added", to: b[key] });
      else if (inA && inB && stable(a[key]) !== stable(b[key])) diffValues(a[key], b[key], at(key), out);
      if (out.length >= MAX_DETAILS) break;
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n && out.length < MAX_DETAILS; i++) {
      if (i >= b.length) out.push({ path: at(i), kind: "removed", from: a[i] });
      else if (i >= a.length) out.push({ path: at(i), kind: "added", to: b[i] });
      else if (stable(a[i]) !== stable(b[i])) diffValues(a[i], b[i], at(i), out);
    }
    return out;
  }
  if (stable(a) !== stable(b)) {
    if (a === undefined) out.push({ path, kind: "added", to: b });
    else if (b === undefined) out.push({ path, kind: "removed", from: a });
    else out.push({ path, kind: "changed", from: a, to: b });
  }
  return out;
}

/** Compared fields of a node/edge as one object (so paths start at the field). */
function pick<T extends object>(obj: T, fields: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (obj[f] !== undefined) out[f as string] = obj[f];
  return out;
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
    if (fields.length > 0) {
      nodesChanged.push({
        id,
        changedFields: fields,
        details: diffValues(pick(an, NODE_FIELDS), pick(bn, NODE_FIELDS)),
      });
    }
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
    if (fields.length > 0) {
      edgesChanged.push({
        key: k,
        changedFields: fields,
        details: diffValues(pick(ae, EDGE_FIELDS), pick(be, EDGE_FIELDS)),
      });
    }
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
    values: {
      nodes: {
        added: Object.fromEntries(nodesAdded.map((id) => [id, bNodes.get(id) as FlowNode])),
        removed: Object.fromEntries(nodesRemoved.map((id) => [id, aNodes.get(id) as FlowNode])),
      },
      edges: {
        added: Object.fromEntries(edgesAdded.map((k) => [k, bEdges.get(k) as FlowEdge])),
        removed: Object.fromEntries(edgesRemoved.map((k) => [k, aEdges.get(k) as FlowEdge])),
      },
    },
    ...(metadataChanged
      ? { metadataDetails: diffValues(a.metadata ?? {}, b.metadata ?? {}, "metadata") }
      : {}),
  };
}

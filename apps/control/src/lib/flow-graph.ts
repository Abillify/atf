// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pure conversion between a backend FlowDefinition and React Flow nodes/edges,
 * with a simple auto-layout. Kept free of React/React Flow runtime imports so
 * the mapping is unit-testable. Node positions round-trip through
 * `metadata.ui.layout` (+ `metadata.ui.viewport`) — the documented contract in
 * `types/flow.ts` (`FlowUiMetadata`) — so an edited graph keeps its
 * arrangement and pan/zoom after save.
 */

import type {
  FlowDefinition,
  FlowNode,
  FlowEdge,
  NodeType,
  UiNodeLayout,
} from "../types/flow";
import type { NodeState } from "../components/graph/graphUtils";

export interface RFNodeData {
  flowNode: FlowNode;
}

export interface RFNode {
  id: string;
  type: "flowNode";
  position: { x: number; y: number };
  data: RFNodeData;
  selected?: boolean;
}

export interface RFEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  data: { conditions?: string };
  selected?: boolean;
}

const COLS = 3;
const COL_W = 240;
const ROW_H = 130;

/** Auto-layout position for the node at `index` when none is stored. */
export function autoPosition(index: number): { x: number; y: number } {
  return { x: (index % COLS) * COL_W, y: Math.floor(index / COLS) * ROW_H };
}

export type LayoutMap = Record<string, { x: number; y: number }>;
export type ViewportState = { x: number; y: number; zoom: number };

/**
 * Reads stored node positions, preferring the documented `metadata.ui.layout`
 * array. Falls back to the older flat `metadata.layout` map that earlier
 * builds of the editor wrote, so flows saved before this migration still
 * round-trip their arrangement instead of snapping back to auto-layout.
 */
function layoutOf(def: FlowDefinition): LayoutMap {
  const uiLayout = def.metadata?.ui?.layout;
  if (Array.isArray(uiLayout)) {
    const map: LayoutMap = {};
    for (const entry of uiLayout) map[entry.id] = { x: entry.x, y: entry.y };
    return map;
  }
  const legacy = def.metadata?.["layout"];
  if (legacy !== null && typeof legacy === "object") {
    return legacy as LayoutMap;
  }
  return {};
}

function viewportOf(def: FlowDefinition): ViewportState | undefined {
  return def.metadata?.ui?.viewport;
}

/**
 * Reads `metadata.$includeOrigins` (`nodeId -> relative sub-flow path`) — set
 * by the backend loader when a flow was composed via `metadata.$include.subflows`
 * (see `src/graph/flow-parser/normalize.ts`). Lets the Studio builder show
 * which nodes live in a separate sub-flow file and, on save, keep them there
 * instead of the write endpoint flattening everything into the parent file.
 */
function nodeOriginsOf(def: FlowDefinition): Record<string, string> | undefined {
  const raw = def.metadata?.["$includeOrigins"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, string>;
}

/** FlowDefinition → React Flow graph (positions from metadata.ui.layout or auto). */
export function flowToGraph(def: FlowDefinition): {
  nodes: RFNode[];
  edges: RFEdge[];
  viewport?: ViewportState;
  nodeOrigins?: Record<string, string>;
} {
  const layout = layoutOf(def);
  const nodes: RFNode[] = def.nodes.map((n, i) => ({
    id: n.id,
    type: "flowNode",
    position: layout[n.id] ?? autoPosition(i),
    data: { flowNode: n },
  }));
  const edges: RFEdge[] = def.edges.map((e, i) => ({
    id: e.id ?? `e${i}-${e.source}-${e.target}`,
    source: e.source,
    target: e.target,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.conditions !== undefined &&
    e.conditions.length > 0 &&
    e.label === undefined
      ? { label: e.conditions }
      : {}),
    data: {
      ...(e.conditions !== undefined ? { conditions: e.conditions } : {}),
    },
  }));
  const viewport = viewportOf(def);
  const nodeOrigins = nodeOriginsOf(def);
  return {
    nodes,
    edges,
    ...(viewport !== undefined ? { viewport } : {}),
    ...(nodeOrigins !== undefined ? { nodeOrigins } : {}),
  };
}

/**
 * React Flow graph → FlowDefinition. Preserves the base flow's id/name/etc and
 * writes the current node positions (+ optional viewport) back into
 * `metadata.ui.layout` / `metadata.ui.viewport`. The legacy flat
 * `metadata.layout` key (if present from an older save) is dropped once the
 * flow round-trips through here, completing the migration for that flow.
 */
export function graphToFlow(
  base: Pick<FlowDefinition, "id" | "name" | "description" | "metadata">,
  nodes: RFNode[],
  edges: RFEdge[],
  viewport?: ViewportState,
  nodeOrigins?: Record<string, string>,
): FlowDefinition {
  const layout: UiNodeLayout[] = nodes.map((n) => ({
    id: n.id,
    x: Math.round(n.position.x),
    y: Math.round(n.position.y),
  }));

  const {
    layout: _legacyLayout,
    $includeOrigins: _staleOrigins,
    ...restMetadata
  } = base.metadata ?? {};
  void _legacyLayout;
  void _staleOrigins;

  // Drop origin entries for nodes no longer on the canvas (deleted since load).
  const presentIds = new Set(nodes.map((n) => n.id));
  const origins =
    nodeOrigins !== undefined
      ? Object.fromEntries(
          Object.entries(nodeOrigins).filter(([id]) => presentIds.has(id)),
        )
      : undefined;

  return {
    id: base.id,
    name: base.name,
    ...(base.description !== undefined
      ? { description: base.description }
      : {}),
    nodes: nodes.map((n) => n.data.flowNode),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.data.conditions !== undefined && e.data.conditions.length > 0
        ? { conditions: e.data.conditions }
        : {}),
      ...(e.label !== undefined && e.label !== e.data.conditions
        ? { label: e.label }
        : {}),
    })),
    metadata: {
      ...restMetadata,
      ui: { layout, ...(viewport !== undefined ? { viewport } : {}) },
      ...(origins !== undefined && Object.keys(origins).length > 0
        ? { $includeOrigins: origins }
        : {}),
    },
  };
}

/** A blank node of the given type with a unique id among `existing`. */
export function makeNode(type: NodeType, existingIds: string[]): FlowNode {
  let n = 1;
  let id = `${type}-${n}`;
  const set = new Set(existingIds);
  while (set.has(id)) {
    n += 1;
    id = `${type}-${n}`;
  }
  const node: FlowNode = { id, type };
  if (type === "llm" || type === "classifier") {
    node.llm = { provider: "openai", model: "gpt-4o-mini" };
  }
  if (type === "tool") node.tools = [];
  if (type === "classifier") {
    node.classifierSchema = {
      classKey: "intent",
      schema: {
        type: "object",
        properties: { intent: { type: "string" } },
        required: ["intent"],
      },
    };
  }
  if (type === "parallel") node.parallelNodes = [];
  return node;
}

/** A fresh empty flow scaffold for "new flow". */
export function emptyFlow(id: string): FlowDefinition {
  return {
    id,
    name: id,
    nodes: [makeNode("llm", [])],
    edges: [],
  };
}

/** A unique id derived from `wantedId`, disambiguated against `existingIds` with a "-copy"/"-copyN" suffix. */
export function uniqueId(wantedId: string, existingIds: string[]): string {
  const set = new Set(existingIds);
  if (!set.has(wantedId)) return wantedId;
  let candidate = `${wantedId}-copy`;
  let n = 2;
  while (set.has(candidate)) {
    candidate = `${wantedId}-copy${n}`;
    n += 1;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Node → NodeState (editor summary line, shared visuals with the live monitor)
// ---------------------------------------------------------------------------

/** Editor-only one-line summary shown under the node label (no live data yet). */
function nodeSubtitle(node: FlowNode): string | undefined {
  switch (node.type) {
    case "llm":
      return node.llm ? `${node.llm.provider}/${node.llm.model}` : "default LLM";
    case "tool":
      return `${node.tools?.length ?? 0} tool(s)`;
    case "classifier":
      return node.classifierSchema
        ? `→ ${node.classifierSchema.classKey}`
        : "no schema";
    case "parallel":
      return `${node.parallelNodes?.length ?? 0} parallel`;
    case "router":
      return "routes";
    case "retrieval":
      return "RAG retrieval";
    case "memory":
      return "long-term memory";
    default:
      return undefined;
  }
}

/**
 * Builds the idle (no live execution data) `NodeState` for a flow node so the
 * Studio builder can render it with `NodeCard` — the exact same presentation
 * component the live monitor uses. `status: "pending"` renders at reduced
 * opacity with no status/latency/cost chrome, which is the right default for
 * a node that hasn't run yet.
 */
export function flowNodeToNodeState(node: FlowNode): NodeState {
  return {
    id: node.id,
    label: node.label ?? node.id,
    status: "pending",
    latency_ms: null,
    nodeType: node.type,
    subtitle: nodeSubtitle(node),
  };
}

/**
 * Merges a live monitoring-derived `NodeState` (from `deriveNodeStates`) over
 * a node's idle base state. Live fields win; `subtitle`/`nodeType`/`label`
 * fall back to the base (flow-definition-derived) values when the live event
 * didn't carry them, so a node keeps its identity even before its first event
 * arrives.
 */
export function mergeLiveState(
  base: NodeState,
  live: NodeState | undefined,
): NodeState {
  if (!live) return base;
  return {
    ...base,
    ...live,
    label: live.label ?? base.label,
    nodeType: base.nodeType,
    subtitle: base.subtitle,
  };
}

// ---------------------------------------------------------------------------
// Validation-path mapping (POST /flows/validate → node/edge ids)
// ---------------------------------------------------------------------------

export interface ParsedValidationPath {
  kind: "node" | "edge" | "global";
  /** Node or edge id the issue refers to, when resolvable. */
  id?: string;
  /** Zero-based array index, when the path carries one (edges only). */
  index?: number;
}

const NODE_PATH_RE = /^nodes\[(\d+)\]\(([^)]+)\)/;
const EDGE_PATH_RE = /^edges\[(\d+)\]/;

/**
 * Parses a `ValidationIssue.path` (e.g. `nodes[2](llm-node).tools`,
 * `edges[0].conditions`, `"$"`, `"edges"`) back to the node/edge it concerns,
 * so the editor can highlight the exact offending element instead of only
 * showing a flat issue list.
 */
export function parseValidationPath(
  path: string,
  edges: RFEdge[],
): ParsedValidationPath {
  const nodeMatch = NODE_PATH_RE.exec(path);
  if (nodeMatch) {
    return { kind: "node", id: nodeMatch[2], index: Number(nodeMatch[1]) };
  }
  const edgeMatch = EDGE_PATH_RE.exec(path);
  if (edgeMatch) {
    const index = Number(edgeMatch[1]);
    return { kind: "edge", id: edges[index]?.id, index };
  }
  return { kind: "global" };
}

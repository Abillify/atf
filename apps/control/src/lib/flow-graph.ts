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
import {
  computeDagreLayout,
  EDITOR_NODE_W,
  EDITOR_NODE_H,
} from "../components/graph/GraphLayoutEngine";
import { parallelChildId } from "../types/flow";
import { TOOL_RAIL_GAP, toolRailSize } from "./tool-chips";

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
  /**
   * `syntheticId`: the edge had no `id` in the flow; ours is canvas-only.
   * `extra`: any other fields the edge carries (e.g. `_comment`), written back
   * untouched.
   */
  data: {
    conditions?: string;
    syntheticId?: boolean;
    extra?: Record<string, unknown>;
    /** Display-only overlay edge (Copilot proposal / version diff). */
    ghostKind?: "added" | "removed";
  };
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

// ---------------------------------------------------------------------------
// Reference edges — node-to-node links that live inside node fields rather
// than in `edges`: parallel fan-out children and agent-harness verifier /
// delegation targets. Display-only (never saved as edges), but without them
// those nodes float unconnected on the canvas and auto-layout can't place them.
// ---------------------------------------------------------------------------

export type ReferenceKind = "parallel" | "verifies" | "delegates";

export interface ReferenceEdge {
  id: string;
  source: string;
  target: string;
  kind: ReferenceKind;
  label: string;
}

export function referenceEdges(nodes: FlowNode[]): ReferenceEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const out: ReferenceEdge[] = [];
  const push = (source: string, target: string, kind: ReferenceKind, label: string) => {
    if (!ids.has(target) || source === target) return;
    out.push({ id: `ref-${kind}-${source}-${target}`, source, target, kind, label });
  };
  for (const n of nodes) {
    for (const entry of n.parallelNodes ?? []) {
      const cond = typeof entry === "string" ? undefined : entry.condition;
      push(n.id, parallelChildId(entry), "parallel", cond ? `parallel if ${cond}` : "parallel");
    }
    if (n.type === "agent-harness" && n.config) {
      const verification = n.config["verification"] as { target?: unknown } | undefined;
      if (typeof verification?.target === "string") {
        push(n.id, verification.target, "verifies", "verifies");
      }
      const allowlist = n.config["allowlist"];
      if (Array.isArray(allowlist)) {
        for (const t of allowlist) {
          if (typeof t === "string") push(n.id, t, "delegates", "delegates");
        }
      }
    }
  }
  return out;
}

/** Horizontal gap between a node and the tool nodes docked to its right. */
const TOOL_GAP = 48;
/** Vertical gap between two tool nodes stacked beside the same caller. */
const TOOL_STACK_GAP = 16;

/**
 * A tool node runs INSIDE its caller for the caller's duration — a parallel
 * child, or an agent-harness worker/verifier that has no incoming flow edge of
 * its own. Its reference link docks on the caller's right edge, so the layout
 * places it to the RIGHT of the caller at the SAME height (not on a rank below
 * it, which would read as "runs after the caller"). A referenced node that is
 * ALSO wired in with a real edge is an ordinary step and keeps its rank.
 */
function toolNodesByCaller(
  refs: ReferenceEdge[],
  realTargets: Set<string>,
): Map<string, string[]> {
  const byCaller = new Map<string, string[]>();
  const claimed = new Set<string>();
  for (const r of refs) {
    if (realTargets.has(r.target) || claimed.has(r.target)) continue;
    claimed.add(r.target); // one caller owns a tool node's placement
    byCaller.set(r.source, [...(byCaller.get(r.source) ?? []), r.target]);
  }
  return byCaller;
}

/**
 * Hierarchical auto-layout for the editor canvas.
 *
 * The vertical structure follows the run: real edges rank the graph top→bottom.
 * Tool nodes (parallel children, harness workers/verifier with no incoming
 * edge) do NOT get a rank of their own — they run during their caller's
 * execution, so they are docked to the RIGHT of the caller at the same height,
 * stacked vertically when a caller has several. This mirrors the right→left
 * tool handles the canvas draws and reads as "runs alongside", not "runs
 * after".
 */
export function layoutEditorGraph(
  nodes: FlowNode[],
  edges: Array<{ source: string; target: string; label?: string }>,
  sizes?: Map<string, { width: number; height: number }>,
  /** Node id → sub-flow file: its nodes are laid out as one group. */
  origins?: Record<string, string>,
): LayoutMap {
  const refs = referenceEdges(nodes);
  const realTargets = new Set(edges.map((e) => e.target));
  // Tool nodes are placed beside their caller, so they are excluded from the
  // ranked graph entirely (no reference edge feeds Dagre for them).
  const toolByCaller = toolNodesByCaller(refs, realTargets);
  const toolNodes = new Set([...toolByCaller.values()].flat());

  const sizeOf = (id: string): { width: number; height: number } =>
    sizes?.get(id) ?? { width: EDITOR_NODE_W, height: EDITOR_NODE_H };

  // Geometry of a caller's tool stack (docked to its right): the widest tool,
  // and the summed height of the stack incl. gaps.
  const toolStack = (caller: string): { width: number; height: number } => {
    const tools = toolByCaller.get(caller) ?? [];
    if (tools.length === 0) return { width: 0, height: 0 };
    const width = Math.max(...tools.map((t) => sizeOf(t).width));
    const height =
      tools.reduce((s, t) => s + sizeOf(t).height, 0) +
      TOOL_STACK_GAP * (tools.length - 1);
    return { width, height };
  };

  // Reserve the space a caller's tool stack needs by laying the caller out at
  // an ENLARGED size (its box + gap + the tool column). Dagre then keeps its
  // neighbours clear of that whole footprint, so tools never overlap other
  // nodes — the bug of placing them blindly after the fact.
  const laidOutIds = nodes.map((n) => n.id).filter((id) => !toolNodes.has(id));
  // The row of tool chips a node with `tools:` gets on its right (FlowCanvas)
  // takes room beside it as well; tool nodes stack after that row.
  const toolsOf = new Map(nodes.map((n) => [n.id, [...new Set(n.tools ?? [])]]));
  const railOf = (id: string): { width: number; height: number } => toolRailSize(toolsOf.get(id) ?? []);
  const railWidth = (id: string): number => {
    const w = railOf(id).width;
    return w > 0 ? TOOL_RAIL_GAP + w : 0;
  };
  const dagreSizes = new Map<string, { width: number; height: number }>();
  for (const id of laidOutIds) {
    const base = sizeOf(id);
    const stack = toolStack(id);
    dagreSizes.set(id, {
      width: base.width + railWidth(id) + (stack.width > 0 ? TOOL_GAP + stack.width : 0),
      // The tool column is centred on the node, so it may reach above and below it.
      height: Math.max(base.height, stack.height, railOf(id).height),
    });
  }

  const positions = computeDagreLayout(
    laidOutIds,
    edges.filter((e) => !toolNodes.has(e.source) && !toolNodes.has(e.target)),
    {
      sizes: dagreSizes,
      ...(origins && Object.keys(origins).length > 0
        ? { clusters: new Map(Object.entries(origins).filter(([id]) => !toolNodes.has(id))) }
        : {}),
      defaultSize: { width: EDITOR_NODE_W, height: EDITOR_NODE_H },
      nodesep: 40,
      ranksep: 70,
      labelSize: { width: 190, height: 16 },
    },
  );

  // `positions` gives the top-left of each caller's ENLARGED footprint. Place
  // the caller vertically centred at the left of that box, and stack its tools
  // to the right — both inside the reserved area, so nothing collides.
  const layout: LayoutMap = {};
  for (const [id, box] of positions) {
    const base = sizeOf(id);
    const stack = toolStack(id);
    const footprintH = Math.max(base.height, stack.height, railOf(id).height);
    layout[id] = { x: box.x, y: box.y + (footprintH - base.height) / 2 };

    const tools = toolByCaller.get(id) ?? [];
    if (tools.length === 0) continue;
    const x = box.x + base.width + railWidth(id) + TOOL_GAP;
    let y = box.y + (footprintH - stack.height) / 2;
    for (const t of tools) {
      layout[t] = { x, y };
      y += sizeOf(t).height + TOOL_STACK_GAP;
    }
  }

  // Any node the ranked layout didn't place (e.g. a tool node whose caller was
  // itself excluded) falls back to a deterministic grid slot.
  nodes.forEach((n, i) => {
    if (layout[n.id] === undefined) layout[n.id] = autoPosition(i);
  });

  return layout;
}
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
  const stored = layoutOf(def);
  // No (or incomplete) stored arrangement → lay the graph out hierarchically
  // instead of dropping nodes into a fixed grid.
  const layout =
    def.nodes.length > 0 && def.nodes.some((n) => stored[n.id] === undefined)
      ? {
          ...layoutEditorGraph(
            def.nodes,
            def.edges.map((e) => ({ ...e, label: e.label ?? e.conditions })),
            undefined,
            nodeOriginsOf(def),
          ),
          ...stored,
        }
      : stored;
  const nodes: RFNode[] = def.nodes.map((n, i) => ({
    id: n.id,
    type: "flowNode",
    position: layout[n.id] ?? autoPosition(i),
    data: { flowNode: n },
  }));
  const edges: RFEdge[] = def.edges.map((e, i) => {
    const {
      id: _id,
      source: _source,
      target: _target,
      conditions: _conditions,
      label: _label,
      ...extra
    } = e as FlowEdge & Record<string, unknown>;
    void _id;
    void _source;
    void _target;
    void _conditions;
    void _label;
    return {
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
      ...(e.id === undefined ? { syntheticId: true } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    },
    };
  });
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
  base: Pick<FlowDefinition, "id" | "name" | "description" | "metadata"> &
    Partial<FlowDefinition>,
  nodes: RFNode[],
  edges: RFEdge[],
  viewport?: ViewportState,
  nodeOrigins?: Record<string, string>,
  /**
   * Write `metadata.ui` (positions + viewport). The Studio skips it for a file
   * flow that never had a stored layout and whose nodes weren't moved — the
   * canvas lays such flows out deterministically, and adding the block would
   * be the only change to an otherwise untouched file.
   */
  includeLayout = true,
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

  // Carry every other top-level field (variables, pricing, dataClasses,
  // recovery, …) through unchanged — the canvas only owns nodes, edges and the
  // UI metadata, and dropping the rest on save would silently break the flow.
  const {
    nodes: _baseNodes,
    edges: _baseEdges,
    metadata: _baseMetadata,
    description,
    ...restTopLevel
  } = base;
  void _baseNodes;
  void _baseEdges;
  void _baseMetadata;

  return {
    ...restTopLevel,
    id: base.id,
    name: base.name,
    ...(description !== undefined ? { description } : {}),
    nodes: nodes.map((n) => n.data.flowNode),
    edges: edges.map((e) => ({
      ...(e.data?.extra ?? {}),
      ...(e.data?.syntheticId ? {} : { id: e.id }),
      source: e.source,
      target: e.target,
      ...(e.data.conditions !== undefined && e.data.conditions.length > 0
        ? { conditions: e.data.conditions }
        : {}),
      ...(e.label !== undefined && e.label !== e.data.conditions
        ? { label: e.label }
        : {}),
    })),
    ...(() => {
      const metadata = {
        ...restMetadata,
        ...(includeLayout
          ? { ui: { layout, ...(viewport !== undefined ? { viewport } : {}) } }
          : {}),
        ...(origins !== undefined && Object.keys(origins).length > 0
          ? { $includeOrigins: origins }
          : {}),
      };
      // Don't invent an empty `metadata: {}` for a flow that has none.
      return base.metadata !== undefined || Object.keys(metadata).length > 0
        ? { metadata }
        : {};
    })(),
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
  // No `llm` block: a node without one runs on the runtime's DEFAULT_LLM, which
  // is guaranteed to be configured — unlike any provider/model we could guess
  // here. The operator picks a shortcut or model in the properties panel.
  const node: FlowNode = { id, type };
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
      if (node.llm?.shortcut) return `⇢ ${node.llm.shortcut}`;
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

// ---------------------------------------------------------------------------
// Node references held in node settings (rename / delete)
// ---------------------------------------------------------------------------

/** Valid node id: what the runtime accepts and what reads well in YAML. */
export const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Rewrites every reference to `oldId` held INSIDE node settings — parallel
 * children and agent-harness `allowlist` / `consequentialTargets` /
 * `verification.target` — to `newId`, or removes it when `newId` is null
 * (node deleted). Edges are not touched here. Returns the updated nodes and a
 * human-readable list of what changed (for the status line).
 */
export function rewriteNodeReferences(
  nodes: FlowNode[],
  oldId: string,
  newId: string | null,
): { nodes: FlowNode[]; changes: string[] } {
  const changes: string[] = [];
  const out = nodes.map((node) => {
    let next = node;

    if (node.parallelNodes?.some((e) => parallelChildId(e) === oldId)) {
      const entries = node.parallelNodes.flatMap((e) => {
        if (parallelChildId(e) !== oldId) return [e];
        if (newId === null) return [];
        return [typeof e === "string" ? newId : { ...e, node: newId }];
      });
      next = { ...next, parallelNodes: entries };
      changes.push(`${node.id}.parallelNodes`);
    }

    const config = node.config;
    if (node.type === "agent-harness" && config) {
      let cfg: Record<string, unknown> = config;
      for (const key of ["allowlist", "consequentialTargets"] as const) {
        const list = cfg[key];
        if (Array.isArray(list) && list.includes(oldId)) {
          const updated =
            newId === null
              ? list.filter((x) => x !== oldId)
              : list.map((x) => (x === oldId ? newId : x));
          cfg = { ...cfg, [key]: updated };
          changes.push(`${node.id}.config.${key}`);
        }
      }
      const verification = cfg["verification"] as { target?: unknown } | undefined;
      if (verification?.target === oldId) {
        if (newId === null) {
          const { verification: _v, ...rest } = cfg;
          void _v;
          cfg = rest;
          changes.push(`${node.id}.config.verification (removed — its target was deleted)`);
        } else {
          cfg = { ...cfg, verification: { ...verification, target: newId } };
          changes.push(`${node.id}.config.verification.target`);
        }
      }
      if (cfg !== config) next = { ...next, config: cfg };
    }
    return next;
  });
  return { nodes: out, changes };
}

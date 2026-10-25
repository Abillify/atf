"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * GraphVisualizer — thin composition layer.
 *
 * Orchestrates:
 *   - computeDagreLayout / computeChronologicalLayout  (GraphLayoutEngine)
 *   - CustomNode                                        (NodeRenderer)
 *   - GraphLegend                                       (GraphLegend)
 *   - NodeDetailPanel                                   (NodeDetailPanel)
 *
 * All heavy logic lives in the submodules; this file wires them together and
 * owns the React Flow canvas.
 *
 */

import { useMemo, useState, useCallback, useEffect } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  getBezierPath,
  useViewport,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { NodeExecutionEvent } from "../types/monitoring";
import type { FlowDefinition } from "../types/flow";
import { parallelChildId, resolveVarsInString } from "../types/flow";
import type { PendingApproval, ResolvedApproval } from "../types/control";

// Sub-module imports
import {
  computeDagreLayout,
  computeChronologicalLayout,
  NODE_W,
  type LayoutTiming,
  type LayoutMeta,
} from "./graph/GraphLayoutEngine";
import { CustomNode, type CustomNodeData } from "./graph/NodeRenderer";
import { GraphLegend } from "./graph/GraphLegend";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { useThrottledValue } from "../hooks/useThrottledValue";
import {
  nodeTypeHex,
  deriveNodeStates,
  mergeDebugTraceIntoNodeStates,
  type NodeVisualType,
  type NodeState,
  type ApprovalState,
} from "./graph/graphUtils";
import type { DebugTrace } from "../types/debug-trace";
import { translate } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Public props — must not change (Req 11.2)
// ---------------------------------------------------------------------------

export interface GraphVisualizerProps {
  events: NodeExecutionEvent[];
  /** Optional flow definition — when provided, edges come from the real topology */
  flowDefinition?: FlowDefinition | null;
  /** Pending tool approvals for the displayed execution (rendered as a blue ring). */
  pendingApprovals?: PendingApproval[];
  /** Resolved tool approvals for the displayed execution (green=approved, red=denied). */
  resolvedApprovals?: ResolvedApproval[];
  /** Callback fired when a node is selected/deselected (lifted state for combined sidebar). */
  onNodeSelect?: (node: NodeState | null) => void;
  /** Externally controlled selected node (when managed by parent). */
  selectedNodeExternal?: NodeState | null;
  /**
   * Full debug trace of the displayed execution (optional). Enriches node
   * states with the structured error recording — error type/details,
   * diagnostics timeline, failing tool results — that the SSE event stream
   * does not carry. Node status always stays event-derived; the trace only
   * adds detail. Null/undefined (evicted, loading, failed) degrades to the
   * plain event-derived view.
   */
  debugTrace?: DebugTrace | null;
}

/** "flow" = Dagre top-down layout; "timeline" = chronological waterfall */
type ViewMode = "flow" | "timeline";

/** Reserved node IDs for the synthetic request/response boundary nodes. */
const REQUEST_NODE_ID = "__request__";
const RESPONSE_NODE_ID = "__response__";

/** Friendly labels for the synthetic boundary nodes. */
function boundaryLabel(id: string): string | undefined {
  if (id === REQUEST_NODE_ID) return "📥 Request";
  if (id === RESPONSE_NODE_ID) return "📤 Response";
  return undefined;
}

// ---------------------------------------------------------------------------
// Node state derivation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Approval state derivation
// ---------------------------------------------------------------------------

/**
 * Folds pending + resolved approvals into a single state per node id.
 * Precedence (highest first): pending > rejected > approved.
 */
function deriveApprovalStates(
  pending: PendingApproval[],
  resolved: ResolvedApproval[],
): Map<string, ApprovalState> {
  const rank: Record<ApprovalState, number> = {
    approved: 0,
    rejected: 1,
    pending: 2,
  };
  const map = new Map<string, ApprovalState>();
  const consider = (nodeId: string | undefined, s: ApprovalState): void => {
    if (!nodeId) return;
    const cur = map.get(nodeId);
    if (cur === undefined || rank[s] > rank[cur]) map.set(nodeId, s);
  };
  for (const r of resolved)
    consider(r.nodeId, r.approved ? "approved" : "rejected");
  for (const p of pending) consider(p.nodeId, "pending");
  return map;
}

// ---------------------------------------------------------------------------
// Traversal detection — routing-decision-aware
// ---------------------------------------------------------------------------

function buildTraversedEdges(
  nodeStates: Map<string, NodeState>,
  topologyEdges: Array<{
    source: string;
    target: string;
    boundary?: boolean;
    parallel?: boolean;
    tool?: boolean;
  }>,
): Set<string> {
  const routerChoices = new Map<string, string>();
  for (const [id, st] of nodeStates) {
    if (st.routing_decision?.target) {
      routerChoices.set(id, st.routing_decision.target);
    }
  }

  const traversed = new Set<string>();
  const isBoundary = (id: string) =>
    id === REQUEST_NODE_ID || id === RESPONSE_NODE_ID;
  const ran = (id: string) => {
    const s = nodeStates.get(id)?.status;
    return s != null && s !== "pending";
  };

  for (const e of topologyEdges) {
    const key = `${e.source}->${e.target}`;
    if (e.boundary || e.tool || e.parallel) {
      const relevantIds = [e.source, e.target].filter((id) => !isBoundary(id));
      if (relevantIds.every(ran)) traversed.add(key);
      continue;
    }
    if (routerChoices.has(e.source)) {
      if (routerChoices.get(e.source) === e.target) {
        traversed.add(key);
      }
      continue;
    }
    const relevantIds = [e.source, e.target].filter((id) => !isBoundary(id));
    if (relevantIds.every(ran)) traversed.add(key);
  }
  return traversed;
}

// ---------------------------------------------------------------------------
// Node type resolution
// ---------------------------------------------------------------------------

/** Matcher for runtime-expanded RAG child ids: `${parentId}:rag:${i}:${coll}`. */
const DYNAMIC_RAG_CHILD_RE = /^.+:rag:\d+:.+$/;

function resolveNodeType(
  id: string,
  state: NodeState,
  flowDefinition: FlowDefinition | null | undefined,
): NodeVisualType {
  if (id === REQUEST_NODE_ID || id === RESPONSE_NODE_ID) return "boundary";
  if (state.kind === "tool") return "tool";
  if (DYNAMIC_RAG_CHILD_RE.test(id)) return "retrieval";
  const flowNode = flowDefinition?.nodes.find((n) => n.id === id);
  if (flowNode) return flowNode.type;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Sequence edge
// ---------------------------------------------------------------------------

type SequenceEdgeType = Edge<{ executionOrder?: number; animated?: boolean }>;

function SequenceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps<SequenceEdgeType>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const order = data?.executionOrder;

  return (
    <>
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
        style={style}
      />
      {order != null && (
        <foreignObject
          x={labelX - 12}
          y={labelY - 12}
          width={24}
          height={24}
          className="overflow-visible"
        >
          <div className="flex items-center justify-center w-5 h-5 rounded-full bg-accent text-accent-foreground text-[10px] font-bold border border-accent shadow-sm">
            {order}
          </div>
        </foreignObject>
      )}
    </>
  );
}

const nodeTypes = { custom: CustomNode };
const edgeTypes = { sequence: SequenceEdge };

// ---------------------------------------------------------------------------
// View-mode toggle toolbar
// ---------------------------------------------------------------------------

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-0 rounded-full border border-border bg-card shadow-sm overflow-hidden text-xs font-medium">
      <button type="button"
        onClick={() => onChange("flow")}
        className={`px-3 py-1.5 transition-colors ${
          mode === "flow"
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted"
        }`}
        title={translate("graphVisualizer.topDownFlowLayoutIntuitive")}
      >
        {translate("graphVisualizer.flow")}
      </button>
      <button type="button"
        onClick={() => onChange("timeline")}
        className={`px-3 py-1.5 transition-colors ${
          mode === "timeline"
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted"
        }`}
        title={translate("graphVisualizer.chronologicalWaterfallTimeline")}
      >
        {translate("graphVisualizer.timeline")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Time ruler (timeline mode only)
// ---------------------------------------------------------------------------

function niceTickStep(rawMs: number): number {
  if (rawMs <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rawMs)));
  const norm = rawMs / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return Math.max(nice * mag, 1);
}

function formatAxisTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(s < 10 ? 2 : 1)}s`;
}

function TimeRuler({ meta }: { meta: LayoutMeta | null }) {
  const { x: vpX, zoom } = useViewport();
  if (!meta || meta.spanMs <= 0) return null;

  const { pxPerMs, spanMs } = meta;
  const stepMs = niceTickStep(spanMs / 8);
  const ticks: Array<{ ms: number; left: number }> = [];
  for (let ms = 0; ms <= spanMs + stepMs; ms += stepMs) {
    ticks.push({ ms, left: vpX + ms * pxPerMs * zoom });
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-full overflow-hidden">
      {ticks.map(({ ms, left }) => (
        <div
          key={ms}
          className="absolute top-0 h-full border-l border-dashed border-border"
          style={{ left }}
        >
          <span className="absolute left-1 top-0.5 whitespace-nowrap rounded bg-card/70 px-1 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
            {formatAxisTime(ms)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main GraphVisualizer
// ---------------------------------------------------------------------------

/**
 * Throttle window (ms) for re-deriving the graph layout from `events`. A
 * token-by-token LLM stream can emit many SSE events per second; without this,
 * every one re-ran the full Dagre layout + React Flow node/edge rebuild (see
 * `useThrottledValue`'s doc comment for the full rationale). 150ms keeps the
 * graph visibly responsive (roughly 6-7 layout passes/sec at most) while
 * collapsing the vast majority of intra-token updates.
 */
const GRAPH_THROTTLE_MS = 150;

export function GraphVisualizer({
  events,
  flowDefinition,
  pendingApprovals,
  resolvedApprovals,
  onNodeSelect,
  selectedNodeExternal,
  debugTrace,
}: GraphVisualizerProps) {
  const [selectedNodeInternal, setSelectedNodeInternal] =
    useState<NodeState | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("flow");
  // Layout derivation (below) is throttled; the "keep selected node in sync"
  // effect further down intentionally uses the RAW `events` so the detail
  // panel for an already-selected node still updates every event, not just on
  // the throttled cadence — only the expensive graph-wide layout is throttled.
  const throttledEvents = useThrottledValue(events, GRAPH_THROTTLE_MS);

  // Use external state when provided, otherwise internal
  const selectedNode =
    selectedNodeExternal !== undefined
      ? selectedNodeExternal
      : selectedNodeInternal;
  const setSelectedNode = useCallback(
    (node: NodeState | null) => {
      if (onNodeSelect) {
        onNodeSelect(node);
      } else {
        setSelectedNodeInternal(node);
      }
    },
    [onNodeSelect],
  );

  const handleNodeClick = useCallback(
    (state: NodeState) => {
      setSelectedNode(selectedNode?.id === state.id ? null : state);
    },
    [setSelectedNode, selectedNode],
  );

  const { rfNodes, rfEdges, layoutMeta } = useMemo(() => {
    const nodeStates = mergeDebugTraceIntoNodeStates(
      deriveNodeStates(throttledEvents),
      debugTrace,
    );
    const approvalStates = deriveApprovalStates(
      pendingApprovals ?? [],
      resolvedApprovals ?? [],
    );

    const allNodeIds: string[] = [];
    for (const [id, state] of nodeStates) {
      if (state.status !== "pending") allNodeIds.push(id);
    }

    // Build topology edges
    const topologyEdges: Array<{
      source: string;
      target: string;
      parallel?: boolean;
      boundary?: boolean;
      tool?: boolean;
    }> = flowDefinition
      ? flowDefinition.edges
          .filter(
            (e) =>
              allNodeIds.includes(e.source) && allNodeIds.includes(e.target),
          )
          .map((e) => ({ source: e.source, target: e.target }))
      : buildExecutionEdges(allNodeIds, nodeStates);

    // Static parallel fan-out edges
    if (flowDefinition) {
      for (const n of flowDefinition.nodes) {
        if (n.type === "parallel" && n.parallelNodes) {
          for (const entry of n.parallelNodes) {
            const childId = parallelChildId(entry);
            if (allNodeIds.includes(n.id) && allNodeIds.includes(childId)) {
              topologyEdges.push({
                source: n.id,
                target: childId,
                parallel: true,
              });
            }
          }
        }
      }
    }

    // Dynamic RAG child edges
    {
      const existingEdgeKeys = new Set(
        topologyEdges.map((e) => `${e.source}->${e.target}`),
      );
      const DYNAMIC_RAG_CHILD = /^(.+):rag:\d+:.+$/;
      for (const id of allNodeIds) {
        if (nodeStates.get(id)?.kind === "tool") continue;
        const match = DYNAMIC_RAG_CHILD.exec(id);
        if (match === null) continue;
        const parentId = match[1];
        if (!allNodeIds.includes(parentId)) continue;
        const key = `${parentId}->${id}`;
        if (existingEdgeKeys.has(key)) continue;
        existingEdgeKeys.add(key);
        topologyEdges.push({ source: parentId, target: id, parallel: true });
      }
    }

    // Tool-call node edges
    {
      const existingEdgeKeys = new Set(
        topologyEdges.map((e) => `${e.source}->${e.target}`),
      );
      for (const [id, st] of nodeStates) {
        if (st.kind !== "tool" || !st.parent_node_id) continue;
        if (!allNodeIds.includes(st.parent_node_id)) continue;
        const key = `${st.parent_node_id}->${id}`;
        if (existingEdgeKeys.has(key)) continue;
        existingEdgeKeys.add(key);
        topologyEdges.push({
          source: st.parent_node_id,
          target: id,
          tool: true,
        });
      }
    }

    // Boundary edges
    if (flowDefinition) {
      const parallelChildIds = new Set<string>();
      for (const n of flowDefinition.nodes) {
        if (n.type === "parallel" && n.parallelNodes) {
          for (const c of n.parallelNodes)
            parallelChildIds.add(parallelChildId(c));
        }
      }
      const hasIncoming = new Set<string>();
      const hasOutgoing = new Set<string>();
      for (const e of flowDefinition.edges) {
        hasIncoming.add(e.target);
        hasOutgoing.add(e.source);
      }
      const flowIds = flowDefinition.nodes
        .map((n) => n.id)
        .filter((id) => !parallelChildIds.has(id));
      if (nodeStates.has(REQUEST_NODE_ID)) {
        for (const id of flowIds) {
          if (!hasIncoming.has(id)) {
            topologyEdges.push({
              source: REQUEST_NODE_ID,
              target: id,
              boundary: true,
            });
          }
        }
      }
      if (nodeStates.has(RESPONSE_NODE_ID)) {
        for (const id of flowIds) {
          if (!hasOutgoing.has(id)) {
            topologyEdges.push({
              source: id,
              target: RESPONSE_NODE_ID,
              boundary: true,
            });
          }
        }
      }
    }

    const traversedKeys = buildTraversedEdges(nodeStates, topologyEdges);

    // Compute positions
    let positions: Map<
      string,
      { x: number; y: number; width?: number; barWidth?: number }
    >;
    let layoutMeta: LayoutMeta | null = null;

    // Layout-only ranking edges: make a parallel/context-assembler node's real
    // successor (e.g. the LLM responder) rank BELOW its dynamic RAG child
    // nodes — matching the mental model that the assembler waits for all
    // retrievals before handing off. These influence Dagre ranking only; they
    // are never rendered as visible edges.
    const layoutEdges: Array<{ source: string; target: string }> = [
      ...topologyEdges,
    ];
    {
      const isRagChild = (id: string) => DYNAMIC_RAG_CHILD_RE.test(id);
      const ragChildParent = /^(.+):rag:\d+:.+$/;
      const ragParents = new Map<string, string[]>();
      for (const id of allNodeIds) {
        const m = ragChildParent.exec(id);
        if (m) {
          const p = m[1];
          const arr = ragParents.get(p) ?? [];
          arr.push(id);
          ragParents.set(p, arr);
        }
      }
      for (const [parentId, children] of ragParents) {
        const successors = topologyEdges
          .filter(
            (e) =>
              e.source === parentId &&
              !isRagChild(e.target) &&
              nodeStates.get(e.target)?.kind !== "tool",
          )
          .map((e) => e.target);
        for (const child of children) {
          for (const succ of successors) {
            layoutEdges.push({ source: child, target: succ });
          }
        }
      }
    }

    if (viewMode === "flow") {
      const dagrePos = computeDagreLayout(allNodeIds, layoutEdges);
      positions = new Map(
        [...dagrePos.entries()].map(([id, pos]) => [
          id,
          { x: pos.x, y: pos.y, width: NODE_W, barWidth: 0 },
        ]),
      );
    } else {
      const layoutTimings: LayoutTiming[] = allNodeIds.map((id) => {
        const st = nodeStates.get(id);
        const parseIso = (iso: string | null | undefined): number | null => {
          if (!iso) return null;
          const t = Date.parse(iso);
          return Number.isNaN(t) ? null : t;
        };
        const start = parseIso(st?.start_time);
        let end = parseIso(st?.end_time);
        if (end == null && start != null && st?.latency_ms != null) {
          end = start + st.latency_ms;
        }
        if (end == null) end = start;
        return { id, start, end };
      });
      const result = computeChronologicalLayout(layoutTimings);
      positions = result.positions as Map<
        string,
        { x: number; y: number; width?: number; barWidth?: number }
      >;
      layoutMeta = result.meta;
    }

    const execOrder = buildExecutionOrder(throttledEvents);

    // Build React Flow nodes
    const nodes: Node<CustomNodeData>[] = allNodeIds.map((id) => {
      const state: NodeState = nodeStates.get(id) ?? {
        id,
        label: id,
        status: "pending",
        latency_ms: null,
      };
      if (flowDefinition) {
        const flowNode = flowDefinition.nodes.find((n) => n.id === id);
        if (flowNode?.label) {
          state.label = resolveVarsInString(
            flowNode.label,
            flowDefinition.variables,
          );
        }
      }
      // Best-effort cleanup for any placeholder `resolveVarsInString` could not
      // resolve — e.g. the flow topology match picked the wrong variant, the
      // definition hasn't loaded yet, or the variable is genuinely undeclared.
      // A dashboard must never surface raw `{{...}}` template syntax to the
      // operator. Prefer the node's own ACTUAL resolved model for this
      // execution (set server-side from the real LLM call, so it reflects the
      // per-request value even when variable overrides changed it) before
      // falling back to stripping the placeholder outright.
      if (state.label.includes("{{")) {
        if (state.model) {
          const model = state.model;
          // Function replacement (not a string) so a model id containing `$`
          // is never interpreted as a `$&`/`$1` replacement pattern.
          state.label = state.label.replace(
            /\{\{\s*vars\.\S*?\}\}/g,
            () => model,
          );
        }
        state.label = state.label.replace(/\{\{\s*[^{}]*?\}\}/g, "…");
      }
      const bl = boundaryLabel(id);
      if (bl) state.label = bl;
      const approval = approvalStates.get(id);
      if (approval) state.approval = approval;
      state.nodeType = resolveNodeType(id, state, flowDefinition);

      const pos = positions.get(id) ?? {
        x: 0,
        y: 0,
        width: NODE_W,
        barWidth: 0,
      };
      return {
        id,
        type: "custom",
        position: { x: pos.x, y: pos.y },
        style: { width: pos.width ?? NODE_W },
        data: {
          state,
          onClick: handleNodeClick,
          barWidth: pos.barWidth ?? 0,
          isTimeline: viewMode === "timeline",
        },
      };
    });

    // Build React Flow edges
    const edges: Edge[] = topologyEdges.map((e, i) => {
      const key = `${e.source}->${e.target}`;
      const isTraversed = traversedKeys.has(key);
      const isActive =
        nodeStates.get(e.target)?.status === "running" ||
        nodeStates.get(e.source)?.status === "running";

      const order = execOrder.get(key);

      // The design tokens are HSL triplets (`215 20% 65%`), not colors: a
      // bare `var(--edge-*)` is invalid for `stroke`/marker `color` (it
      // computes to `none` → invisible edges), so wrap every token in hsl().
      const baseStroke = e.boundary
        ? "hsl(var(--edge-boundary))"
        : e.tool
          ? "hsl(var(--edge-tool))"
          : e.parallel
            ? "hsl(var(--edge-parallel-light))"
            : "hsl(var(--edge-idle))";

      const stroke = isActive
        ? "hsl(var(--edge-active))"
        : isTraversed
          ? baseStroke
          : "hsl(var(--edge-idle-soft))";
      const strokeWidth = isActive
        ? 2.5
        : isTraversed
          ? e.boundary
            ? 2
            : 1.5
          : 1;

      return {
        id: `e${i}-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        sourceHandle: e.tool ? "tool-output" : undefined,
        type: "sequence",
        animated: isActive,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: stroke,
          width: 16,
          height: 16,
        },
        style: {
          stroke,
          strokeWidth,
          ...(isTraversed ? {} : { strokeDasharray: "4 3", opacity: 0.45 }),
          ...(e.parallel || e.tool ? { strokeDasharray: "5 4" } : {}),
        },
        data: {
          executionOrder:
            e.parallel || e.boundary || e.tool ? undefined : order,
        },
      };
    });

    return { rfNodes: nodes, rfEdges: edges, layoutMeta };
  }, [
    throttledEvents,
    flowDefinition,
    pendingApprovals,
    resolvedApprovals,
    handleNodeClick,
    viewMode,
    debugTrace,
  ]);

  // Keep selected node in sync when events update
  useEffect(() => {
    if (selectedNode === null) return;
    const nodeStates = mergeDebugTraceIntoNodeStates(
      deriveNodeStates(events),
      debugTrace,
    );
    const updated = nodeStates.get(selectedNode.id);
    if (updated && JSON.stringify(updated) !== JSON.stringify(selectedNode)) {
      setSelectedNode({ ...updated });
    }
  }, [events, debugTrace, selectedNode, setSelectedNode]);

  const hasNodes = rfNodes.length > 0;

  const presentTypes = useMemo(() => {
    const set = new Set<NodeVisualType>();
    for (const n of rfNodes) {
      const t = n.data.state.nodeType;
      if (t) set.add(t);
    }
    return set;
  }, [rfNodes]);

  return (
    <div className="relative h-full w-full" style={{ minHeight: 420 }}>
      {hasNodes ? (
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.25 }}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          deleteKeyCode={null}
        >
          <Background gap={20} color="hsl(var(--canvas-dots))" />
          {viewMode === "timeline" && <TimeRuler meta={layoutMeta} />}
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) =>
              nodeTypeHex((n.data as CustomNodeData).state.nodeType)
            }
            className="!bottom-12 !right-2"
          />
        </ReactFlow>
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          {translate("graphVisualizer.noExecutionEventsYet")}
        </div>
      )}

      {hasNodes && <GraphLegend present={presentTypes} />}
      {hasNodes && <ViewToggle mode={viewMode} onChange={setViewMode} />}

      {selectedNode && !onNodeSelect && (
        <NodeDetailPanel
          state={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildExecutionEdges(
  nodeIds: string[],
  nodeStates: Map<string, NodeState>,
): Array<{ source: string; target: string }> {
  const ordered = [...nodeIds]
    .filter((id) => nodeStates.get(id)?.kind !== "tool")
    .sort(
      (a, b) =>
        (nodeStates.get(a)?.sequence ?? 999) -
        (nodeStates.get(b)?.sequence ?? 999),
    );
  const edges: Array<{ source: string; target: string }> = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    edges.push({ source: ordered[i], target: ordered[i + 1] });
  }
  return edges;
}

function buildExecutionOrder(
  events: NodeExecutionEvent[],
): Map<string, number> {
  const map = new Map<string, number>();
  const completed = events
    .filter(
      (e) =>
        e.status === "completed" && e.sequence != null && e.kind !== "tool",
    )
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));

  for (let i = 0; i < completed.length - 1; i++) {
    const key = `${completed[i].node_id}->${completed[i + 1].node_id}`;
    if (!map.has(key)) map.set(key, i + 1);
  }
  return map;
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useCallback, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type NodeProps,
  type Viewport,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { RFNode, RFEdge } from "../lib/flow-graph";
import { flowNodeToNodeState, mergeLiveState } from "../lib/flow-graph";
import type { DiffInfo, GhostRFNode } from "../lib/flow-diff-view";
import { NodeCard } from "./graph/NodeRenderer";
import { nodeTypeHex, type NodeState } from "./graph/graphUtils";
import type { NodeType, FlowNode } from "../types/flow";
import { PALETTE_DND_TYPE } from "./FlowNodePalette";

// ---------------------------------------------------------------------------
// Editable node — reuses the exact NodeCard presentation the live monitor
// uses (NodeRenderer.tsx), so an idle editor node and a running/completed
// node look like the same visual family instead of two divergent styles.
// ---------------------------------------------------------------------------

export interface NodeValidationState {
  errors: string[];
  warnings: string[];
}

export interface EdgeValidationState {
  errors: string[];
  warnings: string[];
}

// Defined as a `type` (not `interface`) so it satisfies React Flow v12's
// `Node<Data extends Record<string, unknown>>` constraint via TS's implicit
// index signature for object type aliases.
type EditableNodeData = {
  flowNode: FlowNode;
  liveState?: NodeState;
  validation?: NodeValidationState;
  /** Version-diff status for this node — added/changed (Phase 2). Ghost
   * (removed) nodes carry `ghost: true` instead, see below. */
  diff?: DiffInfo;
  /** True for a synthetic "removed in this version" node — display-only. */
  ghost?: boolean;
  /** Relative sub-flow file this node will be saved into (Phase 4, `$includeOrigins`). */
  origin?: string;
};

type EditableFlowNode = Node<EditableNodeData, "flowNode">;

const DIFF_BADGE: Record<DiffInfo["status"], { glyph: string; className: string }> = {
  added: { glyph: "+", className: "border-green-700 bg-green-500 text-white" },
  changed: { glyph: "~", className: "border-amber-600 bg-amber-400 text-amber-950" },
  removed: { glyph: "−", className: "border-red-700 bg-red-500 text-white" },
};

function EditableNode({
  data,
  selected,
}: NodeProps<EditableFlowNode>): React.JSX.Element {
  const { flowNode, liveState, validation, diff, ghost, origin } = data;
  const state = mergeLiveState(flowNodeToNodeState(flowNode), liveState);
  const hasError = (validation?.errors.length ?? 0) > 0;
  const hasWarning = !hasError && (validation?.warnings.length ?? 0) > 0;
  const validationRing = hasError
    ? "ring-2 ring-offset-1 ring-red-500"
    : hasWarning
      ? "ring-2 ring-offset-1 ring-amber-400"
      : "";
  const validationTitle = [
    ...(validation?.errors ?? []),
    ...(validation?.warnings ?? []),
  ].join("\n");
  const diffBadge = ghost ? DIFF_BADGE.removed : diff ? DIFF_BADGE[diff.status] : null;
  const diffTitle = ghost
    ? "Removed in this version"
    : (diff?.changedFields?.length ?? 0) > 0
      ? `Changed: ${diff!.changedFields!.join(", ")}`
      : diff?.status === "added"
        ? "Added in this version"
        : undefined;

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-muted-foreground"
      />
      <div
        className={`relative rounded-xl ${validationRing} ${ghost ? "opacity-50 border-2 border-dashed border-red-400" : ""}`}
        title={validationTitle || diffTitle || undefined}
      >
        <NodeCard state={state} selected={selected} isTimeline={false} />
        {(hasError || hasWarning) && (
          <div
            aria-hidden
            className={`absolute -bottom-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold shadow-sm ${
              hasError
                ? "border-red-800 bg-red-600 text-white"
                : "border-amber-600 bg-amber-400 text-amber-950"
            }`}
          >
            !
          </div>
        )}
        {diffBadge && (
          <div
            aria-hidden
            title={diffTitle}
            className={`absolute -top-2 -left-2 flex h-5 w-5 items-center justify-center rounded-full border text-[10px] font-bold shadow-sm ${diffBadge.className}`}
          >
            {diffBadge.glyph}
          </div>
        )}
        {origin && (
          <div
            aria-hidden
            title={`Saved to ${origin}`}
            className="absolute -bottom-2 -left-2 flex h-5 w-5 items-center justify-center rounded-full border border-teal-700 bg-teal-500 text-[10px] shadow-sm"
          >
            📄
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-muted-foreground"
      />
    </>
  );
}

const nodeTypes = { flowNode: EditableNode };

export interface FlowCanvasProps {
  nodes: RFNode[];
  edges: RFEdge[];
  editable?: boolean;
  onNodesChange?: (nodes: RFNode[]) => void;
  onEdgesChange?: (edges: RFEdge[]) => void;
  /** Fires whenever the set of selected nodes/edges changes — single click,
   * shift/box multi-select, ctrl/cmd-click, or pane click (both empty). */
  onSelectionChange?: (nodeIds: string[], edgeIds: string[]) => void;
  /** Canvas height. Defaults to "100%" so the graph fills its (sized) parent;
   * pass a number for a fixed pixel height. */
  height?: number | string;
  /** Live per-node execution state from an in-canvas test run (Phase 1). */
  liveStates?: Map<string, NodeState>;
  /** Inline validation issues keyed by node id (Phase 0.7). */
  nodeValidation?: Map<string, NodeValidationState>;
  /** Inline validation issues keyed by edge id. */
  edgeValidation?: Map<string, EdgeValidationState>;
  /** Version-diff status keyed by node id — added/changed (Phase 2). */
  nodeDiff?: Map<string, DiffInfo>;
  /** Version-diff status keyed by edge id — added/changed. */
  edgeDiff?: Map<string, DiffInfo>;
  /** Removed nodes from the compared "from" version, rendered read-only. */
  ghostNodes?: GhostRFNode[];
  /** Removed edges from the compared "from" version, rendered read-only. */
  ghostEdges?: RFEdge[];
  /** Node id -> relative sub-flow file path (Phase 4, `$includeOrigins`). */
  nodeOrigins?: Record<string, string>;
  /** Called when a node type is dropped from the palette onto the canvas at `position` (flow coordinates). */
  onDropNodeType?: (type: NodeType, position: { x: number; y: number }) => void;
  /** Called when the user pans/zooms, so the viewport can be persisted with the flow. */
  onViewportChange?: (viewport: Viewport) => void;
  /** Initial viewport (pan + zoom) restored from the saved flow. */
  defaultViewport?: Viewport;
}

function FlowCanvasInner({
  nodes,
  edges,
  editable = false,
  onNodesChange,
  onEdgesChange,
  onSelectionChange,
  height = "100%",
  liveStates,
  nodeValidation,
  edgeValidation,
  nodeDiff,
  edgeDiff,
  ghostNodes,
  ghostEdges,
  nodeOrigins,
  onDropNodeType,
  onViewportChange,
  defaultViewport,
}: FlowCanvasProps): React.JSX.Element {
  const { screenToFlowPosition } = useReactFlow();

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!editable || !onNodesChange) return;
      onNodesChange(
        applyNodeChanges(
          changes,
          nodes as unknown as Node[],
        ) as unknown as RFNode[],
      );
    },
    [editable, onNodesChange, nodes],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (!editable || !onEdgesChange) return;
      onEdgesChange(
        applyEdgeChanges(
          changes,
          edges as unknown as Edge[],
        ) as unknown as RFEdge[],
      );
    },
    [editable, onEdgesChange, edges],
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!editable || !onEdgesChange) return;
      const id = `e-${conn.source}-${conn.target}-${Date.now()}`;
      const next = addEdge(
        { ...conn, id, data: {} } as Edge,
        edges as unknown as Edge[],
      ) as unknown as RFEdge[];
      onEdgesChange(next);
    },
    [editable, onEdgesChange, edges],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      if (!e.dataTransfer.types.includes(PALETTE_DND_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [editable],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!editable || !onDropNodeType) return;
      const type = e.dataTransfer.getData(PALETTE_DND_TYPE) as NodeType | "";
      if (!type) return;
      e.preventDefault();
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onDropNodeType(type, position);
    },
    [editable, onDropNodeType, screenToFlowPosition],
  );

  // Stable identity for ReactFlow's onSelectionChange. Passing a fresh handler
  // here (an inline arrow, or a handler that changes identity across renders)
  // causes React Flow to re-register its selection listener on every render and
  // re-invoke it immediately; because the parent handler sets state (fresh
  // arrays) that re-render feeds the next re-registration, spinning into an
  // infinite render loop that freezes the whole page. Route the latest callback
  // through a ref so the handler we hand to React Flow never changes identity,
  // regardless of whether the caller memoizes its own `onSelectionChange`.
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const handleSelectionChange = useCallback(
    (sel: { nodes: Node[]; edges: Edge[] }) => {
      onSelectionChangeRef.current?.(
        sel.nodes.map((n) => n.id),
        sel.edges.map((e) => e.id),
      );
    },
    [],
  );

  const renderNodes = useMemo(() => {
    const real = nodes.map((n) => ({
      ...n,
      data: {
        flowNode: n.data.flowNode,
        liveState: liveStates?.get(n.id),
        validation: nodeValidation?.get(n.id),
        diff: nodeDiff?.get(n.id),
        origin: nodeOrigins?.[n.id],
      },
    }));
    if (!ghostNodes || ghostNodes.length === 0) return real;
    const ghosts = ghostNodes.map((n) => ({
      ...n,
      data: { flowNode: n.data.flowNode, ghost: true },
    }));
    return [...real, ...ghosts];
  }, [nodes, liveStates, nodeValidation, nodeDiff, nodeOrigins, ghostNodes]);

  const renderEdges = useMemo(() => {
    const real = edges.map((e) => {
      const validationState = edgeValidation?.get(e.id);
      const diffState = edgeDiff?.get(e.id);
      const hasError = (validationState?.errors.length ?? 0) > 0;
      const hasWarning = !hasError && (validationState?.warnings.length ?? 0) > 0;
      const color = hasError
        ? "#dc2626"
        : hasWarning
          ? "#f59e0b"
          : diffState?.status === "added"
            ? "#16a34a"
            : diffState?.status === "changed"
              ? "#f59e0b"
              : undefined;
      if (color === undefined) return e;
      return {
        ...e,
        style: { stroke: color, strokeWidth: 2 },
        labelStyle: { fill: color, fontWeight: 600 },
      };
    });
    if (!ghostEdges || ghostEdges.length === 0) return real;
    const ghosts = ghostEdges.map((e) => ({
      ...e,
      style: { stroke: "#f87171", strokeWidth: 2, strokeDasharray: "4 3" },
      label: e.label ?? "removed",
      labelStyle: { fill: "#dc2626", fontWeight: 600 },
      selectable: false,
    }));
    return [...real, ...ghosts];
  }, [edges, edgeValidation, edgeDiff, ghostEdges]);

  return (
    <div
      style={{ height }}
      className="rounded-lg border border-border bg-card"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={renderNodes as unknown as Node[]}
        edges={renderEdges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        multiSelectionKeyCode={["Meta", "Control"]}
        selectionKeyCode="Shift"
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onSelectionChange={handleSelectionChange}
        onMoveEnd={(_e, viewport) => onViewportChange?.(viewport)}
        {...(defaultViewport !== undefined ? { defaultViewport } : {})}
        fitView={defaultViewport === undefined}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap
          zoomable
          pannable
          nodeColor={(n) =>
            nodeTypeHex((n.data as EditableNodeData | undefined)?.flowNode?.type)
          }
          className="!bg-muted"
        />
      </ReactFlow>
    </div>
  );
}

/**
 * React Flow canvas shared by the editor. Wrapped in its own
 * `ReactFlowProvider` so `useReactFlow` (needed to translate palette
 * drag-and-drop client coordinates into flow coordinates) is available
 * without requiring the host page to set up a provider itself.
 */
export function FlowCanvas(props: FlowCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

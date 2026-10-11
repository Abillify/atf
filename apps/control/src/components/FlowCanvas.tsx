"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: FlowCanvas split up: the custom nodes (EditableNode, ToolRailNode,
// SubflowBoxNode, BoundaryNode) live in components/graph/CustomNodes.tsx,
// ids/constants in components/graph/canvasIds.ts, the overlay measurements
// and change handlers in the hook hooks/useCanvasOverlay.ts, and the canvas
// graphics (boundary layout, tool rows, renderNodes/renderEdges) in the hook
// hooks/useCanvasGraph.ts, without behavior change. The memo() wrappers of the
// custom nodes (Req 9.4) stay below with the nodeTypes table.

import type React from "react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  MiniMap,
  Panel,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Map as MapIcon,
  Maximize2,
  Network,
  Waypoints,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { RFNode, RFEdge, ReferenceEdge } from "../lib/flow-graph";
import { connectionProblem, type EdgeLike, type NodeLike } from "../lib/edge-rules";
import { useColorSchemeOrDefault } from "../lib/theme/ThemeProvider";
import { usePersistentToggle } from "../hooks/usePersistentToggle";
import type { DiffInfo, GhostRFNode } from "../lib/flow-diff-view";
import { labeledEdgeTypes } from "./graph/LabeledEdge";
import { channelLogicalEdgeId, isChannelEdgeId } from "../lib/edge-channels";
import type { EdgeFlowRecord } from "../lib/run-samples";
import {
  END_ID,
  START_ID,
  entryProblem,
  isBoundaryId,
} from "../lib/flow-boundaries";
import { nodeTypeHex, type NodeState } from "./graph/graphUtils";
import type { NodeType } from "../types/flow";
import { PALETTE_DND_TYPE } from "./FlowNodePalette";
import { SUBFLOW_DND_TYPE } from "./SubflowPalette";
import {
  BoundaryNode,
  EditableNode,
  SubflowBoxNode,
  ToolRailNode,
  type BoundaryCardInfo,
  type EdgeValidationState,
  type EditableNodeData,
  type NodeValidationState,
} from "./graph/CustomNodes";
import { isOverlayEdgeId } from "./graph/canvasIds";
import { useCanvasOverlay } from "../hooks/useCanvasOverlay";
import { useCanvasGraph } from "../hooks/useCanvasGraph";

// Req 9.3: the types stay exportable under their previous path;
// hooks (useStudioValidation, useStudioBuilder) and tests import them here.
export type { NodeValidationState, EdgeValidationState, BoundaryCardInfo };

/** Req 9.4: custom nodes are memoized, so a re-render of the canvas parents
 * (status line, validation, ...) does not re-render unchanged nodes.
 * xyflow calls nodes with stable props as long as data/selected stay the
 * same; memo makes that usable. */
const nodeTypes = {
  flowNode: memo(EditableNode),
  subflowBox: memo(SubflowBoxNode),
  boundary: memo(BoundaryNode),
  toolRail: memo(ToolRailNode),
};
/** Labels are drawn along the edge path, framed in the edge colour. */
const edgeTypes = labeledEdgeTypes;

function CanvasButton({
  label,
  title,
  onClick,
  pressed,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})}
      className={`flex items-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium hover:bg-muted ${
        pressed === false ? "text-muted-foreground" : "text-foreground"
      } ${pressed ? "bg-muted" : ""}`}
    >
      {children}
      {label && <span>{label}</span>}
    </button>
  );
}

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
  /** Called when a sub-flow file is dropped from the Subflows section onto the canvas at `position` (flow coordinates). */
  onDropSubflow?: (path: string, position: { x: number; y: number }) => void;
  /** Called when the user pans/zooms, so the viewport can be persisted with the flow. */
  onViewportChange?: (viewport: Viewport) => void;
  /** Initial viewport (pan + zoom) restored from the saved flow. */
  defaultViewport?: Viewport;
  /** Display-only links derived from node settings (parallel children, harness targets). */
  referenceEdges?: ReferenceEdge[];
  /** Shows a "Tidy up" control on the canvas when provided. */
  onAutoLayout?: () => void;
  /** Bump to re-fit the viewport (e.g. after an auto-layout). */
  fitViewNonce?: number;
  /**
   * Called when a connection the operator drew was refused because it would
   * be invalid (`lib/edge-rules.connectionProblem`) — the edge is not added.
   * `reason` is a human-readable explanation for the status line.
   */
  onInvalidConnection?: (reason: string) => void;
  /** Clicking a sub-flow's box label selects the whole group (all its nodes). */
  onSelectSubflow?: (path: string) => void;
  /** Sub-flow whose group is currently selected — its box is highlighted. */
  selectedSubflowPath?: string | null;
  /**
   * Draws the flow's Start and End (lib/flow-boundaries) with what their
   * cards show. Omit to draw neither.
   */
  boundaries?: { start: BoundaryCardInfo; end: BoundaryCardInfo };
  /** Start or End was selected (null: neither). */
  onSelectBoundary?: (kind: "start" | "end" | null) => void;
  /** A connection was drawn from Start to `nodeId`: make it the entry. */
  onSetEntry?: (nodeId: string) => void;
  /** A tool chip of `nodeId` was clicked (`tool`: the ref or called name). */
  onToolClick?: (nodeId: string, tool: string) => void;
  /**
   * Per-edge data flow of the traced run (from the debug trace): every
   * payload that crossed each edge. Rendered as colored parallel channel
   * lines beside the edge; clicking one opens the payload list in the
   * property panel. Only real runs provide these — pinned/loaded data never
   * highlights edges.
   */
  edgeFlows?: EdgeFlowRecord[];
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
  onDropSubflow,
  onViewportChange,
  defaultViewport,
  referenceEdges,
  onAutoLayout,
  fitViewNonce,
  onInvalidConnection,
  onSelectSubflow,
  selectedSubflowPath,
  boundaries,
  onSelectBoundary,
  onSetEntry,
  onToolClick,
  edgeFlows,
}: FlowCanvasProps): React.JSX.Element {
  const { screenToFlowPosition, zoomIn, zoomOut, fitView } = useReactFlow();
  const colorScheme = useColorSchemeOrDefault();
  const [showReferences, setShowReferences] = usePersistentToggle(
    "canvas.showReferences",
    true,
  );
  const [showMiniMap, setShowMiniMap] = usePersistentToggle(
    "canvas.showMiniMap",
    true,
  );

  useEffect(() => {
    if (fitViewNonce === undefined || fitViewNonce === 0) return;
    // Wait a frame so React Flow has applied the new positions first.
    const id = requestAnimationFrame(() => {
      void fitView({ padding: 0.1, duration: 300, maxZoom: 1 });
    });
    return () => cancelAnimationFrame(id);
  }, [fitViewNonce, fitView]);

  // Req 9.3: overlay measurements (ghost/boundary/tool rail) and the canvas
  // node/edge change handlers live in hooks/useCanvasOverlay.ts.
  const {
    overlaySizes,
    selectedBoundaryId,
    handleNodesChange,
    selectedChannelIds,
    handleEdgesChange,
  } = useCanvasOverlay({
    nodes,
    edges,
    editable,
    onNodesChange,
    onEdgesChange,
    ghostNodes,
    edgeFlows,
  });

  // Adapters onto the shared edge-rule model (lib/edge-rules): the flow node
  // (id/type/parallelNodes/config) and the edge's source/target/conditions are
  // all the rules look at. Reference edges (tool links) are node settings, not
  // flow edges, so they're deliberately excluded here.
  const ruleNodes = useMemo<NodeLike[]>(
    () =>
      nodes.map((n) => ({
        id: n.data.flowNode.id,
        type: n.data.flowNode.type,
        parallelNodes: n.data.flowNode.parallelNodes,
        config: n.data.flowNode.config,
      })),
    [nodes],
  );
  const ruleEdges = useMemo<EdgeLike[]>(
    () =>
      edges.map((e) => ({
        source: e.source,
        target: e.target,
        conditions: e.data?.conditions,
      })),
    [edges],
  );

  // Refuse a connection before React Flow ever draws it, so the invalid edge
  // never flashes onto the canvas. A freshly drawn edge carries no condition,
  // so the self-loop / duplicate / cycle rules (which only bind unconditional
  // edges) apply — the operator adds a condition afterwards in the panel.
  const connectionRejection = useCallback(
    (conn: Connection | Edge): string | null => {
      if (conn.source === null || conn.target === null) return null;
      // Start -> node: makes that node the entry (no edge is added).
      if (conn.source === START_ID) {
        if (!onSetEntry) return "The entry can't be changed here.";
        return entryProblem(ruleNodes, ruleEdges, conn.target, nodeOrigins);
      }
      if (conn.target === END_ID) {
        return "A run ends by itself after a node without outgoing edges — no edge to End is needed.";
      }
      return connectionProblem(ruleNodes, ruleEdges, {
        source: conn.source,
        target: conn.target,
      });
    },
    [ruleNodes, ruleEdges, onSetEntry, nodeOrigins],
  );

  const isValidConnection = useCallback(
    (conn: Connection | Edge): boolean => connectionRejection(conn) === null,
    [connectionRejection],
  );

  const handleConnect = useCallback(
    (conn: Connection) => {
      if (!editable || !onEdgesChange) return;
      const problem = connectionRejection(conn);
      if (problem !== null) {
        onInvalidConnection?.(problem);
        return;
      }
      if (conn.source === START_ID) {
        onSetEntry?.(conn.target);
        return;
      }
      const id = `e-${conn.source}-${conn.target}-${Date.now()}`;
      const next = addEdge(
        { ...conn, id, data: {} } as Edge,
        edges as unknown as Edge[],
      ) as unknown as RFEdge[];
      onEdgesChange(next);
    },
    [
      editable,
      onEdgesChange,
      edges,
      connectionRejection,
      onInvalidConnection,
      onSetEntry,
    ],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      if (
        !e.dataTransfer.types.includes(PALETTE_DND_TYPE) &&
        !e.dataTransfer.types.includes(SUBFLOW_DND_TYPE)
      )
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [editable],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      const subflowPath = e.dataTransfer.getData(SUBFLOW_DND_TYPE);
      if (subflowPath) {
        if (!onDropSubflow) return;
        e.preventDefault();
        onDropSubflow(
          subflowPath,
          screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        );
        return;
      }
      if (!onDropNodeType) return;
      const type = e.dataTransfer.getData(PALETTE_DND_TYPE) as NodeType | "";
      if (!type) return;
      e.preventDefault();
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      onDropNodeType(type, position);
    },
    [editable, onDropNodeType, onDropSubflow, screenToFlowPosition],
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
  const onSelectBoundaryRef = useRef(onSelectBoundary);
  onSelectBoundaryRef.current = onSelectBoundary;
  const handleSelectionChange = useCallback(
    (sel: { nodes: Node[]; edges: Edge[] }) => {
      // Start/End are not flow nodes: reported on their own channel.
      const boundary =
        sel.nodes.length === 1 && isBoundaryId(sel.nodes[0]!.id)
          ? sel.nodes[0]!.id
          : null;
      onSelectBoundaryRef.current?.(
        boundary === null ? null : boundary === START_ID ? "start" : "end",
      );
      // A clicked channel line reports the edge it belongs to; several
      // channels of one edge collapse to that single logical edge.
      const mapped: string[] = [];
      for (const e of sel.edges) {
        if (isChannelEdgeId(e.id)) mapped.push(channelLogicalEdgeId(e.id));
        else if (!isOverlayEdgeId(e.id)) mapped.push(e.id);
      }
      onSelectionChangeRef.current?.(
        sel.nodes.filter((n) => !isBoundaryId(n.id)).map((n) => n.id),
        [...new Set(mapped)],
      );
    },
    [],
  );

  // Req 9.3: boundary layout, tool rows, subflow boxes and the merged
  // renderNodes/renderEdges live in hooks/useCanvasGraph.ts.
  const { renderNodes, renderEdges } = useCanvasGraph({
    nodes,
    edges,
    editable,
    liveStates,
    nodeValidation,
    edgeValidation,
    nodeDiff,
    edgeDiff,
    ghostNodes,
    ghostEdges,
    nodeOrigins,
    referenceEdges,
    showReferences,
    boundaries,
    selectedSubflowPath,
    onSelectSubflow,
    onToolClick,
    edgeFlows,
    ruleNodes,
    ruleEdges,
    overlaySizes,
    selectedBoundaryId,
    selectedChannelIds,
  });

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
        edgeTypes={edgeTypes}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        multiSelectionKeyCode={["Meta", "Control"]}
        selectionKeyCode="Shift"
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        isValidConnection={isValidConnection}
        onSelectionChange={handleSelectionChange}
        onMoveEnd={(_e, viewport) => onViewportChange?.(viewport)}
        {...(defaultViewport !== undefined ? { defaultViewport } : {})}
        fitView={defaultViewport === undefined}
        fitViewOptions={{ maxZoom: 1 }}
        minZoom={0.1}
        colorMode={colorScheme}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        {/* Labelled view controls — replaces React Flow's icon-only <Controls>,
            which were unreadable in dark mode and unexplained. */}
        <Panel
          position="top-left"
          className="!m-2 flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-sm"
        >
          <CanvasButton
            label=""
            title="Zoom in"
            onClick={() => void zoomIn({ duration: 150 })}
          >
            <ZoomIn size={14} aria-hidden />
          </CanvasButton>
          <CanvasButton
            label=""
            title="Zoom out"
            onClick={() => void zoomOut({ duration: 150 })}
          >
            <ZoomOut size={14} aria-hidden />
          </CanvasButton>
          <CanvasButton
            label="Fit"
            title="Fit the whole flow into view"
            onClick={() =>
              void fitView({ padding: 0.1, duration: 300, maxZoom: 1 })
            }
          >
            <Maximize2 size={14} aria-hidden />
          </CanvasButton>
          {onAutoLayout && (
            <CanvasButton
              label="Tidy up"
              title="Re-arrange all nodes top-down by their connections (undo with Cmd/Ctrl+Z)"
              onClick={onAutoLayout}
            >
              <Network size={14} aria-hidden />
            </CanvasButton>
          )}
          {referenceEdges && referenceEdges.length > 0 && (
            <CanvasButton
              label="Tool links"
              title="Show tool connections — nodes one node calls (parallel children, harness workers and verifier), defined in its settings. They dock right → left and are dashed; the run's flow runs top → bottom."
              onClick={() => setShowReferences((v) => !v)}
              pressed={showReferences}
            >
              <Waypoints size={14} aria-hidden />
            </CanvasButton>
          )}
          <CanvasButton
            label="Map"
            title="Show/hide the overview map (bottom right)"
            onClick={() => setShowMiniMap((v) => !v)}
            pressed={showMiniMap}
          >
            <MapIcon size={14} aria-hidden />
          </CanvasButton>
        </Panel>
        {showMiniMap && (
          <MiniMap
            zoomable
            pannable
            ariaLabel="Overview map — drag to pan, scroll to zoom"
            nodeColor={(n) =>
              nodeTypeHex(
                (n.data as EditableNodeData | undefined)?.flowNode?.type,
              )
            }
            className="!bg-muted"
            style={{ width: 140, height: 90 }}
          />
        )}
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

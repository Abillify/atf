"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import {
  SUBFLOW_COLORS,
  subflowBoxes,
  subflowColorIndex,
  subflowLabel,
} from "../lib/subflows";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  MiniMap,
  Panel,
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
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Map as MapIcon, Maximize2, Network, Pin, Waypoints, Wrench, ZoomIn, ZoomOut } from "lucide-react";
import {
  type ToolChip,
  TOOL_CHIP_GAP,
  TOOL_CHIP_H,
  TOOL_RAIL_GAP,
  TOOL_RAIL_INSET,
  toolCallsByParent,
  toolChipsFor,
  toolRailSize,
} from "../lib/tool-chips";
import type { RFNode, RFEdge, ReferenceEdge, ReferenceKind } from "../lib/flow-graph";
import { connectionProblem, type EdgeLike, type NodeLike } from "../lib/edge-rules";
import { useColorSchemeOrDefault } from "../lib/theme/ThemeProvider";
import { usePersistentToggle } from "../hooks/usePersistentToggle";
import { flowNodeToNodeState, mergeLiveState } from "../lib/flow-graph";
import type { DiffInfo, GhostRFNode } from "../lib/flow-diff-view";
import { NodeCard } from "./graph/NodeRenderer";
import { labeledEdgeTypes } from "./graph/LabeledEdge";
import {
  CHANNEL_COLORS,
  CHANNEL_STATUS_LABEL,
  channelEdgeId,
  channelLogicalEdgeId,
  isChannelEdgeId,
  latestFlowsByPair,
  pairKey,
} from "../lib/edge-channels";
import type { EdgeFlowRecord } from "../lib/run-samples";
import {
  BOUNDARY_EDGE_PREFIX,
  boundaryEndEdgeId,
  boundaryStartEdgeId,
  END_ID,
  RESPONSE_EVENT_ID,
  START_ID,
  entryProblem,
  flowBoundaries,
  isBoundaryId,
} from "../lib/flow-boundaries";
import { nodeTypeHex, type NodeState } from "./graph/graphUtils";
import { EDITOR_NODE_W, EDITOR_NODE_H } from "./graph/GraphLayoutEngine";
import type { NodeType, FlowNode } from "../types/flow";
import { PALETTE_DND_TYPE } from "./FlowNodePalette";
import { SUBFLOW_DND_TYPE } from "./SubflowPalette";

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
  /** Calls other nodes as tools (parallel children, harness workers/verifier): handle on the right. */
  toolOut?: boolean;
  /** Is called as a tool by another node: handle on the left. */
  toolIn?: boolean;
  liveState?: NodeState;
  validation?: NodeValidationState;
  /** Version-diff status for this node — added/changed (Phase 2). Ghost
   * (removed) nodes carry `ghost: true` instead, see below. */
  diff?: DiffInfo;
  /** Display-only overlay node: removed in the compared version, or proposed
   * by the Copilot but not accepted yet. */
  ghost?: "removed" | "added";
  /** Relative sub-flow file this node will be saved into (Phase 4, `$includeOrigins`). */
  origin?: string;
  /** Offers tools to its model: the handle its tool row docks to (right side). */
  toolsRail?: boolean;
  /** Run emphasis of the card (see NodeCard `emphasis`). */
  emphasis?: "idle" | "used" | "unused";
};

type EditableFlowNode = Node<EditableNodeData, "flowNode">;

const DIFF_BADGE: Record<DiffInfo["status"], { glyph: string; className: string }> = {
  added: { glyph: "+", className: "border-green-700 bg-green-500 text-white" },
  changed: { glyph: "~", className: "border-amber-600 bg-amber-400 text-amber-950" },
  removed: { glyph: "−", className: "border-red-700 bg-red-500 text-white" },
};

function EditableNode({
  id,
  data,
  selected,
}: NodeProps<EditableFlowNode>): React.JSX.Element {
  const { flowNode, liveState, validation, diff, ghost, toolOut, toolIn, toolsRail, emphasis } = data;
  // React Flow measures handles only when a node's size changes. The tool
  // handles come and go (delegation links show while their harness is
  // selected), so re-measure — or the links to a new handle are dropped.
  const updateNodeInternals = useUpdateNodeInternals();
  // biome-ignore lint/correctness/useExhaustiveDependencies: toolIn/toolOut/toolsRail are the trigger, not inputs
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, toolIn, toolOut, toolsRail, updateNodeInternals]);
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
  const diffBadge = ghost ? DIFF_BADGE[ghost] : diff ? DIFF_BADGE[diff.status] : null;
  const diffTitle = ghost === "added"
    ? "Proposed by the Copilot — accept to add it"
    : ghost === "removed"
    ? "Removed in this version"
    : diff?.status === "removed"
    ? "Would be removed by the Copilot proposal"
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
        className={`relative rounded-xl ${validationRing} ${
          ghost === "added"
            ? "opacity-80 outline outline-2 outline-offset-2 outline-dashed outline-green-500"
            : ghost === "removed" || diff?.status === "removed"
              ? "opacity-50 outline outline-2 outline-offset-2 outline-dashed outline-red-400"
              : ""
        }`}
        title={validationTitle || diffTitle || undefined}
      >
        <NodeCard
          state={state}
          selected={selected}
          isTimeline={false}
          compact
          {...(ghost ? {} : { emphasis: emphasis ?? "idle" })}
        />
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
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-muted-foreground"
      />
      {/* Tool connections (set in node settings, not drawn by hand): the
          caller docks on the right, the called node on the left — distinct
          from the top→bottom flow of the run. */}
      {toolOut && (
        <Handle
          id={TOOL_OUT}
          type="source"
          position={Position.Right}
          isConnectable={false}
          title="Calls other nodes as tools (defined in this node's settings)"
          className="!h-2.5 !w-2.5 !rounded-[2px] !border !border-violet-700 !bg-violet-400"
        />
      )}
      {toolIn && (
        <Handle
          id={TOOL_IN}
          type="target"
          position={Position.Left}
          isConnectable={false}
          title="Called as a tool by another node"
          className="!h-2.5 !w-2.5 !rounded-[2px] !border !border-violet-700 !bg-violet-400"
        />
      )}
      {toolsRail && (
        <Handle
          id={TOOLS_RAIL_OUT}
          type="source"
          position={Position.Right}
          isConnectable={false}
          title="Tools this node offers its model"
          style={{ top: `${toolRailAnchor(toolOut ?? false) * 100}%` }}
          className="!h-2 !w-2 !rounded-full !border !border-teal-700 !bg-teal-400"
        />
      )}
    </>
  );
}

/** Height (fraction) on the node's right side where its tool row docks —
 * above the middle when the middle holds the handle of the node's tool links. */
const toolRailAnchor = (hasToolLinks: boolean): number => (hasToolLinks ? 0.28 : 0.5);

type ToolRailData = {
  chips: ToolChip[];
  /** A run is traced: chips the run didn't call are dimmed. */
  runActive: boolean;
  /** Column size (lib/tool-chips `toolRailSize`) — chips share the width. */
  width: number;
  height: number;
  /** More chips than fit: the column scrolls (running/used ones are on top). */
  scrolls: boolean;
  /** A chip was clicked: open the node's tool settings. */
  onToolClick?: (tool: string) => void;
};

const CHIP_STATUS_CLASS: Record<ToolChip["status"], string> = {
  idle: "border-teal-500/50 bg-card text-foreground",
  running: "border-sky-400 bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-100",
  completed:
    "border-emerald-500 bg-emerald-500 text-white shadow-md shadow-emerald-500/40 ring-2 ring-emerald-300/70 dark:ring-emerald-400/50",
  error: "border-red-600 bg-red-500 text-white ring-2 ring-red-300/70",
};

function chipTitle(c: ToolChip): string {
  const parts = [c.name];
  if (!c.declared) parts.push("called in this run, not listed in the node's tools");
  if (c.status === "running") parts.push("running…");
  if (c.calls > 0) {
    parts.push(`${c.calls} call${c.calls === 1 ? "" : "s"}${c.errors > 0 ? `, ${c.errors} failed` : ""}`);
  }
  if (c.lastLatencyMs !== undefined) parts.push(`last ${c.lastLatencyMs} ms`);
  if (c.staticArgs.length > 0) parts.push(`static arguments: ${c.staticArgs.join(", ")}`);
  return parts.join(" — ");
}

/** The tools a node offers its model, stacked on its right. A click on one
 * opens the node's tool settings. */
function ToolRailNode({ data }: NodeProps<Node<ToolRailData, "toolRail">>): React.JSX.Element {
  // A tool starts running: it moved to the top — scroll there so it is in view.
  const listRef = useRef<HTMLUListElement>(null);
  const running = data.chips
    .filter((c) => c.status === "running")
    .map((c) => c.key)
    .join("\u0000");
  useEffect(() => {
    if (running !== "" && listRef.current) listRef.current.scrollTop = 0;
  }, [running]);
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} className="!h-1.5 !w-1.5 !border-0 !bg-teal-500" />
      <ul
        ref={listRef}
        aria-label={`Tools (${data.chips.length})`}
        // nowheel: the wheel scrolls the list instead of zooming the canvas.
        className={`flex flex-col rounded-lg border border-dashed border-teal-500/50 bg-background/80 backdrop-blur-sm ${
          data.scrolls ? "nowheel overflow-y-auto overscroll-contain [scrollbar-width:thin]" : "overflow-hidden"
        }`}
        style={{ width: data.width, height: data.height, padding: TOOL_RAIL_INSET - 1, gap: TOOL_CHIP_GAP }}
      >
        {data.chips.map((c) => (
          // The running border is drawn inside the chip (inset 0): a scrolling list would clip it outside.
          <li key={c.key} className="relative shrink-0" style={{ height: TOOL_CHIP_H }}>
            <button
              type="button"
              title={`${chipTitle(c)}${data.onToolClick ? " — click to open the node's tool settings" : ""}`}
              data-testid={`tool-chip-${c.name}`}
              data-status={c.status}
              disabled={!data.onToolClick}
              onClick={(e) => {
                e.stopPropagation();
                data.onToolClick?.(c.name);
              }}
              className={`nodrag nopan pointer-events-auto flex h-full w-full items-center gap-1 rounded-md border px-1.5 text-left text-[10px] font-medium leading-none transition-all enabled:cursor-pointer enabled:hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                CHIP_STATUS_CLASS[c.status]
              } ${!c.declared ? "border-dashed" : ""} ${data.runActive && c.status === "idle" ? "opacity-40" : ""}`}
            >
              <Wrench size={12} aria-hidden className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
              {c.staticArgs.length > 0 && (
                <span className="flex shrink-0 items-center gap-0.5 opacity-80" data-testid="tool-chip-static-args">
                  <Pin size={10} aria-hidden />
                  <span className="text-[9px]">{c.staticArgs.length}</span>
                  <span className="sr-only"> static arguments</span>
                </span>
              )}
              {c.calls > 1 && (
                <span className="shrink-0 rounded bg-black/20 px-1 text-[9px]">
                  <span aria-hidden>×</span>
                  {c.calls}
                  <span className="sr-only"> calls</span>
                </span>
              )}
            </button>
            {c.status === "running" && (
              <div
                aria-hidden
                className="node-running-border"
                style={{ "--node-spin-radius": "0.25rem", inset: 0, padding: 2 } as React.CSSProperties}
              />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

type SubflowBoxData = {
  path: string;
  count: number;
  color: number;
  selected?: boolean;
  onSelect?: (path: string) => void;
};

/** Coloured, labelled box behind the nodes of one sub-flow file (display only,
 * except the label which selects the whole group when clicked). When the group
 * is selected the box is drawn boldly (solid ring + tint) so the selection
 * reads as a unit, matching the highlighted nodes inside it. */
function SubflowBoxNode({ data }: NodeProps<Node<SubflowBoxData, "subflowBox">>): React.JSX.Element {
  const c = SUBFLOW_COLORS[data.color] ?? SUBFLOW_COLORS[0];
  return (
    <div
      // When selected the box is lifted above the edge layer (see zIndex in
      // FlowCanvasInner), so we keep only a bold ring/border and NO fill tint —
      // a fill would sit on top of the group's node cards and edge labels.
      className={`h-full w-full rounded-xl border-2 transition-all ${
        data.selected
          ? "border-solid border-sky-500 ring-4 ring-sky-500/50 dark:border-sky-400 dark:ring-sky-400/50"
          : `border-dashed ${c?.box ?? ""}`
      }`}
      data-testid={`subflow-box-${data.path}`}
      data-selected={data.selected ? "true" : "false"}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          data.onSelect?.(data.path);
        }}
        aria-pressed={data.selected ?? false}
        title={`Sub-flow ${data.path} — click to select the whole group. Its nodes are saved to this file and merged into the flow via metadata.$include.`}
        className={`pointer-events-auto absolute left-2 top-1.5 inline-flex max-w-[calc(100%-1rem)] cursor-pointer items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-semibold hover:brightness-95 ${
          data.selected ? "bg-sky-500 text-white ring-2 ring-sky-300 dark:bg-sky-400 dark:text-sky-950" : (c?.label ?? "")
        }`}
        data-testid={`subflow-select-${data.path}`}
      >
        📄 {subflowLabel(data.path)}
        <span className="font-normal opacity-70">· {data.count} node{data.count === 1 ? "" : "s"}</span>
      </button>
    </div>
  );
}

/** What the Start / End cards show (canvas only, see lib/flow-boundaries). */
export interface BoundaryCardInfo {
  /** One line under the title — e.g. the pinned request's question or answer. */
  summary?: string;
  /** Status of the current run's request/response boundary. */
  status?: NodeState["status"];
}

type BoundaryNodeData = {
  kind: "start" | "end";
  info: BoundaryCardInfo;
  connectable: boolean;
};

const BOUNDARY_W = 200;
const BOUNDARY_H = 52;
const BOUNDARY_GAP = 70;

const BOUNDARY_STATUS_RING: Record<NonNullable<BoundaryCardInfo["status"]>, string> = {
  running: "", // rotating border, see below
  completed: "ring-2 ring-green-500",
  error: "ring-2 ring-red-500",
  pending: "",
};

/** Start / End of the flow — not nodes of the definition (lib/flow-boundaries). */
function BoundaryNode({ data, selected }: NodeProps<Node<BoundaryNodeData, "boundary">>): React.JSX.Element {
  const start = data.kind === "start";
  const ring = data.info.status ? BOUNDARY_STATUS_RING[data.info.status] : "";
  return (
    <>
      {!start && (
        <Handle
          type="target"
          position={Position.Top}
          isConnectable={false}
          className="!bg-muted-foreground"
        />
      )}
      <div
        data-testid={`boundary-${data.kind}`}
        style={{ width: BOUNDARY_W, height: BOUNDARY_H }}
        className={`relative flex flex-col justify-center rounded-full border-2 bg-card px-4 shadow-sm ${
          start ? "border-emerald-500" : "border-slate-500 dark:border-slate-400"
        } ${selected ? "outline outline-2 outline-offset-2 outline-sky-500" : ""} ${ring}`}
        title={
          start
            ? "Where a request enters the flow. Click for the pinned request's input; drag from here to a node to make it the entry."
            : "Where the flow returns its answer. Click for the pinned request's answer and the nodes the run can end after."
        }
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <span aria-hidden className={start ? "text-emerald-600" : "text-slate-500"}>
            {start ? "▶" : "■"}
          </span>
          {start ? "Start" : "End"}
          <span className="font-normal text-muted-foreground">{start ? "· request in" : "· answer out"}</span>
        </div>
        {data.info.summary && (
          <div className="truncate text-[10px] text-muted-foreground">{data.info.summary}</div>
        )}
        {data.info.status === "running" && (
          <div
            aria-hidden
            className="node-running-border"
            style={{ "--node-spin-radius": "9999px" } as React.CSSProperties}
          />
        )}
      </div>
      {start && (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={data.connectable}
          className="!bg-emerald-500"
        />
      )}
    </>
  );
}

const SUBFLOW_BOX_PREFIX = "subflow-box:";
/** Handle ids of tool connections (reference edges). Flow edges use the unnamed top/bottom handles. */
const TOOL_OUT = "tool-out";
const TOOL_IN = "tool-in";
/** Handle a node's tool row docks to, and the ids of the row and its link. */
const TOOLS_RAIL_OUT = "tools-rail-out";
const TOOL_RAIL_PREFIX = "tool-rail:";
const TOOL_RAIL_EDGE_PREFIX = "tool-rail-edge:";
const isToolRailId = (id: string): boolean => id.startsWith(TOOL_RAIL_PREFIX);
/** Display-only edges: not flow edges, never reported or changed. Channel
 * lines (edge data flow) are synthetic too — only their logical edge is. */
const isOverlayEdgeId = (id: string): boolean =>
  id.startsWith(BOUNDARY_EDGE_PREFIX) ||
  id.startsWith(TOOL_RAIL_EDGE_PREFIX) ||
  isChannelEdgeId(id);
/** Stroke of an edge the traced run went along. */
const USED_EDGE_STROKE = "#10b981";
const nodeTypes = {
  flowNode: EditableNode,
  subflowBox: SubflowBoxNode,
  boundary: BoundaryNode,
  toolRail: ToolRailNode,
};
/** Labels are drawn along the edge path, framed in the edge colour. */
const edgeTypes = labeledEdgeTypes;

/** Canvas-only label shortening; the full text stays in the edge's data and
 * is shown/edited in the properties panel. */
const MAX_EDGE_LABEL = 36;
function shortLabel(label: unknown): string | undefined {
  if (typeof label !== "string" || label.length === 0) return undefined;
  return label.length > MAX_EDGE_LABEL ? `${label.slice(0, MAX_EDGE_LABEL - 1)}…` : label;
}

/** Reference links are drawn dashed and muted so they read as "wired via a
 * node setting", not as a routing edge you can select or delete. */
const REFERENCE_STYLE: Record<ReferenceKind, { stroke: string; dash: string }> = {
  parallel: { stroke: "#8b5cf6", dash: "6 4" },
  verifies: { stroke: "#e11d48", dash: "2 4" },
  delegates: { stroke: "#0d9488", dash: "5 4" },
};

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

  // Ghost (overlay) nodes and the Start/End cards are not part of `nodes`, so
  // React Flow's measurement changes for them would be dropped — and React
  // Flow keeps an unmeasured node `visibility: hidden`, and forgets the handle
  // positions of a node passed in again without `measured`, drawing no edges
  // to it (the Start/End links vanished on every re-render, e.g. on a click or
  // a run status change). Keep their measured sizes here.
  const ghostIds = useMemo(
    () => new Set((ghostNodes ?? []).map((n) => n.id)),
    [ghostNodes],
  );
  const [overlaySizes, setOverlaySizes] = useState<
    Map<string, { width: number; height: number }>
  >(new Map());

  // Start/End are not in `nodes` either, so their selection is kept here — a
  // select change dropped on the floor left a click on Start without effect
  // (React Flow reports only nodes it sees as selected).
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<string | null>(null);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const overlayDims = changes.filter(
        (c): c is Extract<NodeChange, { type: "dimensions" }> =>
          c.type === "dimensions" &&
          (ghostIds.has(c.id) || isBoundaryId(c.id) || isToolRailId(c.id)) &&
          c.dimensions !== undefined,
      );
      const boundarySelects = changes.filter(
        (c): c is Extract<NodeChange, { type: "select" }> => c.type === "select" && isBoundaryId(c.id),
      );
      if (boundarySelects.length > 0) {
        setSelectedBoundaryId((prev) => {
          let next = prev;
          for (const c of boundarySelects) {
            if (c.selected) next = c.id;
            else if (next === c.id) next = null;
          }
          return next;
        });
      }
      if (overlayDims.length > 0) {
        setOverlaySizes((prev) => {
          const next = new Map(prev);
          for (const c of overlayDims) {
            if (c.dimensions) next.set(c.id, c.dimensions);
          }
          return next;
        });
      }
      if (!editable || !onNodesChange) return;
      const own = changes.filter(
        (c) =>
          !("id" in c) ||
          (!ghostIds.has(c.id) &&
            !c.id.startsWith(SUBFLOW_BOX_PREFIX) &&
            !isBoundaryId(c.id) &&
            !isToolRailId(c.id)),
      );
      if (own.length === 0) return;
      onNodesChange(
        applyNodeChanges(own, nodes as unknown as Node[]) as unknown as RFNode[],
      );
    },
    [editable, onNodesChange, nodes, ghostIds],
  );

  // Channel lines are synthetic: they live only in `renderEdges`, never in the
  // caller's `edges`, so a select change for one would be dropped and the line
  // could never highlight. Track their selection locally, mirroring what the
  // caller's state does for real edges.
  const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(
    () => new Set(),
  );
  // A new trace replaces the channel lines: drop a stale selection so lines a
  // later run happens to reuse don't start out highlighted. (Render-phase
  // reset — React's pattern for adjusting state when a prop changes.)
  const [channelTrace, setChannelTrace] = useState(edgeFlows);
  if (channelTrace !== edgeFlows) {
    setChannelTrace(edgeFlows);
    if (selectedChannelIds.size > 0) setSelectedChannelIds(new Set());
  }

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const channelSelects = changes.filter(
        (c): c is Extract<EdgeChange, { type: "select" }> =>
          c.type === "select" && "id" in c && isChannelEdgeId(c.id),
      );
      if (channelSelects.length > 0) {
        setSelectedChannelIds((prev) => {
          const next = new Set(prev);
          for (const c of channelSelects) {
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
          }
          return next;
        });
      }
      if (!editable || !onEdgesChange) return;
      const own = changes.filter((c) => !("id" in c) || !isOverlayEdgeId(c.id));
      if (own.length === 0) return;
      onEdgesChange(
        applyEdgeChanges(
          own,
          edges as unknown as Edge[],
        ) as unknown as RFEdge[],
      );
    },
    [editable, onEdgesChange, edges],
  );

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
    () => edges.map((e) => ({ source: e.source, target: e.target, conditions: e.data?.conditions })),
    [edges],
  );

  // Refuse a connection before React Flow ever draws it, so the invalid edge
  // never flashes onto the canvas. A freshly drawn edge carries no condition,
  // so the self-loop / duplicate / cycle rules (which only bind unconditional
  // edges) apply — the operator adds a condition afterwards in the panel.
  const connectionRejection = useCallback(
    (conn: Connection | Edge): string | null => {
      if (conn.source === null || conn.target === null) return null;
      // Start → node: makes that node the entry (no edge is added).
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
    [editable, onEdgesChange, edges, connectionRejection, onInvalidConnection, onSetEntry],
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
        onDropSubflow(subflowPath, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
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
      const boundary = sel.nodes.length === 1 && isBoundaryId(sel.nodes[0]!.id) ? sel.nodes[0]!.id : null;
      onSelectBoundaryRef.current?.(boundary === null ? null : boundary === START_ID ? "start" : "end");
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

  // Start/End cards and the implicit entry/exit links (lib/flow-boundaries).
  const boundaryLayout = useMemo(() => {
    if (!boundaries || nodes.length === 0) return null;
    const b = flowBoundaries(ruleNodes, ruleEdges);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const centerX = (ids: string[]): number => {
      const xs = ids.map((id) => byId.get(id)?.position.x).filter((x): x is number => x !== undefined);
      const x = xs.length > 0 ? xs.reduce((a, c) => a + c, 0) / xs.length : (nodes[0]?.position.x ?? 0);
      return x + EDITOR_NODE_W / 2 - BOUNDARY_W / 2;
    };
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const maxY = Math.max(...nodes.map((n) => n.position.y));
    const exitIds = b.exits.map((e) => e.nodeId);
    return {
      b,
      start: { x: centerX(b.entryId !== null ? [b.entryId] : []), y: minY - BOUNDARY_GAP - BOUNDARY_H },
      end: { x: centerX(exitIds), y: maxY + EDITOR_NODE_H + BOUNDARY_GAP },
    };
  }, [boundaries, nodes, ruleNodes, ruleEdges]);

  // Nodes with tool connections get the side handles those edges dock to.
  const { toolCallers, toolCallees } = useMemo(() => {
    const refs = showReferences ? (referenceEdges ?? []) : [];
    return {
      toolCallers: new Set(refs.map((r) => r.source)),
      toolCallees: new Set(refs.map((r) => r.target)),
    };
  }, [referenceEdges, showReferences]);

  // A traced run (Run & Trace, or an attached execution): the nodes it passed
  // through are highlighted, the others dimmed.
  const runActive = (liveStates?.size ?? 0) > 0;
  const toolCalls = useMemo(() => toolCallsByParent(liveStates), [liveStates]);

  // Every node that offers tools gets a row of tool chips on its right.
  const toolRails = useMemo(
    () =>
      nodes
        .filter((n) => (n.data.flowNode.tools?.length ?? 0) > 0 || toolCalls.has(n.id))
        .map((n) => {
          const { tools, config: { toolArgs } = {} } = n.data.flowNode;
          return { node: n, chips: toolChipsFor(tools, toolCalls.get(n.id) ?? [], toolArgs) };
        }),
    [nodes, toolCalls],
  );
  const railNodeIds = useMemo(() => new Set(toolRails.map((r) => r.node.id)), [toolRails]);

  const renderNodes = useMemo(() => {
    const real = nodes.map((n) => ({
      ...n,
      data: {
        flowNode: n.data.flowNode,
        liveState: liveStates?.get(n.id),
        validation: nodeValidation?.get(n.id),
        diff: nodeDiff?.get(n.id),
        origin: nodeOrigins?.[n.id],
        toolOut: toolCallers.has(n.id),
        toolIn: toolCallees.has(n.id),
        toolsRail: railNodeIds.has(n.id),
        emphasis: !runActive ? "idle" : liveStates?.has(n.id) ? "used" : "unused",
      },
    }));
    const rails = toolRails.map(({ node: n, chips }) => {
      const id = `${TOOL_RAIL_PREFIX}${n.id}`;
      const measured = (n as { measured?: { width?: number; height?: number } }).measured;
      const w = measured?.width ?? EDITOR_NODE_W;
      const h = measured?.height ?? EDITOR_NODE_H;
      // Fixed size (the layout reserves exactly this), centred beside the node.
      const size = toolRailSize(chips.map((c) => c.name));
      return {
        id,
        type: "toolRail",
        position: {
          x: n.position.x + w + TOOL_RAIL_GAP,
          y: n.position.y + h / 2 - size.height / 2,
        },
        width: size.width,
        height: size.height,
        ...(overlaySizes.has(id) ? { measured: overlaySizes.get(id) } : {}),
        draggable: false,
        selectable: false,
        connectable: false,
        focusable: false,
        deletable: false,
        data: {
          chips,
          runActive,
          width: size.width,
          height: size.height,
          scrolls: size.scrolls,
          ...(onToolClick ? { onToolClick: (tool: string) => onToolClick(n.id, tool) } : {}),
        },
      };
    });
    // Sub-flow boxes behind their nodes, sized from the rendered nodes.
    const boxes = nodeOrigins
      ? subflowBoxes(nodes as never, nodeOrigins, { width: EDITOR_NODE_W, height: EDITOR_NODE_H })
      : [];
    const allPaths = boxes.map((b) => b.path);
    const boxNodes = boxes.map((b) => ({
      id: `${SUBFLOW_BOX_PREFIX}${b.path}`,
      type: "subflowBox",
      position: { x: b.x, y: b.y },
      width: b.width,
      height: b.height,
      style: { width: b.width, height: b.height, pointerEvents: "none" as const },
      // Behind the nodes by default. When selected, lift the box above the edge
      // layer (edges/edge-labels render around zIndex 1000) so its highlight
      // and label aren't hidden by an edge label crossing the group.
      zIndex: b.path === selectedSubflowPath ? 1001 : -1,
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      deletable: false,
      data: {
        path: b.path,
        count: b.nodeIds.length,
        color: subflowColorIndex(b.path, allPaths),
        selected: b.path === selectedSubflowPath,
        ...(onSelectSubflow ? { onSelect: onSelectSubflow } : {}),
      },
    }));
    const boundaryNodes =
      boundaries && boundaryLayout
        ? (["start", "end"] as const).map((kind) => {
            const id = kind === "start" ? START_ID : END_ID;
            return {
              id,
              type: "boundary",
              position: boundaryLayout[kind],
              width: BOUNDARY_W,
              height: BOUNDARY_H,
              ...(overlaySizes.has(id) ? { measured: overlaySizes.get(id) } : {}),
              draggable: false,
              deletable: false,
              connectable: editable,
              selected: selectedBoundaryId === id,
              data: { kind, info: boundaries[kind], connectable: editable },
            };
          })
        : [];
    if (!ghostNodes || ghostNodes.length === 0) return [...boxNodes, ...real, ...rails, ...boundaryNodes];
    const ghosts = ghostNodes.map((n) => ({
      ...n,
      // Visible (and edge-connectable) before React Flow has measured it.
      initialWidth: EDITOR_NODE_W,
      initialHeight: EDITOR_NODE_H,
      ...(overlaySizes.has(n.id) ? { measured: overlaySizes.get(n.id) } : {}),
      data: { flowNode: n.data.flowNode, ghost: n.ghostKind ?? "removed" },
    }));
    return [...boxNodes, ...real, ...rails, ...ghosts, ...boundaryNodes];
  }, [boundaries, boundaryLayout, editable, nodes, liveStates, nodeValidation, nodeDiff, nodeOrigins, ghostNodes, overlaySizes, toolCallers, toolCallees, onSelectSubflow, selectedSubflowPath, selectedBoundaryId, toolRails, railNodeIds, runActive, onToolClick]);

  const renderEdges = useMemo(() => {
    // Edges between the same two nodes share one curve: number their labels
    // so each gets its own spot along it (LabeledEdge `labelSlot`).
    const edgePairKey = (e: { source: string; target: string }) => `${e.source}\u0000${e.target}`;
    const pairCount = new Map<string, number>();
    for (const edge of edges) {
      if (edge.label) pairCount.set(edgePairKey(edge), (pairCount.get(edgePairKey(edge)) ?? 0) + 1);
    }
    const pairSeen = new Map<string, number>();
    // The run went along an edge when it ran both ends, the target after the
    // source (when both carry a sequence number).
    const usedEdge = (source: string, target: string): boolean => {
      const s = liveStates?.get(source);
      const t = liveStates?.get(target);
      if (!s || !t) return false;
      return s.sequence == null || t.sequence == null || t.sequence > s.sequence;
    };
    // Per-edge data flow of the traced run: the newest traversal per pair.
    // Each payload becomes a colored channel line beside the base edge;
    // `consumed` items still draw their line — the payload crossed THIS edge
    // and ends at the target (e.g. the image at the vision node), which is
    // exactly where the line stops.
    const flowByPair = latestFlowsByPair(edgeFlows ?? []);
    const CHANNEL_GAP = 6;
    const channelEdgesFor = (
      logicalId: string,
      source: string,
      target: string,
    ) => {
      if (!runActive) return [];
      const record = flowByPair.get(pairKey(source, target));
      if (record === undefined || record.items.length === 0) return [];
      const n = record.items.length;
      return record.items.map((item, i) => {
        const status = CHANNEL_STATUS_LABEL[item.status];
        return {
          id: channelEdgeId(logicalId, i),
          source,
          target,
          type: "channel",
          selectable: true,
          deletable: false,
          focusable: false,
          zIndex: 1,
          selected: selectedChannelIds.has(channelEdgeId(logicalId, i)),
          data: {
            color: CHANNEL_COLORS[item.kind],
            offset: (i - (n - 1) / 2) * CHANNEL_GAP,
            logicalEdgeId: logicalId,
            title: `${item.label} · ${status}`,
          },
        };
      });
    };
    // The element type is widened to React Flow's `Edge`: the branches below
    // return different shapes (base edges, dimmed/styled variants, channel
    // lines), and without the annotation TS locks the union onto the first
    // channel-line shape and rejects the base edges. `renderEdges` is handed
    // to React Flow as `Edge[]` anyway.
    const real = edges.flatMap<Edge>((edge) => {
      const count = pairCount.get(edgePairKey(edge)) ?? 0;
      const index = edge.label ? (pairSeen.get(edgePairKey(edge)) ?? 0) : 0;
      if (edge.label) pairSeen.set(edgePairKey(edge), index + 1);
      const e = {
        ...edge,
        type: "labeled",
        label: shortLabel(edge.label),
        // The untruncated label, for the edge's tooltip.
        data: {
          ...edge.data,
          fullLabel: edge.label,
          ...(count > 1 ? { labelSlot: { index, count } } : {}),
        },
      };
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
              : diffState?.status === "removed"
                ? "#f87171"
                : undefined;
      if (color === undefined) {
        if (!runActive) return [e];
        if (!usedEdge(edge.source, edge.target)) return [{ ...e, style: { opacity: 0.35 } }];
        // The run went this way: one colored channel line per payload the
        // runtime recorded for this edge. The channels REPLACE the base edge
        // — as many lines as the panel lists payloads; clicking a channel
        // still opens this edge's properties (logicalEdgeId).
        const channels = channelEdgesFor(e.id, edge.source, edge.target);
        if (channels.length > 0) return channels;
        return [{ ...e, style: { stroke: USED_EDGE_STROKE, strokeWidth: 2.5 } }];
      }
      return [
        {
          ...e,
          style: {
            stroke: color,
            strokeWidth: 2,
            ...(diffState?.status === "removed" ? { strokeDasharray: "4 3" } : {}),
          },
        },
      ];
    });
    // Tool links leave the caller from one handle and share its first stretch,
    // so identical labels ("delegates" ×3) would pile up there: label only one
    // per caller — colour and dash already tell the kind apart. It goes on the
    // longest of them (the target furthest above/below), where it has room.
    const yOf = new Map(nodes.map((n) => [n.id, n.position.y]));
    const reach = (r: ReferenceEdge) =>
      Math.abs((yOf.get(r.target) ?? 0) - (yOf.get(r.source) ?? 0));
    const labelledRef = new Map<string, ReferenceEdge>();
    for (const r of referenceEdges ?? []) {
      const key = `${r.source}\u0000${r.label}`;
      const current = labelledRef.get(key);
      if (current === undefined || reach(r) > reach(current)) labelledRef.set(key, r);
    }
    const refs =
      showReferences && referenceEdges
        ? referenceEdges.map((r) => {
            const labelHere = labelledRef.get(`${r.source}\u0000${r.label}`) === r;
            return {
              id: r.id,
              source: r.source,
              target: r.target,
              sourceHandle: TOOL_OUT,
              targetHandle: TOOL_IN,
              type: "labeledStep",
              ...(labelHere ? { label: r.label } : {}),
              selectable: false,
              deletable: false,
              focusable: false,
              style: {
                stroke: REFERENCE_STYLE[r.kind].stroke,
                strokeDasharray: REFERENCE_STYLE[r.kind].dash,
                strokeWidth: 1.5,
              },
              data: {},
            };
          })
            // Labelled links last: drawn on top, so the unlabelled ones that
            // branch off the shared stretch can't run across the label.
            .sort((a, b) => Number("label" in a) - Number("label" in b))
        : [];
    // Implicit entry/exit links: dashed, display only. The run's own entry and
    // exit (the exit that ran last, once the answer went out) are drawn solid.
    const ranExit = (() => {
      if (!boundaryLayout || !liveStates?.has(RESPONSE_EVENT_ID)) return null;
      let best: { id: string; seq: number } | null = null;
      for (const x of boundaryLayout.b.exits) {
        const st = liveStates.get(x.nodeId);
        if (!st) continue;
        const seq = st.sequence ?? 0;
        if (best === null || seq > best.seq) best = { id: x.nodeId, seq };
      }
      return best?.id ?? null;
    })();
    const boundaryStyle = (used: boolean, idleStroke: string) =>
      used
        ? { stroke: USED_EDGE_STROKE, strokeWidth: 2.5 }
        : { stroke: idleStroke, strokeDasharray: "5 4", strokeWidth: 1.5, ...(runActive ? { opacity: 0.35 } : {}) };
    const implicit = boundaryLayout
      ? [
          ...(boundaryLayout.b.entryId !== null ? [boundaryLayout.b.entryId] : []).map((id) => {
            const used = runActive && (liveStates?.has(id) ?? false);
            const channels = channelEdgesFor(boundaryStartEdgeId(id), START_ID, id);
            return [
              ...(used && channels.length > 0
                ? []
                : [
                    {
                      id: boundaryStartEdgeId(id),
                      source: START_ID,
                      target: id,
                      type: "labeled",
                      selectable: false,
                      deletable: false,
                      focusable: false,
                      style: boundaryStyle(used, "#10b981"),
                      data: {},
                    },
                  ]),
              ...channels,
            ];
          }),
          ...boundaryLayout.b.exits.map((x) => {
            const used = ranExit === x.nodeId;
            const channels = channelEdgesFor(boundaryEndEdgeId(x.nodeId), x.nodeId, END_ID);
            return [
              ...(used && channels.length > 0
                ? []
                : [
                    {
                      id: boundaryEndEdgeId(x.nodeId),
                      source: x.nodeId,
                      target: END_ID,
                      type: "labeled",
                      ...(x.kind === "nomatch" ? { label: "no match" } : {}),
                      selectable: false,
                      deletable: false,
                      focusable: false,
                      style: boundaryStyle(used, "#94a3b8"),
                      data: {},
                    },
                  ]),
              ...channels,
            ];
          }),
        ].flat()
      : [];
    // Node → its tool row.
    const railEdges = toolRails.map(({ node: n, chips }) => {
      const used = chips.some((c) => c.calls > 0);
      const running = chips.some((c) => c.status === "running");
      return {
        id: `${TOOL_RAIL_EDGE_PREFIX}${n.id}`,
        source: n.id,
        sourceHandle: TOOLS_RAIL_OUT,
        target: `${TOOL_RAIL_PREFIX}${n.id}`,
        type: "labeled",
        selectable: false,
        deletable: false,
        focusable: false,
        animated: running,
        style: used
          ? { stroke: USED_EDGE_STROKE, strokeWidth: 2.5 }
          : {
              stroke: "#14b8a6",
              strokeDasharray: "3 3",
              strokeWidth: 1.5,
              ...(runActive ? { opacity: 0.35 } : {}),
            },
        data: {},
      };
    });
    if (!ghostEdges || ghostEdges.length === 0) return [...real, ...refs, ...railEdges, ...implicit];
    const ghosts = ghostEdges.map((e) => {
      const added = e.data?.ghostKind === "added";
      return {
        ...e,
        type: "labeled",
        style: {
          stroke: added ? "#16a34a" : "#f87171",
          strokeWidth: 2,
          strokeDasharray: "4 3",
        },
        label: e.label ?? (added ? "proposed" : "removed"),
        selectable: false,
      };
    });
    return [...real, ...refs, ...railEdges, ...ghosts, ...implicit];
  }, [edges, nodes, edgeValidation, edgeDiff, ghostEdges, referenceEdges, showReferences, boundaryLayout, liveStates, runActive, toolRails, edgeFlows, selectedChannelIds]);

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
          <CanvasButton label="" title="Zoom in" onClick={() => void zoomIn({ duration: 150 })}>
            <ZoomIn size={14} aria-hidden />
          </CanvasButton>
          <CanvasButton label="" title="Zoom out" onClick={() => void zoomOut({ duration: 150 })}>
            <ZoomOut size={14} aria-hidden />
          </CanvasButton>
          <CanvasButton
            label="Fit"
            title="Fit the whole flow into view"
            onClick={() => void fitView({ padding: 0.1, duration: 300, maxZoom: 1 })}
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
              nodeTypeHex((n.data as EditableNodeData | undefined)?.flowNode?.type)
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

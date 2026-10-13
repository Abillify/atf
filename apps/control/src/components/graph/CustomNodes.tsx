"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: the editor's xyflow custom nodes, moved out of FlowCanvas.tsx
// without behavior change. The memo() wrappers (Req 9.4) stay in
// FlowCanvas.tsx with the nodeTypes table.

import type React from "react";
import { useEffect, useRef } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Pin, Wrench } from "lucide-react";
import { NodeCard } from "./NodeRenderer";
import type { NodeState } from "./graphUtils";
import { flowNodeToNodeState, mergeLiveState } from "../../lib/flow-graph";
import type { DiffInfo } from "../../lib/flow-diff-view";
import {
  type ToolChip,
  TOOL_CHIP_GAP,
  TOOL_CHIP_H,
  TOOL_RAIL_INSET,
} from "../../lib/tool-chips";
import { SUBFLOW_COLORS, subflowLabel } from "../../lib/subflows";
import type { FlowNode } from "../../types/flow";
import { TOOL_IN, TOOL_OUT, TOOLS_RAIL_OUT } from "./canvasIds";

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
export type EditableNodeData = {
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
  added: { glyph: "+", className: "border-success-border bg-success-solid text-on-solid" },
  changed: { glyph: "~", className: "border-warning-border bg-warning-solid text-warning" },
  removed: { glyph: "−", className: "border-danger-border bg-danger-solid text-on-solid" },
};

export function EditableNode({
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
    ? "ring-2 ring-offset-1 ring-danger"
    : hasWarning
      ? "ring-2 ring-offset-1 ring-warning"
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
            ? "opacity-80 outline outline-2 outline-offset-2 outline-dashed outline-success"
            : ghost === "removed" || diff?.status === "removed"
              ? "opacity-50 outline outline-2 outline-offset-2 outline-dashed outline-danger"
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
                ? "border-danger-border bg-danger-solid text-on-solid"
                : "border-warning-border bg-warning-solid text-warning"
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
          className="!h-2.5 !w-2.5 !rounded-[2px] !border !border-copilot-border !bg-copilot-solid"
        />
      )}
      {toolIn && (
        <Handle
          id={TOOL_IN}
          type="target"
          position={Position.Left}
          isConnectable={false}
          title="Called as a tool by another node"
          className="!h-2.5 !w-2.5 !rounded-[2px] !border !border-copilot-border !bg-copilot-solid"
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
          className="!h-2 !w-2 !rounded-full !border !border-subflow-border !bg-subflow-solid"
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
  idle: "border-subflow-border bg-card text-foreground",
  running: "border-info-border bg-info-soft text-info dark:bg-info-soft dark:text-info",
  completed:
    "border-success-border bg-success-solid text-on-solid shadow-md shadow-success/40 ring-2 ring-success/70 dark:ring-success/50",
  error: "border-danger-border bg-danger-solid text-on-solid ring-2 ring-danger/70",
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
export function ToolRailNode({ data }: NodeProps<Node<ToolRailData, "toolRail">>): React.JSX.Element {
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
      <Handle type="target" position={Position.Left} isConnectable={false} className="!h-1.5 !w-1.5 !border-0 !bg-subflow-solid" />
      <ul
        ref={listRef}
        aria-label={`Tools (${data.chips.length})`}
        // nowheel: the wheel scrolls the list instead of zooming the canvas.
        className={`flex flex-col rounded-lg border border-dashed border-subflow-border bg-background/80 backdrop-blur-sm ${
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
              className={`nodrag nopan pointer-events-auto flex h-full w-full items-center gap-1 rounded-md border px-1.5 text-left text-[10px] font-medium leading-none transition-all enabled:cursor-pointer enabled:hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-info ${
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
export function SubflowBoxNode({ data }: NodeProps<Node<SubflowBoxData, "subflowBox">>): React.JSX.Element {
  const c = SUBFLOW_COLORS[data.color] ?? SUBFLOW_COLORS[0];
  return (
    <div
      // When selected the box is lifted above the edge layer (see zIndex in
      // FlowCanvasInner), so we keep only a bold ring/border and NO fill tint —
      // a fill would sit on top of the group's node cards and edge labels.
      className={`h-full w-full rounded-xl border-2 transition-all ${
        data.selected
          ? "border-solid border-info-border ring-4 ring-info/50 dark:border-info-border dark:ring-info/50"
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
          data.selected ? "bg-info-solid text-on-solid ring-2 ring-info dark:bg-info-solid dark:text-info" : (c?.label ?? "")
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

export const BOUNDARY_W = 200;
export const BOUNDARY_H = 52;
export const BOUNDARY_GAP = 70;

const BOUNDARY_STATUS_RING: Record<NonNullable<BoundaryCardInfo["status"]>, string> = {
  running: "", // rotating border, see below
  completed: "ring-2 ring-success",
  error: "ring-2 ring-danger",
  pending: "",
};

/** Start / End of the flow — not nodes of the definition (lib/flow-boundaries). */
export function BoundaryNode({ data, selected }: NodeProps<Node<BoundaryNodeData, "boundary">>): React.JSX.Element {
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
          start ? "border-success-border" : "border-muted-foreground/60"
        } ${selected ? "outline outline-2 outline-offset-2 outline-info" : ""} ${ring}`}
        title={
          start
            ? "Where a request enters the flow. Click for the pinned request's input; drag from here to a node to make it the entry."
            : "Where the flow returns its answer. Click for the pinned request's answer and the nodes the run can end after."
        }
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <span aria-hidden className={start ? "text-success" : "text-muted-foreground"}>
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
          className="!bg-success-solid"
        />
      )}
    </>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * NodeRenderer — React Flow custom node component for the graph visualizer.
 *
 * Renders a single flow/execution node with:
 *   - node-type fill colour
 *   - status dot (corner badge)
 *   - approval ring / badge when relevant
 *   - latency, model, token and cost rows
 *   - error snippet
 *   - sequence badge
 *   - duration bar (timeline mode only)
 *
 */

import type React from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { NODE_W, NODE_H, EDITOR_NODE_W } from "./GraphLayoutEngine";
import {
  nodeTypeColor,
  nodeTypeLabel,
  statusIndicator,
  approvalRing,
  approvalBadge,
  formatCost,
  nodeErrorTooltip,
  type NodeState,
} from "./graphUtils";
import { Wrench } from "lucide-react";
import { nodeTypeIcon } from "./nodeIcons";
import { translate } from "../../lib/i18n";

// Defined as a `type` (not `interface`) so it satisfies React Flow v12's
// `Node<Data extends Record<string, unknown>>` constraint via TS's implicit
// index signature for object type aliases.
export type CustomNodeData = {
  state: NodeState;
  onClick: (state: NodeState) => void;
  /** True-duration bar width in px (timeline mode only). */
  barWidth?: number;
  /** Whether we're in timeline mode (shows bar + handle positions stay LR). */
  isTimeline?: boolean;
};

export type CustomFlowNode = Node<CustomNodeData, "custom">;

export interface NodeCardProps {
  state: NodeState;
  /** ReactFlow selection state — draws a subtle ring when no status/approval
   * ring already claims that space, so editor selection never fights with
   * execution-state colour coding. */
  selected?: boolean;
  onClick?: (state: NodeState) => void;
  /** True-duration bar width in px (timeline mode only). */
  barWidth?: number;
  /** Whether we're in timeline mode (shows the duration bar). */
  isTimeline?: boolean;
  /**
   * Editor density: fixed width, two-line label, no reserved height. The
   * editor never shows latency/tokens/cost rows for idle nodes, so the
   * monitor's 96px minimum was mostly empty space there.
   */
  compact?: boolean;
  /**
   * Run emphasis (Studio editor): `idle` — no run traced, the node is drawn
   * at full strength instead of as "pending"; `used` — the traced run passed
   * through it (highlighted); `unused` — it did not (dimmed). Omitted (the
   * monitor): pending nodes are dimmed as before.
   */
  emphasis?: "idle" | "used" | "unused";
}

/** Ring of a node the traced run passed through. */
const USED_RING =
  "ring-[3px] ring-offset-2 ring-offset-background ring-success";

/**
 * The presentational node card — everything about how a node LOOKS (colour,
 * status dot, latency/cost/token rows, error snippet) with no dependency on
 * being mounted as a ReactFlow node type. Shared by `CustomNode` (the
 * read-only monitor's registered node type, which adds Handles around it) and
 * the Studio builder's editable canvas (FlowCanvas), so an edited node and a
 * live-executing node render identically.
 */
export function NodeCard({
  state,
  selected,
  onClick,
  barWidth,
  isTimeline,
  compact = false,
  emphasis,
}: NodeCardProps): React.JSX.Element {
  const colorClass = nodeTypeColor(state.nodeType);
  const isPending = state.status === "pending";
  const isRunning = state.status === "running";
  const isTool = state.kind === "tool";
  const status = statusIndicator(state.status);
  const statusRing = state.approval
    ? approvalRing(state.approval)
    : status.ring;
  // Selection is a deliberate user action, so it wins over the passive
  // status/approval ring: a selected node gets a bold, high-contrast ring plus
  // a lift (shadow + slight scale) so it's unmistakable even on the coloured,
  // ring-carrying cards. Unselected nodes keep their status/approval ring.
  const ringClass = selected
    ? "ring-4 ring-offset-2 ring-offset-background ring-info"
    : statusRing || (emphasis === "used" ? USED_RING : "");
  const badge = state.approval ? approvalBadge(state.approval) : null;
  const Icon = isTool ? Wrench : nodeTypeIcon(state.nodeType);
  const dimClass =
    emphasis === "unused"
      ? selected
        ? ""
        : "opacity-40 saturate-50"
      : emphasis === undefined && isPending && !selected
        ? "opacity-50"
        : "";
  const liftClass = selected
    ? "z-10 scale-[1.03] shadow-xl shadow-info/30 brightness-110"
    : emphasis === "used"
      ? "shadow-lg shadow-success/40"
      : "shadow-md";

  // Full error recording (type, message, diagnostics, failing tool result)
  // as a native hover tooltip — the card body only has room for a two-line
  // snippet. Undefined for nodes without error info, so healthy nodes carry
  // no title attribute at all.
  const errorTooltip = nodeErrorTooltip(state);

  return (
    /* biome-ignore lint/a11y/useSemanticElements: draggable React Flow node with block layout content; <button> would break the drag/resize handles */
    <div
      role="button"
      tabIndex={0}
      aria-label={`${isTool ? "Tool" : nodeTypeLabel(state.nodeType)} ${state.label} — ${state.status}${state.approval ? ` — approval ${state.approval}` : ""}`}
      title={errorTooltip}
      onClick={() => onClick?.(state)}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(state)}
      className={`
        relative w-full rounded-xl border-2 ${compact ? "px-2.5 py-1.5" : "px-3 py-2"} text-on-solid cursor-pointer
        hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-on-solid
        transition-all duration-150 select-none
        ${isTool ? "border-dashed" : ""}
        ${liftClass}
        ${colorClass} ${ringClass} ${dimClass}
      `}
      data-emphasis={emphasis}
      style={
        compact
          ? { width: EDITOR_NODE_W }
          : { minWidth: NODE_W, minHeight: NODE_H }
      }
    >
      {/* Duration bar — timeline mode only */}
      {isTimeline && barWidth != null && !isPending && (
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 h-1.5 rounded-tl-md rounded-br-md bg-card/85"
          style={{ width: Math.max(3, barWidth) }}
        />
      )}

      <div className={`flex items-start ${compact ? "gap-2" : "gap-2.5"}`}>
        {/* Type icon — tells the node types apart at a glance. */}
        <div
          aria-hidden
          data-testid="node-type-icon"
          className={`flex shrink-0 items-center justify-center rounded-lg bg-black/20 ring-1 ring-inset ring-on-solid/20 ${
            compact ? "h-9 w-9" : "h-10 w-10"
          }`}
        >
          <Icon size={compact ? 22 : 24} strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          {/* Top row: label + type badge */}
          <div
            className={`flex items-start justify-between gap-1 ${compact ? "mb-0.5" : "mb-1"}`}
          >
            <div
              className="font-semibold text-xs leading-snug"
              style={{
                maxWidth: "75%",
                wordBreak: "break-word",
                display: "-webkit-box",
                WebkitLineClamp: compact ? 2 : 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
              title={state.label}
            >
              {state.label}
            </div>
            <span className="shrink-0 text-[9px] uppercase tracking-wide bg-black/20 rounded px-1 py-0.5 leading-none mt-0.5">
              {nodeTypeLabel(state.nodeType)}
            </span>
          </div>

          {/* Subtitle row — editor-only static summary (e.g. "openai/gpt-4o-mini") */}
          {state.subtitle && (
            <div
              className="mb-0.5 truncate text-[10px] opacity-80"
              title={state.subtitle}
            >
              {state.subtitle}
            </div>
          )}

          {/* Middle row: status / latency / model — empty for idle editor nodes */}
          {(!compact ||
            state.status === "running" ||
            state.latency_ms != null ||
            state.model) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs opacity-85">
              {state.status === "running" && <span>{translate("nodeRenderer.running")}</span>}
              {state.latency_ms != null && state.status !== "running" && (
                <span>{state.latency_ms}ms</span>
              )}
              {state.model && (
                <span
                  className="text-[10px] opacity-80 truncate max-w-[110px]"
                  title={state.model}
                >
                  {state.model.split("/").pop()}
                </span>
              )}
            </div>
          )}

          {/* Approval badge */}
          {badge && (
            <span
              className={`inline-block rounded px-1 mt-0.5 text-[10px] font-semibold ${badge.className}`}
            >
              {badge.label}
            </span>
          )}

          {/* Tokens + cost row */}
          {(state.input_tokens != null ||
            state.output_tokens != null ||
            state.cost != null) && (
            <div className="flex items-center gap-2 mt-0.5 text-[10px] opacity-75">
              {state.input_tokens != null && <span>↑{state.input_tokens}</span>}
              {state.output_tokens != null && (
                <span>↓{state.output_tokens}</span>
              )}
              {state.cost != null && (
                <span className="font-semibold text-success">
                  ~{formatCost(state.cost)}
                </span>
              )}
            </div>
          )}

          {/* Error snippet — hover (the card or this line) for the full recording */}
          {state.status === "error" && state.error_message && (
            <div
              className="mt-1 cursor-help text-[10px] bg-danger-solid/80 rounded px-1.5 py-0.5 line-clamp-2 break-words"
              title={errorTooltip}
              data-testid="node-error-snippet"
            >
              {state.error_message}
            </div>
          )}
        </div>
      </div>

      {/* Sequence badge (top-left) */}
      {state.sequence != null && (
        <div className="absolute -top-2 -left-2 bg-card text-foreground text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center border border-border shadow-sm">
          {state.sequence}
        </div>
      )}

      {/* Running: a rotating border instead of a status dot. */}
      {isRunning && <div aria-hidden className="node-running-border" />}

      {/* Status dot (top-right). The compact (Studio editor) card leaves out the
          empty "pending" dot: without a run it carries no information and reads
          like an unconnected port. */}
      {!(compact && isPending) && !isRunning && (
        <div
          title={status.label}
          aria-hidden
          className={`absolute -top-2 -right-2 w-5 h-5 rounded-full border flex items-center justify-center text-[10px] font-bold shadow-sm ${status.dot}`}
        >
          {status.glyph}
        </div>
      )}
    </div>
  );
}

export function CustomNode({ data, selected }: NodeProps<CustomFlowNode>) {
  const { state, onClick, barWidth, isTimeline } = data;

  // In flow (Dagre TB) mode handles sit on Top/Bottom; in timeline LR.
  const targetPos = isTimeline ? Position.Left : Position.Top;
  const sourcePos = isTimeline ? Position.Right : Position.Bottom;

  return (
    <>
      <Handle type="target" position={targetPos} className="!bg-muted-foreground" />
      {/* Extra source handle for tool-call edges — sits at 50% of the side */}
      <Handle
        type="source"
        position={sourcePos}
        id="tool-output"
        className="!bg-subflow-solid"
        style={isTimeline ? { top: "50%" } : { left: "50%" }}
      />
      <NodeCard
        state={state}
        selected={selected}
        onClick={onClick}
        barWidth={barWidth}
        isTimeline={isTimeline}
      />
      <Handle type="source" position={sourcePos} className="!bg-muted-foreground" />
    </>
  );
}

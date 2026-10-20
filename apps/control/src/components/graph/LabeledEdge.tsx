"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";

/**
 * Edge whose label is part of the line: the text runs along the path (it
 * follows the curve) inside a capsule outlined in the edge's stroke colour, so
 * the line flows into the label frame instead of being cut by a label box.
 *
 * The capsule is the path itself, stroked thick and dashed down to the label's
 * extent around the midpoint: an outer stroke in the edge colour, an inner one
 * in the canvas colour, the text on top.
 *
 * A label longer than the edge keeps its beginning and is cut at the end
 * ("…"); the full text is the tooltip.
 *
 * Edges between the same two nodes are drawn on the same curve. The caller
 * numbers them (`data.labelSlot`), and each label then sits at its own spot
 * along the curve — 1/3 and 2/3 for two — instead of all in the middle.
 */

const FONT_SIZE = 11;
/** Capsule thickness (outer, edge colour) and the inner fill inset. */
const CAPSULE_W = 17;
const BORDER_W = 1.5;
/** Horizontal breathing room inside the capsule (round caps add CAPSULE_W/2 per side). */
const PAD = 2;
/** Fallback when the DOM can't measure (SSR, jsdom). */
const APPROX_CHAR_W = 6.2;

type PathKind = "bezier" | "smoothstep";

function buildPath(
  kind: PathKind,
  sx: number,
  sy: number,
  sp: Position,
  tx: number,
  ty: number,
  tp: Position,
): string {
  const args = {
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sp,
    targetX: tx,
    targetY: ty,
    targetPosition: tp,
  };
  if (kind !== "smoothstep") return getBezierPath(args)[0];
  // A step leaves each handle straight for `offset` px (default 20). When the
  // two handles are closer than twice that, both stubs overshoot the middle
  // and the path zigzags there — right where the label sits. Keep them within
  // half the gap.
  const gap = sp === "left" || sp === "right" ? Math.abs(tx - sx) : Math.abs(ty - sy);
  return getSmoothStepPath({ ...args, offset: Math.min(20, gap / 2) })[0];
}

/** This edge's label position among edges between the same two nodes. */
export interface LabelSlot {
  index: number;
  count: number;
}

function labelSlot(data: unknown): LabelSlot {
  const s = (data as { labelSlot?: Partial<LabelSlot> } | undefined)?.labelSlot;
  return typeof s?.index === "number" && typeof s.count === "number" && s.count > 1 && s.index >= 0 && s.index < s.count
    ? { index: s.index, count: s.count }
    : { index: 0, count: 1 };
}

interface Measure {
  length: number;
  /** Width of the full label text. */
  textWidth: number;
  /** Text would render upside down along the forward path. */
  flip: boolean;
}

function LabeledEdgeImpl({
  kind,
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  label,
  data,
  style,
  markerEnd,
  markerStart,
  interactionWidth,
}: EdgeProps & { kind: PathKind }) {
  const path = buildPath(kind, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition);
  // Same route drawn target → source, used for the text when the forward
  // direction would put it upside down.
  const reversed = buildPath(kind, targetX, targetY, targetPosition, sourceX, sourceY, sourcePosition);
  const text = typeof label === "string" && label.length > 0 ? label : undefined;
  // The caller may have shortened `label` already; `data.fullLabel` is the original.
  const fullText = typeof data?.fullLabel === "string" && data.fullLabel.length > 0 ? data.fullLabel : text;

  const pathRef = useRef<SVGPathElement>(null);
  // Measures the FULL label (hidden) — the visible one may be shortened.
  const measureRef = useRef<SVGTextElement>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  useLayoutEffect(() => {
    if (!text || path.length === 0) return;
    const p = pathRef.current;
    const t = measureRef.current;
    let length = 0;
    let flip = targetX < sourceX;
    try {
      length = p?.getTotalLength?.() ?? 0;
      if (p && length > 2) {
        const a = p.getPointAtLength(length / 2 - 1);
        const b = p.getPointAtLength(length / 2 + 1);
        const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        // Keep text readable; vertical runs always read top → bottom.
        flip = angle > 100 || angle < -80;
      }
    } catch {
      length = 0;
    }
    let textWidth = text.length * APPROX_CHAR_W;
    try {
      const w = t?.getComputedTextLength?.();
      if (w && w > 0) textWidth = w;
    } catch {
      // keep the estimate
    }
    setMeasure((prev) =>
      prev && prev.length === length && prev.textWidth === textWidth && prev.flip === flip
        ? prev
        : { length, textWidth, flip },
    );
  }, [path, text, sourceX, targetX]);

  const reactId = useId();
  const textPathId = `edge-label-path-${reactId.replace(/:/g, "")}-${id}`;

  const color = typeof style?.stroke === "string" ? style.stroke : undefined;
  const background =
    "var(--xy-edge-label-background-color, var(--xy-edge-label-background-color-default))";
  const textFill = color ?? "var(--xy-edge-label-color, var(--xy-edge-label-color-default))";

  const length = measure?.length ?? 0;
  // Where along the curve this label is centred, and how much of the curve it
  // may take: all of it alone, an equal share next to parallel edges' labels.
  const slot = labelSlot(data);
  const center = (slot.index + 1) / (slot.count + 1);
  // Room for text along the edge, and the part of the label that fits in it:
  // cut at the end, never in the middle.
  // A step edge turns twice; its middle point sits on the straight middle
  // run (vertical between side handles), so the label must fit on that run —
  // text bent round a corner piles its glyphs up.
  const sideHandles = sourcePosition === "left" || sourcePosition === "right";
  const straightRun =
    kind === "smoothstep"
      ? Math.abs(sideHandles ? targetY - sourceY : targetX - sourceX) - CAPSULE_W / 2
      : Number.POSITIVE_INFINITY;
  const room = Math.max(
    0,
    Math.min(length - CAPSULE_W * 2, length / slot.count - CAPSULE_W, straightRun) - PAD * 2,
  );
  const fullWidth = measure?.textWidth ?? 0;
  let shown = text;
  let shownWidth = fullWidth;
  if (text && measure && length > 0 && fullWidth > room) {
    const chars = Math.floor((text.length * room) / fullWidth) - 1;
    shown = chars > 0 ? `${text.slice(0, chars).trimEnd()}…` : "";
    shownWidth = chars > 0 ? (fullWidth * (chars + 1)) / text.length : 0;
  }
  const segment = Math.min(shownWidth + PAD * 2, room + PAD * 2);
  const capsuleDash =
    length > 0 && segment > 0
      ? { strokeDasharray: `${segment} ${length}`, strokeDashoffset: -(center * length - segment / 2) }
      : undefined;
  // Only draw the frame when the label actually fits on the edge.
  const fits = capsuleDash !== undefined && shown !== "" && shownWidth + PAD * 2 <= segment + 0.5;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        {...(markerEnd !== undefined ? { markerEnd } : {})}
        {...(markerStart !== undefined ? { markerStart } : {})}
        {...(interactionWidth !== undefined ? { interactionWidth } : {})}
      />
      {text && (
        <g className="react-flow__edge-inline-label" data-testid={`edge-label-${id}`}>
          {shown !== fullText && <title>{fullText}</title>}
          <path ref={pathRef} d={path} fill="none" stroke="none" />
          <path id={textPathId} d={measure?.flip ? reversed : path} fill="none" stroke="none" />
          {fits && (
            <>
              <path
                d={path}
                className="react-flow__edge-path"
                style={{
                  ...(color ? { stroke: color } : {}),
                  strokeWidth: CAPSULE_W,
                  strokeLinecap: "round",
                  strokeDasharray: capsuleDash.strokeDasharray,
                  strokeDashoffset: capsuleDash.strokeDashoffset,
                  fill: "none",
                }}
              />
              <path
                d={path}
                style={{
                  stroke: background,
                  strokeWidth: CAPSULE_W - BORDER_W * 2,
                  strokeLinecap: "round",
                  strokeDasharray: capsuleDash.strokeDasharray,
                  strokeDashoffset: capsuleDash.strokeDashoffset,
                  fill: "none",
                }}
              />
            </>
          )}
          <text
            dy="0.35em"
            style={{
              fontSize: FONT_SIZE,
              fontWeight: 600,
              fill: textFill,
              stroke: fits ? "none" : background,
              strokeWidth: fits ? 0 : 3,
              paintOrder: "stroke",
              // Hidden until measured, so it never flashes at the wrong spot.
              visibility: measure ? "visible" : "hidden",
            }}
          >
            <textPath
              href={`#${textPathId}`}
              // The reversed path runs target → source: mirror the position.
              startOffset={`${(measure?.flip ? 1 - center : center) * 100}%`}
              textAnchor="middle"
            >
              {shown}
            </textPath>
          </text>
          <text
            ref={measureRef}
            aria-hidden
            style={{ fontSize: FONT_SIZE, fontWeight: 600, visibility: "hidden" }}
          >
            {text}
          </text>
        </g>
      )}
    </>
  );
}

export function LabeledBezierEdge(props: EdgeProps) {
  return <LabeledEdgeImpl {...props} kind="bezier" />;
}

export function LabeledSmoothStepEdge(props: EdgeProps) {
  return <LabeledEdgeImpl {...props} kind="smoothstep" />;
}

/**
 * A single data-flow channel line: one payload (query, image, tool, result)
 * that a traced run carried over an edge. Drawn beside the edge's base line —
 * the SAME bezier the base edge uses (type "labeled"), with both ends shifted
 * sideways by `data.offset` perpendicular to the handle direction — so several
 * payloads on one edge render as parallel lanes next to each other instead of
 * piling onto one curve. In the payload kind's color, with a dot at the
 * source end marking where each lane starts.
 *
 * Selectable: clicking it opens the property panel with the full list of
 * payloads that crossed the logical edge (`data.logicalEdgeId`).
 */
function ChannelEdgeImpl({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const offset =
    typeof data?.offset === "number" && Number.isFinite(data.offset)
      ? data.offset
      : 0;
  // Lanes run perpendicular to the direction the edge leaves its handles:
  // top/bottom handles → shift sideways (x), left/right → shift vertically (y).
  // Shifting BOTH ends keeps the bezier parallel to the base edge's curve.
  const vertical =
    sourcePosition === Position.Top || sourcePosition === Position.Bottom;
  const sx = vertical ? sourceX + offset : sourceX;
  const sy = vertical ? sourceY : sourceY + offset;
  const tx = vertical ? targetX + offset : targetX;
  const ty = vertical ? targetY : targetY + offset;
  const path = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition,
    targetX: tx,
    targetY: ty,
    targetPosition,
  })[0];
  // Fallback stroke: the token is an HSL triplet (globals.css) and must be
  // wrapped in hsl() to be a valid stroke color.
  const stroke =
    typeof data?.color === "string" ? data.color : "hsl(var(--edge-used))";
  const title = typeof data?.title === "string" ? data.title : undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: selected ? 3 : 2,
          opacity: selected ? 1 : 0.85,
        }}
      />
      {/* Source-end dot on the lane's own start, so the bundle reads as
          separate lines even where they converge at the handle. */}
      <circle cx={sx} cy={sy} r={selected ? 4 : 3} style={{ fill: stroke }} />
      {title !== undefined && <title>{title}</title>}
    </>
  );
}

export const labeledEdgeTypes = {
  labeled: LabeledBezierEdge,
  labeledStep: LabeledSmoothStepEdge,
  channel: ChannelEdgeImpl,
};

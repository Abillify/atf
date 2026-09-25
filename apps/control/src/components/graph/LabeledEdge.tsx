"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
  type Position,
} from "@xyflow/react";

/**
 * Edge whose label is part of the line: the text runs along the path (it
 * follows the curve) inside a capsule outlined in the edge's stroke colour, so
 * the line flows into the label frame instead of being cut by a label box.
 *
 * The capsule is the path itself, stroked thick and dashed down to the label's
 * extent around the midpoint: an outer stroke in the edge colour, an inner one
 * in the canvas colour, the text on top.
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
  return kind === "smoothstep" ? getSmoothStepPath(args)[0] : getBezierPath(args)[0];
}

interface Measure {
  length: number;
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

  const pathRef = useRef<SVGPathElement>(null);
  const textRef = useRef<SVGTextElement>(null);
  const [measure, setMeasure] = useState<Measure | null>(null);

  useLayoutEffect(() => {
    if (!text || path.length === 0) return;
    const p = pathRef.current;
    const t = textRef.current;
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
  const segment = Math.min((measure?.textWidth ?? 0) + PAD * 2, Math.max(0, length - CAPSULE_W * 2));
  const capsuleDash =
    length > 0 && segment > 0
      ? { strokeDasharray: `${segment} ${length}`, strokeDashoffset: -(length - segment) / 2 }
      : undefined;
  // Only draw the frame when the label actually fits on the edge.
  const fits = capsuleDash !== undefined && (measure?.textWidth ?? 0) + PAD * 2 <= segment;

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
            ref={textRef}
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
            <textPath href={`#${textPathId}`} startOffset="50%" textAnchor="middle">
              {text}
            </textPath>
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

export const labeledEdgeTypes = {
  labeled: LabeledBezierEdge,
  labeledStep: LabeledSmoothStepEdge,
};

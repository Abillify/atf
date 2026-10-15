"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useRef } from "react";
import { translate } from "../lib/i18n";

/**
 * Vertical drag handle that resizes the panel next to it. Place it as a flex
 * sibling directly in front of (`side="left"`) or behind (`side="right"`) the
 * panel: with `side="left"` — the usual case for right-hand panels — dragging
 * the handle to the LEFT widens the panel.
 *
 * Pointer capture keeps the drag alive even when the cursor leaves the handle
 * (over the canvas, where React Flow would otherwise steal the events).
 * Keyboard-accessible: focus the separator and use ←/→; double-click resets
 * to the default width.
 */
export function ResizeHandle({
  side,
  width,
  onWidth,
  min,
  max,
  initial,
  label,
}: {
  /** Which edge of the panel the handle sits on. */
  side: "left" | "right";
  width: number;
  onWidth: (next: number) => void;
  min: number;
  max: number;
  /** Width a double-click restores. */
  initial: number;
  label: string;
}): React.JSX.Element {
  const startRef = useRef<{ x: number; w: number } | null>(null);
  // +1 for a left-edge handle dragged left, -1 for a right-edge one.
  const sign = side === "left" ? -1 : 1;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, w: width };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = startRef.current;
    if (start === null) return;
    onWidth(start.w + sign * (e.clientX - start.x));
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    startRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onWidth(width + (side === "left" ? step : -step));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onWidth(width + (side === "left" ? -step : step));
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: <hr> cannot carry the pointer/keyboard handlers or the aria-valuenow of a resizable separator
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={translate("resizeHandle.labelDragOrFocusAnd", { label })}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onWidth(initial)}
      onKeyDown={onKeyDown}
      className="w-1.5 shrink-0 cursor-col-resize touch-none select-none rounded-full bg-transparent transition-colors hover:bg-primary/40 focus-visible:bg-primary/60 focus-visible:outline-none"
    />
  );
}

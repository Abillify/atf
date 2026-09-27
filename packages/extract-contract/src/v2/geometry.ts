// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * v2/geometry.ts
 *
 * Bounding-box helpers for v2, in the same coordinate space as v1
 * (`[x1, y1, x2, y2]`, normalised to `[0,1]`, origin top-left) but kept
 * independent of the v1 marker module so the v2 surface has no v1 import.
 */

import type { BBox } from "./records.js";

/** Number of decimals a formatted bbox coordinate carries. */
export const BBOX_PRECISION = 4;

/** True when the box is inside `[0,1]`, correctly ordered and has area. */
export function isValidBoundingBoxTuple(bbox: BBox): boolean {
  const [x1, y1, x2, y2] = bbox;
  return (
    [x1, y1, x2, y2].every((v) => Number.isFinite(v) && v >= 0 && v <= 1) &&
    x2 > x1 &&
    y2 > y1
  );
}

/** Clamp, order and round a box into the contract's coordinate space. */
export function normalizeBoundingBoxTuple(bbox: BBox): BBox {
  const clamp = (value: number): number =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const round = (value: number): number =>
    Number.parseFloat(value.toFixed(BBOX_PRECISION));
  const [rawX1, rawY1, rawX2, rawY2] = bbox;
  const x1 = clamp(rawX1);
  const y1 = clamp(rawY1);
  const x2 = clamp(rawX2);
  const y2 = clamp(rawY2);
  return [
    round(Math.min(x1, x2)),
    round(Math.min(y1, y2)),
    round(Math.max(x1, x2)),
    round(Math.max(y1, y2)),
  ];
}

/** `[0.1204, 0.3388, 0.4810, 0.7204]` */
export function formatBoundingBoxTuple(bbox: BBox): string {
  return `[${bbox.map((v) => v.toFixed(BBOX_PRECISION)).join(", ")}]`;
}

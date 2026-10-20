// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: ids, prefixes and pure constants of the canvas, moved out of
// FlowCanvas.tsx without behavior change.

import { BOUNDARY_EDGE_PREFIX } from "../../lib/flow-boundaries";
import { isChannelEdgeId } from "../../lib/edge-channels";
import type { ReferenceKind } from "../../lib/flow-graph";

export const SUBFLOW_BOX_PREFIX = "subflow-box:";
/** Handle ids of tool connections (reference edges). Flow edges use the unnamed
 top/bottom handles. */
export const TOOL_OUT = "tool-out";
export const TOOL_IN = "tool-in";
/** Handle a node's tool row docks to, and the ids of the row and its link. */
export const TOOLS_RAIL_OUT = "tools-rail-out";
export const TOOL_RAIL_PREFIX = "tool-rail:";
export const TOOL_RAIL_EDGE_PREFIX = "tool-rail-edge:";
export const isToolRailId = (id: string): boolean => id.startsWith(TOOL_RAIL_PREFIX);
/** Display-only edges: not flow edges, never reported or changed. Channel
 * lines (edge data flow) are synthetic too — only their logical edge is. */
export const isOverlayEdgeId = (id: string): boolean =>
  id.startsWith(BOUNDARY_EDGE_PREFIX) ||
  id.startsWith(TOOL_RAIL_EDGE_PREFIX) ||
  isChannelEdgeId(id);
/** Stroke of an edge the traced run went along (design token, see globals.css).
 * The token is an HSL triplet, so it must be wrapped in hsl() to be a valid
 * `stroke` value — a bare var() computes to `none` (invisible edges). */
export const USED_EDGE_STROKE = "hsl(var(--edge-used))";

/** Canvas-only label shortening; the full text stays in the edge's data and
 * is shown/edited in the properties panel. */
export const MAX_EDGE_LABEL = 36;
export function shortLabel(label: unknown): string | undefined {
  if (typeof label !== "string" || label.length === 0) return undefined;
  return label.length > MAX_EDGE_LABEL ? `${label.slice(0, MAX_EDGE_LABEL - 1)}…` : label;
}

/** Reference links are drawn dashed and muted so they read as "wired via a
 * node setting", not as a routing edge you can select or delete. */
export const REFERENCE_STYLE: Record<ReferenceKind, { stroke: string; dash: string }> =
  {
    parallel: { stroke: "hsl(var(--edge-parallel))", dash: "6 4" },
    verifies: { stroke: "hsl(var(--edge-verifies))", dash: "2 4" },
    delegates: { stroke: "hsl(var(--edge-delegates))", dash: "5 4" },
  };

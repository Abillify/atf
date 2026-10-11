"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: overlay measurements (ghost/boundary/tool-rail nodes) and the
// canvas change handlers, moved out of FlowCanvas.tsx without
// behavior change.

import { useCallback, useMemo, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import type { RFEdge, RFNode } from "../lib/flow-graph";
import type { GhostRFNode } from "../lib/flow-diff-view";
import { isBoundaryId } from "../lib/flow-boundaries";
import { isChannelEdgeId } from "../lib/edge-channels";
import type { EdgeFlowRecord } from "../lib/run-samples";
import {
  isOverlayEdgeId,
  isToolRailId,
  SUBFLOW_BOX_PREFIX,
} from "../components/graph/canvasIds";

export type UseCanvasOverlayParams = {
  nodes: RFNode[];
  edges: RFEdge[];
  editable: boolean;
  onNodesChange?: (nodes: RFNode[]) => void;
  onEdgesChange?: (edges: RFEdge[]) => void;
  ghostNodes?: GhostRFNode[];
  edgeFlows?: EdgeFlowRecord[];
};

export function useCanvasOverlay({
  nodes,
  edges,
  editable,
  onNodesChange,
  onEdgesChange,
  ghostNodes,
  edgeFlows,
}: UseCanvasOverlayParams) {
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

  return {
    overlaySizes,
    selectedBoundaryId,
    handleNodesChange,
    selectedChannelIds,
    handleEdgesChange,
  };
}

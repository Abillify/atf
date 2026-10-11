"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: the canvas graphics (boundary layout, tool rows, ghost boxes,
// renderNodes/renderEdges), moved out of FlowCanvas.tsx without
// behavior change.

import { useMemo } from "react";
import type { Edge } from "@xyflow/react";
import { subflowBoxes, subflowColorIndex } from "../lib/subflows";
import {
  TOOL_RAIL_GAP,
  toolCallsByParent,
  toolChipsFor,
  toolRailSize,
} from "../lib/tool-chips";
import type { RFNode, RFEdge, ReferenceEdge } from "../lib/flow-graph";
import type { NodeLike, EdgeLike } from "../lib/edge-rules";
import type { DiffInfo, GhostRFNode } from "../lib/flow-diff-view";
import {
  CHANNEL_COLORS,
  CHANNEL_STATUS_LABEL,
  channelEdgeId,
  latestFlowsByPair,
  pairKey,
} from "../lib/edge-channels";
import type { EdgeFlowRecord } from "../lib/run-samples";
import {
  boundaryEndEdgeId,
  boundaryStartEdgeId,
  END_ID,
  RESPONSE_EVENT_ID,
  START_ID,
  flowBoundaries,
} from "../lib/flow-boundaries";
import type { NodeState } from "../components/graph/graphUtils";
import { EDITOR_NODE_W, EDITOR_NODE_H } from "../components/graph/GraphLayoutEngine";
import {
  BOUNDARY_GAP,
  BOUNDARY_H,
  BOUNDARY_W,
  type BoundaryCardInfo,
  type EdgeValidationState,
  type NodeValidationState,
} from "../components/graph/CustomNodes";
import {
  REFERENCE_STYLE,
  SUBFLOW_BOX_PREFIX,
  TOOL_IN,
  TOOL_OUT,
  TOOL_RAIL_EDGE_PREFIX,
  TOOL_RAIL_PREFIX,
  TOOLS_RAIL_OUT,
  USED_EDGE_STROKE,
  shortLabel,
} from "../components/graph/canvasIds";

export type UseCanvasGraphParams = {
  nodes: RFNode[];
  edges: RFEdge[];
  editable: boolean;
  liveStates?: Map<string, NodeState>;
  nodeValidation?: Map<string, NodeValidationState>;
  edgeValidation?: Map<string, EdgeValidationState>;
  nodeDiff?: Map<string, DiffInfo>;
  edgeDiff?: Map<string, DiffInfo>;
  ghostNodes?: GhostRFNode[];
  ghostEdges?: RFEdge[];
  nodeOrigins?: Record<string, string>;
  referenceEdges?: ReferenceEdge[];
  showReferences: boolean;
  boundaries?: { start: BoundaryCardInfo; end: BoundaryCardInfo };
  selectedSubflowPath?: string | null;
  onSelectSubflow?: (path: string) => void;
  onToolClick?: (nodeId: string, tool: string) => void;
  edgeFlows?: EdgeFlowRecord[];
  ruleNodes: NodeLike[];
  ruleEdges: EdgeLike[];
  overlaySizes: Map<string, { width: number; height: number }>;
  selectedBoundaryId: string | null;
  selectedChannelIds: Set<string>;
};

export function useCanvasGraph({
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
}: UseCanvasGraphParams) {
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
      const hasWarning =
        !hasError && (validationState?.warnings.length ?? 0) > 0;
      const color = hasError
        ? "var(--edge-error)"
        : hasWarning
          ? "var(--edge-active)"
          : diffState?.status === "added"
            ? "var(--edge-added)"
            : diffState?.status === "changed"
              ? "var(--edge-active)"
              : diffState?.status === "removed"
                ? "var(--edge-removed)"
                : undefined;
      if (color === undefined) {
        if (!runActive) return [e];
        if (!usedEdge(edge.source, edge.target))
          return [{ ...e, style: { opacity: 0.35 } }];
        // The run went this way: one colored channel line per payload the
        // runtime recorded for this edge. The channels REPLACE the base edge
        // — as many lines as the panel lists payloads; clicking a channel
        // still opens this edge's properties (logicalEdgeId).
        const channels = channelEdgesFor(e.id, edge.source, edge.target);
        if (channels.length > 0) return channels;
        return [
          { ...e, style: { stroke: USED_EDGE_STROKE, strokeWidth: 2.5 } },
        ];
      }
      return [
        {
          ...e,
          style: {
            stroke: color,
            strokeWidth: 2,
            ...(diffState?.status === "removed"
              ? { strokeDasharray: "4 3" }
              : {}),
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
                      style: boundaryStyle(used, USED_EDGE_STROKE),
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
                      style: boundaryStyle(used, "var(--edge-idle)"),
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
              stroke: "var(--edge-tool)",
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
          stroke: added ? "var(--edge-added)" : "var(--edge-removed)",
          strokeWidth: 2,
          strokeDasharray: "4 3",
        },
        label: e.label ?? (added ? "proposed" : "removed"),
        selectable: false,
      };
    });
    return [...real, ...refs, ...railEdges, ...ghosts, ...implicit];
  }, [edges, nodes, edgeValidation, edgeDiff, ghostEdges, referenceEdges, showReferences, boundaryLayout, liveStates, runActive, toolRails, edgeFlows, selectedChannelIds]);

  return { renderNodes, renderEdges };
}

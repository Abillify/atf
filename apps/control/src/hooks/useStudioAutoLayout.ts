"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Auto layout and delegation reference edges of the Studio builder (Req 9.3,
 * Task 13.4): one-click hierarchy via Dagre plus the reference edges that
 * show a harness delegation while it is selected. Split out of
 * `components/StudioBuilder.tsx` without behavior change.
 */

import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { layoutEditorGraph, referenceEdges as deriveReferenceEdges, type RFEdge, type RFNode } from "../lib/flow-graph";

export function useStudioAutoLayout({
  nodes,
  edges,
  nodeOrigins,
  selectedNodeIds,
  setNodes,
}: {
  nodes: RFNode[];
  edges: RFEdge[];
  nodeOrigins: Record<string, string>;
  selectedNodeIds: string[];
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
}): {
  fitViewNonce: number;
  setFitViewNonce: Dispatch<SetStateAction<number>>;
  handleAutoLayout: () => void;
  referenceEdges: ReturnType<typeof deriveReferenceEdges>;
} {
  const [fitViewNonce, setFitViewNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleAutoLayout = useCallback(() => {
    setNodes((ns) => {
      // Lay out with the sizes React Flow actually rendered, so long labels
      // can't make neighbours overlap.
      const sizes = new Map<string, { width: number; height: number }>();
      for (const n of ns) {
        const m = (n as { measured?: { width?: number; height?: number } })
          .measured;
        if (m?.width && m.height)
          sizes.set(n.id, { width: m.width, height: m.height });
      }
      const positions = layoutEditorGraph(
        ns.map((n) => n.data.flowNode),
        edges.map((e) => ({
          source: e.source,
          target: e.target,
          ...(e.label ? { label: e.label } : {}),
        })),
        sizes,
        nodeOrigins,
      );
      return ns.map((n) => ({
        ...n,
        position: positions[n.id] ?? n.position,
      }));
    });
    setFitViewNonce((v) => v + 1);
  }, [edges, nodeOrigins]);

  // Delegation links fan out from a harness to half the flow; draw them only
  // while that harness is selected so they explain it without cluttering —
  // except to a node with no other link at all (a worker only the harness
  // calls), which would otherwise float unconnected on the canvas.
  const referenceEdges = useMemo(() => {
    const refs = deriveReferenceEdges(nodes.map((n) => n.data.flowNode));
    const linked = new Set<string>();
    for (const e of edges) {
      linked.add(e.source);
      linked.add(e.target);
    }
    for (const r of refs) if (r.kind !== "delegates") linked.add(r.target);
    return refs.filter(
      (r) =>
        r.kind !== "delegates" ||
        selectedNodeIds.includes(r.source) ||
        !linked.has(r.target),
    );
  }, [nodes, edges, selectedNodeIds]);

  return { fitViewNonce, setFitViewNonce, handleAutoLayout, referenceEdges };
}

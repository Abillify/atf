"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Undo/redo history of the Studio builder (Req 9.3, Task 13.4): debounced
 * pushes, applying snapshots and the undo/redo handlers.
 * Split out of `components/StudioBuilder.tsx`; the code is taken over
 * unchanged, only state and setters are passed through as parameters.
 */

import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { FlowDefinition } from "../types/flow";
import type { RFEdge, RFNode } from "../lib/flow-graph";
import type { useFlowHistory } from "../lib/flow-history";

export function useStudioHistory({
  skipHistoryRef,
  nodes,
  edges,
  base,
  nodeOrigins,
  history,
  setNodes,
  setEdges,
  setBase,
  setNodeOrigins,
}: {
  skipHistoryRef: { current: boolean };
  nodes: RFNode[];
  edges: RFEdge[];
  base: FlowDefinition;
  nodeOrigins: Record<string, string>;
  history: ReturnType<typeof useFlowHistory>;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  setBase: Dispatch<SetStateAction<FlowDefinition>>;
  setNodeOrigins: Dispatch<SetStateAction<Record<string, string>>>;
}): {
  handleUndo: () => void;
  handleRedo: () => void;
} {
  // -------------------------------------------------------------------------
  // Undo/redo history — debounced so a drag gesture or a burst of edits
  // becomes one history entry (see flow-history.ts for the coalescing logic).
  // -------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      return;
    }
    const t = setTimeout(
      () => history.maybePush({ nodes, edges, base, nodeOrigins }),
      400,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, base, nodeOrigins]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const applySnapshot = useCallback(
    (snap: {
      nodes: RFNode[];
      edges: RFEdge[];
      base?: FlowDefinition;
      nodeOrigins?: Record<string, string>;
    }) => {
      skipHistoryRef.current = true;
      setNodes(snap.nodes);
      setEdges(snap.edges);
      if (snap.base) setBase(snap.base);
      if (snap.nodeOrigins) setNodeOrigins(snap.nodeOrigins);
    },
    [],
  );

  const handleUndo = useCallback(() => {
    const snap = history.undo();
    if (snap) applySnapshot(snap);
  }, [history, applySnapshot]);

  const handleRedo = useCallback(() => {
    const snap = history.redo();
    if (snap) applySnapshot(snap);
  }, [history, applySnapshot]);

  return { handleUndo, handleRedo };
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Copilot focus of the Studio builder (Req 9.3, Task 13.4): what is reported
 * to the Copilot as the selection, accepting a suggestion, focus/selection
 * tracking in the settings fields and the outward `onInspect` report.
 * Split out of `components/StudioBuilder.tsx`; the code is taken over
 * unchanged, only state and setters are passed through as parameters.
 */

import type React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { CopilotFocus } from "../components/FlowCopilotPanel";
import type { DiffOverlay } from "../lib/flow-diff-view";
import { flowToGraph, type RFEdge, type RFNode } from "../lib/flow-graph";
import type { FlowDefinition } from "../types/flow";

export function useStudioCopilot({
  nodes,
  edges,
  selNode,
  selEdge,
  selectedNodeIds,
  diffOverlay,
  setBase,
  setNodes,
  setEdges,
  setNodeOrigins,
  onInspect,
}: {
  nodes: RFNode[];
  edges: RFEdge[];
  selNode: string | null;
  selEdge: string | null;
  selectedNodeIds: string[];
  diffOverlay: DiffOverlay | undefined;
  setBase: Dispatch<SetStateAction<FlowDefinition>>;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  setNodeOrigins: Dispatch<SetStateAction<Record<string, string>>>;
  onInspect?: (info: { nodeId: string; type: string; field?: string } | null) => void;
}): {
  handleCopilotAccept: (proposed: FlowDefinition) => void;
  selectedFlowNode: RFNode["data"]["flowNode"] | null;
  focusedField: string | undefined;
  setFocusedField: Dispatch<SetStateAction<string | undefined>>;
  setFieldSelection: Dispatch<SetStateAction<string | undefined>>;
  handlePanelSelect: (e: React.SyntheticEvent) => void;
  copilotFocus: CopilotFocus | undefined;
} {
  // -------------------------------------------------------------------------
  // Copilot accept — replaces the canvas state with the accepted proposal.
  // Picked up by the debounced history effect as a normal, undoable edit.
  // -------------------------------------------------------------------------
  // Latest proposal preview, so accepting places new nodes where the preview
  // showed them.
  const diffOverlayRef = useRef<DiffOverlay | undefined>(undefined);
  diffOverlayRef.current = diffOverlay;

  const handleCopilotAccept = useCallback(
    (proposed: FlowDefinition): void => {
      setBase(proposed);
      const g = flowToGraph(proposed);
      // Existing nodes stay exactly where they are on the canvas; new ones take
      // the position the preview showed. Only if neither applies does the
      // proposal's own layout decide.
      const current = new Map(nodes.map((n) => [n.id, n.position]));
      const previewed = new Map(
        (diffOverlayRef.current?.ghostNodes ?? []).map((n) => [
          n.id,
          n.position,
        ]),
      );
      const placed = g.nodes.map((n) => ({
        ...n,
        position: current.get(n.id) ?? previewed.get(n.id) ?? n.position,
      }));
      setNodes(placed);
      setEdges(g.edges);
      setNodeOrigins(g.nodeOrigins ?? {});
    },
    [nodes, setBase, setNodes, setEdges, setNodeOrigins],
  );

  const selectedFlowNode = useMemo(
    () => nodes.find((n) => n.id === selNode)?.data.flowNode ?? null,
    [nodes, selNode],
  );
  const inspectedId = selectedFlowNode?.id;
  const inspectedType = selectedFlowNode?.type;

  const [focusedField, setFocusedField] = useState<string | undefined>(
    undefined,
  );
  /** Text selected in the focused settings field (for the Copilot). */
  const [fieldSelection, setFieldSelection] = useState<string | undefined>(
    undefined,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: inspectedId is the reset trigger, not a read — switching the inspected node clears focus & selection
  useEffect(() => {
    setFocusedField(undefined);
    setFieldSelection(undefined);
  }, [inspectedId]);

  // Remember the selection inside a settings field — it survives the click
  // into the Copilot, which moves the focus away.
  const handlePanelSelect = useCallback((e: React.SyntheticEvent) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (
      typeof el.selectionStart !== "number" ||
      typeof el.selectionEnd !== "number"
    )
      return;
    const text = el.value.slice(el.selectionStart, el.selectionEnd);
    setFieldSelection(text.trim() === "" ? undefined : text);
  }, []);

  // What the Copilot is told the user has selected.
  const copilotFocus = useMemo<CopilotFocus | undefined>(() => {
    const nodeIds =
      selectedNodeIds.length > 0 ? selectedNodeIds : selNode ? [selNode] : [];
    const e = selEdge ? edges.find((x) => x.id === selEdge) : undefined;
    if (nodeIds.length === 0 && !e) return undefined;
    const single = nodeIds.length === 1;
    return {
      nodeIds,
      ...(e ? { edge: { source: e.source, target: e.target } } : {}),
      ...(single && focusedField ? { field: focusedField } : {}),
      ...(single && focusedField && fieldSelection ? { fieldSelection } : {}),
    };
  }, [selectedNodeIds, selNode, selEdge, edges, focusedField, fieldSelection]);

  useEffect(() => {
    onInspect?.(
      inspectedId && inspectedType
        ? {
            nodeId: inspectedId,
            type: inspectedType,
            ...(focusedField ? { field: focusedField } : {}),
          }
        : null,
    );
  }, [inspectedId, inspectedType, focusedField, onInspect]);

  return {
    handleCopilotAccept,
    selectedFlowNode,
    focusedField,
    setFocusedField,
    setFieldSelection,
    handlePanelSelect,
    copilotFocus,
  };
}

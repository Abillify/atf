"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Bulk actions of the Studio builder (Req 9.3, Task 13.4): delete, duplicate,
 * copy/paste and select-all for multi-selection. Split out of
 * `components/StudioBuilder.tsx` without behavior change.
 */

import {
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { uniqueId, type RFNode } from "../lib/flow-graph";

export function useStudioBulkActions({
  removeNodes,
  selectedNodeIds,
  setNodes,
  setSelNode,
  setSelectedNodeIds,
}: {
  removeNodes: (ids: string[]) => void;
  selectedNodeIds: string[];
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setSelNode: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
}): {
  handleBulkDelete: () => void;
  handleDuplicateSelected: () => void;
  handleCopySelected: () => void;
  handlePaste: () => void;
  handleSelectAll: () => void;
} {
  const clipboardRef = useRef<RFNode[]>([]);

  const handleBulkDelete = useCallback(() => {
    removeNodes(selectedNodeIds);
  }, [selectedNodeIds, removeNodes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleDuplicateSelected = useCallback(() => {
    setNodes((ns) => {
      const selected = ns.filter((n) => n.selected);
      if (selected.length === 0) return ns;
      const takenIds = ns.map((n) => n.id);
      const clones: RFNode[] = [];
      for (const n of selected) {
        const newId = uniqueId(n.id, [...takenIds, ...clones.map((c) => c.id)]);
        clones.push({
          id: newId,
          type: "flowNode",
          position: { x: n.position.x + 40, y: n.position.y + 40 },
          data: { flowNode: { ...n.data.flowNode, id: newId } },
          selected: true,
        });
      }
      const newIds = clones.map((c) => c.id);
      setSelectedNodeIds(newIds);
      setSelNode(newIds.length === 1 ? newIds[0]! : null);
      return [...ns.map((n) => ({ ...n, selected: false })), ...clones];
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleCopySelected = useCallback(() => {
    setNodes((ns) => {
      clipboardRef.current = ns.filter((n) => n.selected);
      return ns;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    setNodes((ns) => {
      const takenIds = ns.map((n) => n.id);
      const clones: RFNode[] = [];
      for (const n of clipboardRef.current) {
        const newId = uniqueId(n.id, [...takenIds, ...clones.map((c) => c.id)]);
        clones.push({
          id: newId,
          type: "flowNode",
          position: { x: n.position.x + 40, y: n.position.y + 40 },
          data: { flowNode: { ...n.data.flowNode, id: newId } },
          selected: true,
        });
      }
      const newIds = clones.map((c) => c.id);
      setSelectedNodeIds(newIds);
      setSelNode(newIds.length === 1 ? newIds[0]! : null);
      return [...ns.map((n) => ({ ...n, selected: false })), ...clones];
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleSelectAll = useCallback(() => {
    setNodes((ns) => {
      const ids = ns.map((n) => n.id);
      setSelectedNodeIds(ids);
      setSelNode(null);
      return ns.map((n) => ({ ...n, selected: true }));
    });
  }, []);

  return {
    handleBulkDelete,
    handleDuplicateSelected,
    handleCopySelected,
    handlePaste,
    handleSelectAll,
  };
}

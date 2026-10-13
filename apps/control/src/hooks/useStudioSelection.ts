"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Selection of the Studio builder (Req 9.3, Task 13.4): bundles all React
 * Flow selection changes (click, box select, Cmd/Ctrl click) and remembers
 * one-off group selections for the subflow panel. Split out of
 * `components/StudioBuilder.tsx` without behavior change.
 */

import {
  useCallback,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";

export function useStudioSelection({
  setSelNode,
  setSelEdge,
  setSelectedNodeIds,
  setSelectedSubflowPath,
}: {
  setSelNode: Dispatch<SetStateAction<string | null>>;
  setSelEdge: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedSubflowPath: Dispatch<SetStateAction<string | null>>;
}): {
  handleSelectionChange: (nodeIds: string[], edgeIds: string[]) => void;
  /** Node ids of the last explicit subflow group selection (see selectSubflowGroup). */
  groupSelectionRef: React.RefObject<Set<string> | null>;
} {
  /** Node ids of the last explicit sub-flow-group selection, so the resulting
   * onSelectionChange doesn't clear it (see selectSubflowGroup). */
  const groupSelectionRef = useRef<Set<string> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleSelectionChange = useCallback(
    (nodeIds: string[], edgeIds: string[]): void => {
      setSelectedNodeIds(nodeIds);
      // A group selection is opened explicitly by selectSubflowGroup, which
      // programmatically selects the group's nodes. React Flow then fires this
      // handler once for that change; we consume the one-shot marker and keep
      // the group panel open. EVERY later selection change — including a click
      // on the group's own node(s), which for a single-node sub-flow is the
      // same node set — clears the group selection so the node's property panel
      // takes over. This is what lets a one-node sub-flow's node be edited.
      const pending = groupSelectionRef.current;
      groupSelectionRef.current = null;
      const isProgrammaticGroupSelect =
        pending !== null &&
        pending.size === nodeIds.length &&
        nodeIds.every((id) => pending.has(id));
      if (!isProgrammaticGroupSelect) {
        setSelectedSubflowPath(null);
      }
      if (nodeIds.length === 1) {
        setSelNode(nodeIds[0]);
        setSelEdge(null);
      } else if (edgeIds.length === 1 && nodeIds.length === 0) {
        setSelEdge(edgeIds[0]);
        setSelNode(null);
      } else {
        setSelNode(null);
        setSelEdge(null);
      }
    },
    [],
  );

  return { handleSelectionChange, groupSelectionRef };
}

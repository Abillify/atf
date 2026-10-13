"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Node CRUD of the Studio builder (Req 9.3, Task 13.4): create, update,
 * delete and rename nodes, and edit edges. Split out of
 * `components/StudioBuilder.tsx` without behavior change.
 */

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { EdgeSelection } from "../components/NodePropertyPanel";
import {
  autoPosition,
  makeNode,
  NODE_ID_RE,
  rewriteNodeReferences,
  type RFEdge,
  type RFNode,
} from "../lib/flow-graph";
import { subflowAt, subflowBoxes } from "../lib/subflows";
import { EDITOR_NODE_H, EDITOR_NODE_W } from "../components/graph/GraphLayoutEngine";
import type { FlowDefinition, NodeType } from "../types/flow";
import type { StudioStatusKind } from "./useStudioStatus";

export function useStudioNodeCrud({
  nodes,
  nodeOrigins,
  setNodes,
  setEdges,
  setNodeOrigins,
  setBase,
  setSelNode,
  setSelEdge,
  setSelectedNodeIds,
  loadedPositionsRef,
  setStatus,
  setStatusKind,
}: {
  nodes: RFNode[];
  nodeOrigins: Record<string, string>;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  setNodeOrigins: Dispatch<SetStateAction<Record<string, string>>>;
  setBase: Dispatch<SetStateAction<FlowDefinition>>;
  setSelNode: Dispatch<SetStateAction<string | null>>;
  setSelEdge: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  loadedPositionsRef: RefObject<Map<string, { x: number; y: number }>>;
  setStatus: (message: string | null) => void;
  setStatusKind: (kind: StudioStatusKind) => void;
}): {
  addNodeAt: (type: NodeType, position?: { x: number; y: number }) => void;
  updateNode: (updated: FlowDefinition["nodes"][number]) => void;
  removeNodes: (ids: string[]) => void;
  deleteNode: (id: string) => void;
  renameNode: (oldId: string, newId: string) => string | null;
  updateEdge: (sel: EdgeSelection) => void;
  deleteEdge: (id: string) => void;
} {
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const addNodeAt = useCallback(
    (type: NodeType, position?: { x: number; y: number }): void => {
      // Dropped onto a sub-flow box → the new node belongs to that sub-flow.
      const into =
        position !== undefined
          ? subflowAt(
              position,
              subflowBoxes(nodes as never, nodeOrigins, {
                width: EDITOR_NODE_W,
                height: EDITOR_NODE_H,
              }),
            )
          : undefined;
      setNodes((ns) => {
        const node = makeNode(
          type,
          ns.map((n) => n.id),
        );
        if (into !== undefined)
          setNodeOrigins((o) => ({ ...o, [node.id]: into }));
        const pos = position ?? autoPosition(ns.length);
        setSelNode(node.id);
        setSelEdge(null);
        setSelectedNodeIds([node.id]);
        return [
          ...ns,
          {
            id: node.id,
            type: "flowNode",
            position: pos,
            data: { flowNode: node },
          },
        ];
      });
    },
    [nodes, nodeOrigins],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const updateNode = useCallback(
    (updated: FlowDefinition["nodes"][number]): void => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === updated.id ? { ...n, data: { flowNode: updated } } : n,
        ),
      );
    },
    [],
  );

  /**
   * Removes nodes AND every reference to them held in other nodes' settings
   * (parallel children, harness allowlist/verifier), so a delete never leaves
   * a dangling id behind. Undoable like any other edit.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const removeNodes = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      let remaining = nodes
        .filter((n) => !drop.has(n.id))
        .map((n) => n.data.flowNode);
      const changes: string[] = [];
      for (const id of ids) {
        const res = rewriteNodeReferences(remaining, id, null);
        remaining = res.nodes;
        changes.push(...res.changes);
      }
      const byId = new Map(remaining.map((fn) => [fn.id, fn]));
      setNodes((ns) =>
        ns
          .filter((n) => !drop.has(n.id))
          .map((n) => {
            const fn = byId.get(n.id);
            return fn && fn !== n.data.flowNode
              ? { ...n, data: { ...n.data, flowNode: fn } }
              : n;
          }),
      );
      setEdges((es) =>
        es.filter((e) => !drop.has(e.source) && !drop.has(e.target)),
      );
      setSelNode(null);
      setSelectedNodeIds([]);
      if (changes.length > 0) {
        setStatus(
          `Deleted ${ids.length} node(s) and removed their references in: ${[...new Set(changes)].join(", ")} (Cmd/Ctrl+Z to undo).`,
        );
        setStatusKind("info");
      }
    },
    [nodes],
  );

  const deleteNode = useCallback(
    (id: string): void => removeNodes([id]),
    [removeNodes],
  );

  /**
   * Renames a node and follows every reference: edges, parallel children,
   * harness allowlist/verifier, its sub-flow origin. Returns an error message,
   * or null on success.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const renameNode = useCallback(
    (oldId: string, newId: string): string | null => {
      const next = newId.trim();
      if (next === oldId) return null;
      if (!NODE_ID_RE.test(next)) {
        return "Use letters, digits, - and _ (must start with a letter or digit).";
      }
      if (nodes.some((n) => n.id === next))
        return `A node "${next}" already exists.`;

      const { nodes: rewritten, changes } = rewriteNodeReferences(
        nodes.map((n) => n.data.flowNode),
        oldId,
        next,
      );
      const byId = new Map(rewritten.map((fn) => [fn.id, fn]));
      setNodes((ns) =>
        ns.map((n) => {
          const fn = byId.get(n.id) ?? n.data.flowNode;
          return n.id === oldId
            ? {
                ...n,
                id: next,
                data: { ...n.data, flowNode: { ...fn, id: next } },
              }
            : fn !== n.data.flowNode
              ? { ...n, data: { ...n.data, flowNode: fn } }
              : n;
        }),
      );
      setEdges((es) =>
        es.map((e) =>
          e.source === oldId || e.target === oldId
            ? {
                ...e,
                source: e.source === oldId ? next : e.source,
                target: e.target === oldId ? next : e.target,
              }
            : e,
        ),
      );
      setNodeOrigins((o) => {
        if (!(oldId in o)) return o;
        const { [oldId]: origin, ...rest } = o;
        return { ...rest, [next]: origin };
      });
      // Keep the edge-origin bookkeeping of id-less sub-flow edges ("a->b").
      setBase((b) => {
        const eo = b.metadata?.["$includeEdgeOrigins"] as
          | Record<string, string>
          | undefined;
        if (!eo) return b;
        const renamed = Object.fromEntries(
          Object.entries(eo).map(([k, v]) => {
            const [src, tgt] = k.split("->");
            return tgt !== undefined && (src === oldId || tgt === oldId)
              ? [
                  `${src === oldId ? next : src}->${tgt === oldId ? next : tgt}`,
                  v,
                ]
              : [k, v];
          }),
        );
        return {
          ...b,
          metadata: { ...b.metadata, $includeEdgeOrigins: renamed },
        };
      });
      const pos = loadedPositionsRef.current.get(oldId);
      if (pos) loadedPositionsRef.current.set(next, pos);
      setSelNode((cur) => (cur === oldId ? next : cur));
      setSelectedNodeIds((ids) => ids.map((i) => (i === oldId ? next : i)));
      setStatus(
        `Renamed ${oldId} → ${next}${changes.length > 0 ? `; updated ${[...new Set(changes)].join(", ")}` : ""}.`,
      );
      setStatusKind("info");
      return null;
    },
    [nodes],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const updateEdge = useCallback((sel: EdgeSelection): void => {
    setEdges((es) =>
      es.map((e) =>
        e.id === sel.id
          ? {
              ...e,
              label: sel.label ?? undefined,
              data: { ...e.data, conditions: sel.conditions ?? undefined },
            }
          : e,
      ),
    );
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const deleteEdge = useCallback((id: string): void => {
    setEdges((es) => es.filter((e) => e.id !== id));
    setSelEdge(null);
  }, []);

  return {
    addNodeAt,
    updateNode,
    removeNodes,
    deleteNode,
    renameNode,
    updateEdge,
    deleteEdge,
  };
}

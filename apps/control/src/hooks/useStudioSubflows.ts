"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Subflows of the Studio builder (Req 9.3, Task 13.4): include/create
 * `$include` files, group selection, a separate undo/redo per file and
 * save/delete/reset of a file. Split out of `components/StudioBuilder.tsx`
 * without behavior change.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { flowToGraph, makeNode, type RFEdge, type RFNode } from "../lib/flow-graph";
import {
  fetchSubflowContent,
  removeSubflow,
  subflowFragment,
  subflowGroup,
  subflowLabel,
  subflowNodeIds,
  subflowPathFor,
  writeSubflowContent,
} from "../lib/subflows";
import type {
  SubflowSnapshot,
  useSubflowHistory,
} from "../lib/subflow-history";
import { EDITOR_NODE_W } from "../components/graph/GraphLayoutEngine";
import type { FlowDefinition } from "../types/flow";
import type { StudioStatusKind } from "./useStudioStatus";

export function useStudioSubflows({
  base,
  nodes,
  edges,
  nodeOrigins,
  token,
  subflowHistory,
  skipHistoryRef,
  groupSelectionRef,
  setNodes,
  setEdges,
  setNodeOrigins,
  setBase,
  setSelNode,
  setSelEdge,
  setSelectedNodeIds,
  setSelectedSubflowPath,
  setStatus,
  setStatusKind,
}: {
  base: FlowDefinition;
  nodes: RFNode[];
  edges: RFEdge[];
  nodeOrigins: Record<string, string>;
  token: string | undefined;
  subflowHistory: ReturnType<typeof useSubflowHistory>;
  skipHistoryRef: RefObject<boolean>;
  groupSelectionRef: RefObject<Set<string> | null>;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  setNodeOrigins: Dispatch<SetStateAction<Record<string, string>>>;
  setBase: Dispatch<SetStateAction<FlowDefinition>>;
  setSelNode: Dispatch<SetStateAction<string | null>>;
  setSelEdge: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeIds: Dispatch<SetStateAction<string[]>>;
  setSelectedSubflowPath: Dispatch<SetStateAction<string | null>>;
  setStatus: (message: string | null) => void;
  setStatusKind: (kind: StudioStatusKind) => void;
}): {
  subflowSnapshotOf: (path: string) => SubflowSnapshot;
  handleExtractSubflow: (name: string) => void;
  setNodeOrigin: (nodeId: string, path: string | null) => void;
  includeSubflow: (path: string, at?: { x: number; y: number }) => Promise<string>;
  createSubflow: (name: string) => string | null;
  edgeOrigins: Record<string, string>;
  selectSubflowGroup: (path: string) => void;
  handleDeleteSubflow: (path: string) => void;
  handleSaveSubflow: (path: string) => Promise<void>;
  handleUndoSubflow: (path: string) => void;
  handleRedoSubflow: (path: string) => void;
  handleResetSubflow: (path: string) => Promise<void>;
} {
  // -------------------------------------------------------------------------
  // Extract to sub-flow (Phase 4): tags the selected nodes with a new
  // `$includeOrigins` entry. Nodes STAY on the canvas — `$include`-composed
  // flows always show their fully merged graph in one view; the tag only
  // controls which file a node's content is written to on save (see
  // `splitByIncludeOrigin` in `src/routes/flows.ts`). Cross-boundary edges
  // need no special handling: they stay with the parent and still resolve
  // once the files are re-merged on next load.
  // -------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleExtractSubflow = useCallback(
    (name: string): void => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const relPath = `subflows/${trimmed}.yaml`;
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      if (selectedIds.length === 0) return;
      setNodeOrigins((prev) => {
        const next = { ...prev };
        for (const id of selectedIds) next[id] = relPath;
        return next;
      });
      setStatus(
        `${selectedIds.length} node(s) tagged for subflows/${trimmed}.yaml — save to write it.`,
      );
      setStatusKind("info");
    },
    [nodes],
  );

  // -------------------------------------------------------------------------
  // Sub-flows: include a file, create a new one, move a node between files.
  // The canvas always shows the merged graph; a node's origin decides which
  // file it is written to on save (the runtime adds new files to
  // metadata.$include and drops files no longer used).
  // -------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const setNodeOrigin = useCallback(
    (nodeId: string, path: string | null): void => {
      setNodeOrigins((o) => {
        const { [nodeId]: _old, ...rest } = o;
        void _old;
        return path ? { ...rest, [nodeId]: path } : rest;
      });
    },
    [],
  );

  /**
   * Places a sub-flow file's nodes/edges on the canvas. With `at` (dropped
   * from the Subflows section), the group's top-left goes to that flow
   * coordinate; without it (dialog / Include button) it lands to the right
   * of the current graph.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const includeSubflow = useCallback(
    async (path: string, at?: { x: number; y: number }): Promise<string> => {
      const content = await fetchSubflowContent(path, token);
      const existing = new Set(nodes.map((n) => n.id));
      const incoming = content.nodes.filter((n) => !existing.has(n.id));
      const skipped = content.nodes.length - incoming.length;
      if (incoming.length === 0) {
        return skipped > 0
          ? `All nodes of ${path} are already on the canvas.`
          : `${path} has no nodes.`;
      }
      const ids = new Set(incoming.map((n) => n.id));
      const subEdges = content.edges.filter(
        (e) =>
          (ids.has(e.source) || existing.has(e.source)) &&
          (ids.has(e.target) || existing.has(e.target)),
      );
      // Lay the sub-flow out on its own, to the right of the current graph.
      const g = flowToGraph({
        id: "sub",
        name: "sub",
        nodes: incoming,
        edges: subEdges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      });
      const maxX = nodes.reduce(
        (m, n) => Math.max(m, n.position.x + EDITOR_NODE_W),
        0,
      );
      const minY = nodes.reduce(
        (m, n) => Math.min(m, n.position.y),
        Number.POSITIVE_INFINITY,
      );
      const gx = Math.min(...g.nodes.map((n) => n.position.x));
      const gy = Math.min(...g.nodes.map((n) => n.position.y));
      const dx = (at ? at.x : nodes.length > 0 ? maxX + 140 : 0) - gx;
      const dy = (at ? at.y : Number.isFinite(minY) ? minY : 0) - gy;
      const newNodes = g.nodes.map((n) => ({
        ...n,
        position: { x: n.position.x + dx, y: n.position.y + dy },
      }));
      const edgeIds = new Set(edges.map((e) => e.id));
      const newEdges = flowToGraph({
        id: "sub",
        name: "sub",
        nodes: incoming,
        edges: subEdges,
      }).edges.map((e) => {
        let id = e.id;
        while (edgeIds.has(id)) id = `${id}-sub`;
        edgeIds.add(id);
        return { ...e, id };
      });
      setNodes((ns) => [...ns, ...newNodes]);
      setEdges((es) => [...es, ...newEdges]);
      setNodeOrigins((o) => ({
        ...o,
        ...Object.fromEntries(incoming.map((n) => [n.id, path])),
      }));
      if (Object.keys(content.edgeOrigins).length > 0) {
        setBase((b) => ({
          ...b,
          metadata: {
            ...(b.metadata ?? {}),
            $includeEdgeOrigins: {
              ...((b.metadata as Record<string, unknown> | undefined)?.[
                "$includeEdgeOrigins"
              ] as Record<string, string> | undefined),
              ...content.edgeOrigins,
            },
          },
        }));
      }
      return `Included ${path}: ${incoming.length} node(s)${skipped > 0 ? `, ${skipped} skipped (id already on the canvas)` : ""} — save to add it to the flow.`;
    },
    [nodes, edges, token],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const createSubflow = useCallback(
    (name: string): string | null => {
      const path = subflowPathFor(name);
      if (!path) return "Enter a name (letters, digits, - or _).";
      if (Object.values(nodeOrigins).includes(path))
        return `${path} already exists in this flow.`;
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      if (selectedIds.length > 0) {
        setNodeOrigins((o) => ({
          ...o,
          ...Object.fromEntries(selectedIds.map((id) => [id, path])),
        }));
        setStatus(
          `${selectedIds.length} node(s) moved to ${path} — save to write the file.`,
        );
      } else {
        // An empty sub-flow can't be drawn: start it with one node beside the graph.
        const maxX = nodes.reduce(
          (m, n) => Math.max(m, n.position.x + EDITOR_NODE_W),
          0,
        );
        const minY = nodes.reduce(
          (m, n) => Math.min(m, n.position.y),
          Number.POSITIVE_INFINITY,
        );
        setNodes((ns) => {
          const node = makeNode(
            "llm",
            ns.map((n) => n.id),
          );
          setNodeOrigins((o) => ({ ...o, [node.id]: path }));
          setSelNode(node.id);
          setSelEdge(null);
          setSelectedNodeIds([node.id]);
          return [
            ...ns,
            {
              id: node.id,
              type: "flowNode",
              position: {
                x: nodes.length > 0 ? maxX + 140 : 0,
                y: Number.isFinite(minY) ? minY : 0,
              },
              data: { flowNode: node },
            },
          ];
        });
        setStatus(
          `Created ${path} with a first node — drop more nodes onto its box, then save.`,
        );
      }
      setStatusKind("info");
      return null;
    },
    [nodes, nodeOrigins],
  );

  // -------------------------------------------------------------------------
  // Sub-flow groups on the canvas — a whole `$include` group can be selected,
  // moved, deleted, saved to its file on its own, and stepped/undone/reset
  // independently of the rest of the flow (see lib/subflows.ts &
  // lib/subflow-history.ts).
  // -------------------------------------------------------------------------

  /** `$includeEdgeOrigins` off `base.metadata` (edge key → sub-flow path). */
  const edgeOrigins = useMemo<Record<string, string>>(
    () =>
      (base.metadata?.["$includeEdgeOrigins"] as
        | Record<string, string>
        | undefined) ?? {},
    [base.metadata],
  );

  /** The current canvas slice of sub-flow `path` as a history snapshot. */
  const subflowSnapshotOf = useCallback(
    (path: string): SubflowSnapshot => {
      const g = subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path);
      const groupKeys = new Set(
        g.edges.map((e) =>
          e.data?.syntheticId ? `${e.source}->${e.target}` : e.id,
        ),
      );
      return {
        nodes: g.nodes,
        edges: g.edges,
        edgeOrigins: Object.fromEntries(
          Object.entries(edgeOrigins).filter(
            ([k, p]) => p === path && groupKeys.has(k),
          ),
        ),
      };
    },
    [nodes, edges, nodeOrigins, edgeOrigins],
  );

  // Record each sub-flow's state for its scoped history, debounced like the
  // global history so a drag/burst becomes one step. A path new to the history
  // seeds its baseline; the debounce reads the latest snapshot via a ref.
  const subflowSnapshotRef = useRef(subflowSnapshotOf);
  subflowSnapshotRef.current = subflowSnapshotOf;
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  useEffect(() => {
    const paths = [...new Set(Object.values(nodeOrigins))];
    const t = setTimeout(() => {
      for (const p of paths)
        subflowHistory.push(p, subflowSnapshotRef.current(p));
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, edges, nodeOrigins, edgeOrigins, subflowHistory]);

  /**
   * Replaces exactly sub-flow `path`'s nodes/edges/edge-origins on the canvas
   * with `snap`, leaving every other node, edge and sub-flow untouched. Used by
   * per-sub-flow undo/redo and reset.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const applySubflowSnapshot = useCallback(
    (path: string, snap: SubflowSnapshot): void => {
      skipHistoryRef.current = true;
      const oldIds = new Set(subflowNodeIds(nodeOrigins, path));
      const oldEdgeKeys = new Set(
        subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path).edges.map(
          (e) => (e.data?.syntheticId ? `${e.source}->${e.target}` : e.id),
        ),
      );
      const newIds = new Set(snap.nodes.map((n) => n.id));
      setNodes((ns) => [...ns.filter((n) => !oldIds.has(n.id)), ...snap.nodes]);
      setEdges((es) => {
        const keep = es.filter((e) => {
          const key = e.data?.syntheticId ? `${e.source}->${e.target}` : e.id;
          return !oldEdgeKeys.has(key);
        });
        return [...keep, ...snap.edges];
      });
      setNodeOrigins((o) => {
        const rest = Object.fromEntries(
          Object.entries(o).filter(([id]) => !oldIds.has(id)),
        );
        return {
          ...rest,
          ...Object.fromEntries([...newIds].map((id) => [id, path])),
        };
      });
      setBase((b) => {
        const eo =
          (b.metadata?.["$includeEdgeOrigins"] as
            | Record<string, string>
            | undefined) ?? {};
        const withoutPath = Object.fromEntries(
          Object.entries(eo).filter(([, p]) => p !== path),
        );
        const merged = { ...withoutPath, ...snap.edgeOrigins };
        const metadata = { ...(b.metadata ?? {}) } as Record<string, unknown>;
        if (Object.keys(merged).length > 0)
          metadata["$includeEdgeOrigins"] = merged;
        else delete metadata["$includeEdgeOrigins"];
        return { ...b, metadata };
      });
    },
    [nodes, edges, nodeOrigins, edgeOrigins],
  );

  /**
   * Selects a whole sub-flow group (all its nodes) on the canvas. This is the
   * ONLY way the sub-flow action panel opens — an explicit click on the group's
   * box label/border, never an inferred consequence of selecting a node inside
   * it. Otherwise a single-node sub-flow could never have its node's properties
   * edited (selecting the node would look identical to selecting the group).
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const selectSubflowGroup = useCallback(
    (path: string): void => {
      const ids = new Set(subflowNodeIds(nodeOrigins, path));
      if (ids.size === 0) return;
      // Remember the group's node set so the selection-change that React Flow
      // fires for this programmatic selection doesn't immediately clear the
      // group selection (see handleSelectionChange).
      groupSelectionRef.current = ids;
      setNodes((ns) => ns.map((n) => ({ ...n, selected: ids.has(n.id) })));
      setSelectedNodeIds([...ids]);
      setSelectedSubflowPath(path);
      setSelNode(null);
      setSelEdge(null);
    },
    [nodeOrigins],
  );

  /**
   * Removes a whole sub-flow from THIS flow: its nodes/edges leave the canvas
   * and its `$include` bookkeeping is cleared, so on save the runtime drops the
   * file from `metadata.$include`. The sub-flow FILE on disk is not touched.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleDeleteSubflow = useCallback(
    (path: string): void => {
      const r = removeSubflow(nodes, edges, nodeOrigins, edgeOrigins, path);
      if (r.removedNodeIds.length === 0) return;
      setNodes(r.nodes);
      setEdges(r.edges);
      setNodeOrigins(r.origins);
      setBase((b) => {
        const metadata = { ...(b.metadata ?? {}) } as Record<string, unknown>;
        if (Object.keys(r.edgeOrigins).length > 0)
          metadata["$includeEdgeOrigins"] = r.edgeOrigins;
        else delete metadata["$includeEdgeOrigins"];
        return { ...b, metadata };
      });
      setSelectedNodeIds([]);
      setSelNode(null);
      setSelEdge(null);
      groupSelectionRef.current = null;
      setSelectedSubflowPath(null);
      subflowHistory.forget(path);
      setStatus(
        `Removed sub-flow ${subflowLabel(path)} from this flow (${r.removedNodeIds.length} node(s)). ` +
          "Its file is kept — save to drop it from this flow's includes. Cmd/Ctrl+Z to undo.",
      );
      setStatusKind("info");
    },
    [nodes, edges, nodeOrigins, edgeOrigins, subflowHistory],
  );

  /** Writes just this sub-flow's file (POST /flows/subflows/write). */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleSaveSubflow = useCallback(
    async (path: string): Promise<void> => {
      const g = subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path);
      if (g.nodes.length === 0) return;
      setStatus(`Saving ${subflowLabel(path)}…`);
      setStatusKind("info");
      try {
        await writeSubflowContent(path, subflowFragment(g), token);
        // The current state is now the saved baseline for this sub-flow.
        subflowHistory.init(path, subflowSnapshotOf(path));
        setStatus(`Saved ${subflowLabel(path)} to its file — live now.`);
        setStatusKind("ok");
      } catch (err) {
        setStatus(
          `✗ Could not save ${subflowLabel(path)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        setStatusKind("error");
      }
    },
    [
      nodes,
      edges,
      nodeOrigins,
      edgeOrigins,
      token,
      subflowHistory,
      subflowSnapshotOf,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleUndoSubflow = useCallback(
    (path: string): void => {
      const snap = subflowHistory.undo(path);
      if (snap) {
        applySubflowSnapshot(path, snap);
        setStatus(`Undid an edit in ${subflowLabel(path)}.`);
        setStatusKind("info");
      }
    },
    [subflowHistory, applySubflowSnapshot],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleRedoSubflow = useCallback(
    (path: string): void => {
      const snap = subflowHistory.redo(path);
      if (snap) {
        applySubflowSnapshot(path, snap);
        setStatus(`Redid an edit in ${subflowLabel(path)}.`);
        setStatusKind("info");
      }
    },
    [subflowHistory, applySubflowSnapshot],
  );

  /** Resets a sub-flow to the version on disk (its file), re-fetching it. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleResetSubflow = useCallback(
    async (path: string): Promise<void> => {
      setStatus(`Resetting ${subflowLabel(path)} to the saved file…`);
      setStatusKind("info");
      try {
        const content = await fetchSubflowContent(path, token);
        // Lay the fetched nodes out where the current group sits, so a reset
        // doesn't jump the group across the canvas.
        const current = subflowGroup(
          nodes,
          edges,
          nodeOrigins,
          edgeOrigins,
          path,
        );
        const posById = new Map(current.nodes.map((n) => [n.id, n.position]));
        const anchor = current.nodes[0]?.position ?? { x: 0, y: 0 };
        const g = flowToGraph({
          id: "sub",
          name: "sub",
          nodes: content.nodes,
          edges: content.edges,
        });
        const placed = g.nodes.map((n) => ({
          ...n,
          position: posById.get(n.id) ?? anchor,
        }));
        const snap: SubflowSnapshot = {
          nodes: placed,
          edges: g.edges,
          edgeOrigins: Object.fromEntries(
            Object.entries(content.edgeOrigins).map(([k]) => [k, path]),
          ),
        };
        applySubflowSnapshot(path, snap);
        subflowHistory.init(path, snap);
        setStatus(`Reset ${subflowLabel(path)} to the saved file.`);
        setStatusKind("ok");
      } catch (err) {
        setStatus(
          `✗ Could not reset ${subflowLabel(path)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        setStatusKind("error");
      }
    },
    [
      nodes,
      edges,
      nodeOrigins,
      edgeOrigins,
      token,
      applySubflowSnapshot,
      subflowHistory,
    ],
  );

  return {
    subflowSnapshotOf,
    handleExtractSubflow,
    setNodeOrigin,
    includeSubflow,
    createSubflow,
    edgeOrigins,
    selectSubflowGroup,
    handleDeleteSubflow,
    handleSaveSubflow,
    handleUndoSubflow,
    handleRedoSubflow,
    handleResetSubflow,
  };
}

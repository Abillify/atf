"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * useFlowHistory — dependency-free undo/redo for the Studio builder canvas.
 *
 * Snapshots are coalesced by the caller (StudioBuilder debounces pushes so an
 * entire drag gesture or a burst of edits becomes one history entry instead of
 * one per intermediate event) and de-duplicated here by content (ignoring
 * ReactFlow's transient `selected` flag) so selecting nodes never creates a
 * spurious undo step.
 */

import { useCallback, useRef, useState } from "react";
import type { RFNode, RFEdge } from "./flow-graph";
import type { FlowDefinition } from "../types/flow";

export interface FlowGraphSnapshot {
  nodes: RFNode[];
  edges: RFEdge[];
  /**
   * Flow-level settings (name, description, variables, pricing, …) so edits in
   * the Flow settings panel are undoable like canvas edits. Its own
   * `nodes`/`edges` are stale by design (the canvas owns those) and ignored.
   */
  base?: FlowDefinition;
  /** Sub-flow file per node id (`$includeOrigins`). */
  nodeOrigins?: Record<string, string>;
}

export interface UseFlowHistoryResult {
  /** Pushes `snapshot` as the new current state, unless its content (ignoring
   * selection) is identical to the current one. */
  maybePush: (snapshot: FlowGraphSnapshot) => void;
  /** Steps back one entry and returns it, or undefined when there's nothing to undo. */
  undo: () => FlowGraphSnapshot | undefined;
  /** Steps forward one entry and returns it, or undefined when there's nothing to redo. */
  redo: () => FlowGraphSnapshot | undefined;
  /** Clears all history and sets `snapshot` as the current baseline (e.g. on flow switch). */
  reset: (snapshot: FlowGraphSnapshot) => void;
  canUndo: boolean;
  canRedo: boolean;
}

const MAX_HISTORY = 100;

/** Normalizes a snapshot to a content-only signature (drops `.selected`). */
function signature(snapshot: FlowGraphSnapshot): string {
  const nodes = snapshot.nodes
    .map((n) => ({ id: n.id, position: n.position, flowNode: n.data.flowNode }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = snapshot.edges
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      conditions: e.data.conditions,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const { nodes: _n, edges: _e, ...settings } = snapshot.base ?? ({} as Partial<FlowDefinition>);
  void _n;
  void _e;
  return JSON.stringify({ nodes, edges, settings, origins: snapshot.nodeOrigins ?? {} });
}

export function useFlowHistory(
  initial: FlowGraphSnapshot,
): UseFlowHistoryResult {
  const past = useRef<FlowGraphSnapshot[]>([]);
  const future = useRef<FlowGraphSnapshot[]>([]);
  const current = useRef<FlowGraphSnapshot>(initial);
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  const maybePush = useCallback(
    (snapshot: FlowGraphSnapshot) => {
      if (signature(snapshot) === signature(current.current)) return;
      past.current.push(current.current);
      if (past.current.length > MAX_HISTORY) past.current.shift();
      current.current = snapshot;
      future.current = [];
      bump();
    },
    [bump],
  );

  const undo = useCallback((): FlowGraphSnapshot | undefined => {
    const prev = past.current.pop();
    if (!prev) return undefined;
    future.current.push(current.current);
    current.current = prev;
    bump();
    return prev;
  }, [bump]);

  const redo = useCallback((): FlowGraphSnapshot | undefined => {
    const next = future.current.pop();
    if (!next) return undefined;
    past.current.push(current.current);
    current.current = next;
    bump();
    return next;
  }, [bump]);

  const reset = useCallback(
    (snapshot: FlowGraphSnapshot) => {
      past.current = [];
      future.current = [];
      current.current = snapshot;
      bump();
    },
    [bump],
  );

  return {
    maybePush,
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Per-sub-flow undo/redo and reset, scoped to one `$include` group.
 *
 * The canvas has a global undo/redo (`useFlowHistory`); this adds a history
 * that only sees ONE sub-flow, so an operator working inside a sub-flow can
 * step its edits back and forth — and reset it to the version on disk —
 * without touching the rest of the flow. A snapshot holds only that
 * sub-flow's nodes, its edges and its edge-origin bookkeeping; applying one
 * replaces exactly those on the canvas and leaves every other node/edge as-is.
 */

import { useCallback, useRef, useState } from "react";
import type { RFNode, RFEdge } from "./flow-graph";

export interface SubflowSnapshot {
  /** The sub-flow's nodes (their canvas positions included). */
  nodes: RFNode[];
  /** The edges written back into this sub-flow's file. */
  edges: RFEdge[];
  /** `$includeEdgeOrigins` entries that name this file. */
  edgeOrigins: Record<string, string>;
}

/** Content signature (ignores ReactFlow's transient `selected` flag). */
function signature(snap: SubflowSnapshot): string {
  const nodes = snap.nodes
    .map((n) => ({ id: n.id, position: n.position, flowNode: n.data.flowNode }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = snap.edges
    .map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label, conditions: e.data?.conditions }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ nodes, edges, edgeOrigins: snap.edgeOrigins });
}

/** Whether two snapshots are equal in content. */
export function sameSubflowSnapshot(a: SubflowSnapshot, b: SubflowSnapshot): boolean {
  return signature(a) === signature(b);
}

interface Entry {
  past: SubflowSnapshot[];
  future: SubflowSnapshot[];
  current: SubflowSnapshot;
  /** The version on disk (last saved / loaded), for reset. */
  baseline: SubflowSnapshot;
}

const MAX_HISTORY = 100;

export interface UseSubflowHistoryResult {
  /** Records the current state of sub-flow `path`, coalescing no-op changes. */
  push: (path: string, snap: SubflowSnapshot) => void;
  /** Establishes `snap` as both current state and disk baseline (load/save). */
  init: (path: string, snap: SubflowSnapshot) => void;
  /** Steps `path` back one edit; returns the snapshot to apply, or undefined. */
  undo: (path: string) => SubflowSnapshot | undefined;
  /** Steps `path` forward one edit; returns the snapshot to apply, or undefined. */
  redo: (path: string) => SubflowSnapshot | undefined;
  /** The saved baseline of `path`, or undefined if never initialised. */
  savedBaseline: (path: string) => SubflowSnapshot | undefined;
  /** Drops all history for `path` (e.g. after the sub-flow is removed). */
  forget: (path: string) => void;
  canUndo: (path: string) => boolean;
  canRedo: (path: string) => boolean;
  /** True when `path` differs from its saved baseline. */
  isDirty: (path: string) => boolean;
}

/**
 * A per-sub-flow history keyed by file path. State lives in a ref (mutations
 * don't need to re-render on their own); a tick forces a re-render so the
 * `canUndo`/`canRedo`/`isDirty` reads in the UI stay current.
 */
export function useSubflowHistory(): UseSubflowHistoryResult {
  const entries = useRef<Map<string, Entry>>(new Map());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  const init = useCallback(
    (path: string, snap: SubflowSnapshot) => {
      entries.current.set(path, { past: [], future: [], current: snap, baseline: snap });
      bump();
    },
    [bump],
  );

  const push = useCallback(
    (path: string, snap: SubflowSnapshot) => {
      const e = entries.current.get(path);
      if (e === undefined) {
        // First time we see this sub-flow (e.g. just included) — the incoming
        // state is both its current and its baseline.
        entries.current.set(path, { past: [], future: [], current: snap, baseline: snap });
        bump();
        return;
      }
      if (signature(snap) === signature(e.current)) return;
      e.past.push(e.current);
      if (e.past.length > MAX_HISTORY) e.past.shift();
      e.current = snap;
      e.future = [];
      bump();
    },
    [bump],
  );

  const undo = useCallback(
    (path: string): SubflowSnapshot | undefined => {
      const e = entries.current.get(path);
      const prev = e?.past.pop();
      if (e === undefined || prev === undefined) return undefined;
      e.future.push(e.current);
      e.current = prev;
      bump();
      return prev;
    },
    [bump],
  );

  const redo = useCallback(
    (path: string): SubflowSnapshot | undefined => {
      const e = entries.current.get(path);
      const next = e?.future.pop();
      if (e === undefined || next === undefined) return undefined;
      e.past.push(e.current);
      e.current = next;
      bump();
      return next;
    },
    [bump],
  );

  const savedBaseline = useCallback(
    (path: string): SubflowSnapshot | undefined => entries.current.get(path)?.baseline,
    [],
  );

  const forget = useCallback(
    (path: string) => {
      if (entries.current.delete(path)) bump();
    },
    [bump],
  );

  const canUndo = useCallback((path: string): boolean => (entries.current.get(path)?.past.length ?? 0) > 0, []);
  const canRedo = useCallback((path: string): boolean => (entries.current.get(path)?.future.length ?? 0) > 0, []);
  const isDirty = useCallback((path: string): boolean => {
    const e = entries.current.get(path);
    return e !== undefined && signature(e.current) !== signature(e.baseline);
  }, []);

  return { push, init, undo, redo, savedBaseline, forget, canUndo, canRedo, isDirty };
}

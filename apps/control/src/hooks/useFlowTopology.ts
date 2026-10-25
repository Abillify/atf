"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * useFlowTopology — resolves the best-matching FlowDefinition for the set of
 * node events currently displayed in the Live Graph.
 *
 * Extracted from the monolithic page.tsx (Req. 11.1, 11.3):
 *   - Loads all flow definitions once the flow list is available.
 *   - Picks the definition that matches the displayed run by flow_id first,
 *     then by node-ID overlap as a fallback.
 *
 */

import { useState, useEffect } from "react";
import type { NodeExecutionEvent } from "../types/monitoring";
import type { FlowDefinition } from "../types/flow";

interface FlowListItem {
  id: string;
  name: string;
}

type GetFlowFn = (id: string) => Promise<{
  published?: FlowDefinition | null;
  draft?: FlowDefinition | null;
}>;

export interface UseFlowTopologyOptions {
  /** Available flow list (from useFlows). */
  flows: FlowListItem[];
  /** Fetch function for a single flow definition (from useFlows). */
  getFlow: GetFlowFn;
  /** Events for the execution currently shown in the graph. */
  displayEvents: NodeExecutionEvent[];
}

export interface UseFlowTopologyResult {
  /** The resolved FlowDefinition for the current execution, or null. */
  flowDefinition: FlowDefinition | null;
  /** A snapshot of all loaded definitions, keyed by flow id. */
  loadedFlowDefs: Map<string, FlowDefinition>;
}

export function useFlowTopology({
  flows,
  getFlow,
  displayEvents,
}: UseFlowTopologyOptions): UseFlowTopologyResult {
  const [loadedFlowDefs, setLoadedFlowDefs] = useState<
    Map<string, FlowDefinition>
  >(new Map());
  const [flowDefinition, setFlowDefinition] = useState<FlowDefinition | null>(
    null,
  );

  // Load all flow definitions once the flow list is available.
  // biome-ignore lint/correctness/useExhaustiveDependencies: definitions load once per flow-list size; getFlow identity must not re-trigger
  useEffect(() => {
    if (flows.length === 0) return;
    let cancelled = false;
    void (async () => {
      const map = new Map<string, FlowDefinition>();
      await Promise.all(
        flows.map(async (f) => {
          try {
            const detail = await getFlow(f.id);
            const def = detail.published ?? detail.draft;
            if (def) map.set(f.id, def);
          } catch {
            /* skip */
          }
        }),
      );
      if (!cancelled) setLoadedFlowDefs(map);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows.length]);

  // Resolve the flow topology for the execution currently shown in the graph.
  // Prefer an exact match on the run's `flow_id`. The engine now stamps
  // `flow_id` on EVERY node-lifecycle event (not just the synthetic
  // __request__/__response__ boundary nodes — see
  // src/graph/graph-engine/handler-factories.ts), so a run with any events at
  // all always carries a `flow_id`. The node-ID overlap fallback below only
  // exists for events persisted before that change (no `flow_id` at all); it
  // deliberately refuses to guess when several flows tie on overlap — several
  // single-node passthrough flows share a generic node id like "responder",
  // and picking an arbitrary winner there previously mislabelled nodes with
  // another flow's node label (e.g. showing "Bedrock Responder" for a run that
  // actually executed the local-model `task` flow).
  useEffect(() => {
    if (loadedFlowDefs.size === 0 || displayEvents.length === 0) return;

    const flowId = displayEvents.find((e) => e.flow_id)?.flow_id;
    if (flowId !== undefined) {
      // `flow_id` is present — this is the authoritative source. Resolve to
      // the matching definition when loaded, or to null when it's confirmed
      // absent from the flow list (deleted/renamed flow). Never fall back to
      // node-ID overlap here: that heuristic can only produce a WRONG flow
      // once we know the right one's id, never a better guess.
      setFlowDefinition(loadedFlowDefs.get(flowId) ?? null);
      return;
    }

    // No event carries a `flow_id` (legacy persisted run from before every
    // node event was stamped) — fall back to node-ID overlap, but only when
    // there is a single unambiguous best match. A tie means the events could
    // belong to any of several flows sharing those node ids, so guessing
    // would be worse than showing nothing.
    const eventNodeIds = new Set(displayEvents.map((e) => e.node_id));
    let best: FlowDefinition | null = null;
    let bestScore = 0;
    let bestIsTied = false;
    for (const def of loadedFlowDefs.values()) {
      const score = def.nodes.filter((n) => eventNodeIds.has(n.id)).length;
      if (score > bestScore) {
        bestScore = score;
        best = def;
        bestIsTied = false;
      } else if (score === bestScore && score > 0) {
        bestIsTied = true;
      }
    }
    setFlowDefinition(bestIsTied ? null : best);
  }, [displayEvents, loadedFlowDefs]);

  return { flowDefinition, loadedFlowDefs };
}

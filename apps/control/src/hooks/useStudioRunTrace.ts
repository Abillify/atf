"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Edge data flow of the tracked run in the Studio builder (Req 9.3, Task 13.4):
 * fetching the trace after the run ends and live polling during the run.
 * Split out of `components/StudioBuilder.tsx` without behavior change.
 */

import { useCallback, useEffect, useState } from "react";
import { fetchRunTrace, type EdgeFlowRecord } from "../lib/run-samples";

export function useStudioRunTrace({
  runExecutionId,
  token,
}: {
  runExecutionId: string | null;
  token: string | null | undefined;
}): {
  edgeFlows: EdgeFlowRecord[];
  handleRunFinished: (executionId: string | null) => void;
} {
  /**
   * Per-edge data flow of the traced run (Studio-instrumented runs only):
   * fetched once the run finishes, drawn as colored channel lines on the
   * canvas and listed in full in the edge section of the property panel.
   */
  const [edgeFlows, setEdgeFlows] = useState<EdgeFlowRecord[]>([]);

  // The run (or attached run) finished: pull its trace so the canvas can draw
  // the per-edge data flow. Only real runs report edge flows — pinned or
  // loaded data never highlights edges (operator decision).
  const handleRunFinished = useCallback(
    (executionId: string | null): void => {
      if (executionId === null) {
        setEdgeFlows([]);
        return;
      }
      void fetchRunTrace(executionId, token ?? undefined)
        .then((trace) => setEdgeFlows(trace.edge_flows ?? []))
        .catch(() => setEdgeFlows([]));
    },
    [token],
  );

  // Live edge-flow polling: the trace store holds every edge record from the
  // moment the graph crosses it and serves the trace while it still runs, so
  // the canvas can draw the channels DURING the run instead of waiting for
  // the stream to end. Poll every 1.5 s while the trace reports `running`;
  // the finish handler above fetches the authoritative final state. A few
  // tolerated misses cover the window where the execution id was locked from
  // the event stream but the trace is not readable yet.
  useEffect(() => {
    if (runExecutionId === null) {
      setEdgeFlows([]);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    const poll = (): void => {
      void fetchRunTrace(runExecutionId, token ?? undefined)
        .then((trace) => {
          if (cancelled) return;
          misses = 0;
          setEdgeFlows(trace.edge_flows ?? []);
          if (trace.status === "running") timer = setTimeout(poll, 1_500);
        })
        .catch(() => {
          if (cancelled) return;
          misses += 1;
          if (misses <= 3) timer = setTimeout(poll, 1_500);
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runExecutionId, token]);

  return { edgeFlows, handleRunFinished };
}

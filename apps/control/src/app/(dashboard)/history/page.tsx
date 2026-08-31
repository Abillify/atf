"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /history — Execution History route (Req. 9.1, 9.2, 9.3, 12.3).
 */

import dynamic from "next/dynamic";
import { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useHistory } from "../../../hooks/useHistory";
import { useHistoryFacets } from "../../../hooks/useHistoryFacets";
import { useReplay } from "../../../hooks/useReplay";
import { useDebugDownload } from "../../../hooks/useDebugDownload";
import { useTraceAnalysis } from "../../../hooks/useTraceAnalysis";
import { useCreateVariant } from "../../../hooks/useCreateVariant";
import { useMonitoringEvents } from "../../../hooks/useMonitoringEvents";
import type { TraceSuggestion } from "../../../types/trace-analysis";

// Heavy panels — loaded client-side only (Req. 12.3).
const PersistedHistory = dynamic(
  () =>
    import("../../../components/PersistedHistory").then(
      (m) => m.PersistedHistory,
    ),
  { ssr: false },
);

const ReplayResultCard = dynamic(
  () =>
    import("../../../components/ReplayResultCard").then(
      (m) => m.ReplayResultCard,
    ),
  { ssr: false },
);

const ExecutionHistory = dynamic(
  () =>
    import("../../../components/ExecutionHistory").then(
      (m) => m.ExecutionHistory,
    ),
  { ssr: false },
);

const TraceAnalysisPanel = dynamic(
  () =>
    import("../../../components/TraceAnalysisPanel").then(
      (m) => m.TraceAnalysisPanel,
    ),
  { ssr: false },
);

export default function HistoryPage() {
  const { token, ready, renewNow } = useAuth();
  const tokenOpt = token ?? undefined;

  const { events } = useMonitoringEvents({
    enabled: ready,
    onSessionExpired: renewNow,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const PAGE_SIZE = 50;
  const [offset, setOffset] = useState(0);
  const [includeFlows, setIncludeFlows] = useState<string[]>([]);
  const [excludeFlows, setExcludeFlows] = useState<string[]>([]);
  const [userFilter, setUserFilter] = useState("");

  const {
    executions,
    total,
    isLoading: historyLoading,
    error: historyError,
    refresh: refreshHistory,
  } = useHistory({
    enabled: ready,
    limit: PAGE_SIZE,
    offset,
    ...(includeFlows.length > 0 ? { includeFlows } : {}),
    ...(excludeFlows.length > 0 ? { excludeFlows } : {}),
    ...(userFilter !== "" ? { userName: userFilter } : {}),
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const { facets } = useHistoryFacets({
    enabled: ready,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  // Filter changes reset pagination back to the newest page.
  const handleIncludeFlows = (flows: string[]): void => {
    setIncludeFlows(flows);
    setOffset(0);
  };
  const handleExcludeFlows = (flows: string[]): void => {
    setExcludeFlows(flows);
    setOffset(0);
  };
  const handleUserFilter = (user: string): void => {
    setUserFilter(user);
    setOffset(0);
  };

  const replay = useReplay(
    tokenOpt !== undefined ? { token: tokenOpt } : undefined,
  );
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const debugDownload = useDebugDownload(
    tokenOpt !== undefined ? { token: tokenOpt } : undefined,
  );
  const traceAnalysis = useTraceAnalysis(
    tokenOpt !== undefined ? { token: tokenOpt } : undefined,
  );
  const createVariant = useCreateVariant(
    tokenOpt !== undefined ? { token: tokenOpt } : undefined,
  );

  const handleAnalyze = (executionId: string): void => {
    // Reveal the panel immediately (shows the analysing state), then run.
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    void traceAnalysis.analyze(executionId);
  };

  // Turn an auto-applicable analysis suggestion into an evaluated optimizer
  // variant, then deep-link to the Optimizer to watch the run + promote.
  const handleCreateVariant = (suggestion: TraceSuggestion): void => {
    const analysis = traceAnalysis.analysis;
    if (analysis?.flowId == null || analysis.flowId === "") return;
    const edit = suggestion.edit as
      | { nodes?: Array<{ nodeId?: string }> }
      | undefined;
    const targetNodeId = edit?.nodes?.[0]?.nodeId;
    void createVariant
      .create({
        flowId: analysis.flowId,
        suggestionId: suggestion.id,
        edit: suggestion.edit,
        ...(targetNodeId !== undefined ? { targetNodeId } : {}),
        ...(analysis.scopeNodeIds !== undefined
          ? { scopeNodeIds: analysis.scopeNodeIds }
          : {}),
      })
      .then((flowId) => {
        if (flowId !== null && typeof window !== "undefined") {
          window.location.href = `/optimizer?flow=${encodeURIComponent(flowId)}`;
        }
      });
  };

  const handleReplay = (executionId: string): void => {
    setReplayingId(executionId);
    void replay.run({ executionId }).finally(() => setReplayingId(null));
  };

  // "View in graph" — we navigate to the graph route with the execution in the URL.
  // Deep-linking: /graph?execution=<id>
  const handleViewEvents = (id: string): void => {
    if (typeof window !== "undefined") {
      window.location.href = `/graph?execution=${encodeURIComponent(id)}`;
    }
  };

  return (
    <div className="w-full p-4 sm:p-6">
      <TraceAnalysisPanel
        analysis={traceAnalysis.analysis}
        isAnalyzing={traceAnalysis.analyzingId !== null}
        error={traceAnalysis.error}
        onClear={traceAnalysis.clear}
        onCreateVariant={handleCreateVariant}
        creatingSuggestionId={createVariant.creatingId}
        variantError={createVariant.error}
      />
      <ReplayResultCard
        result={replay.result}
        isRunning={replay.isRunning}
        error={replay.error}
        onClear={replay.clear}
      />
      {executions.length > 0 || !historyError ? (
        <PersistedHistory
          executions={executions}
          isLoading={historyLoading}
          error={historyError}
          onRefresh={refreshHistory}
          onReplay={handleReplay}
          replayingId={replayingId}
          onViewEvents={handleViewEvents}
          onDownloadDebug={(id) => void debugDownload.download(id)}
          downloadingId={debugDownload.downloadingId}
          onAnalyze={handleAnalyze}
          analyzingId={traceAnalysis.analyzingId}
          flowOptions={facets.flows}
          userOptions={facets.users}
          includeFlows={includeFlows}
          excludeFlows={excludeFlows}
          userFilter={userFilter}
          onIncludeFlowsChange={handleIncludeFlows}
          onExcludeFlowsChange={handleExcludeFlows}
          onUserFilterChange={handleUserFilter}
          total={total}
          pageSize={PAGE_SIZE}
          offset={offset}
          onOffsetChange={setOffset}
        />
      ) : (
        <ExecutionHistory events={events} />
      )}
    </div>
  );
}

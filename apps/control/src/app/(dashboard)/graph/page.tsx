"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /graph — Live Graph route (Req. 9.1, 9.2, 9.3, 11.1, 11.3, 12.3, 13.6).
 *
 * Hosts the GraphVisualizer, ExecutionPicker, and a combined right sidebar with
 * tabs for "Details" (node detail) and "Live Metrics". The sidebar occupies the
 * combined width previously used by the detail overlay + metrics panel, making
 * node details more readable.
 */

import dynamic from "next/dynamic";
import { useMemo, useState, useCallback } from "react";
import { ExecutionPicker } from "../../../components/ExecutionPicker";
import { MetricsSidebar } from "../../../components/MetricsSidebar";
import { NodeDetailContent } from "../../../components/graph/NodeDetailPanel";
import {
  nodeTypeColor,
  nodeTypeLabel,
  statusIndicator,
  type NodeState,
} from "../../../components/graph/graphUtils";
import { useAuth } from "../../../lib/auth/useAuth";
import { useMonitoringEvents } from "../../../hooks/useMonitoringEvents";
import { useHistory } from "../../../hooks/useHistory";
import { useApprovals } from "../../../hooks/useApprovals";
import { useSessionRenew } from "../../../hooks/useSessionRenew";
import { useFlows } from "../../../hooks/useFlows";
import { useExecutionScoping } from "../../../hooks/useExecutionScoping";
import { useFlowTopology } from "../../../hooks/useFlowTopology";

// Heavy visualisation panel — loaded client-side only to keep the initial
// bundle lean (Req. 12.3).
const GraphVisualizer = dynamic(
  () =>
    import("../../../components/GraphVisualizer").then(
      (m) => m.GraphVisualizer,
    ),
  { ssr: false },
);

type SidebarTab = "details" | "metrics";

export default function GraphPage() {
  const { token, ready, renewNow } = useAuth();
  const enabled = ready;
  const tokenOpt = token ?? undefined;

  const { events, isConnected, error, clearEvents } = useMonitoringEvents({
    enabled,
    onSessionExpired: renewNow,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const { executions } = useHistory({
    enabled,
    // The request picker is intentionally broader than the paginated history
    // table. Load every run retained by the in-memory backend (500 by default)
    // so older requests do not disappear from the Live Graph sidebar.
    limit: 500,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const { pending, resolved: resolvedApprovals } = useApprovals({
    enabled,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const { flows, get: getFlow } = useFlows({
    enabled,
    ...(tokenOpt !== undefined ? { token: tokenOpt } : {}),
  });

  const [includeFlows, setIncludeFlows] = useState<string[]>([]);
  const [excludeFlows, setExcludeFlows] = useState<string[]>([]);
  const flowOptions = useMemo(
    () =>
      [...new Set([
        ...executions.map((execution) => execution.flow_id),
        ...events.map((event) => event.flow_id),
      ].filter((flow): flow is string => typeof flow === "string" && flow !== ""))]
        .sort((a, b) => a.localeCompare(b)),
    [executions, events],
  );

  // Execution scoping: liveExecutions, pickerItems, displayEvents, handlers.
  const scoping = useExecutionScoping({
    events,
    executions,
    token: tokenOpt,
    includeFlows,
    excludeFlows,
  });

  // Flow topology: resolve the FlowDefinition that best matches the displayed run.
  const { flowDefinition } = useFlowTopology({
    flows,
    getFlow,
    displayEvents: scoping.displayEvents,
  });

  // Approvals scoped to the execution currently shown in the graph.
  const graphApprovals = useMemo(() => {
    if (scoping.effectiveExecutionId === null)
      return { pending: [], resolved: [] };
    return {
      pending: pending.filter(
        (p) => p.executionId === scoping.effectiveExecutionId,
      ),
      resolved: resolvedApprovals.filter(
        (r) => r.executionId === scoping.effectiveExecutionId,
      ),
    };
  }, [pending, resolvedApprovals, scoping.effectiveExecutionId]);

  // Lifted node selection state — shared between graph and sidebar
  const [selectedNode, setSelectedNode] = useState<NodeState | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("metrics");

  const handleNodeSelect = useCallback(
    (node: NodeState | null) => {
      setSelectedNode(node);
      // Auto-switch to the details tab only when a *different* node becomes
      // selected. Guarding on the id prevents live event updates (which re-emit
      // the same selected node) from hijacking the tab away from Live Metrics.
      if (node && node.id !== selectedNode?.id) setSidebarTab("details");
    },
    [selectedNode],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <ExecutionPicker
        items={scoping.pickerItems}
        flowOptions={flowOptions}
        includeFlows={includeFlows}
        excludeFlows={excludeFlows}
        onIncludeFlowsChange={setIncludeFlows}
        onExcludeFlowsChange={setExcludeFlows}
        selectedId={scoping.selectedExecutionId}
        following={scoping.following}
        onSelect={scoping.handleSelectExecution}
        onFollowLive={scoping.handleFollowLive}
        onClearHistory={() => {
          clearEvents();
        }}
      />

      <div className="flex min-h-[60vh] flex-1 flex-col overflow-hidden p-4 lg:min-h-0">
        {/* Connection status */}
        <div className="mb-2 flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              isConnected ? "bg-green-500" : "bg-red-400"
            }`}
          />
          <span className={isConnected ? "text-green-600" : "text-red-600 dark:text-red-400"}>
            {isConnected ? "Connected" : "Disconnected"}
          </span>
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </div>

        {scoping.pickerItems.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>No execution events yet. Send a chat request to get started.</p>
          </div>
        ) : scoping.displayEvents.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>No events for this execution.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <GraphVisualizer
              events={scoping.displayEvents}
              flowDefinition={flowDefinition}
              pendingApprovals={graphApprovals.pending}
              resolvedApprovals={graphApprovals.resolved}
              onNodeSelect={handleNodeSelect}
              selectedNodeExternal={selectedNode}
            />
          </div>
        )}
      </div>

      {/* Combined right sidebar: Details + Live Metrics in tabs */}
      <aside className="flex max-h-[70vh] w-full shrink-0 flex-col overflow-hidden border-t border-border bg-muted lg:h-full lg:max-h-none lg:w-[540px] lg:border-l lg:border-t-0">
        {/* Tab bar */}
        <div className="flex shrink-0 border-b border-border">
          <button
            onClick={() => setSidebarTab("details")}
            className={`flex-1 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              sidebarTab === "details"
                ? "border-b-2 border-accent bg-card text-accent"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            Details
          </button>
          <button
            onClick={() => setSidebarTab("metrics")}
            className={`flex-1 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              sidebarTab === "metrics"
                ? "border-b-2 border-accent bg-card text-accent"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            Live Metrics
          </button>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {sidebarTab === "details" ? (
            selectedNode ? (
              <div className="p-4">
                {/* Node header */}
                <div
                  className={`mb-4 rounded-lg px-4 py-3 text-white ${nodeTypeColor(selectedNode.nodeType)}`}
                >
                  <div className="font-semibold text-sm truncate">
                    {selectedNode.label}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs opacity-90">
                    <span
                      className={`inline-block w-2.5 h-2.5 rounded-full border ${statusIndicator(selectedNode.status).dot}`}
                      aria-hidden
                    />
                    <span className="capitalize">
                      {nodeTypeLabel(selectedNode.nodeType)} · {selectedNode.status}
                    </span>
                  </div>
                </div>
                <NodeDetailContent state={selectedNode} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground p-4">
                <p className="text-sm text-center">
                  Click a node in the graph to view its details.
                </p>
              </div>
            )
          ) : (
            <MetricsSidebar
              events={scoping.displayEvents}
              executions={scoping.pickerItems}
              embedded
            />
          )}
        </div>
      </aside>
    </div>
  );
}

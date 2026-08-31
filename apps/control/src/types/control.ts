// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Types for the control-plane endpoints surfaced in the dashboard:
 *   GET  /monitoring/approvals       → { pending: PendingApproval[]; resolved: ResolvedApproval[] }
 *   POST /monitoring/approvals/:id
 *   GET  /monitoring/canary          → { deployments: CanaryStatusEntry[] }
 *   POST /monitoring/replay          → ReplayResult
 *
 * Mirror the backend shapes (src/graph/approval-gate.ts, canary.ts, replay.ts).
 */

export interface PendingApproval {
  id: string;
  executionId: string;
  nodeId: string;
  tool: string;
  args: Record<string, unknown>;
  tenantId?: string;
  requestedAt: string;
}

/**
 * A tool approval that has already been decided. Retained briefly on the
 * backend (bounded, recent runs only) so dashboards can show the final
 * outcome — e.g. colouring a graph node green (approved) or red (denied).
 */
export interface ResolvedApproval {
  id: string;
  approved: boolean;
  /** Full tool reference, when known. */
  tool?: string;
  /** Node that requested the approval — maps the decision onto a graph node. */
  nodeId?: string;
  /** Execution the approval belonged to — scopes the decision to one run. */
  executionId?: string;
  /**
   * Arguments the tool was to be called with — lets a dashboard disambiguate
   * multiple same-tool calls in one node by matching on the exact args.
   */
  args?: Record<string, unknown>;
  /** Reviewer identifier, when known. */
  by?: string;
  /** True when the decision was the timeout auto-deny (counts as denied). */
  timedOut?: boolean;
  /** ISO-8601 timestamp when the approval was first requested (mirrors PendingApproval.requestedAt). */
  requestedAt?: string;
  decidedAt: string;
}

export interface CanaryStats {
  samples: number;
  errors: number;
  scoreSum: number;
  scoreCount: number;
}

export interface CanaryStatusEntry {
  flow: string;
  candidate: string;
  trafficPercent: number;
  rolledBack: boolean;
  stable: CanaryStats;
  canary: CanaryStats;
}

export interface ReplayResult {
  executionId: string;
  originalFlowId: string;
  replayedFlowId: string;
  originalResponse: string;
  replayedResponse: string;
  similarity: number;
  changed: boolean;
}

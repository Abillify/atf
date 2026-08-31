// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Backend metrics summary as returned by GET /monitoring/metrics.
 * Mirrors MetricsSummary in the backend (src/observability/metrics.ts) plus
 * the per-tenant cost snapshot.
 */

export interface TenantSpend {
  tenant: string;
  spent: number;
  cap: number;
  resetAt: number;
}

/** Spend attributed to a single authenticated user in the rolling 24h window. */
export interface UserSpend {
  /** Stable user id (JWT `sub` / Open WebUI user id). */
  userId: string;
  /** Best-known display name/email for the user (may equal the id). */
  label: string;
  spent: number;
}

/** Spend attributed to a single flow in the rolling 24h window. */
export interface FlowSpend {
  flowId: string;
  spent: number;
}

export interface MetricsSummary {
  requestsTotal: number;
  requestsByStatus: Record<string, number>;
  nodeExecutionsTotal: number;
  nodeErrorsTotal: number;
  llmCallsTotal: number;
  llmErrorsTotal: number;
  tokensPrompt: number;
  tokensCompletion: number;
  costTotal: number;
  costByModel: Record<string, number>;
  tokensByModel: Record<string, { prompt: number; completion: number }>;
  activeExecutions: number;
  queueDepth: number;
  avgNodeLatencyMs: number;
  groundednessPassed: number;
  groundednessFailed: number;
  approvalsApproved: number;
  approvalsDenied: number;
  /** Response cache totals (0 when caching disabled). */
  cacheHits: number;
  cacheMisses: number;
  /** Per-layer breakdown — exact-match vs. semantic near-duplicate. */
  cacheExactHits: number;
  cacheSemanticHits: number;
  tenants: TenantSpend[];
  /** Per-authenticated-user spend (24h). Empty when no attributable spend yet. */
  spendByUser: UserSpend[];
  /** Per-flow spend (24h). Empty when no attributable spend yet. */
  spendByFlow: FlowSpend[];
}

export const EMPTY_SUMMARY: MetricsSummary = {
  requestsTotal: 0,
  requestsByStatus: {},
  nodeExecutionsTotal: 0,
  nodeErrorsTotal: 0,
  llmCallsTotal: 0,
  llmErrorsTotal: 0,
  tokensPrompt: 0,
  tokensCompletion: 0,
  costTotal: 0,
  costByModel: {},
  tokensByModel: {},
  activeExecutions: 0,
  queueDepth: 0,
  avgNodeLatencyMs: 0,
  groundednessPassed: 0,
  groundednessFailed: 0,
  approvalsApproved: 0,
  approvalsDenied: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheExactHits: 0,
  cacheSemanticHits: 0,
  tenants: [],
  spendByUser: [],
  spendByFlow: [],
};

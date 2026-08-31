// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Types for the self-optimizing flow endpoints surfaced in the dashboard:
 *   POST /optimizer/:flowId/run             → OptimizationRun (202 when async)
 *   GET  /optimizer/:flowId/runs            → { runs: OptimizationRun[] }
 *   GET  /optimizer/runs/:runId             → OptimizationRun
 *   POST /optimizer/runs/:runId/promote     → OptimizationRun
 *
 * Mirror the backend shapes (src/graph/flow-optimizer.ts).
 */

export type OptimizationRunStatus =
  | "pending"
  | "mining"
  | "generating"
  | "evaluating"
  | "promoting"
  | "done"
  | "error"
  | "skipped";

/** One evaluated production case for a baseline or variant (full traceability). */
export interface OptimizerCaseResult {
  caseId: string;
  userPrompt: string;
  responseText: string;
  score?: number;
  passed: boolean;
  error?: string;
}

export interface VariantEvalResult {
  label: string;
  systemPrompt: string;
  avgScore?: number;
  passRate: number;
  avgLatencyMs: number;
  totalCost: number;
  error?: string;
  cases: OptimizerCaseResult[];
}

export interface OptimizationRun {
  id: string;
  flowId: string;
  targetNodeId: string;
  startedAt: string;
  finishedAt?: string;
  status: OptimizationRunStatus;
  sampleCount: number;
  baselineScore?: number;
  baselineCases?: OptimizerCaseResult[];
  baselineSystemPrompt?: string;
  variants: VariantEvalResult[];
  promotedVariant?: string;
  promotedVersion?: number;
  error?: string;
}

/** Options accepted by POST /optimizer/:flowId/run. */
export interface OptimizerRunOptions {
  targetNodeId?: string;
  variantCount?: number;
  minSamples?: number;
  maxSamples?: number;
  minScoreImprovement?: number;
  autoPromote?: boolean;
  optimizationGoal?: string;
  suggestTemperature?: boolean;
  allowStructural?: boolean;
  scopeNodeIds?: string[];
  /**
   * Ready-made structural edits to evaluate as variants (e.g. the
   * auto-applicable suggestions from a trace analysis). Opaque on the frontend
   * — the backend validates each edit before evaluating it.
   */
  seedEdits?: unknown[];
  async?: boolean;
}

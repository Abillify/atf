// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Frontend mirror of the backend trace-analysis result shape
 * (`src/graph/trace-analyzer.ts`), returned by `POST /optimizer/analyze/:executionId`.
 *
 * `StructuralEdit` (the machine-actionable change set carried by some
 * suggestions) is intentionally kept opaque here — the frontend only needs to
 * know whether an edit is present, not its internal structure.
 */

export type FindingCategory =
  | "error"
  | "performance"
  | "efficiency"
  | "logic"
  | "cost";

/** Suggestions may additionally be prompt-level. */
export type SuggestionCategory = FindingCategory | "prompt";

export type Severity = "info" | "warn" | "critical";

/** Deterministic, LLM-free metrics computed straight from the trace. */
export interface TraceMetrics {
  nodeCount: number;
  totalLatencyMs: number;
  wallClockMs?: number;
  totalCost: number;
  totalTokens: number;
  errorNodeCount: number;
  diagnosticCounts: { info: number; warn: number; error: number };
  toolCallCount: number;
  toolErrorCount: number;
  groundednessFailures: number;
  slowestNode?: { nodeId: string; latencyMs: number };
  costliestNode?: { nodeId: string; cost: number };
}

/** One observation about the run. */
export interface TraceFinding {
  category: FindingCategory;
  severity: Severity;
  /** Node the finding is about (omitted for flow-level findings). */
  nodeId?: string;
  observation: string;
  evidence?: string;
}

/** A concrete, optionally auto-applicable improvement suggestion. */
export interface TraceSuggestion {
  id: string;
  category: SuggestionCategory;
  severity: Severity;
  title: string;
  rationale: string;
  expectedImpact: string;
  /** Present when the optimizer can build a variant from it directly. Opaque here. */
  edit?: unknown;
}

export interface TraceAnalysis {
  executionId: string;
  flowId: string | null;
  status: string;
  /** Present when the analysis was restricted to a sub-section of the flow. */
  scopeNodeIds?: string[];
  summary: string;
  /** Present when the run failed or degraded — the primary cause. */
  rootCause?: string;
  findings: TraceFinding[];
  suggestions: TraceSuggestion[];
  metrics: TraceMetrics;
}

/** Options for a trace-analysis request (both optional). */
export interface TraceAnalysisOptions {
  /** Restrict the analysis to a sub-section of the flow. */
  scopeNodeIds?: string[];
  /** Steer what the analysis optimizes for, e.g. "minimise latency". */
  goal?: string;
}

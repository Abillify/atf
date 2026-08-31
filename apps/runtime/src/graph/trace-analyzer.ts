// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * LLM trace analyzer (`src/graph/trace-analyzer.ts`)
 *
 * Reads a full {@link DebugTrace} of one flow execution and produces a
 * structured post-mortem: WHY the run failed or degraded (root cause), plus
 * efficiency / performance / logic / cost findings and concrete, machine-
 * actionable improvement suggestions. Each suggestion can carry a
 * {@link StructuralEdit} so the output feeds straight into the flow optimizer
 * (generate variants → replay → canary) without a human having to re-type the
 * change.
 *
 * Two layers:
 *   1. A DETERMINISTIC digest ({@link summarizeTrace}) computes hard metrics
 *      (latency/cost/token totals, per-node breakdown, error + diagnostic
 *      counts, groundedness/tool-error signals) and renders a compact, token-
 *      bounded text view of the run. No LLM, fully pure + unit-testable.
 *   2. An LLM pass ({@link analyzeTrace}) reasons over that digest via
 *      `generateObject` to author the narrative + suggestions. The hard metrics
 *      are always attached from layer 1 (never hallucinated by the model).
 *
 * Supports PARTIAL analysis: pass `scopeNodeIds` to restrict the digest and the
 * suggestions to a subset of nodes (a flow sub-section), mirroring the
 * optimizer's sub-graph evaluation.
 *
 * The only I/O is the injected model call, so the module is unit-testable with
 * a fake model. No `any` at module boundaries.
 */

import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "ai";
import type {
  DebugTrace,
  DebugNodeTrace,
  DebugNodeDiagnostic,
} from "../types/debug-trace.js";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import type { Logger } from "../observability/logger.js";
import type { StructuralEdit } from "./prompt-variant-generator.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type FindingCategory =
  | "error"
  | "performance"
  | "efficiency"
  | "logic"
  | "cost";

export type Severity = "info" | "warn" | "critical";

/** Deterministic, LLM-free metrics computed straight from the trace. */
export interface TraceMetrics {
  nodeCount: number;
  /** Sum of per-node latency (ms) across analyzed nodes. */
  totalLatencyMs: number;
  /** Wall-clock duration of the whole run (ms), when timestamps allow. */
  wallClockMs?: number;
  totalCost: number;
  totalTokens: number;
  errorNodeCount: number;
  /** Count of diagnostic events by severity across analyzed nodes. */
  diagnosticCounts: { info: number; warn: number; error: number };
  toolCallCount: number;
  toolErrorCount: number;
  /** Nodes that ran the groundedness gate and failed it. */
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
  /** What was observed. */
  observation: string;
  /** Concrete evidence from the trace (a diagnostic code, an error, a number). */
  evidence?: string;
}

/** A concrete, optionally auto-applicable improvement suggestion. */
export interface TraceSuggestion {
  /** Stable id within this analysis (assigned if the model omits it). */
  id: string;
  category: FindingCategory | "prompt";
  severity: Severity;
  title: string;
  rationale: string;
  /** Expected effect (e.g. "removes the empty-response retries; ~30% faster"). */
  expectedImpact: string;
  /**
   * Machine-actionable change set. When present the optimizer can build a
   * variant from it directly (evaluate → replay → canary). Omitted for
   * suggestions that require human judgement (e.g. "add a new guardrail node").
   */
  edit?: StructuralEdit;
}

export interface TraceAnalysis {
  executionId: string;
  flowId: string | null;
  status: DebugTrace["status"];
  /** Present when the analysis was restricted to a sub-section of the flow. */
  scopeNodeIds?: string[];
  /** One-paragraph overall assessment. */
  summary: string;
  /** Present when the run failed or degraded — the primary cause. */
  rootCause?: string;
  findings: TraceFinding[];
  suggestions: TraceSuggestion[];
  /** Hard metrics (never LLM-authored). */
  metrics: TraceMetrics;
}

export interface AnalyzeTraceOptions {
  /** Restrict analysis to these node ids (partial / sub-graph analysis). */
  scopeNodeIds?: string[];
  /**
   * Steers what the analysis optimizes for, e.g. "minimise latency" or
   * "maximise factual grounding". Appended to the model prompt.
   */
  goal?: string;
  /** Max chars of prompt/response text included per node in the digest. Default 600. */
  maxTextPerNode?: number;
}

// ---------------------------------------------------------------------------
// Deterministic digest (pure)
// ---------------------------------------------------------------------------

function scopedNodes(
  trace: DebugTrace,
  scopeNodeIds?: string[],
): DebugNodeTrace[] {
  if (scopeNodeIds === undefined || scopeNodeIds.length === 0)
    return trace.nodes;
  const scope = new Set(scopeNodeIds);
  return trace.nodes.filter((n) => scope.has(n.node_id));
}

/** Computes the hard, LLM-free metrics for (a subset of) a trace. Pure. */
export function computeTraceMetrics(
  trace: DebugTrace,
  scopeNodeIds?: string[],
): TraceMetrics {
  const nodes = scopedNodes(trace, scopeNodeIds);

  let totalLatencyMs = 0;
  let totalCost = 0;
  let totalTokens = 0;
  let errorNodeCount = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let groundednessFailures = 0;
  const diagnosticCounts = { info: 0, warn: 0, error: 0 };
  let slowestNode: { nodeId: string; latencyMs: number } | undefined;
  let costliestNode: { nodeId: string; cost: number } | undefined;

  for (const n of nodes) {
    const latency = n.latency_ms ?? 0;
    totalLatencyMs += latency;
    if (slowestNode === undefined || latency > slowestNode.latencyMs) {
      slowestNode = { nodeId: n.node_id, latencyMs: latency };
    }
    const cost = n.cost ?? 0;
    totalCost += cost;
    if (costliestNode === undefined || cost > costliestNode.cost) {
      costliestNode = { nodeId: n.node_id, cost };
    }
    totalTokens += (n.input_tokens ?? 0) + (n.output_tokens ?? 0);
    if (n.status === "error") errorNodeCount++;
    for (const tc of n.tool_calls ?? []) {
      toolCallCount++;
      if (tc.is_error) toolErrorCount++;
    }
    for (const d of n.diagnostics ?? []) diagnosticCounts[d.level]++;
    if (n.groundedness !== undefined && !n.groundedness.passed)
      groundednessFailures++;
  }

  const wallClockMs =
    trace.finished_at !== null
      ? Math.max(
          0,
          Date.parse(trace.finished_at) - Date.parse(trace.started_at),
        )
      : undefined;

  return {
    nodeCount: nodes.length,
    totalLatencyMs: Math.round(totalLatencyMs),
    ...(wallClockMs !== undefined && Number.isFinite(wallClockMs)
      ? { wallClockMs }
      : {}),
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    totalTokens,
    errorNodeCount,
    diagnosticCounts,
    toolCallCount,
    toolErrorCount,
    groundednessFailures,
    ...(slowestNode !== undefined ? { slowestNode } : {}),
    ...(costliestNode !== undefined ? { costliestNode } : {}),
  };
}

function renderDiagnostic(d: DebugNodeDiagnostic): string {
  const detail =
    d.details !== undefined ? ` ${JSON.stringify(d.details)}` : "";
  return `[${d.level}] ${d.code}: ${d.message}${detail}`;
}

/**
 * Renders a compact, token-bounded text view of the run for the LLM. Includes
 * per-node type/model/latency/tokens/cost, diagnostics, errors, groundedness,
 * tool calls, and truncated prompt/response text.
 */
export function summarizeTrace(
  trace: DebugTrace,
  options: AnalyzeTraceOptions = {},
): string {
  const nodes = scopedNodes(trace, options.scopeNodeIds);
  const cap = Math.max(120, options.maxTextPerNode ?? 600);
  const clip = (s: string | undefined): string =>
    s === undefined
      ? ""
      : s.length > cap
        ? `${s.slice(0, cap)}… (${s.length} chars total)`
        : s;

  const lines: string[] = [];
  lines.push(`Flow: ${trace.flow_id ?? "(unknown)"}`);
  lines.push(`Overall status: ${trace.status}`);
  if (trace.errors.length > 0) {
    lines.push(
      `Stream errors: ${trace.errors
        .map((e) => `${e.type}: ${e.message}`)
        .join(" | ")}`,
    );
  }
  lines.push("");

  let seq = 0;
  for (const n of nodes) {
    seq++;
    lines.push(
      `### Node ${seq}: ${n.node_id} [${n.node_type ?? "?"}] — ${n.status}`,
    );
    const meta: string[] = [];
    if (n.model !== undefined) meta.push(`model=${n.model}`);
    if (n.latency_ms !== null && n.latency_ms !== undefined)
      meta.push(`latency=${n.latency_ms}ms`);
    if (n.input_tokens !== undefined || n.output_tokens !== undefined)
      meta.push(`tokens=${n.input_tokens ?? 0}in/${n.output_tokens ?? 0}out`);
    if (n.cost !== undefined) meta.push(`cost=${n.cost}`);
    if (meta.length > 0) lines.push(meta.join("  "));

    if (n.status === "error") {
      lines.push(
        `ERROR: ${n.error_type ?? "error"} — ${n.error_message ?? "(no message)"}`,
      );
      if (n.error_details !== undefined)
        lines.push(`error_details: ${JSON.stringify(n.error_details)}`);
    }
    if (n.diagnostics !== undefined && n.diagnostics.length > 0) {
      lines.push("diagnostics:");
      for (const d of n.diagnostics) lines.push(`  - ${renderDiagnostic(d)}`);
    }
    if (n.groundedness !== undefined) {
      lines.push(
        `groundedness: score=${n.groundedness.score} passed=${n.groundedness.passed} unsupported=${n.groundedness.unsupported.length}/${n.groundedness.checked_sentences}`,
      );
    }
    if (n.classifier !== undefined) {
      lines.push(
        `classifier: label=${n.classifier.class_label ?? "(none)"} usedFallback=${n.classifier.used_fallback ?? false}`,
      );
    }
    if (n.tool_calls !== undefined && n.tool_calls.length > 0) {
      lines.push(`tool calls (${n.tool_calls.length}):`);
      for (const tc of n.tool_calls) {
        lines.push(
          `  - ${tc.name}${tc.is_error ? " [ERROR]" : ""}${tc.exec_time_seconds !== undefined ? ` ${tc.exec_time_seconds}s` : ""} args=${clip(JSON.stringify(tc.arguments))}`,
        );
      }
    }
    if (n.full_prompt !== undefined)
      lines.push(`prompt: ${clip(n.full_prompt)}`);
    if (n.full_response !== undefined)
      lines.push(`response: ${clip(n.full_response)}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM analysis schema
// ---------------------------------------------------------------------------

const NodeEditSchema = z.object({
  nodeId: z.string().min(1),
  systemPrompt: z.string().min(1).max(65_536).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(65_536).optional(),
  model: z
    .object({ provider: z.string().min(1), model: z.string().min(1) })
    .optional(),
  addTools: z.array(z.string().min(1)).max(50).optional(),
  removeTools: z.array(z.string().min(1)).max(50).optional(),
});

const EdgeEditSchema = z.object({
  op: z.enum(["add", "remove"]),
  source: z.string().min(1),
  target: z.string().min(1),
  conditions: z.string().max(1024).optional(),
});

const SuggestionSchema = z.object({
  category: z.enum(["error", "performance", "efficiency", "logic", "cost", "prompt"]),
  severity: z.enum(["info", "warn", "critical"]),
  title: z.string().min(1),
  rationale: z.string().min(1),
  expectedImpact: z.string().min(1),
  edit: z
    .object({
      summary: z.string().optional(),
      nodes: z.array(NodeEditSchema).max(20).optional(),
      edges: z.array(EdgeEditSchema).max(20).optional(),
    })
    .optional()
    .describe(
      "Machine-actionable change set. Include ONLY when the fix is a concrete edit to existing nodes/edges.",
    ),
});

const AnalysisSchema = z.object({
  summary: z.string().min(1),
  rootCause: z
    .string()
    .optional()
    .describe("The primary cause, when the run failed or clearly degraded."),
  findings: z
    .array(
      z.object({
        category: z.enum(["error", "performance", "efficiency", "logic", "cost"]),
        severity: z.enum(["info", "warn", "critical"]),
        nodeId: z.string().optional(),
        observation: z.string().min(1),
        evidence: z.string().optional(),
      }),
    )
    .max(30),
  suggestions: z.array(SuggestionSchema).max(20),
});

const ANALYZER_SYSTEM_PROMPT = `You are a senior LLMOps engineer analysing the execution trace of an agent flow.
Explain WHY the run failed or under-performed and propose concrete, high-leverage improvements.
Ground every finding in the trace's evidence (a diagnostic code, an error type, a latency/cost number, a groundedness score).
When a fix is a concrete change to an EXISTING node or edge, attach a machine-actionable "edit" so it can be applied and re-evaluated automatically:
- node edits may change systemPrompt, temperature, maxTokens, model (provider+model), or the tool list;
- edge edits add/remove routing edges.
Do NOT invent node ids that are not in the trace. Omit "edit" for suggestions that need human judgement.
Be concise and specific; prefer the smallest change that addresses the observed problem.`;

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * Analyses a debug trace with an LLM and returns a structured
 * {@link TraceAnalysis}. Hard metrics are computed deterministically and always
 * attached; the narrative + suggestions come from the model.
 */
export async function analyzeTrace(
  trace: DebugTrace,
  model: LanguageModel,
  options: AnalyzeTraceOptions = {},
): Promise<TraceAnalysis> {
  const metrics = computeTraceMetrics(trace, options.scopeNodeIds);
  const digest = summarizeTrace(trace, options);

  const scopeNote =
    options.scopeNodeIds !== undefined && options.scopeNodeIds.length > 0
      ? `\n\nAnalyse ONLY these nodes (a sub-section of the flow): ${options.scopeNodeIds.join(", ")}.`
      : "";
  const goalNote = options.goal ? `\n\nOptimization goal: ${options.goal}` : "";

  const metricsLine =
    `Metrics: nodes=${metrics.nodeCount} errors=${metrics.errorNodeCount} ` +
    `totalLatency=${metrics.totalLatencyMs}ms totalCost=${metrics.totalCost} ` +
    `tokens=${metrics.totalTokens} toolCalls=${metrics.toolCallCount}(${metrics.toolErrorCount} errored) ` +
    `diagnostics=${metrics.diagnosticCounts.warn}warn/${metrics.diagnosticCounts.error}err ` +
    `groundednessFailures=${metrics.groundednessFailures}`;

  const prompt =
    `${metricsLine}\n\n` +
    `Execution trace:\n${digest}` +
    scopeNote +
    goalNote;

  const { object } = await generateObject({
    model,
    schema: AnalysisSchema,
    system: ANALYZER_SYSTEM_PROMPT,
    prompt,
    temperature: 0.2,
  });

  const suggestions: TraceSuggestion[] = object.suggestions.map((s, i) => ({
    id: `s${i + 1}`,
    category: s.category,
    severity: s.severity,
    title: s.title,
    rationale: s.rationale,
    expectedImpact: s.expectedImpact,
    ...(s.edit !== undefined ? { edit: s.edit as StructuralEdit } : {}),
  }));

  return {
    executionId: trace.execution_id,
    flowId: trace.flow_id,
    status: trace.status,
    ...(options.scopeNodeIds !== undefined && options.scopeNodeIds.length > 0
      ? { scopeNodeIds: options.scopeNodeIds }
      : {}),
    summary: object.summary,
    ...(object.rootCause !== undefined ? { rootCause: object.rootCause } : {}),
    findings: object.findings,
    suggestions,
    metrics,
  };
}

/**
 * Renders a {@link TraceAnalysis} to compact text — used as the
 * `analysisContext` seed for the structural variant generator so variants are
 * grounded in the real failure/slowness the analysis found.
 */
export function renderAnalysisContext(analysis: TraceAnalysis): string {
  const lines: string[] = [];
  lines.push(`Summary: ${analysis.summary}`);
  if (analysis.rootCause !== undefined)
    lines.push(`Root cause: ${analysis.rootCause}`);
  if (analysis.findings.length > 0) {
    lines.push("Findings:");
    for (const f of analysis.findings) {
      lines.push(
        `  - [${f.severity}/${f.category}]${f.nodeId !== undefined ? ` (${f.nodeId})` : ""} ${f.observation}${f.evidence !== undefined ? ` — ${f.evidence}` : ""}`,
      );
    }
  }
  if (analysis.suggestions.length > 0) {
    lines.push("Suggested changes:");
    for (const s of analysis.suggestions) {
      lines.push(`  - [${s.category}] ${s.title}: ${s.rationale}`);
    }
  }
  return lines.join("\n");
}

/**
 * Extracts the concrete, auto-applicable {@link StructuralEdit}s from an
 * analysis (suggestions that carry an `edit`). The optimizer uses these to seed
 * variants directly from a trace analysis.
 */
export function suggestionEdits(analysis: TraceAnalysis): StructuralEdit[] {
  return analysis.suggestions
    .filter((s): s is TraceSuggestion & { edit: StructuralEdit } =>
      s.edit !== undefined,
    )
    .map((s) => ({ summary: s.title, ...s.edit }));
}

// ---------------------------------------------------------------------------
// Service wrapper
// ---------------------------------------------------------------------------

/**
 * Thin service that resolves a stored debug trace by execution id and runs
 * {@link analyzeTrace} over it. Returns `undefined` when the trace is unknown
 * (aged out of the ring buffer or never existed) so the HTTP layer can map
 * that to a 404.
 */
export interface TraceAnalyzer {
  analyze(
    executionId: string,
    options?: AnalyzeTraceOptions,
  ): Promise<TraceAnalysis | undefined>;
}

export interface TraceAnalyzerDeps {
  debugTraceStore: DebugTraceStore;
  model: LanguageModel;
  logger?: Logger;
}

export function createTraceAnalyzer(deps: TraceAnalyzerDeps): TraceAnalyzer {
  return {
    async analyze(executionId, options) {
      const trace = deps.debugTraceStore.getTrace(executionId);
      if (trace === undefined) return undefined;
      deps.logger?.info("Analysing execution trace", {
        executionId,
        scoped:
          options?.scopeNodeIds !== undefined &&
          options.scopeNodeIds.length > 0,
      });
      return analyzeTrace(trace, deps.model, options ?? {});
    },
  };
}

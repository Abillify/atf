// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Decision-Provenance / Explainability Card (`src/observability/explain.ts`)
 *
 * Aggregates everything the platform already recorded about ONE completed
 * execution into a single, human-readable artefact answering "why did the
 * agent answer this way" — the transparency evidence EU AI Act Art. 13/14
 * (transparency to the user, and information enabling human oversight) asks
 * for, and no AI gateway competitor currently ships as a first-class report.
 *
 * Sources aggregated (all read-only; this module writes nothing):
 *   - {@link ExecutionStore} — the node path actually taken (order, status,
 *     latency, model, tokens, per-node cost, tool calls, the routing decision
 *     at each `router` node) and the execution-level rollup (total cost,
 *     duration, status).
 *   - {@link DebugTraceStore} — full-detail overlay when the trace is still in
 *     the bounded in-memory ring (untruncated prompts/responses, per-node
 *     groundedness score, semantic tool-selection detail, classifier output).
 *     Optional: a trace older than the ring, or from a different replica,
 *     simply means those fields are omitted — the card still assembles from
 *     the durable execution history alone.
 *   - {@link PiiVault} — the (PII-value-free) count of tokenized spans by type
 *     and detector, when the reversible PII vault ran for this execution.
 *   - {@link AuditLog} — operator actions recorded against this execution id
 *     as `target` (e.g. an approval decision, a replay run).
 *
 * The card is built ONCE per request, on demand — it is not a new hot-path
 * write, and degrades gracefully when any one source has nothing to report
 * (an execution with no tool calls, no PII, no audit entries, or an evicted
 * debug trace still produces a valid, just sparser, card).
 *
 * No `any` at module boundaries.
 */

import type { ExecutionSummary } from "../monitoring/execution-store.js";
import type { NodeExecutionEvent, NodeToolCall } from "../types/monitoring.js";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import type { DebugGroundedness, DebugNodeDiagnostic } from "../types/debug-trace.js";
import type { PiiVault, PiiVaultActionSummary } from "../graph/pii-vault.js";
import type { AuditLog, AuditRecord } from "./audit-log.js";

// ---------------------------------------------------------------------------
// Card shape
// ---------------------------------------------------------------------------

/** One step of the execution path, as actually taken. */
export interface ExplainStep {
  nodeId: string;
  label?: string;
  kind: "node" | "tool";
  status: "running" | "completed" | "error";
  sequence?: number;
  latencyMs: number | null;
  /** `provider/model`, when this step made a priced or unpriced LLM call. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  /** Tool calls made during this step (populated on the issuing node). */
  toolCalls?: Array<{ id: string; name: string; execTimeSeconds?: number | null }>;
  /** The routing decision this step made, when it was a `router` node. */
  routing?: NodeExecutionEvent["routing_decision"];
  /** Groundedness/citation gate outcome for this step, when the gate ran (debug-trace overlay only). */
  groundedness?: DebugGroundedness;
  /**
   * The Objective-Driven Routing / Solver-Loop's decision for this step, when
   * the node declared `config.objective` (debug-trace overlay only — sourced
   * from the `objective_solver_attempt` diagnostic the llm handler emits via
   * `runtime.onNodeDiagnostic`). Shows every candidate the solver tried, in
   * cost-ascending order, and which declared clauses each one cleared —
   * exactly the same transparency the routing decision above gives a `router`
   * node, extended to a model-selection decision made INSIDE an `llm` node.
   */
  objectiveSolver?: ObjectiveSolverStepDetail;
  errorMessage?: string;
}

/** Attempt-trace summary attached to {@link ExplainStep.objectiveSolver}. */
export interface ObjectiveSolverStepDetail {
  selected: string;
  satisfiedObjective: boolean;
  fallbackUsed: boolean;
  attempts: unknown[];
}

/** Aggregated LLM usage across every step of the run. */
export interface ExplainModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  callCount: number;
}

export interface ExplainCard {
  executionId: string;
  flowId: string | null;
  status: ExecutionSummary["status"];
  startedAt: string;
  finishedAt: string | null;
  totalLatencyMs: number | null;
  totalCost: number | null;
  userName: string | null;
  userPrompt: string | null;

  /** The node/tool path actually executed, in order. */
  steps: ExplainStep[];

  /** Every distinct model used, with aggregated token/cost totals. */
  modelsUsed: ExplainModelUsage[];

  /** Every routing decision made along the path (router nodes only). */
  routingDecisions: Array<{ nodeId: string; decision: NonNullable<NodeExecutionEvent["routing_decision"]> }>;

  /** Overall groundedness verdict — the LOWEST-scoring step that ran the gate, when any did. */
  groundedness?: DebugGroundedness & { nodeId: string };

  /** PII vault action summary for this execution, when the vault tokenized anything. */
  piiActions?: PiiVaultActionSummary;

  /** Operator actions recorded against this execution (approvals, replays, …). */
  auditEntries: AuditRecord[];

  /**
   * Sources this card could NOT read (e.g. the debug trace aged out of its
   * ring, or no audit log is configured) — surfaced so a reader knows the
   * card is a best-effort assembly, not a claim of completeness.
   */
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * The subset of the durable/in-memory execution history the card needs. This
 * is deliberately the same shape `MonitoringServiceInterface` already exposes
 * (`getHistory`/`getExecutionEvents`) rather than the raw `ExecutionStore`, so
 * the card can be wired directly off the monitoring service — which always has
 * an execution store (falling back to an in-memory one), whereas the
 * standalone `ExecutionStore` from persistence is `undefined` without a
 * database.
 */
export interface ExplainHistorySource {
  listRecent(limit: number): Promise<ExecutionSummary[]>;
  listEvents(executionId: string): Promise<NodeExecutionEvent[]>;
}

export interface ExplainCardDeps {
  history: ExplainHistorySource;
  debugTraceStore?: DebugTraceStore;
  piiVault?: PiiVault;
  auditLog?: AuditLog;
}

/**
 * Builds the {@link ExplainCard} for one execution id. Returns `undefined`
 * when the execution history has no record of the id at all (never ran, or
 * aged out of retention) — the one case the card cannot degrade past.
 */
export async function buildExplainCard(
  deps: ExplainCardDeps,
  executionId: string,
): Promise<ExplainCard | undefined> {
  const { history, debugTraceStore, piiVault, auditLog } = deps;
  const degraded: string[] = [];

  // The durable/in-memory execution history is the primary source — it has
  // the node path, models, tokens and cost for every execution regardless of
  // how long ago it ran (subject to retention).
  const rawEvents = await history.listEvents(executionId);
  if (rawEvents.length === 0) {
    return undefined;
  }

  // The engine emits TWO events per node — a `running` event at node start and
  // a terminal (`completed`/`error`) event at the end (see
  // handler-factories.ts emitNodeEvent sites). Collapse each node's pair into a
  // single step, preferring the terminal event (which carries the model,
  // tokens, cost, latency and routing decision the running event lacks). Keyed
  // by (node_id, sequence) so distinct tool calls / re-runs stay separate; the
  // running and terminal event of one node share a sequence and thus collapse.
  const byNode = new Map<string, NodeExecutionEvent>();
  for (const e of rawEvents) {
    const key = `${e.node_id}::${e.sequence ?? ""}`;
    const existing = byNode.get(key);
    if (
      existing === undefined ||
      (existing.status === "running" && e.status !== "running")
    ) {
      byNode.set(key, e);
    }
  }
  const events = [...byNode.values()].sort((a, b) => {
    const seqDiff = (a.sequence ?? 0) - (b.sequence ?? 0);
    if (seqDiff !== 0) return seqDiff;
    return (
      new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    );
  });

  // Find the execution summary for the rollup fields (status, totals). Recent
  // executions are typically in `listRecent`; fall back to deriving from the
  // event stream directly when the summary isn't in the (bounded) recent list.
  const recent = await history.listRecent(500);
  const summary = recent.find((e) => e.execution_id === executionId);

  const debugTrace = debugTraceStore?.getTrace(executionId);
  if (debugTrace === undefined) {
    degraded.push(
      "debug_trace_unavailable: full prompt/response and groundedness detail may be incomplete (the debug trace ring only retains the most recent ~200 executions per replica)",
    );
  }
  const debugNodesById = new Map(
    (debugTrace?.nodes ?? []).map((n) => [n.node_id, n]),
  );

  const steps: ExplainStep[] = events.map((e) => {
    const debugNode = debugNodesById.get(e.node_id);
    return {
      nodeId: e.node_id,
      ...(e.label !== undefined ? { label: e.label } : {}),
      kind: e.kind === "tool" ? "tool" : "node",
      status: e.status,
      ...(e.sequence !== undefined ? { sequence: e.sequence } : {}),
      latencyMs: e.latency_ms,
      ...(e.model !== undefined ? { model: e.model } : {}),
      ...(e.input_tokens !== undefined ? { inputTokens: e.input_tokens } : {}),
      ...(e.output_tokens !== undefined
        ? { outputTokens: e.output_tokens }
        : {}),
      ...(e.cost !== undefined ? { cost: e.cost } : {}),
      ...(e.tool_calls !== undefined && e.tool_calls.length > 0
        ? { toolCalls: e.tool_calls.map(summarizeToolCall) }
        : {}),
      ...(e.routing_decision !== undefined
        ? { routing: e.routing_decision }
        : {}),
      ...(debugNode?.groundedness !== undefined
        ? { groundedness: debugNode.groundedness }
        : {}),
      ...((() => {
        const detail = extractObjectiveSolverDetail(debugNode?.diagnostics);
        return detail !== undefined ? { objectiveSolver: detail } : {};
      })()),
      ...(e.error_message !== undefined ? { errorMessage: e.error_message } : {}),
    };
  });

  // Aggregate models used across the run.
  const modelTotals = new Map<string, ExplainModelUsage>();
  for (const e of events) {
    if (e.model === undefined || e.model === "") continue;
    let m = modelTotals.get(e.model);
    if (m === undefined) {
      m = { model: e.model, inputTokens: 0, outputTokens: 0, cost: 0, callCount: 0 };
      modelTotals.set(e.model, m);
    }
    m.inputTokens += e.input_tokens ?? 0;
    m.outputTokens += e.output_tokens ?? 0;
    m.cost += e.cost ?? 0;
    m.callCount += 1;
  }
  const modelsUsed = [...modelTotals.values()].map((m) => ({
    ...m,
    cost: Math.round(m.cost * 1_000_000) / 1_000_000,
  }));

  // Routing decisions in path order.
  const routingDecisions = events
    .filter(
      (e): e is NodeExecutionEvent & { routing_decision: NonNullable<NodeExecutionEvent["routing_decision"]> } =>
        e.routing_decision !== undefined,
    )
    .map((e) => ({ nodeId: e.node_id, decision: e.routing_decision }));

  // Worst (lowest-scoring) groundedness verdict along the path, if any ran.
  let groundedness: ExplainCard["groundedness"];
  for (const step of steps) {
    if (step.groundedness === undefined) continue;
    if (groundedness === undefined || step.groundedness.score < groundedness.score) {
      groundedness = { ...step.groundedness, nodeId: step.nodeId };
    }
  }
  if (debugTraceStore !== undefined && groundedness === undefined) {
    // Debug trace was available but carried no groundedness data for any
    // node — this is a normal case (groundedness gate disabled or no
    // retrieval context), not degraded.
  }

  // PII vault action summary (survives release(), see pii-vault.ts).
  const piiActions = piiVault?.getActionSummary(executionId);
  if (piiVault !== undefined && piiActions === undefined) {
    // Either nothing was tokenized, or the summary aged out of its bounded
    // ring — both are normal, not flagged as degraded (there is no PII
    // exposure evidence to report either way, and that ambiguity is
    // inherent to a best-effort in-memory ring, same as the debug trace).
  }

  // Audit entries recorded against this execution id. The audit log has no
  // target-filtered query, so we scan the most recent page and filter. If the
  // page is full, older operator actions against this execution may be beyond
  // it — flag that rather than silently under-reporting.
  const AUDIT_SCAN_LIMIT = 1000;
  let auditEntries: AuditRecord[] = [];
  if (auditLog !== undefined) {
    try {
      const all = await auditLog.list({ limit: AUDIT_SCAN_LIMIT });
      auditEntries = all.filter((a) => a.target === executionId);
      if (all.length >= AUDIT_SCAN_LIMIT) {
        degraded.push(
          `audit_scan_truncated: only the newest ${AUDIT_SCAN_LIMIT} audit records were scanned for this execution; older operator actions (if any) are not shown`,
        );
      }
    } catch {
      degraded.push("audit_log_query_failed: operator-action evidence may be incomplete");
    }
  } else {
    degraded.push("audit_log_unconfigured: no operator-action evidence available");
  }

  return {
    executionId,
    flowId: summary?.flow_id ?? events[0]?.flow_id ?? null,
    status: summary?.status ?? deriveStatus(events),
    startedAt: summary?.started_at ?? events[0]?.start_time ?? new Date(0).toISOString(),
    finishedAt: summary?.finished_at ?? null,
    totalLatencyMs: summary?.total_latency_ms ?? null,
    totalCost: summary?.total_cost ?? (modelsUsed.length > 0
      ? Math.round(modelsUsed.reduce((s, m) => s + m.cost, 0) * 1_000_000) / 1_000_000
      : null),
    userName: summary?.user_name ?? null,
    userPrompt: summary?.user_prompt ?? null,
    steps,
    modelsUsed,
    routingDecisions,
    ...(groundedness !== undefined ? { groundedness } : {}),
    ...(piiActions !== undefined ? { piiActions } : {}),
    auditEntries,
    degraded,
  };
}

/**
 * Finds the LAST `objective_solver_attempt` diagnostic in a node's debug-trace
 * timeline (the retry/fallback candidate chain in `llm.ts` can re-run the
 * dispatch on a fallback attempt; the final diagnostic is the one that
 * actually determined the model this step used) and projects it into the
 * card's stable shape. Returns `undefined` when the node declared no
 * objective config (no such diagnostic was ever emitted) or the debug trace
 * for it is unavailable.
 */
function extractObjectiveSolverDetail(
  diagnostics: readonly DebugNodeDiagnostic[] | undefined,
): ObjectiveSolverStepDetail | undefined {
  if (diagnostics === undefined) return undefined;
  let found: DebugNodeDiagnostic | undefined;
  for (const d of diagnostics) {
    if (d.code === "objective_solver_attempt") found = d;
  }
  if (found === undefined) return undefined;
  const details = found.details ?? {};
  const selected = details.selected;
  const satisfiedObjective = details.satisfiedObjective;
  const fallbackUsed = details.fallbackUsed;
  const attempts = details.attempts;
  return {
    selected: typeof selected === "string" ? selected : "unknown",
    satisfiedObjective: satisfiedObjective === true,
    fallbackUsed: fallbackUsed === true,
    attempts: Array.isArray(attempts) ? attempts : [],
  };
}

function summarizeToolCall(tc: NodeToolCall): {
  id: string;
  name: string;
  execTimeSeconds?: number | null;
} {
  return {
    id: tc.id,
    name: tc.name,
    ...(tc.exec_time_seconds !== undefined
      ? { execTimeSeconds: tc.exec_time_seconds }
      : {}),
  };
}

function deriveStatus(events: readonly NodeExecutionEvent[]): ExecutionSummary["status"] {
  if (events.some((e) => e.status === "error")) return "error";
  if (events.every((e) => e.status === "completed")) return "completed";
  return "running";
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Renders an {@link ExplainCard} as a downloadable Markdown document — the
 * same "one-click artefact" pattern the compliance dossier and RoPA use.
 */
export function renderExplainCardMarkdown(card: ExplainCard): string {
  const lines: string[] = [
    `# Decision-Provenance Card — ${card.executionId}`,
    "",
    `- **Flow:** ${card.flowId ?? "(unknown)"}`,
    `- **Status:** ${card.status}`,
    `- **Started:** ${card.startedAt}`,
    `- **Finished:** ${card.finishedAt ?? "(in progress / unknown)"}`,
    `- **Total latency:** ${card.totalLatencyMs !== null ? `${card.totalLatencyMs} ms` : "unknown"}`,
    `- **Total cost:** ${card.totalCost !== null ? `$${card.totalCost.toFixed(6)}` : "unknown"}`,
    `- **User:** ${card.userName ?? "(anonymous)"}`,
    ...(card.userPrompt !== null ? [`- **Prompt:** ${card.userPrompt}`] : []),
    "",
    "## Execution path",
    "",
  ];
  for (const step of card.steps) {
    const label = step.label ?? step.nodeId;
    const bits: string[] = [`**${label}**`, `(${step.kind}, ${step.status})`];
    if (step.latencyMs !== null) bits.push(`${step.latencyMs}ms`);
    if (step.model !== undefined) bits.push(`model=${step.model}`);
    if (step.cost !== undefined && step.cost > 0)
      bits.push(`$${step.cost.toFixed(6)}`);
    lines.push(`- ${bits.join(" · ")}`);
    if (step.toolCalls !== undefined) {
      for (const tc of step.toolCalls) {
        lines.push(`  - tool call: \`${tc.name}\``);
      }
    }
    if (step.routing !== undefined) {
      lines.push(`  - routed to \`${step.routing.target}\``);
    }
    if (step.groundedness !== undefined) {
      lines.push(
        `  - groundedness: ${(step.groundedness.score * 100).toFixed(0)}% (${step.groundedness.passed ? "passed" : "failed"})`,
      );
    }
    if (step.objectiveSolver !== undefined) {
      const s = step.objectiveSolver;
      lines.push(
        `  - objective-driven routing: selected \`${s.selected}\` ` +
          `(${s.satisfiedObjective ? "satisfied every declared objective" : s.fallbackUsed ? "fallback used — no candidate satisfied every objective" : "not satisfied"}), ` +
          `${s.attempts.length} attempt(s)`,
      );
    }
    if (step.errorMessage !== undefined) {
      lines.push(`  - ⚠️ error: ${step.errorMessage}`);
    }
  }

  lines.push("", "## Models used", "");
  if (card.modelsUsed.length === 0) {
    lines.push("_No priced LLM calls recorded._");
  } else {
    for (const m of card.modelsUsed) {
      lines.push(
        `- \`${m.model}\` — ${m.callCount} call(s), ${m.inputTokens} in / ${m.outputTokens} out tokens, $${m.cost.toFixed(6)}`,
      );
    }
  }

  if (card.groundedness !== undefined) {
    lines.push("", "## Groundedness", "");
    lines.push(
      `Lowest-scoring node: \`${card.groundedness.nodeId}\` — ${(card.groundedness.score * 100).toFixed(0)}% (${card.groundedness.passed ? "passed" : "failed"}), ${card.groundedness.checked_sentences} sentence(s) checked.`,
    );
    if (card.groundedness.unsupported.length > 0) {
      lines.push("", "Unsupported claims:");
      for (const u of card.groundedness.unsupported.slice(0, 10)) {
        lines.push(`- "${u.sentence}" (support ${(u.support * 100).toFixed(0)}%)`);
      }
    }
  }

  if (card.piiActions !== undefined) {
    lines.push("", "## PII vault actions", "");
    lines.push(
      `${card.piiActions.totalTokenized} PII span(s) tokenized before reaching any LLM provider.`,
    );
    for (const [type, count] of Object.entries(card.piiActions.byType)) {
      lines.push(`- ${type}: ${count}`);
    }
  }

  lines.push("", "## Operator actions", "");
  if (card.auditEntries.length === 0) {
    lines.push("_No operator actions recorded against this execution._");
  } else {
    for (const a of card.auditEntries) {
      lines.push(`- ${a.at} — **${a.actor}** ${a.action} (${a.outcome})`);
    }
  }

  if (card.degraded.length > 0) {
    lines.push("", "## Notes", "");
    for (const d of card.degraded) lines.push(`- ${d}`);
  }

  return lines.join("\n");
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Policy-Replay Simulator (`src/replay/policy-replay.ts`) — Req 16, Task 22.1.
 *
 * Evaluates a CANDIDATE policy (compliance policy and/or tool-authorization
 * policy) against stored executions from the {@link ReplayExecutionSource}
 * WITHOUT any side effects: the evaluators involved
 * ({@link evaluatePolicy}, {@link createToolAuthzEngine},
 * {@link InputGuardrail.scan}) are pure, and the simulator only ever calls the
 * read methods (`listHistory`, `listEvents`) of the execution source — it
 * never records, saves, purges or otherwise mutates state (Property 17).
 *
 * Only tokenised / redacted data is touched: the replay reads the persisted
 * execution rollups and node events (tool names, serialized tool arguments as
 * captured by monitoring, prompt previews) — exactly the same data the
 * monitoring history view exposes to operators. No live LLM or MCP call is
 * made, so no un-tokenised payload is re-processed.
 *
 * For every replayed execution the simulator reports the OLD outcome (current
 * live policies) and the NEW outcome (candidate policies) plus a per-tool-call
 * diff, and aggregates everything into a human-readable summary.
 */

import type { ZodError } from "zod";
import { evaluatePolicy, type EvalRequestContext, type PolicyDecision, type PolicyEvalResult } from "../compliance/policy-evaluator.js";
import { CompliancePolicySchema, type CompliancePolicy } from "../compliance/policy-schema.js";
import { createToolAuthzEngine, ToolAuthzPolicySchema, type ToolAuthzEngine } from "../graph/tool-authz.js";
import type { InputGuardrail, InputScanResult } from "../graph/input-guardrails.js";
import type { HistoryPage, HistoryQuery } from "../monitoring/execution-store.js";
import type { NodeExecutionEvent, RequestContext } from "../types/monitoring.js";

// ---------------------------------------------------------------------------
// Read-only execution source (satisfied by ExecutionStore and by an adapter
// over MonitoringServiceInterface — the simulator must never see write methods)
// ---------------------------------------------------------------------------

/**
 * The minimal read surface the replay needs. Deliberately narrower than
 * {@link ExecutionStore}: the simulator structurally cannot mutate history
 * because it only receives these two read methods.
 */
export interface ReplayExecutionSource {
  listHistory(query: HistoryQuery): Promise<HistoryPage>;
  listEvents(executionId: string): Promise<NodeExecutionEvent[]>;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Per-tool-call old-vs-new authorization verdict for one replayed call. */
export interface ReplayToolCallResult {
  /** MCP tool name as recorded in the execution history. */
  tool: string;
  oldAllowed: boolean;
  newAllowed: boolean;
  /** Rule id that decided under the current policy ("default" when none). */
  oldRuleId: string;
  /** Rule id that decided under the candidate policy. */
  newRuleId: string;
  /** True when oldAllowed !== newAllowed. */
  changed: boolean;
}

/** Replay verdict for one stored execution. */
export interface ReplayExecutionResult {
  execution_id: string;
  flow_id: string | null;
  tenant_id: string | null;
  started_at: string;
  user_name: string | null;
  /** Combined outcome under the CURRENT policies (compliance + tool authz). */
  old_outcome: PolicyDecision;
  /** Combined outcome under the CANDIDATE policies. */
  new_outcome: PolicyDecision;
  /** True when the outcome flipped or any tool-call verdict flipped. */
  changed: boolean;
  old_compliance: PolicyEvalResult;
  new_compliance: PolicyEvalResult;
  tool_calls: ReplayToolCallResult[];
  /** Input-guardrail scan of the stored prompt (same for old and new). */
  guardrail?: InputScanResult;
}

/** Aggregate summary of a replay run (Req 16.2 "Zusammenfassung"). */
export interface ReplaySummary {
  /** Executions actually replayed (after window / cap filters). */
  evaluated: number;
  /** Executions whose combined outcome or tool verdicts changed. */
  changed: number;
  /** Executions newly DENIED by the candidate that were not denied before. */
  newlyDenied: number;
  /** Executions the candidate now allows that the current policy denied. */
  newlyAllowed: number;
  /** Total tool calls replayed across all executions. */
  toolCallsEvaluated: number;
  /** Tool calls whose allow/deny verdict flipped. */
  toolCallFlips: number;
  /** Short German-free human-readable lines for the UI summary block. */
  highlights: string[];
}

/** Full replay result: per-execution diffs + aggregate summary. */
export interface PolicyReplayResult {
  /** Validation errors of the CANDIDATE policies (empty when valid). */
  errors: string[];
  results: ReplayExecutionResult[];
  summary: ReplaySummary;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface PolicyReplayPolicies {
  /** Current live compliance policy (undefined = none loaded). */
  currentCompliancePolicy?: CompliancePolicy;
  /** Current live tool-authz policy object (undefined = no policy). */
  currentToolAuthzPolicy?: unknown;
  /**
   * The live tool-authz engine, when available. Preferred over
   * {@link currentToolAuthzPolicy} for the OLD side: it reproduces the exact
   * in-force semantics, including the fail-closed deny-all engine, which a
   * policy-object round-trip through {@link createToolAuthzEngine} would lose.
   */
  currentToolAuthzEngine?: ToolAuthzEngine;
  /** Candidate compliance policy (validated against CompliancePolicySchema). */
  candidateCompliancePolicy?: unknown;
  /** Candidate tool-authz policy (validated against ToolAuthzPolicySchema). */
  candidateToolAuthzPolicy?: unknown;
}

export interface PolicyReplayOptions {
  /** Maximum number of executions to replay. Default 50, hard cap 500. */
  maxExecutions?: number;
  /** Only replay executions started at/after this ISO timestamp. */
  from?: string;
  /** Only replay executions started at/before this ISO timestamp. */
  to?: string;
  /** Restrict the replay to these flow ids. */
  flowIds?: string[];
  /** Progress callback (completed, total) — used by the SSE route. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

/** How many history rows to fetch before client-side window filtering. */
const HISTORY_FETCH_MULTIPLIER = 10;
const HISTORY_FETCH_CAP = 1000;
const DEFAULT_MAX_EXECUTIONS = 50;
const HARD_MAX_EXECUTIONS = 500;

// ---------------------------------------------------------------------------
// Candidate validation
// ---------------------------------------------------------------------------

function zodIssues(err: ZodError): string[] {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/**
 * Validate both candidate policies without building engines. Returns the list
 * of validation errors (empty when both candidates are absent or valid).
 */
export function validateCandidatePolicies(policies: PolicyReplayPolicies): string[] {
  const errors: string[] = [];
  if (policies.candidateCompliancePolicy !== undefined) {
    const parsed = CompliancePolicySchema.safeParse(policies.candidateCompliancePolicy);
    if (!parsed.success) {
      errors.push(...zodIssues(parsed.error).map((m) => `compliance: ${m}`));
    }
  }
  if (policies.candidateToolAuthzPolicy !== undefined) {
    const parsed = ToolAuthzPolicySchema.safeParse(policies.candidateToolAuthzPolicy);
    if (!parsed.success) {
      errors.push(...zodIssues(parsed.error).map((m) => `toolAuthz: ${m}`));
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Outcome combination
// ---------------------------------------------------------------------------

const DECISION_RANK: Record<PolicyDecision, number> = {
  allow: 0,
  "require-approval": 1,
  deny: 2,
};

function worst(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

/**
 * Combined outcome for one execution: the compliance decision, escalated to
 * "deny" when any tool call would have been blocked by tool authorization.
 */
function combinedOutcome(
  compliance: PolicyEvalResult,
  toolCalls: ReadonlyArray<{ allowed: boolean }>,
): PolicyDecision {
  let out = compliance.decision;
  for (const tc of toolCalls) {
    if (!tc.allowed) out = worst(out, "deny");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

interface ExtractedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Pull the recorded tool calls (name + parsed args) out of the node events. */
function extractToolCalls(events: readonly NodeExecutionEvent[]): ExtractedToolCall[] {
  const out: ExtractedToolCall[] = [];
  for (const ev of events) {
    if (ev.tool_calls === undefined) continue;
    for (const call of ev.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.args_json);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed recorded args: replay with empty args rather than fail.
      }
      out.push({ name: call.name, args });
    }
  }
  return out;
}

/** Reconstruct the tool-authz request context from a stored execution. */
function replayAuthzCtx(
  executionId: string,
  tenantId: string | null,
  role: string | undefined,
): RequestContext {
  return {
    // The replay never forwards a token anywhere — the evaluators are pure and
    // only read clientId/role/userId. An empty marker keeps the type honest.
    ssoToken: "policy-replay-dry-run",
    executionId,
    ...(tenantId !== null ? { clientId: tenantId } : {}),
    ...(role !== undefined ? { role } : {}),
  };
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/**
 * Run the replay simulation. PURE with respect to all stores: the only calls
 * against `source` are `listHistory` / `listEvents` (Property 17).
 */
export async function simulatePolicyReplay(
  source: ReplayExecutionSource,
  policies: PolicyReplayPolicies,
  opts: PolicyReplayOptions = {},
  guardrail?: InputGuardrail,
): Promise<PolicyReplayResult> {
  const errors = validateCandidatePolicies(policies);
  if (errors.length > 0) {
    return { errors, results: [], summary: emptySummary() };
  }

  const maxExecutions = Math.min(
    Math.max(1, Math.floor(opts.maxExecutions ?? DEFAULT_MAX_EXECUTIONS)),
    HARD_MAX_EXECUTIONS,
  );

  // Fetch a generous newest-first page, then apply the time window
  // client-side (HistoryQuery has no time filter) and cap the work.
  const query: HistoryQuery = {
    limit: Math.min(maxExecutions * HISTORY_FETCH_MULTIPLIER, HISTORY_FETCH_CAP),
    ...(opts.flowIds !== undefined && opts.flowIds.length > 0
      ? { includeFlows: opts.flowIds }
      : {}),
  };
  const page = await source.listHistory(query);
  const candidates = page.executions
    .filter((e) => (opts.from !== undefined ? e.started_at >= opts.from : true))
    .filter((e) => (opts.to !== undefined ? e.started_at <= opts.to : true))
    .slice(0, maxExecutions);

  // Build the four engines once (pure construction, no I/O).
  const oldAuthz: ToolAuthzEngine =
    policies.currentToolAuthzEngine ??
    createToolAuthzEngine(policies.currentToolAuthzPolicy);
  const newAuthz: ToolAuthzEngine = createToolAuthzEngine(policies.candidateToolAuthzPolicy);
  const oldCompliancePolicy = policies.currentCompliancePolicy;
  const newCompliancePolicy =
    policies.candidateCompliancePolicy === undefined
      ? undefined
      : (policies.candidateCompliancePolicy as CompliancePolicy);

  const results: ReplayExecutionResult[] = [];
  let toolCallsEvaluated = 0;
  let toolCallFlips = 0;
  let changedCount = 0;
  let newlyDenied = 0;
  let newlyAllowed = 0;

  const total = candidates.length;
  for (const summary of candidates) {
    const events = await source.listEvents(summary.execution_id);
    const calls = extractToolCalls(events);
    const authzCtx = replayAuthzCtx(summary.execution_id, summary.tenant_id, undefined);

    const toolResults: ReplayToolCallResult[] = calls.map((call) => {
      const oldDecision = oldAuthz.evaluate(call.name, call.args, authzCtx);
      const newDecision = newAuthz.evaluate(call.name, call.args, authzCtx);
      return {
        tool: call.name,
        oldAllowed: oldDecision.allowed,
        newAllowed: newDecision.allowed,
        oldRuleId: oldDecision.ruleId,
        newRuleId: newDecision.ruleId,
        changed: oldDecision.allowed !== newDecision.allowed,
      };
    });

    // Execution-level compliance context rebuilt from the stored rollup.
    // Data classes are not persisted per execution, so data rules only fire
    // when the candidate declares them for contexts that carry classes; the
    // model/approval rules evaluate fully from flow/tenant/tool information.
    const evalCtx: EvalRequestContext = {
      ...(summary.tenant_id !== null ? { tenantId: summary.tenant_id } : {}),
      ...(summary.flow_id !== null ? { flowId: summary.flow_id } : {}),
      ...(toolResults.length > 0 ? { toolIds: toolResults.map((t) => t.tool) } : {}),
    };
    const oldCompliance = evaluatePolicy(oldCompliancePolicy, evalCtx);
    const newCompliance = evaluatePolicy(newCompliancePolicy, evalCtx);

    const oldOutcome = combinedOutcome(oldCompliance, toolResults.map((t) => ({ allowed: t.oldAllowed })));
    const newOutcome = combinedOutcome(newCompliance, toolResults.map((t) => ({ allowed: t.newAllowed })));
    const flips = toolResults.filter((t) => t.changed).length;
    const changed = oldOutcome !== newOutcome || flips > 0;

    if (changed) changedCount += 1;
    if (oldOutcome !== "deny" && newOutcome === "deny") newlyDenied += 1;
    if (oldOutcome === "deny" && newOutcome !== "deny") newlyAllowed += 1;
    toolCallsEvaluated += toolResults.length;
    toolCallFlips += flips;

    const result: ReplayExecutionResult = {
      execution_id: summary.execution_id,
      flow_id: summary.flow_id,
      tenant_id: summary.tenant_id,
      started_at: summary.started_at,
      user_name: summary.user_name,
      old_outcome: oldOutcome,
      new_outcome: newOutcome,
      changed,
      old_compliance: oldCompliance,
      new_compliance: newCompliance,
      tool_calls: toolResults,
    };
    if (guardrail !== undefined && summary.user_prompt !== null && summary.user_prompt !== "") {
      result.guardrail = guardrail.scan([{ role: "user", content: summary.user_prompt }]);
    }
    results.push(result);

    if (opts.onProgress !== undefined) {
      await opts.onProgress(results.length, total);
    }
  }

  const summary: ReplaySummary = {
    evaluated: results.length,
    changed: changedCount,
    newlyDenied,
    newlyAllowed,
    toolCallsEvaluated,
    toolCallFlips,
    highlights: buildHighlights(results.length, changedCount, newlyDenied, newlyAllowed, toolCallsEvaluated, toolCallFlips),
  };

  return { errors: [], results, summary };
}

function emptySummary(): ReplaySummary {
  return {
    evaluated: 0,
    changed: 0,
    newlyDenied: 0,
    newlyAllowed: 0,
    toolCallsEvaluated: 0,
    toolCallFlips: 0,
    highlights: [],
  };
}

function buildHighlights(
  evaluated: number,
  changed: number,
  newlyDenied: number,
  newlyAllowed: number,
  toolCallsEvaluated: number,
  toolCallFlips: number,
): string[] {
  const lines: string[] = [];
  lines.push(`${evaluated} execution(s) replayed against the candidate policy.`);
  if (changed === 0) {
    lines.push("No behavioral change detected — the candidate behaves identically on this history.");
  } else {
    lines.push(`${changed} execution(s) would behave differently under the candidate.`);
    if (newlyDenied > 0) lines.push(`${newlyDenied} execution(s) would be newly DENIED.`);
    if (newlyAllowed > 0) lines.push(`${newlyAllowed} execution(s) would be newly ALLOWED.`);
  }
  if (toolCallFlips > 0) {
    lines.push(`${toolCallFlips} of ${toolCallsEvaluated} recorded tool calls flip their authorization verdict.`);
  } else if (toolCallsEvaluated > 0) {
    lines.push(`All ${toolCallsEvaluated} recorded tool calls keep their authorization verdict.`);
  }
  return lines;
}

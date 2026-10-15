// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Execution taint for indirect prompt injection.
 *
 * Neutralising a payload (see `injection-findings.ts`) is a heuristic. Once a
 * scan has flagged retrieved or tool-produced text, the rest of the run can no
 * longer be trusted to carry out only what the user asked. This module records
 * that fact per execution and lets the tool boundary act on it: after a
 * finding, a tool that is not declared read-only needs human approval before it
 * runs. Read-only tools are unaffected, so research keeps working.
 *
 * Read-only means the MCP tool declares `readOnlyHint: true` and does not also
 * declare `destructiveHint: true`. A tool without annotations is treated as a
 * write tool (fail safe, the same rule shadow and replay runs apply).
 */

import type { ApprovalRegistry, PendingApproval } from "./approval-gate.js";
import type { ExecRuntime } from "./exec-runtime.js";
import type { RequestContext } from "../types/monitoring.js";
import type { NodeDiagnosticInput } from "../types/debug-trace.js";

/** Per-execution record of "untrusted content reached the model". */
export interface ExecutionTaint {
  readonly tainted: boolean;
  /** Distinct source refs (`retrieval/kb`, `server/tool`) that caused the taint. */
  readonly sources: readonly string[];
  mark(sourceRef: string): void;
}

export function createExecutionTaint(): ExecutionTaint {
  const sources = new Set<string>();
  return {
    get tainted() {
      return sources.size > 0;
    },
    get sources() {
      return [...sources];
    },
    mark(sourceRef) {
      // Bounded: a long run must not grow this without limit.
      if (sources.size < 20) sources.add(sourceRef);
      else if (!sources.has(sourceRef)) sources.add("(more)");
    },
  };
}

/** The subset of MCP tool annotations the taint rule looks at. */
export interface TaintToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export function isReadOnlyTool(
  annotations: TaintToolAnnotations | undefined,
): boolean {
  return (
    annotations?.readOnlyHint === true && annotations.destructiveHint !== true
  );
}

/** Wiring a tool boundary needs to enforce the taint rule. */
export interface TaintGuard {
  taint: ExecutionTaint;
  /** Approval mechanism; when absent a tainted write call is denied outright. */
  gate?: ApprovalRegistry;
  notify?: (pending: PendingApproval) => void;
  /** Metric / trace sink for the outcome. */
  onOutcome?: (info: {
    toolRef: string;
    nodeId: string;
    outcome: "approved" | "denied" | "no_gate";
    sources: readonly string[];
  }) => void;
}

/**
 * Builds the guard for one node from the execution runtime, or undefined when
 * taint enforcement is off. Outcomes land on the node's trace
 * (`tainted_write_tool_approval`) and in `aiperator_taint_approvals_total`; the
 * approval request itself is the audit record, like any other approval.
 */
export function taintGuardForNode(
  runtime: Pick<
    ExecRuntime,
    | "taint"
    | "approvalGate"
    | "onApprovalRequired"
    | "onNodeDiagnostic"
    | "metrics"
  >,
  nodeId: string,
): TaintGuard | undefined {
  if (runtime.taint === undefined) return undefined;
  return {
    taint: runtime.taint,
    ...(runtime.approvalGate !== undefined
      ? { gate: runtime.approvalGate }
      : {}),
    ...(runtime.onApprovalRequired !== undefined
      ? { notify: runtime.onApprovalRequired }
      : {}),
    onOutcome: (info) => {
      runtime.onNodeDiagnostic?.(nodeId, taintDiagnostic(info));
      runtime.metrics?.recordCounter("aiperator_taint_approvals_total", {
        outcome: info.outcome,
      });
    },
  };
}

export type TaintDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Applies the taint rule to one tool call. Returns `allowed: true` when the
 * execution is clean or the tool is read-only. Otherwise it asks a human via
 * the approval gate and fails closed on denial, timeout or a missing gate.
 */
export async function enforceTaintApproval(
  guard: TaintGuard,
  call: {
    toolRef: string;
    nodeId: string;
    args: Record<string, unknown>;
    annotations: TaintToolAnnotations | undefined;
    ctx: Pick<
      RequestContext,
      "executionId" | "clientId" | "userName" | "userEmail" | "userId"
    >;
  },
): Promise<TaintDecision> {
  if (!guard.taint.tainted || isReadOnlyTool(call.annotations)) {
    return { allowed: true };
  }
  const sources = guard.taint.sources;
  if (guard.gate === undefined) {
    guard.onOutcome?.({
      toolRef: call.toolRef,
      nodeId: call.nodeId,
      outcome: "no_gate",
      sources,
    });
    return {
      allowed: false,
      reason:
        "Not executed: earlier content in this run looked like a prompt injection and no approval gate is configured to confirm a write action.",
    };
  }
  const requestedBy =
    call.ctx.userName ?? call.ctx.userEmail ?? call.ctx.userId;
  const decision = await guard.gate.request(
    {
      executionId: call.ctx.executionId,
      nodeId: call.nodeId,
      tool: call.toolRef,
      args: call.args,
      title: "Confirm action after suspected prompt injection",
      message:
        `Content from ${sources.join(", ")} looked like a prompt injection. ` +
        `Confirm that "${call.toolRef}" is really what the user asked for.`,
      ...(call.ctx.clientId !== undefined
        ? { tenantId: call.ctx.clientId }
        : {}),
      ...(requestedBy !== undefined && requestedBy.trim() !== ""
        ? { requestedBy }
        : {}),
    },
    guard.notify,
  );
  guard.onOutcome?.({
    toolRef: call.toolRef,
    nodeId: call.nodeId,
    outcome: decision.approved ? "approved" : "denied",
    sources,
  });
  if (decision.approved) return { allowed: true };
  return {
    allowed: false,
    reason: decision.reason ?? "denied by reviewer",
  };
}

/** Trace diagnostic emitted when the taint rule engaged on a call. */
export function taintDiagnostic(info: {
  toolRef: string;
  outcome: "approved" | "denied" | "no_gate";
  sources: readonly string[];
}): NodeDiagnosticInput {
  return {
    level: "warn",
    code: "tainted_write_tool_approval",
    message:
      `Write tool ${info.toolRef} needed approval after a suspected prompt injection ` +
      `(sources: ${info.sources.join(", ") || "unknown"}); ` +
      `outcome: ${info.outcome}.`,
    details: { tool: info.toolRef, outcome: info.outcome },
  };
}

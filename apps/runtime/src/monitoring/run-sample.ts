// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Turns a recorded execution (debug trace) into SAMPLE VALUES shaped like what
 * the engine exposes at run time, so the Studio's expression builder can pin a
 * real run and preview prompts, tool arguments and conditions with it:
 *
 *   - template roots (`resolveContextPlaceholders`, tool template context):
 *     `query`, `classLabel`, `classification`, `node.<id>.classification`,
 *     `turn[0]`, `context.*`
 *   - condition roots (`buildConditionContext`): `lastMessageText`,
 *     `messageCount`, `hasErrors`, `errorCount`, `currentNodeId`, `role`,
 *     `plan`, `language`, `userEmail`, `clientId`, `claims`
 *
 * Next to the sample values, `response` / `responseNodeId` carry the answer
 * the flow returned (the Studio's End node shows it).
 *
 * Only what the trace recorded is included: classification comes from
 * classifier nodes' parsed output (in execution order, later wins, like the
 * merged run state); fields the trace does not keep (e.g. `groups`, request
 * parameters) are simply absent.
 */

import type { DebugTrace } from "../types/debug-trace.js";

export interface RunSample {
  executionId: string;
  flowId: string | null;
  startedAt: string;
  /** Short text of the triggering user message, for pickers. */
  preview: string;
  sample: Record<string, unknown>;
  /** The answer the flow returned, when the run finished with one. */
  response?: string;
  /** Node that produced `response`. */
  responseNodeId?: string;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p !== null && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/** The last user message of a trace (what `{{query}}` renders). */
export function traceQuery(trace: DebugTrace): string {
  const users = trace.input_messages.filter((m) => m.role === "user");
  return messageText(users[users.length - 1]?.content);
}

export function buildRunSample(trace: DebugTrace): RunSample {
  const ordered = [...trace.nodes].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const node: Record<string, { classification: Record<string, unknown> }> = {};
  const classification: Record<string, unknown> = {};
  let classLabel: string | undefined;
  for (const n of ordered) {
    const parsed = n.classifier?.parsed;
    if (parsed) {
      node[n.node_id] = { classification: parsed };
      Object.assign(classification, parsed);
    }
    if (n.classifier?.class_label !== undefined) classLabel = n.classifier.class_label;
  }

  const c = trace.context;
  const context: Record<string, unknown> = {
    executionId: trace.execution_id,
    ...(c.user_name !== undefined ? { userName: c.user_name } : {}),
    ...(c.user_email !== undefined ? { userEmail: c.user_email } : {}),
    ...(c.user_id !== undefined ? { userId: c.user_id } : {}),
    ...(c.client_id !== undefined ? { clientId: c.client_id } : {}),
    ...(c.chat_id !== undefined ? { chatId: c.chat_id } : {}),
    ...(c.language !== undefined ? { language: c.language } : {}),
    ...(c.role !== undefined ? { role: c.role } : {}),
    ...(c.plan !== undefined ? { plan: c.plan } : {}),
    ...(c.jwt_claims !== undefined ? { claims: c.jwt_claims } : {}),
  };
  const query = traceQuery(trace);
  const errorCount =
    trace.errors.length + trace.nodes.filter((n) => n.status === "error").length;

  const sample: Record<string, unknown> = {
    // Template roots
    query,
    ...(classLabel !== undefined ? { classLabel } : {}),
    classification,
    node,
    turn: [node],
    context,
    // Condition roots
    lastMessageText: query,
    messageCount: trace.input_messages.length,
    hasErrors: errorCount > 0,
    errorCount,
    currentNodeId: ordered[ordered.length - 1]?.node_id ?? null,
    ...(c.role !== undefined ? { role: c.role } : {}),
    ...(c.plan !== undefined ? { plan: c.plan } : {}),
    ...(c.language !== undefined ? { language: c.language } : {}),
    ...(c.user_email !== undefined ? { userEmail: c.user_email } : {}),
    ...(c.client_id !== undefined ? { clientId: c.client_id } : {}),
    ...(c.jwt_claims !== undefined ? { claims: c.jwt_claims } : {}),
  };
  return {
    executionId: trace.execution_id,
    flowId: trace.flow_id,
    startedAt: trace.started_at,
    preview: query.length > 80 ? `${query.slice(0, 79)}…` : query,
    sample,
    ...(trace.final_response !== undefined ? { response: trace.final_response } : {}),
    ...(trace.final_node_id !== undefined ? { responseNodeId: trace.final_node_id } : {}),
  };
}

/** True when a trace belongs to `flowId` — the live flow or a Studio test run of it. */
export function traceBelongsToFlow(traceFlowId: string | null, flowId: string): boolean {
  return traceFlowId === flowId || (traceFlowId?.startsWith(`${flowId}@studio-`) ?? false);
}

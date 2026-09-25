// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Opening a recorded request (running or finished) from the Live Graph in the
 * Studio: the Studio's Run & Trace bar attaches to that execution and shows it
 * as if it had been started there — trace on the canvas, prompt, answer, pin.
 */

import type { NodeExecutionEvent } from "../types/monitoring";

const STUDIO_TEST_MARKER = "@studio-";
const REQUEST_NODE_ID = "__request__";
const RESPONSE_NODE_ID = "__response__";

/** The flow a run belongs to: Studio test runs (`<flowId>@studio-<nonce>`) map back to `<flowId>`. */
export function baseFlowId(flowId: string): string {
  const i = flowId.indexOf(STUDIO_TEST_MARKER);
  return i > 0 ? flowId.slice(0, i) : flowId;
}

/** Studio URL that opens `flowId` with `executionId` attached to Run & Trace. */
export function studioRunHref(flowId: string, executionId: string): string {
  const q = new URLSearchParams({ flow: baseFlowId(flowId), execution: executionId });
  return `/studio?${q.toString()}`;
}

/**
 * Durable events of one execution merged with live ones not in there yet.
 * A node's `running` event is dropped once a finished event for the same
 * start exists, so a late live `running` event can't regress its state.
 */
export function mergeExecutionEvents(
  persisted: NodeExecutionEvent[],
  live: NodeExecutionEvent[],
): NodeExecutionEvent[] {
  const key = (e: NodeExecutionEvent) => `${e.node_id}::${e.start_time}`;
  const seen = new Set(persisted.map((e) => `${key(e)}::${e.status}`));
  const all = [...persisted, ...live.filter((e) => !seen.has(`${key(e)}::${e.status}`))];
  const finished = new Set(all.filter((e) => e.status !== "running").map(key));
  return all.filter((e) => e.status !== "running" || !finished.has(key(e)));
}

export interface AttachedRunInfo {
  prompt?: string;
  /** The final answer, once the response boundary was recorded. */
  answer?: string;
  /** Still in progress: no response yet or a node still running. */
  running: boolean;
  flowId?: string;
}

/** The answer text inside the response boundary's assembled completion payload. */
export function answerText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
  } catch {
    // truncated or plain text: show as recorded
  }
  return raw;
}

/** Prompt, answer and progress of a recorded execution. */
export function describeRun(events: NodeExecutionEvent[]): AttachedRunInfo {
  let prompt: string | undefined;
  let answer: string | undefined;
  let flowId: string | undefined;
  const latest = new Map<string, NodeExecutionEvent>();
  for (const e of events) {
    latest.set(e.node_id, e);
    if (prompt === undefined && e.user_prompt) prompt = e.user_prompt;
    if (flowId === undefined && e.flow_id) flowId = e.flow_id;
    if (e.node_id === RESPONSE_NODE_ID && e.status !== "running" && e.response) {
      answer = answerText(e.response);
    }
  }
  if (prompt === undefined) {
    const req = latest.get(REQUEST_NODE_ID);
    if (req?.prompt) prompt = req.prompt;
  }
  const anyRunning = [...latest.values()].some((e) => e.status === "running");
  // Chat requests always close with a response boundary (also on errors); runs
  // recorded without boundaries count as done once no node is running.
  const response = latest.get(RESPONSE_NODE_ID);
  const awaitingResponse =
    latest.has(REQUEST_NODE_ID) && (response === undefined || response.status === "running");
  return {
    running: anyRunning || awaitingResponse,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(flowId !== undefined ? { flowId } : {}),
  };
}

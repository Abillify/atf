// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Pinned run data for the Studio's expression builder: a recorded execution
 * of the flow (live or a Studio test run), turned by the runtime into sample
 * values (`GET /monitoring/debug/:id/sample`), so prompts, tool arguments and
 * conditions preview with real node results. The pin is remembered per flow
 * in this browser.
 */

import { backendUrl } from "./backend-url";

export interface RunSummary {
  execution_id: string;
  flow_id: string | null;
  started_at: string;
  status: string;
  /** The triggering user message (shortened). */
  preview: string;
}

export interface PinnedRun {
  executionId: string;
  flowId: string | null;
  startedAt: string;
  preview: string;
  /** Values keyed like the run-time roots: query, context, node, classification, … */
  sample: Record<string, unknown>;
  /** The answer the flow returned (runs pinned before this was recorded have none). */
  response?: string;
  /** Node that produced `response`. */
  responseNodeId?: string;
}

const authHeaders = (token: string | undefined): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

/** Recent runs of `flowId`, including its Studio test runs (newest first). */
export async function fetchFlowRuns(flowId: string, token: string | undefined): Promise<RunSummary[]> {
  const resp = await fetch(backendUrl(`/monitoring/debug?flowId=${encodeURIComponent(flowId)}&limit=20`), {
    headers: authHeaders(token),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return ((await resp.json()) as { traces: RunSummary[] }).traces;
}

/** One run as sample values. */
export async function fetchRunSample(executionId: string, token: string | undefined): Promise<PinnedRun> {
  const resp = await fetch(backendUrl(`/monitoring/debug/${encodeURIComponent(executionId)}/sample`), {
    headers: authHeaders(token),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as PinnedRun;
}

/** One message of the request as the trace recorded it (text bounded). */
export interface RunTraceMessage {
  role: string;
  content: string | unknown[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

/** What kind of payload crossed an edge (mirrors runtime types/edge-flow.ts). */
export type EdgeFlowItemKind = "text" | "image" | "tool" | "data";

/** Passed along, consumed by the target, or produced by the source node. */
export type EdgeFlowItemStatus = "passed" | "produced" | "consumed";

/** One payload channel on an edge — rendered as a colored parallel line. */
export interface EdgeFlowItem {
  kind: EdgeFlowItemKind;
  label: string;
  status: EdgeFlowItemStatus;
  content?: string;
  media_type?: string;
  ref?: string;
  bytes?: number;
  tool_name?: string;
}

/** One traversal of an edge: every payload that crossed from source to target. */
export interface EdgeFlowRecord {
  source: string;
  target: string;
  sequence: number;
  items: EdgeFlowItem[];
}

/** The input side of a recorded execution (`GET /monitoring/debug/:id`). */
export interface RunTrace {
  execution_id: string;
  flow_id: string | null;
  flow_version?: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  /** Session identity and request metadata (chat_id, user_*, jwt_claims, …). */
  context: Record<string, unknown>;
  /** The conversation as received, all roles. */
  input_messages: RunTraceMessage[];
  /**
   * Per-edge data flow of this run (Studio-instrumented runs only): one
   * record per traversal; the canvas renders the newest per (source, target).
   */
  edge_flows?: EdgeFlowRecord[];
}

/** The full debug trace of one run — what the Start panel shows as the run's input. */
export async function fetchRunTrace(executionId: string, token: string | undefined): Promise<RunTrace> {
  const resp = await fetch(backendUrl(`/monitoring/debug/${encodeURIComponent(executionId)}`), {
    headers: authHeaders(token),
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as RunTrace;
}

/** Whether a run came from the Studio's test runner. */
export const isStudioRun = (flowId: string | null): boolean => flowId?.includes("@studio-") ?? false;

const storageKey = (flowId: string): string => `studio.pinnedRun.${flowId}`;

export function loadPinnedRun(flowId: string): PinnedRun | null {
  try {
    const raw = localStorage.getItem(storageKey(flowId));
    return raw ? (JSON.parse(raw) as PinnedRun) : null;
  } catch {
    return null;
  }
}

export function savePinnedRun(flowId: string, run: PinnedRun | null): void {
  try {
    if (run) localStorage.setItem(storageKey(flowId), JSON.stringify(run));
    else localStorage.removeItem(storageKey(flowId));
  } catch {
    // Storage unavailable (private mode, quota): the pin lasts for this session only.
  }
}

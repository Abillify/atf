// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Debug Trace Store (`src/monitoring/debug-trace-store.ts`)
 *
 * Bounded in-memory ring buffer for debug traces. Each entry captures what
 * happened during one flow execution (prompts, LLM responses, MCP/RAG tool call
 * arguments and results, semantic tool selection decisions, session metadata) so
 * a developer can export and inspect a run as JSON via
 * GET /monitoring/debug/:executionId.
 *
 * Design decisions:
 *   - NOT persisted to Postgres. Debug traces are operator/developer tooling
 *     only; a bounded in-memory store is the right tradeoff.
 *   - This store is the SINGLE ingest point for a trace, so it is also where the
 *     text budgets from `debug-trace-limits.ts` are enforced. Clamping here (not
 *     in the route) means the ring buffer itself stays small — an agentic
 *     Akten-Recherche run previously produced multi-megabyte traces, and 200 of
 *     those in the buffer is a heap problem, not just a large response. Metadata
 *     is never abridged; only free text is bounded.
 *   - Accumulation model: `_executeFlowInternal` builds per-node data in local
 *     maps, then calls `upsertNode` once per node when it completes. The store
 *     therefore never receives partial node data — each upsert is the final,
 *     complete record for that node.
 *   - Eviction: oldest entry evicted first (insertion-order Map) when the cap
 *     is reached. Default cap is 200 traces.
 *
 * No `any` at module boundaries.
 */

import type {
  DebugTrace,
  DebugTraceContext,
  DebugTraceLimits,
  DebugNodeTrace,
  DebugNodeAttempt,
  DebugUsage,
  DebugStreamError,
} from "../types/debug-trace.js";
import type { EdgeFlowRecord } from "../types/edge-flow.js";
import {
  DEFAULT_DEBUG_TRACE_LIMITS,
  clampDebugNode,
  clampDebugTrace,
  clampEdgeFlowRecord,
  clampUtf8,
} from "./debug-trace-limits.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Lightweight summary row for the list endpoint. */
export interface DebugTraceSummary {
  execution_id: string;
  flow_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  node_count: number;
}

export interface DebugTraceStore {
  /**
   * Registers a new trace skeleton at execution start. The `nodes` array is
   * initially empty; nodes are appended via {@link upsertNode}. Idempotent —
   * calling again with the same `execution_id` is a no-op.
   */
  startTrace(trace: DebugTrace): void;

  /**
   * Inserts or replaces the debug record for one graph node. Called once per
   * node from `emitNodeEnd`, after all of the node's tool calls have completed
   * and the full prompt/response text is available.
   */
  upsertNode(executionId: string, node: DebugNodeTrace): void;

  /**
   * Merges additional context onto an already-started trace.
   *
   * `startTrace` runs before the thread lock is taken, so facts that are only
   * known once the conversation thread has been resolved (the checkpoint thread
   * key, how much of the request transcript was already persisted) cannot be
   * supplied up front. They matter for post-mortems — a repeated answer is
   * indistinguishable from a duplicate submit without them — so they are patched
   * in rather than left out. No-op for an unknown execution id.
   */
  annotateContext(executionId: string, patch: Partial<DebugTraceContext>): void;

  /**
   * Appends one edge-traversal record to the trace's `edge_flows`. Called by
   * the engine each time the graph advances (conditional routers and
   * unconditional edges), so a loop over the same edge yields several records
   * and the consumer keeps the last per (source, target). No-op for an unknown
   * execution id.
   */
  upsertEdgeFlow(executionId: string, record: EdgeFlowRecord): void;

  /**
   * Seals the trace as finished, recording the final status, accumulated token
   * usage, any stream errors and — when there was one — the answer the flow
   * returned. Safe to call even when the execution errored mid-stream —
   * partial traces are still useful for debugging.
   */
  finishTrace(
    executionId: string,
    status: "completed" | "error",
    usage: DebugUsage,
    errors: DebugStreamError[],
    final?: { response: string; nodeId?: string },
  ): void;

  /** Returns the full trace for one execution, or `undefined` when not found. */
  getTrace(executionId: string): DebugTrace | undefined;

  /**
   * Returns lightweight summaries of the most recent traces, newest first.
   * Suitable for building a list view without loading full prompt/response text.
   */
  listRecent(limit: number): DebugTraceSummary[];
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

/** Cap on edge-flow records kept per trace (newest win on a loop). */
const MAX_EDGE_FLOWS_PER_TRACE = 200;

function nodeAttempt(node: DebugNodeTrace): DebugNodeAttempt | undefined {
  if (node.attempt === undefined) return undefined;
  const {
    node_id: _nodeId,
    node_type: _nodeType,
    attempt,
    attempts: _attempts,
    ...details
  } = node;
  return { attempt, ...details };
}

export class InMemoryDebugTraceStore implements DebugTraceStore {
  private readonly traces = new Map<string, DebugTrace>();
  /** Insertion-order list of execution IDs for eviction. */
  private readonly order: string[] = [];

  private readonly limits: DebugTraceLimits;

  constructor(
    private readonly maxTraces = 200,
    limits: Partial<DebugTraceLimits> = {},
  ) {
    this.limits = { ...DEFAULT_DEBUG_TRACE_LIMITS, ...limits };
  }

  startTrace(trace: DebugTrace): void {
    if (this.traces.has(trace.execution_id)) return;
    const bounded = clampDebugTrace(trace, this.limits);
    this.traces.set(bounded.execution_id, bounded);
    this.order.push(bounded.execution_id);
    this.evictIfNeeded();
  }

  upsertNode(executionId: string, node: DebugNodeTrace): void {
    const trace = this.traces.get(executionId);
    if (trace === undefined) return;
    const bounded = clampDebugNode(node, this.limits);
    // One entry per flow node and delegation instance: concurrent delegations
    // to the same node (instance_id set) must not replace each other.
    const idx = trace.nodes.findIndex(
      (n) => n.node_id === bounded.node_id && n.instance_id === bounded.instance_id,
    );
    if (bounded.attempt === undefined) {
      if (idx === -1) trace.nodes.push(bounded);
      else trace.nodes[idx] = bounded;
      return;
    }

    const currentAttempt = nodeAttempt(bounded);
    if (currentAttempt === undefined) return;
    if (idx === -1) {
      trace.nodes.push({ ...bounded, attempts: [currentAttempt] });
      return;
    }

    const previous = trace.nodes[idx];
    if (previous === undefined) return;
    const attempts = [...(previous.attempts ?? [])];
    if (attempts.length === 0) {
      const legacyAttempt = nodeAttempt(previous);
      if (legacyAttempt !== undefined) attempts.push(legacyAttempt);
    }
    const attemptIdx = attempts.findIndex(
      (item) => item.attempt === currentAttempt.attempt,
    );
    if (attemptIdx === -1) attempts.push(currentAttempt);
    else attempts[attemptIdx] = currentAttempt;
    attempts.sort((a, b) => a.attempt - b.attempt);
    trace.nodes[idx] = { ...bounded, attempts };
  }

  annotateContext(
    executionId: string,
    patch: Partial<DebugTraceContext>,
  ): void {
    const trace = this.traces.get(executionId);
    if (trace === undefined) return;
    trace.context = { ...trace.context, ...patch };
  }

  upsertEdgeFlow(executionId: string, record: EdgeFlowRecord): void {
    const trace = this.traces.get(executionId);
    if (trace === undefined) return;
    const bounded = clampEdgeFlowRecord(record, this.limits);
    const flows = trace.edge_flows ?? [];
    flows.push(bounded);
    // Ring semantics within the trace: a pathological loop could otherwise
    // grow edge_flows unbounded between clamping passes. Keep the newest.
    trace.edge_flows =
      flows.length > MAX_EDGE_FLOWS_PER_TRACE
        ? flows.slice(-MAX_EDGE_FLOWS_PER_TRACE)
        : flows;
  }

  finishTrace(
    executionId: string,
    status: "completed" | "error",
    usage: DebugUsage,
    errors: DebugStreamError[],
    final?: { response: string; nodeId?: string },
  ): void {
    const trace = this.traces.get(executionId);
    if (trace === undefined) return;
    trace.status = status;
    trace.finished_at = new Date().toISOString();
    trace.usage = usage;
    trace.errors = errors;
    if (final !== undefined) {
      trace.final_response = clampUtf8(
        final.response,
        this.limits.finalResponseBytes,
      );
      if (final.nodeId !== undefined) trace.final_node_id = final.nodeId;
    }
  }

  getTrace(executionId: string): DebugTrace | undefined {
    return this.traces.get(executionId);
  }

  listRecent(limit: number): DebugTraceSummary[] {
    const out: DebugTraceSummary[] = [];
    for (const id of this.order.toReversed()) {
      if (out.length >= limit) break;
      const t = this.traces.get(id);
      if (t !== undefined) {
        out.push({
          execution_id: t.execution_id,
          flow_id: t.flow_id,
          started_at: t.started_at,
          finished_at: t.finished_at,
          status: t.status,
          node_count: t.nodes.length,
        });
      }
    }
    return out;
  }

  private evictIfNeeded(): void {
    while (this.order.length > this.maxTraces) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.traces.delete(oldest);
    }
  }
}

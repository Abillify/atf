// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Execution audit / history store (`src/monitoring/execution-store.ts`)
 *
 * Persists the node-execution event stream so the dashboard "History" tab and
 * any audit tooling can show past runs — not just whatever happened to be live
 * in the current browser session.
 *
 * Two implementations behind one interface:
 *   - {@link InMemoryExecutionStore}: a bounded ring buffer. Always present so
 *     the history endpoint works without a database (session-scoped, per replica).
 *   - {@link PostgresExecutionStore}: durable, cross-replica audit log in the
 *     `executions` + `node_events` tables.
 *
 * `recordEvent` is fire-and-forget (never blocks or throws into the hot path).
 *
 * No `any` at module boundaries.
 */

import type { NodeExecutionEvent } from "../types/monitoring.js";
import {
  FLOW_END_NODE_ID,
  RESPONSE_NODE_ID,
} from "../types/monitoring.js";
import type { Database } from "../db/database.js";
import type { Logger } from "../observability/logger.js";
import {
  subjectUserIds,
  type ErasureSubject,
} from "../observability/retention.js";

/** Per-request rollup derived from the node-event stream. */
export interface ExecutionSummary {
  execution_id: string;
  flow_id: string | null;
  tenant_id: string | null;
  status: "running" | "completed" | "error";
  node_count: number;
  error_count: number;
  total_latency_ms: number | null;
  /**
   * Total estimated USD cost of this run — the sum of every node's `cost`.
   * Null when no priced LLM call was recorded.
   */
  total_cost: number | null;
  started_at: string;
  finished_at: string | null;
  /** Display name (or email/id) of the user who triggered the run. */
  user_name: string | null;
  /** The user's prompt text (last user message), truncated. */
  user_prompt: string | null;
  conversation_id?: string | null;
  chat_id?: string | null;
  session_id?: string | null;
}

/**
 * Columns the history view may sort on. Every value maps to a fixed SQL
 * expression (see {@link historySortClause}) — the client string is never
 * interpolated raw, so an unknown/attacker-supplied column cannot inject SQL.
 * `runtime` is derived (finished_at - started_at) rather than a stored column.
 */
export type HistorySortColumn =
  | "started_at"
  | "flow_id"
  | "user_name"
  | "node_count"
  | "total_latency_ms"
  | "total_cost"
  | "runtime";

/** Sort direction; defaults to `desc` (newest/largest first). */
export type HistorySortDirection = "asc" | "desc";

/** Whitelisted sort columns — used to validate a client-supplied `sort`. */
export const HISTORY_SORT_COLUMNS: readonly HistorySortColumn[] = [
  "started_at",
  "flow_id",
  "user_name",
  "node_count",
  "total_latency_ms",
  "total_cost",
  "runtime",
];

/** Narrow an arbitrary string to a whitelisted sort column. */
export function parseHistorySortColumn(
  value: string | undefined,
): HistorySortColumn | undefined {
  return HISTORY_SORT_COLUMNS.includes(value as HistorySortColumn)
    ? (value as HistorySortColumn)
    : undefined;
}

/** Fixed SQL expression per sort column — never built from raw input. */
const HISTORY_SORT_SQL: Record<HistorySortColumn, string> = {
  started_at: "started_at",
  flow_id: "flow_id",
  user_name: "user_name",
  node_count: "node_count",
  total_latency_ms: "total_latency_ms",
  total_cost: "total_cost",
  runtime: "(finished_at - started_at)",
};

/**
 * Build the ORDER BY clause for a history query. Nulls sort last regardless of
 * direction (a still-running run has no latency/cost/finish yet), with
 * `started_at DESC` as a stable tiebreaker so pagination never skips or repeats
 * a row when the sort key is not unique.
 */
export function historySortClause(
  query: Pick<HistoryQuery, "sortColumn" | "sortDir">,
): string {
  const col = HISTORY_SORT_SQL[query.sortColumn ?? "started_at"];
  const dir = (query.sortDir ?? "desc") === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir} NULLS LAST, started_at DESC`;
}

/** Extract the comparable value for one summary on a sort column (null = last). */
function sortValue(
  e: ExecutionSummary,
  column: HistorySortColumn,
): number | string | null {
  switch (column) {
    case "started_at":
      return e.started_at;
    case "flow_id":
      return e.flow_id;
    case "user_name":
      return e.user_name;
    case "node_count":
      return e.node_count;
    case "total_latency_ms":
      return e.total_latency_ms;
    case "total_cost":
      return e.total_cost;
    case "runtime": {
      if (e.finished_at === null) return null;
      const d =
        new Date(e.finished_at).getTime() - new Date(e.started_at).getTime();
      return Number.isFinite(d) ? d : null;
    }
  }
}

/**
 * In-memory counterpart of {@link historySortClause}: sorts summaries by the
 * same column/direction with nulls last and a `started_at DESC` tiebreaker, so
 * the in-memory store and Postgres return identically ordered pages.
 */
export function sortSummaries(
  rows: ExecutionSummary[],
  query: Pick<HistoryQuery, "sortColumn" | "sortDir">,
): ExecutionSummary[] {
  const column = query.sortColumn ?? "started_at";
  const dir = (query.sortDir ?? "desc") === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, column);
    const bv = sortValue(b, column);
    // Nulls always last, independent of direction.
    if (av === null && bv === null) {
      // fall through to tiebreaker
    } else if (av === null) return 1;
    else if (bv === null) return -1;
    else if (av !== bv) return av < bv ? -dir : dir;
    // Stable tiebreaker: newest first by started_at.
    return new Date(b.started_at).getTime() - new Date(a.started_at).getTime();
  });
}

/**
 * Query parameters for a paginated, filterable history listing.
 */
export interface HistoryQuery {
  /** Page size (rows to return). */
  limit: number;
  /** Rows to skip from the newest end (for pagination). Default 0. */
  offset?: number;
  /** Included flow ids. Empty/undefined includes every flow. */
  includeFlows?: string[];
  /** Excluded flow ids. Exclusion takes precedence over inclusion. */
  excludeFlows?: string[];
  /** When set, only executions triggered by this user (display name) are returned. */
  userName?: string;
  /** Column to sort by. Defaults to `started_at`. */
  sortColumn?: HistorySortColumn;
  /** Sort direction. Defaults to `desc`. */
  sortDir?: HistorySortDirection;
}

/** A single page of execution history plus the total matching count. */
export interface HistoryPage {
  executions: ExecutionSummary[];
  /** Total number of rows matching the filters (ignoring limit/offset). */
  total: number;
}

/** Distinct filter values available for the history view. */
export interface HistoryFacets {
  /** Distinct flow ids seen in the history, sorted. */
  flows: string[];
  /** Distinct user display names seen in the history, sorted. */
  users: string[];
}

/**
 * Per-flow run statistics aggregated over a time window — powers the flow
 * table's stats columns (run count, average runtime, average/total cost).
 */
export interface FlowStats {
  flow_id: string;
  /** Number of executions started within the window. */
  runs: number;
  /**
   * Mean of `total_latency_ms` over runs that have a latency (null when no
   * run in the window recorded one yet).
   */
  avg_latency_ms: number | null;
  /** Mean of `total_cost` over runs that have a cost (null when none did). */
  avg_cost: number | null;
  /** Sum of `total_cost` over the window (null when no run recorded a cost). */
  total_cost: number | null;
}

/** Extra context attached when persisting an event. */
export interface ExecutionEventMeta {
  flowId?: string;
  tenantId?: string;
  conversationId?: string;
  chatId?: string;
  sessionId?: string;
}

/**
 * One permanent per-request token-usage record — the essential cost info kept
 * indefinitely (independent of execution-history retention). One row per
 * request, accumulated across all of the run's LLM calls.
 */
export interface UsageLogEntry {
  execution_id: string;
  /** Flow that ran. */
  flow_id: string | null;
  tenant_id: string | null;
  /** Stable user id (may be null when the request was anonymous). */
  user_id: string | null;
  /** User display name/email captured at request time. */
  user_label: string | null;
  /** Last LLM model used in the request (provider/model). */
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Estimated total cost of the request (null when no priced call ran). */
  cost: number | null;
  /** Summed node wall-clock duration in ms (mirrors executions.total_latency_ms). */
  duration_ms: number | null;
  /** First N characters of the user's prompt. */
  prompt_preview: string | null;
  /** Request timestamp (ISO-8601). */
  created_at: string;
  finished_at: string | null;
}

export interface ExecutionStore {
  /** Records a single node-execution event. Fire-and-forget. */
  recordEvent(event: NodeExecutionEvent, meta?: ExecutionEventMeta): void;
  /**
   * Forces any internally batched/queued writes out immediately. A no-op for
   * implementations with no write buffering (e.g. {@link InMemoryExecutionStore}).
   * Called on graceful shutdown so a killed process does not drop the tail of
   * an in-flight batch window, and by any read path that needs to observe a
   * just-recorded event with no delay.
   */
  flush?(): Promise<void>;
  /** Returns the most recent executions, newest first. */
  listRecent(limit: number): Promise<ExecutionSummary[]>;
  /**
   * Returns a filterable, paginated page of executions (newest first) together
   * with the total number of rows matching the filters. Powers the dashboard
   * history view's pagination and flow/user filters.
   */
  listHistory(query: HistoryQuery): Promise<HistoryPage>;
  /** Returns the distinct flow ids and user names present in the history. */
  listHistoryFacets(): Promise<HistoryFacets>;
  /**
   * Per-flow run statistics (runs, avg latency, avg/total cost) over every
   * execution started at or after `sinceIso`. Powers the flow table's stats
   * columns. Flows without runs in the window are omitted.
   */
  listFlowStats(sinceIso: string): Promise<FlowStats[]>;
  /**
   * Returns the most recent permanent per-request token-usage records, newest
   * first. Unlike {@link listRecent}, these survive retention purges.
   */
  listRecentUsage(limit: number): Promise<UsageLogEntry[]>;
  /** Returns all node events for one execution, oldest first. */
  listEvents(executionId: string): Promise<NodeExecutionEvent[]>;
  /**
   * Clears the entire execution history (all executions and their events).
   * Operator action exposed via DELETE /monitoring/history. Returns the number
   * of executions removed.
   */
  clear(): Promise<number>;
  /**
   * Retention: deletes executions (and their events) started strictly before
   * the ISO cutoff. Returns the number of executions removed.
   */
  purgeOlderThan(cutoffIso: string): Promise<number>;
  /**
   * Right-to-be-forgotten. A subject carrying user identifiers erases only the
   * executions attributed to that user (`token_usage_log.user_id`/`user_label`
   * or `executions.user_name`), limited to `tenantId` when given, together
   * with their node events and usage-log rows. Only a subject without user
   * identifiers erases the whole tenant. Returns the number of executions
   * removed.
   */
  eraseSubject(subject: ErasureSubject): Promise<number>;
  /**
   * Execution ids attributed to one of the subject's user identifiers (same
   * attribution as {@link eraseSubject}); empty for a subject without user
   * identifiers. Lets stores keyed only by execution id (the PII vault) erase
   * one user's rows instead of the whole tenant's.
   */
  executionIdsForSubject(subject: ErasureSubject): Promise<string[]>;
  /**
   * Checkpoint thread keys (`${flow_id}:${conversation_id}`, see the graph
   * engine) of the subject's conversations: the user's executions for a
   * user-scoped subject, every execution of the tenant otherwise.
   */
  conversationThreadsForSubject(subject: ErasureSubject): Promise<string[]>;
}

const DEFAULT_TENANT_ID = "default";

const isTerminal = (s: NodeExecutionEvent["status"]): boolean =>
  s === "completed" || s === "error";

// ---------------------------------------------------------------------------
// In-memory ring buffer (default)
// ---------------------------------------------------------------------------

interface MemExecution extends ExecutionSummary {
  events: NodeExecutionEvent[];
  /** Accumulated token usage across the run's LLM calls (for the usage log). */
  prompt_tokens: number;
  completion_tokens: number;
  /** Last LLM model seen in the run. */
  model: string | null;
  /** Stable user id (from the request boundary event), when known. */
  user_id: string | null;
}

/** Bounded in-memory store. Evicts the oldest execution when full. */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly byId = new Map<string, MemExecution>();
  private readonly order: string[] = [];

  constructor(private readonly maxExecutions = 500) {}

  recordEvent(event: NodeExecutionEvent, meta?: ExecutionEventMeta): void {
    let exec = this.byId.get(event.execution_id);
    if (exec === undefined) {
      exec = {
        execution_id: event.execution_id,
        flow_id: meta?.flowId ?? null,
        tenant_id: meta?.tenantId ?? null,
        status: "running",
        node_count: 0,
        error_count: 0,
        total_latency_ms: null,
        total_cost: null,
        started_at: event.start_time,
        finished_at: null,
        user_name: event.user_name ?? null,
        user_prompt: event.user_prompt ?? null,
        conversation_id: meta?.conversationId ?? null,
        chat_id: meta?.chatId ?? null,
        session_id: meta?.sessionId ?? null,
        events: [],
        prompt_tokens: 0,
        completion_tokens: 0,
        model: null,
        user_id: event.user_id ?? null,
      };
      this.byId.set(event.execution_id, exec);
      this.order.push(event.execution_id);
      this.evictIfNeeded();
    }
    if (meta?.flowId && exec.flow_id === null) exec.flow_id = meta.flowId;
    if (meta?.tenantId && exec.tenant_id === null)
      exec.tenant_id = meta.tenantId;
    if (meta?.conversationId && exec.conversation_id === null)
      exec.conversation_id = meta.conversationId;
    if (meta?.chatId && exec.chat_id === null) exec.chat_id = meta.chatId;
    if (meta?.sessionId && exec.session_id === null)
      exec.session_id = meta.sessionId;
    // Backfill identity/prompt from whichever event carries them (the
    // `__request__` boundary node), without overwriting an existing value.
    if (event.user_name && exec.user_name === null)
      exec.user_name = event.user_name;
    if (event.user_prompt && exec.user_prompt === null)
      exec.user_prompt = event.user_prompt;
    if (event.user_id && exec.user_id === null) exec.user_id = event.user_id;
    exec.events.push(event);

    // Synthetic tool nodes are excluded from the rollup: their time is already
    // contained in the issuing node's latency (see PostgresExecutionStore).
    if (isTerminal(event.status) && event.kind !== "tool") {
      // The terminal markers (`__flow_end__` from the engine, `__response__`
      // from the chat route) are rollup markers, not graph nodes: they flip
      // the execution status but never count as a node or an error.
      const isTerminalMarker =
        event.node_id === FLOW_END_NODE_ID ||
        event.node_id === RESPONSE_NODE_ID;
      if (!isTerminalMarker) {
        exec.node_count += 1;
        if (event.status === "error") exec.error_count += 1;
      }
      if (event.latency_ms !== null) {
        exec.total_latency_ms = (exec.total_latency_ms ?? 0) + event.latency_ms;
      }
      if (event.cost !== undefined) {
        exec.total_cost = (exec.total_cost ?? 0) + event.cost;
      }
      // Accumulate token usage + capture the model for the permanent usage log.
      if (event.input_tokens !== undefined)
        exec.prompt_tokens += event.input_tokens;
      if (event.output_tokens !== undefined)
        exec.completion_tokens += event.output_tokens;
      if (event.model !== undefined && event.model !== "")
        exec.model = event.model;
      // Status/finished_at flip ONLY on the terminal marker. A completed node
      // inside a still-running multi-node flow must NOT report the whole
      // execution as completed — that made a flow indistinguishable from a
      // finished one seconds after its first node returned.
      if (isTerminalMarker) {
        exec.status = event.status;
        exec.finished_at = event.end_time;
      }
    }
  }

  private evictIfNeeded(): void {
    while (this.order.length > this.maxExecutions) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.byId.delete(oldest);
    }
  }

  async listRecent(limit: number): Promise<ExecutionSummary[]> {
    const out: ExecutionSummary[] = [];
    for (const id of this.order.toReversed()) {
      if (out.length >= limit) break;
      const exec = this.byId.get(id);
      if (exec !== undefined) out.push(stripEvents(exec));
    }
    return out;
  }

  async listHistory(query: HistoryQuery): Promise<HistoryPage> {
    const limit = Math.max(query.limit, 0);
    const offset = Math.max(query.offset ?? 0, 0);
    const matches: ExecutionSummary[] = [];
    // Newest-first, applying the flow/user filters.
    for (const id of this.order.toReversed()) {
      const exec = this.byId.get(id);
      if (exec === undefined) continue;
      const flowId = exec.flow_id ?? "";
      if (
        query.includeFlows !== undefined &&
        query.includeFlows.length > 0 &&
        !query.includeFlows.includes(flowId)
      )
        continue;
      if (query.excludeFlows?.includes(flowId) === true) continue;
      if (
        query.userName !== undefined &&
        (exec.user_name ?? "") !== query.userName
      )
        continue;
      matches.push(stripEvents(exec));
    }
    const sorted = sortSummaries(matches, query);
    const executions = sorted.slice(offset, offset + limit);
    return { executions, total: matches.length };
  }

  async listHistoryFacets(): Promise<HistoryFacets> {
    const flows = new Set<string>();
    const users = new Set<string>();
    for (const exec of this.byId.values()) {
      if (exec.flow_id !== null) flows.add(exec.flow_id);
      if (exec.user_name !== null && exec.user_name !== "")
        users.add(exec.user_name);
    }
    return {
      flows: [...flows].sort((a, b) => a.localeCompare(b)),
      users: [...users].sort((a, b) => a.localeCompare(b)),
    };
  }

  async listFlowStats(sinceIso: string): Promise<FlowStats[]> {
    const acc = new Map<string, FlowStatsAccumulator>();
    for (const exec of this.byId.values()) {
      if (exec.flow_id === null) continue;
      if (exec.started_at < sinceIso) continue;
      let a = acc.get(exec.flow_id);
      if (a === undefined) {
        a = { runs: 0, latencySum: 0, latencyN: 0, costSum: 0, costN: 0 };
        acc.set(exec.flow_id, a);
      }
      a.runs += 1;
      if (exec.total_latency_ms !== null) {
        a.latencySum += exec.total_latency_ms;
        a.latencyN += 1;
      }
      if (exec.total_cost !== null) {
        a.costSum += exec.total_cost;
        a.costN += 1;
      }
    }
    return [...acc.entries()]
      .map(([flowId, a]) => ({
        flow_id: flowId,
        runs: a.runs,
        avg_latency_ms: a.latencyN > 0 ? a.latencySum / a.latencyN : null,
        avg_cost: a.costN > 0 ? a.costSum / a.costN : null,
        total_cost: a.costN > 0 ? a.costSum : null,
      }))
      .sort((x, y) => x.flow_id.localeCompare(y.flow_id));
  }

  async listRecentUsage(limit: number): Promise<UsageLogEntry[]> {
    const out: UsageLogEntry[] = [];
    for (const id of this.order.toReversed()) {
      if (out.length >= limit) break;
      const exec = this.byId.get(id);
      if (exec !== undefined) out.push(memToUsage(exec));
    }
    return out;
  }

  async listEvents(executionId: string): Promise<NodeExecutionEvent[]> {
    return this.byId.get(executionId)?.events.slice() ?? [];
  }

  async clear(): Promise<number> {
    const removed = this.order.length;
    this.byId.clear();
    this.order.length = 0;
    return removed;
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    let removed = 0;
    for (const [id, exec] of this.byId) {
      if (exec.started_at < cutoffIso) {
        this.byId.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.rebuildOrder();
    return removed;
  }

  async eraseSubject(subject: ErasureSubject): Promise<number> {
    const userIds = new Set(subjectUserIds(subject));
    if (userIds.size === 0 && subject.tenantId === undefined) return 0;
    let removed = 0;
    for (const [id, exec] of this.byId) {
      const inTenant =
        subject.tenantId === undefined || exec.tenant_id === subject.tenantId;
      const ownedByUser =
        userIds.size === 0 ||
        (exec.user_id !== null && userIds.has(exec.user_id)) ||
        (exec.user_name !== null && userIds.has(exec.user_name));
      if (inTenant && ownedByUser) {
        this.byId.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.rebuildOrder();
    return removed;
  }

  async executionIdsForSubject(subject: ErasureSubject): Promise<string[]> {
    const userIds = new Set(subjectUserIds(subject));
    if (userIds.size === 0) return [];
    const ids: string[] = [];
    for (const [id, exec] of this.byId) {
      if (subject.tenantId !== undefined && exec.tenant_id !== subject.tenantId)
        continue;
      if (
        (exec.user_id !== null && userIds.has(exec.user_id)) ||
        (exec.user_name !== null && userIds.has(exec.user_name))
      )
        ids.push(id);
    }
    return ids;
  }

  async conversationThreadsForSubject(
    subject: ErasureSubject,
  ): Promise<string[]> {
    const owned =
      subjectUserIds(subject).length > 0
        ? new Set(await this.executionIdsForSubject(subject))
        : undefined;
    if (owned === undefined && subject.tenantId === undefined) return [];
    const threads = new Set<string>();
    for (const [id, exec] of this.byId) {
      if (owned !== undefined ? !owned.has(id) : exec.tenant_id !== subject.tenantId)
        continue;
      if (exec.flow_id !== null && exec.conversation_id !== null)
        threads.add(`${exec.flow_id}:${exec.conversation_id}`);
    }
    return [...threads];
  }

  private rebuildOrder(): void {
    const kept = this.order.filter((id) => this.byId.has(id));
    this.order.length = 0;
    this.order.push(...kept);
  }
}

function stripEvents(e: MemExecution): ExecutionSummary {
  const { events: _events, ...summary } = e;
  void _events;
  return summary;
}

/** Running totals for one flow while aggregating {@link FlowStats}. */
interface FlowStatsAccumulator {
  runs: number;
  latencySum: number;
  latencyN: number;
  costSum: number;
  costN: number;
}

/** Projects an in-memory execution into a permanent-log-shaped usage entry. */
function memToUsage(e: MemExecution): UsageLogEntry {
  return {
    execution_id: e.execution_id,
    flow_id: e.flow_id,
    tenant_id: e.tenant_id,
    user_id: e.user_id,
    user_label: e.user_name,
    model: e.model,
    prompt_tokens: e.prompt_tokens,
    completion_tokens: e.completion_tokens,
    total_tokens: e.prompt_tokens + e.completion_tokens,
    cost: e.total_cost,
    duration_ms: e.total_latency_ms,
    prompt_preview: e.user_prompt,
    created_at: e.started_at,
    finished_at: e.finished_at,
  };
}

// ---------------------------------------------------------------------------
// Postgres store (durable, cross-replica)
// ---------------------------------------------------------------------------

/** One row queued for a batched `node_events` insert. */
interface QueuedNodeEventRow {
  execution_id: string;
  node_id: string;
  status: NodeExecutionEvent["status"];
  start_time: string;
  end_time: string | null;
  latency_ms: number | null;
  error_message: string | null;
  sequence: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost: number | null;
  tool_calls: string | null;
  prompt: string | null;
  response: string | null;
  user_name: string | null;
  user_prompt: string | null;
  kind: string | null;
  parent_node_id: string | null;
  label: string | null;
}

export class PostgresExecutionStore implements ExecutionStore {
  /**
   * Bounded write queue for `node_events` INSERTs, flushed as one multi-row
   * statement instead of one INSERT per event.
   *
   * `node_events` is the one table here whose row count scales with node
   * count, not request count: a 10-node flow emits roughly 2 events per node
   * (start + terminal) plus synthetic tool-call events, so a single chat
   * request can queue 20-40 rows. Batching these into one INSERT (rather than
   * `executions`/`token_usage_log`, which are small per-execution UPSERTs with
   * COALESCE-based backfill semantics that a batch would have to reproduce
   * carefully) removes the dominant share of round-trips without touching
   * that backfill logic at all.
   *
   * Flushed on whichever comes first: `flushIntervalMs` elapsed, or
   * `maxBatchSize` rows queued — bounding both the write latency (a dashboard
   * "live-ish" tail) and the memory a burst of events can hold before landing.
   */
  private readonly writeQueue: QueuedNodeEventRow[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  /** Serialises flushes so two concurrent triggers never race the same rows. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Database,
    private readonly logger?: Logger,
    options: { flushIntervalMs?: number; maxBatchSize?: number } = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 200);
  }

  /**
   * Runs writes under a tenant context even for anonymous requests. The
   * default tenant is also used by cost_ledger, so this keeps legacy
   * tenant-less traffic compatible with enforced RLS without inserting NULL.
   */
  private scoped<T>(
    tenantId: string | undefined,
    cb: (db: Database) => Promise<T>,
  ): Promise<T> {
    const effectiveTenantId = tenantId ?? DEFAULT_TENANT_ID;
    if (this.db.withTenant) {
      return this.db.withTenant(effectiveTenantId, cb);
    }
    return cb(this.db);
  }

  /**
   * In-flight `persist()` calls not yet resolved. `recordEvent` is
   * fire-and-forget, so a row is only actually PUSHED onto `writeQueue`
   * partway through `persist()` (after the `executions`/`token_usage_log`
   * upserts) — `flush()` must wait for these too, or it can drain an empty
   * queue while a `persist()` call is still on its way to enqueueing a row.
   * Entries remove themselves on settle, so this never grows unbounded.
   */
  private readonly pendingPersists = new Set<Promise<void>>();

  recordEvent(event: NodeExecutionEvent, meta?: ExecutionEventMeta): void {
    const p = this.persist(event, meta).catch((err) => {
      this.logger?.warn("Failed to persist execution event", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.pendingPersists.add(p);
    void p.finally(() => this.pendingPersists.delete(p));
  }

  private async persist(
    event: NodeExecutionEvent,
    meta?: ExecutionEventMeta,
  ): Promise<void> {
    await this.scoped(meta?.tenantId, async (db) => {
      // Ensure the parent execution row exists (idempotent). When a later event
      // (the `__request__` boundary) carries identity/prompt, backfill them
      // without clobbering values already set.
      await db.query(
        `INSERT INTO executions
           (execution_id, flow_id, tenant_id, user_name, user_prompt, conversation_id, chat_id, session_id, status, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9)
         ON CONFLICT (execution_id) DO UPDATE
           SET user_name      = COALESCE(executions.user_name, EXCLUDED.user_name),
               user_prompt    = COALESCE(executions.user_prompt, EXCLUDED.user_prompt),
               conversation_id = COALESCE(executions.conversation_id, EXCLUDED.conversation_id),
               chat_id        = COALESCE(executions.chat_id, EXCLUDED.chat_id),
               session_id     = COALESCE(executions.session_id, EXCLUDED.session_id)`,
        [
          event.execution_id,
          meta?.flowId ?? null,
          meta?.tenantId ?? DEFAULT_TENANT_ID,
          event.user_name ?? null,
          event.user_prompt ?? null,
          meta?.conversationId ?? null,
          meta?.chatId ?? null,
          meta?.sessionId ?? null,
          event.start_time,
        ],
      );

      // Permanent per-request usage log (survives retention purges). Insert the
      // row on the first event; identity/prompt/flow arrive on the `__request__`
      // boundary event and are backfilled without clobbering existing values.
      // Token/cost/duration totals are rolled forward on terminal events below.
      await db.query(
        `INSERT INTO token_usage_log
           (execution_id, flow_id, tenant_id, user_id, user_label, prompt_preview, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (execution_id) DO UPDATE
           SET flow_id        = COALESCE(token_usage_log.flow_id, EXCLUDED.flow_id),
               tenant_id      = COALESCE(token_usage_log.tenant_id, EXCLUDED.tenant_id),
               user_id        = COALESCE(token_usage_log.user_id, EXCLUDED.user_id),
               user_label     = COALESCE(token_usage_log.user_label, EXCLUDED.user_label),
               prompt_preview = COALESCE(token_usage_log.prompt_preview, EXCLUDED.prompt_preview)`,
        [
          event.execution_id,
          meta?.flowId ?? null,
          meta?.tenantId ?? DEFAULT_TENANT_ID,
          event.user_id ?? null,
          event.user_name ?? null,
          event.user_prompt ?? null,
          event.start_time,
        ],
      );

      // Append the raw event for a full audit trail, including the per-node
      // detail the dashboard renders (order, model/tokens, tool calls,
      // prompt/response) and the request boundary's user identity/prompt.
      // Queued rather than inserted immediately — see `enqueueNodeEvent`.
      this.enqueueNodeEvent({
        execution_id: event.execution_id,
        node_id: event.node_id,
        status: event.status,
        start_time: event.start_time,
        end_time: event.end_time,
        latency_ms: event.latency_ms,
        error_message: event.error_message ?? null,
        sequence: event.sequence ?? null,
        model: event.model ?? null,
        input_tokens: event.input_tokens ?? null,
        output_tokens: event.output_tokens ?? null,
        cost: event.cost ?? null,
        tool_calls:
          event.tool_calls !== undefined
            ? JSON.stringify(event.tool_calls)
            : null,
        prompt: event.prompt ?? null,
        response: event.response ?? null,
        user_name: event.user_name ?? null,
        user_prompt: event.user_prompt ?? null,
        kind: event.kind ?? null,
        parent_node_id: event.parent_node_id ?? null,
        label: event.label ?? null,
      });

      // Roll the per-execution summary forward on terminal node events.
      // Synthetic tool nodes are excluded: their wall-clock time is already
      // contained in the issuing node's latency, so counting them would inflate
      // node_count and double-count total_latency_ms.
      if (isTerminal(event.status) && event.kind !== "tool") {
        // The terminal markers (`__flow_end__` from the engine, `__response__`
        // from the chat route) flip the execution status but are not graph
        // nodes themselves — mirrors InMemoryExecutionStore.recordEvent.
        // Ordinary node events only roll counters forward; the status stays
        // "running" until a marker arrives, so a multi-node flow never reports
        // "completed" after its first node.
        const isTerminalMarker =
          event.node_id === FLOW_END_NODE_ID ||
          event.node_id === RESPONSE_NODE_ID;
        await db.query(
          `UPDATE executions
              SET node_count = node_count + (CASE WHEN $6 THEN 0 ELSE 1 END),
                  error_count = error_count + (CASE WHEN $6 THEN 0 ELSE $2 END),
                  total_latency_ms = COALESCE(total_latency_ms, 0) + $3,
                  total_cost = CASE WHEN $5::double precision IS NULL THEN total_cost
                                        ELSE COALESCE(total_cost, 0) + $5 END,
                  status = CASE WHEN NOT $6 THEN status
                                WHEN $4 = 'error' OR status = 'error' THEN 'error'
                                ELSE 'completed' END,
                  finished_at = CASE WHEN $6 THEN now() ELSE finished_at END
            WHERE execution_id = $1`,
          [
            event.execution_id,
            event.status === "error" ? 1 : 0,
            event.latency_ms ?? 0,
            event.status,
            event.cost ?? null,
            isTerminalMarker,
          ],
        );

        // Roll the permanent usage log forward: accumulate tokens/cost/duration
        // and keep the last non-null model. `finished_at` marks the last event.
        await db.query(
          `UPDATE token_usage_log
              SET prompt_tokens     = prompt_tokens + $2,
                  completion_tokens = completion_tokens + $3,
                  total_tokens      = total_tokens + $2 + $3,
                  duration_ms       = duration_ms + $4,
                  cost              = CASE WHEN $5::double precision IS NULL THEN cost
                                           ELSE cost + $5 END,
                  model             = COALESCE($6, model),
                  finished_at       = now()
            WHERE execution_id = $1`,
          [
            event.execution_id,
            event.input_tokens ?? 0,
            event.output_tokens ?? 0,
            event.latency_ms ?? 0,
            event.cost ?? null,
            event.model ?? null,
          ],
        );
      }
    });
  }

  /**
   * Queues a `node_events` row and schedules (or immediately triggers) a
   * flush. Never awaited by the caller — `recordEvent` is fire-and-forget by
   * contract, so a queued-but-not-yet-flushed row is exactly as durable as an
   * in-flight single INSERT was before (i.e. not durable across a crash
   * between enqueue and flush; this trades a small window of that pre-existing
   * risk for a large reduction in database round-trips).
   */
  private enqueueNodeEvent(row: QueuedNodeEventRow): void {
    this.writeQueue.push(row);
    if (this.writeQueue.length >= this.maxBatchSize) {
      if (this.flushTimer !== undefined) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
      this.scheduleFlush();
      return;
    }
    if (this.flushTimer === undefined) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.scheduleFlush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  /** Chains onto `flushChain` so overlapping triggers flush sequentially, never concurrently. */
  private scheduleFlush(): void {
    this.flushChain = this.flushChain.then(() => this.flushNodeEvents());
  }

  /** Drains the current queue and inserts it as one multi-row statement. */
  private async flushNodeEvents(): Promise<void> {
    if (this.writeQueue.length === 0) return;
    const batch = this.writeQueue.splice(0, this.writeQueue.length);
    const cols = [
      "execution_id",
      "node_id",
      "status",
      "start_time",
      "end_time",
      "latency_ms",
      "error_message",
      "sequence",
      "model",
      "input_tokens",
      "output_tokens",
      "cost",
      "tool_calls",
      "prompt",
      "response",
      "user_name",
      "user_prompt",
      "kind",
      "parent_node_id",
      "label",
    ] as const;
    const params: unknown[] = [];
    const valueGroups: string[] = [];
    for (const row of batch) {
      const placeholders: string[] = [];
      for (const col of cols) {
        params.push(row[col]);
        placeholders.push(`$${params.length}`);
      }
      valueGroups.push(`(${placeholders.join(", ")})`);
    }
    const sql = `INSERT INTO node_events (${cols.join(", ")}) VALUES ${valueGroups.join(", ")}`;
    try {
      await this.db.query(sql, params);
    } catch (err) {
      this.logger?.warn("Failed to flush batched node_events insert", {
        rows: batch.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Flushes any queued `node_events` rows immediately. Exposed for graceful
   * shutdown (so a killed process does not drop the tail of an in-flight
   * batch window) and for tests that need to observe writes synchronously.
   */
  async flush(): Promise<void> {
    // Wait for every in-flight persist() to reach the point where it has
    // either enqueued its row or failed — otherwise a flush racing a fresh
    // recordEvent() could drain the queue before that event's row lands in it.
    if (this.pendingPersists.size > 0) {
      await Promise.allSettled([...this.pendingPersists]);
    }
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.scheduleFlush();
    await this.flushChain;
  }

  // listRecent / listEvents / purgeOlderThan below are operator-plane or
  // system (retention) reads that span tenants by design. They are NOT tenant
  // scoped and require a BYPASSRLS role under enforced RLS (see ADR-0005).
  async listRecent(limit: number): Promise<ExecutionSummary[]> {
    const rows = await this.db.withOperator((db) =>
      db.query<ExecutionRow>(
        `SELECT execution_id, flow_id, tenant_id, status, node_count, error_count,
                total_latency_ms, total_cost, started_at, finished_at, user_name, user_prompt,
                conversation_id, chat_id, session_id
           FROM executions
          ORDER BY started_at DESC
          LIMIT $1`,
        [limit],
      ),
    );
    return rows.map(rowToSummary);
  }

  // Filterable, paginated history read (operator-plane, cross-tenant by design
  // — same RLS caveat as listRecent). Builds a dynamic WHERE from the flow/user
  // filters and returns both the page and the total matching count.
  async listHistory(query: HistoryQuery): Promise<HistoryPage> {
    const limit = Math.max(query.limit, 0);
    const offset = Math.max(query.offset ?? 0, 0);

    const conditions: string[] = [];
    const filterParams: unknown[] = [];
    if (query.includeFlows !== undefined && query.includeFlows.length > 0) {
      filterParams.push(query.includeFlows);
      conditions.push(`flow_id = ANY($${filterParams.length}::text[])`);
    }
    if (query.excludeFlows !== undefined && query.excludeFlows.length > 0) {
      filterParams.push(query.excludeFlows);
      conditions.push(`NOT (flow_id = ANY($${filterParams.length}::text[]))`);
    }
    if (query.userName !== undefined) {
      filterParams.push(query.userName);
      conditions.push(`user_name = $${filterParams.length}`);
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this.db.withOperator(async (db) => {
      const countRows = await db.query<{ total: number | string }>(
        `SELECT COUNT(*)::bigint AS total FROM executions ${where}`,
        filterParams,
      );
      const total = Number(countRows[0]?.total ?? 0);

      const rows = await db.query<ExecutionRow>(
        `SELECT execution_id, flow_id, tenant_id, status, node_count, error_count,
                total_latency_ms, total_cost, started_at, finished_at, user_name, user_prompt,
                conversation_id, chat_id, session_id
           FROM executions
           ${where}
          ${historySortClause(query)}
          LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
        [...filterParams, limit, offset],
      );
      return { executions: rows.map(rowToSummary), total };
    });
  }

  async listHistoryFacets(): Promise<HistoryFacets> {
    return this.db.withOperator(async (db) => {
      const flowRows = await db.query<{ flow_id: string }>(
        `SELECT DISTINCT flow_id FROM executions
          WHERE flow_id IS NOT NULL
          ORDER BY flow_id ASC`,
        [],
      );
      const userRows = await db.query<{ user_name: string }>(
        `SELECT DISTINCT user_name FROM executions
          WHERE user_name IS NOT NULL AND user_name <> ''
          ORDER BY user_name ASC`,
        [],
      );
      return {
        flows: flowRows.map((r) => r.flow_id),
        users: userRows.map((r) => r.user_name),
      };
    });
  }

  // Per-flow run statistics over a time window (operator-plane, cross-tenant
  // by design — same RLS caveat as listRecent). AVG/SUM ignore NULL rows, so
  // flows whose runs have no latency/cost yet report null instead of 0.
  async listFlowStats(sinceIso: string): Promise<FlowStats[]> {
    const rows = await this.db.withOperator((db) =>
      db.query<FlowStatsRow>(
        `SELECT flow_id,
                COUNT(*)::bigint AS runs,
                AVG(total_latency_ms) AS avg_latency_ms,
                AVG(total_cost) AS avg_cost,
                SUM(total_cost) AS total_cost
           FROM executions
          WHERE started_at >= $1::timestamptz AND flow_id IS NOT NULL
          GROUP BY flow_id
          ORDER BY flow_id ASC`,
        [sinceIso],
      ),
    );
    return rows.map((r) => ({
      flow_id: r.flow_id,
      runs: Number(r.runs),
      avg_latency_ms:
        r.avg_latency_ms === null || r.avg_latency_ms === undefined
          ? null
          : Number(r.avg_latency_ms),
      avg_cost:
        r.avg_cost === null || r.avg_cost === undefined
          ? null
          : Number(r.avg_cost),
      total_cost:
        r.total_cost === null || r.total_cost === undefined
          ? null
          : Number(r.total_cost),
    }));
  }

  // Permanent usage log read (operator-plane, cross-tenant by design — same RLS
  // caveat as listRecent). Reads the durable token_usage_log, newest first.
  async listRecentUsage(limit: number): Promise<UsageLogEntry[]> {
    const rows = await this.db.withOperator((db) =>
      db.query<UsageLogRow>(
        `SELECT execution_id, flow_id, tenant_id, user_id, user_label, model,
                prompt_tokens, completion_tokens, total_tokens, cost,
                duration_ms, prompt_preview, created_at, finished_at
           FROM token_usage_log
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      ),
    );
    return rows.map(rowToUsage);
  }

  async listEvents(executionId: string): Promise<NodeExecutionEvent[]> {
    // Force out any queued-but-not-yet-flushed node_events rows first — a
    // caller asking for THIS execution's events almost always does so right
    // after it finished (the dashboard detail view, the explainability card),
    // exactly when a batch window might still be open. Without this, a read
    // immediately after a run could show a truncated event trail.
    await this.flush();
    // Fetching all events for a specific execution is an operator-plane read
    // (the dashboard history detail view). Cross-tenant by design — the
    // execution_id is the only selector, not the tenant — so we use the
    // operator pool under enforced RLS.
    const rows = await this.db.withOperator((db) =>
      db.query<NodeEventRow>(
        `SELECT execution_id, node_id, status, start_time, end_time, latency_ms, error_message,
                sequence, model, input_tokens, output_tokens, cost, tool_calls, prompt, response,
                user_name, user_prompt, kind, parent_node_id, label
           FROM node_events
          WHERE execution_id = $1
          ORDER BY sequence ASC NULLS LAST, created_at ASC`,
        [executionId],
      ),
    );
    return rows.map((r) => ({
      execution_id: r.execution_id,
      node_id: r.node_id,
      status: r.status,
      start_time: toIso(r.start_time),
      end_time: r.end_time === null ? null : toIso(r.end_time),
      latency_ms: r.latency_ms,
      ...(r.error_message !== null ? { error_message: r.error_message } : {}),
      ...(r.sequence !== null && r.sequence !== undefined
        ? { sequence: Number(r.sequence) }
        : {}),
      ...(r.model !== null && r.model !== undefined ? { model: r.model } : {}),
      ...(r.input_tokens !== null && r.input_tokens !== undefined
        ? { input_tokens: Number(r.input_tokens) }
        : {}),
      ...(r.output_tokens !== null && r.output_tokens !== undefined
        ? { output_tokens: Number(r.output_tokens) }
        : {}),
      ...(r.cost !== null && r.cost !== undefined
        ? { cost: Number(r.cost) }
        : {}),
      ...((): { tool_calls?: NodeExecutionEvent["tool_calls"] } => {
        const tc = parseToolCalls(r.tool_calls);
        return tc !== undefined ? { tool_calls: tc } : {};
      })(),
      ...(r.prompt !== null && r.prompt !== undefined
        ? { prompt: r.prompt }
        : {}),
      ...(r.response !== null && r.response !== undefined
        ? { response: r.response }
        : {}),
      ...(r.user_name !== null && r.user_name !== undefined
        ? { user_name: r.user_name }
        : {}),
      ...(r.user_prompt !== null && r.user_prompt !== undefined
        ? { user_prompt: r.user_prompt }
        : {}),
      ...(r.kind === "tool" ? { kind: "tool" as const } : {}),
      ...(r.parent_node_id !== null && r.parent_node_id !== undefined
        ? { parent_node_id: r.parent_node_id }
        : {}),
      ...(r.label !== null && r.label !== undefined ? { label: r.label } : {}),
    }));
  }

  async purgeOlderThan(cutoffIso: string): Promise<number> {
    // Retention purge spans all tenants — operator-plane, requires BYPASSRLS.
    return this.db.withOperator(async (db) => {
      await db.query(
        `DELETE FROM node_events WHERE execution_id IN
           (SELECT execution_id FROM executions WHERE started_at < $1)`,
        [cutoffIso],
      );
      const rows = await db.query<{ execution_id: string }>(
        `DELETE FROM executions WHERE started_at < $1 RETURNING execution_id`,
        [cutoffIso],
      );
      return rows.length;
    });
  }

  async eraseSubject(subject: ErasureSubject): Promise<number> {
    const userIds = subjectUserIds(subject);
    if (userIds.length > 0) return this.eraseUser(userIds, subject.tenantId);
    if (subject.tenantId === undefined) return 0;
    const tenantId = subject.tenantId;
    return this.scoped(tenantId, async (db) => {
      await db.query(
        `DELETE FROM node_events WHERE execution_id IN
           (SELECT execution_id FROM executions WHERE tenant_id = $1)`,
        [tenantId],
      );
      // The permanent usage log carries the prompt preview (PII), so a
      // right-to-be-forgotten erase must clear it too — it is otherwise never
      // pruned. Tenant-scoped, matching the execution erase above.
      await db.query(`DELETE FROM token_usage_log WHERE tenant_id = $1`, [
        tenantId,
      ]);
      const rows = await db.query<{ execution_id: string }>(
        `DELETE FROM executions WHERE tenant_id = $1 RETURNING execution_id`,
        [tenantId],
      );
      return rows.length;
    });
  }

  /**
   * User-scoped erase: only the executions attributed to one of `userIds`.
   * The usage log is the durable attribution (it outlives retention purges
   * and carries the stable `user_id`); `executions.user_name` covers rows
   * whose usage-log entry is gone. Without a tenant the erase spans tenants
   * and needs the operator connection.
   */
  private async eraseUser(
    userIds: string[],
    tenantId: string | undefined,
  ): Promise<number> {
    const run = async (db: Database): Promise<number> => {
      const ids = await ownedExecutionIds(db, userIds, tenantId);
      if (ids.length === 0) return 0;
      const idList = JSON.stringify(ids);
      await db.query(
        `DELETE FROM node_events WHERE execution_id::text IN
           (SELECT jsonb_array_elements_text($1::text::jsonb))`,
        [idList],
      );
      // The permanent usage log carries the prompt preview (PII), so the
      // user's rows go too — it is otherwise never pruned.
      await db.query(
        `DELETE FROM token_usage_log WHERE execution_id::text IN
           (SELECT jsonb_array_elements_text($1::text::jsonb))`,
        [idList],
      );
      const rows = await db.query<{ execution_id: string }>(
        `DELETE FROM executions WHERE execution_id::text IN
           (SELECT jsonb_array_elements_text($1::text::jsonb))
         RETURNING execution_id`,
        [idList],
      );
      return rows.length;
    };
    return tenantId !== undefined
      ? this.scoped(tenantId, run)
      : this.db.withOperator(run);
  }

  async executionIdsForSubject(subject: ErasureSubject): Promise<string[]> {
    const userIds = subjectUserIds(subject);
    if (userIds.length === 0) return [];
    const { tenantId } = subject;
    const run = (db: Database) => ownedExecutionIds(db, userIds, tenantId);
    return tenantId !== undefined
      ? this.scoped(tenantId, run)
      : this.db.withOperator(run);
  }

  async conversationThreadsForSubject(
    subject: ErasureSubject,
  ): Promise<string[]> {
    const userIds = subjectUserIds(subject);
    const { tenantId } = subject;
    if (userIds.length === 0 && tenantId === undefined) return [];
    const run = async (db: Database): Promise<string[]> => {
      const rows =
        userIds.length > 0
          ? await db.query<{ thread: string }>(
              `SELECT DISTINCT flow_id || ':' || conversation_id AS thread
                 FROM executions
                WHERE execution_id::text IN
                      (SELECT jsonb_array_elements_text($1::text::jsonb))
                  AND flow_id IS NOT NULL AND conversation_id IS NOT NULL`,
              [JSON.stringify(await ownedExecutionIds(db, userIds, tenantId))],
            )
          : await db.query<{ thread: string }>(
              `SELECT DISTINCT flow_id || ':' || conversation_id AS thread
                 FROM executions
                WHERE tenant_id = $1
                  AND flow_id IS NOT NULL AND conversation_id IS NOT NULL`,
              [tenantId],
            );
      return rows.map((r) => r.thread);
    };
    return tenantId !== undefined
      ? this.scoped(tenantId, run)
      : this.db.withOperator(run);
  }

  async clear(): Promise<number> {
    // Operator-plane clear of the whole audit log. Spans tenants by design and
    // requires the BYPASSRLS operator connection under enforced RLS (ADR-0005).
    return this.db.withOperator(async (db) => {
      await db.query(`DELETE FROM node_events`);
      const rows = await db.query<{ execution_id: string }>(
        `DELETE FROM executions RETURNING execution_id`,
      );
      return rows.length;
    });
  }
}

/** Execution ids attributed to one of `userIds` (see `eraseUser`). */
async function ownedExecutionIds(
  db: Database,
  userIds: string[],
  tenantId: string | undefined,
): Promise<string[]> {
  // A JSON list rather than a driver array parameter: Bun's SQL client sends
  // a JS array as a comma-joined string, which Postgres rejects. The `::text`
  // hop matters too — a bare `$1::jsonb` arrives as a JSON string scalar.
  const tenantClause = tenantId !== undefined ? " AND tenant_id = $2" : "";
  const idList = JSON.stringify(userIds);
  const params: unknown[] =
    tenantId !== undefined ? [idList, tenantId] : [idList];
  const rows = await db.query<{ execution_id: string }>(
    `WITH ids AS (SELECT jsonb_array_elements_text($1::text::jsonb) AS id)
     SELECT execution_id FROM token_usage_log
       WHERE (user_id IN (SELECT id FROM ids) OR user_label IN (SELECT id FROM ids))${tenantClause}
     UNION
     SELECT execution_id FROM executions
       WHERE user_name IN (SELECT id FROM ids)${tenantClause}`,
    params,
  );
  return rows.map((r) => r.execution_id);
}

interface ExecutionRow {
  execution_id: string;
  flow_id: string | null;
  tenant_id: string | null;
  status: ExecutionSummary["status"];
  node_count: number | string;
  error_count: number | string;
  total_latency_ms: number | string | null;
  total_cost: number | string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
  user_name: string | null;
  user_prompt: string | null;
  conversation_id: string | null;
  chat_id: string | null;
  session_id: string | null;
}

/** Aggregated {@link FlowStats} row as Postgres returns it (numeric as string). */
interface FlowStatsRow {
  flow_id: string;
  runs: number | string;
  avg_latency_ms: number | string | null;
  avg_cost: number | string | null;
  total_cost: number | string | null;
}

interface NodeEventRow {
  execution_id: string;
  node_id: string;
  status: NodeExecutionEvent["status"];
  start_time: string | Date;
  end_time: string | Date | null;
  latency_ms: number | null;
  error_message: string | null;
  sequence: number | string | null;
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cost: number | string | null;
  tool_calls: unknown;
  prompt: string | null;
  response: string | null;
  user_name: string | null;
  user_prompt: string | null;
  kind: string | null;
  parent_node_id: string | null;
  label: string | null;
}

/**
 * Reconstructs the `tool_calls` array from a JSONB column. The driver may
 * return it already parsed (object/array) or as a JSON string — handle both,
 * and fall back to undefined on anything unusable.
 */
function parseToolCalls(v: unknown): NodeExecutionEvent["tool_calls"] {
  if (v === null || v === undefined) return undefined;
  let value: unknown = v;
  if (typeof v === "string") {
    try {
      value = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(value)
    ? (value as NonNullable<NodeExecutionEvent["tool_calls"]>)
    : undefined;
}

function rowToSummary(r: ExecutionRow): ExecutionSummary {
  return {
    execution_id: r.execution_id,
    flow_id: r.flow_id,
    tenant_id: r.tenant_id,
    status: r.status,
    node_count: Number(r.node_count),
    error_count: Number(r.error_count),
    total_latency_ms:
      r.total_latency_ms === null ? null : Number(r.total_latency_ms),
    total_cost: r.total_cost === null ? null : Number(r.total_cost),
    started_at: toIso(r.started_at),
    finished_at: r.finished_at === null ? null : toIso(r.finished_at),
    user_name: r.user_name,
    user_prompt: r.user_prompt,
    conversation_id: r.conversation_id,
    chat_id: r.chat_id,
    session_id: r.session_id,
  };
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : v;
}

interface UsageLogRow {
  execution_id: string;
  flow_id: string | null;
  tenant_id: string | null;
  user_id: string | null;
  user_label: string | null;
  model: string | null;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  total_tokens: number | string;
  cost: number | string | null;
  duration_ms: number | string | null;
  prompt_preview: string | null;
  created_at: string | Date;
  finished_at: string | Date | null;
}

function rowToUsage(r: UsageLogRow): UsageLogEntry {
  return {
    execution_id: r.execution_id,
    flow_id: r.flow_id,
    tenant_id: r.tenant_id,
    user_id: r.user_id,
    user_label: r.user_label,
    model: r.model,
    prompt_tokens: Number(r.prompt_tokens),
    completion_tokens: Number(r.completion_tokens),
    total_tokens: Number(r.total_tokens),
    cost: r.cost === null ? null : Number(r.cost),
    duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
    prompt_preview: r.prompt_preview,
    created_at: toIso(r.created_at),
    finished_at: r.finished_at === null ? null : toIso(r.finished_at),
  };
}

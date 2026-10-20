// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type { Database } from "../db/database.js";
import type { GraphEngineService } from "../graph/graph-engine.js";
import type { FlowRegistry } from "../graph/flow-parser.js";
import type { DebugTraceStore } from "../monitoring/debug-trace-store.js";
import type { MonitoringServiceInterface } from "../monitoring/monitoring-service.js";
import type { Logger } from "../observability/logger.js";
import type { DebugTrace } from "../types/debug-trace.js";
import type { ChatCompletionChunk, TokenUsage } from "../types/openai.js";
import type { RequestContext } from "../types/monitoring.js";
import { evaluateAssertion, type Assertion, type AssertionResult } from "./eval-runner.js";

export type EvalMatrixStatus = "queued" | "running" | "completed" | "failed";
export type EvalMatrixCellStatus = EvalMatrixStatus;

export interface EvalMatrixTask {
  id: string;
  prompt: string;
  /**
   * Free-text reference answer, scored by token overlap (passes at 0.7). Optional
   * when `assert` is given; a task needs at least one of the two.
   */
  expected?: string;
  /**
   * Structured, deterministic checks (contains, regex, jsonPath, toolCalled,
   * maxTokens, …). All must pass. With `expected` as well, the cell passes only
   * when both do. Additive: tasks with only `expected` behave as before.
   */
  assert?: Assertion[];
}

export interface EvalMatrixCell {
  id: string;
  taskId: string;
  flowId: string;
  status: EvalMatrixCellStatus;
  executionId?: string;
  flowVersion?: string | null;
  responseText?: string;
  score?: number;
  passed?: boolean;
  /** Result of each structured assertion of the task, in order. */
  assertions?: AssertionResult[];
  latencyMs?: number;
  cost?: number;
  error?: string;
  trace?: DebugTrace;
  startedAt?: string;
  completedAt?: string;
}

export interface EvalMatrixRun {
  id: string;
  name: string;
  status: EvalMatrixStatus;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  concurrency: number;
  total: number;
  completed: number;
  failed: number;
  tasks: EvalMatrixTask[];
  flows: string[];
  cells: EvalMatrixCell[];
}

export type EvalMatrixRunSummary = Omit<EvalMatrixRun, "cells"> & {
  cells: Array<Omit<EvalMatrixCell, "trace"> & { traceAvailable: boolean }>;
};

export interface EvalMatrixRunStore {
  save(run: EvalMatrixRun): Promise<void>;
  get(id: string): Promise<EvalMatrixRun | undefined>;
  listRecent(limit?: number): Promise<EvalMatrixRun[]>;
}

function cloneRun(run: EvalMatrixRun): EvalMatrixRun {
  return structuredClone(run);
}

export class InMemoryEvalMatrixRunStore implements EvalMatrixRunStore {
  private readonly runs = new Map<string, EvalMatrixRun>();

  async save(run: EvalMatrixRun): Promise<void> {
    this.runs.set(run.id, cloneRun(run));
  }

  async get(id: string): Promise<EvalMatrixRun | undefined> {
    const run = this.runs.get(id);
    return run === undefined ? undefined : cloneRun(run);
  }

  async listRecent(limit = 50): Promise<EvalMatrixRun[]> {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(200, Math.floor(limit))))
      .map(cloneRun);
  }
}

interface EvalMatrixRunRow {
  payload: unknown;
}

export class PostgresEvalMatrixRunStore implements EvalMatrixRunStore {
  constructor(
    private readonly database: Database,
    private readonly logger?: Logger,
  ) {}

  async save(run: EvalMatrixRun): Promise<void> {
    await this.database.query(
      `INSERT INTO eval_matrix_runs
         (id, name, status, created_by, created_at, started_at, completed_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         started_at = EXCLUDED.started_at,
         completed_at = EXCLUDED.completed_at,
         payload = EXCLUDED.payload`,
      [
        run.id,
        run.name,
        run.status,
        run.createdBy,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
        JSON.stringify(run),
      ],
    );
  }

  async get(id: string): Promise<EvalMatrixRun | undefined> {
    try {
      const rows = await this.database.query<EvalMatrixRunRow>(
        "SELECT payload FROM eval_matrix_runs WHERE id = $1 AND expires_at > now()",
        [id],
      );
      return parseRun(rows[0]?.payload);
    } catch (error) {
      this.logger?.warn("Failed to load eval matrix run", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async listRecent(limit = 50): Promise<EvalMatrixRun[]> {
    const count = Math.max(1, Math.min(200, Math.floor(limit)));
    try {
      await this.database.query("DELETE FROM eval_matrix_runs WHERE expires_at <= now()");
      const rows = await this.database.query<EvalMatrixRunRow>(
        "SELECT payload FROM eval_matrix_runs WHERE expires_at > now() ORDER BY created_at DESC LIMIT $1",
        [count],
      );
      return rows.flatMap((row) => {
        const run = parseRun(row.payload);
        return run === undefined ? [] : [run];
      });
    } catch (error) {
      this.logger?.warn("Failed to list eval matrix runs", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function parseRun(value: unknown): EvalMatrixRun | undefined {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const run = parsed as Partial<EvalMatrixRun>;
  if (
    typeof run.id !== "string" ||
    typeof run.name !== "string" ||
    !Array.isArray(run.tasks) ||
    !Array.isArray(run.flows) ||
    !Array.isArray(run.cells)
  ) return undefined;
  return parsed as EvalMatrixRun;
}

export function createEvalMatrixRunStore(
  database?: Database,
  logger?: Logger,
): EvalMatrixRunStore {
  return database === undefined
    ? new InMemoryEvalMatrixRunStore()
    : new PostgresEvalMatrixRunStore(database, logger);
}

export function summarizeEvalMatrixRun(
  run: EvalMatrixRun,
  includeCellOutput = true,
): EvalMatrixRunSummary {
  return {
    ...run,
    cells: run.cells.map(({ trace, responseText, error, ...cell }) => ({
      ...cell,
      ...(includeCellOutput && responseText !== undefined ? { responseText } : {}),
      ...(includeCellOutput && error !== undefined ? { error } : {}),
      traceAvailable: trace !== undefined,
    })),
  };
}

export interface StartEvalMatrixInput {
  name: string;
  tasks: EvalMatrixTask[];
  flows: string[];
  concurrency?: number;
  createdBy: string;
}

export interface EvalMatrixServiceDeps {
  store: EvalMatrixRunStore;
  graphEngine: GraphEngineService;
  flowRegistry: FlowRegistry;
  debugTraceStore: DebugTraceStore;
  monitoring?: MonitoringServiceInterface;
  logger?: Logger;
  admit?: (flowId: string, context: RequestContext) => Promise<void>;
}

function normalizeReferenceText(value: string): string[] {
  return value
    .toLocaleLowerCase("de")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

/** Deterministic reference score used when no dedicated judge model is configured. */
export function scoreAgainstReference(actual: string, expected: string): number {
  const normalizedActual = normalizeReferenceText(actual);
  const normalizedExpected = normalizeReferenceText(expected);
  if (normalizedActual.join(" ") === normalizedExpected.join(" ")) return 1;
  if (normalizedActual.length === 0 || normalizedExpected.length === 0) return 0;
  const actualSet = new Set(normalizedActual);
  const expectedSet = new Set(normalizedExpected);
  let intersection = 0;
  for (const token of expectedSet) if (actualSet.has(token)) intersection += 1;
  return Math.round((2 * intersection / (actualSet.size + expectedSet.size)) * 1000) / 1000;
}

function redactArchiveValue(value: unknown, key = ""): unknown {
  if (/token|secret|password|authorization|api[-_]?key|cookie/i.test(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return JSON.stringify(redactArchiveValue(JSON.parse(value) as unknown));
      } catch {
        // Preserve non-JSON model/tool text and apply string-level patterns below.
      }
    }
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/(?:sk|api)[-_][A-Za-z0-9_-]{12,}/gi, "[REDACTED]")
      .replace(/(authorization|api[-_ ]?key|password|secret|token)\s*[:=]\s*["']?[^,\s"'}]+/gi, "$1=[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactArchiveValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactArchiveValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

/** Removes request identity and secret-looking values before durable trace archival. */
export function sanitizeTraceForArchive(trace: DebugTrace): DebugTrace {
  const sanitized = redactArchiveValue(structuredClone(trace)) as DebugTrace;
  sanitized.context = {
    ...(trace.context.trace_id !== undefined ? { trace_id: trace.context.trace_id } : {}),
  };
  return sanitized;
}

function traceCost(trace: DebugTrace | undefined): number {
  if (trace === undefined) return 0;
  return Math.round(
    trace.nodes.reduce((sum, node) => sum + (node.cost ?? 0), 0) * 1_000_000,
  ) / 1_000_000;
}

export class EvalMatrixService {
  private readonly persistChains = new Map<string, Promise<void>>();

  constructor(private readonly deps: EvalMatrixServiceDeps) {}

  private async persist(run: EvalMatrixRun): Promise<void> {
    const snapshot = cloneRun(run);
    const previous = this.persistChains.get(run.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.deps.store.save(snapshot));
    this.persistChains.set(run.id, next);
    try {
      await next;
    } finally {
      if (this.persistChains.get(run.id) === next) this.persistChains.delete(run.id);
    }
  }

  async start(input: StartEvalMatrixInput): Promise<EvalMatrixRunSummary> {
    const unknownFlows = input.flows.filter(
      (flowId) => this.deps.flowRegistry.get(flowId) === undefined,
    );
    if (unknownFlows.length > 0) {
      throw new Error(`Unknown flows: ${unknownFlows.join(", ")}`);
    }
    const createdAt = new Date().toISOString();
    const run: EvalMatrixRun = {
      id: crypto.randomUUID(),
      name: input.name,
      status: "queued",
      createdBy: input.createdBy,
      createdAt,
      concurrency: Math.max(1, Math.min(10, Math.floor(input.concurrency ?? 2))),
      total: input.tasks.length * input.flows.length,
      completed: 0,
      failed: 0,
      tasks: input.tasks,
      flows: input.flows,
      cells: input.tasks.flatMap((task) => input.flows.map((flowId) => ({
        id: crypto.randomUUID(),
        taskId: task.id,
        flowId,
        status: "queued" as const,
      }))),
    };
    await this.persist(run);
    void this.execute(run).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      run.status = "failed";
      run.completedAt = new Date().toISOString();
      for (const cell of run.cells) {
        if (cell.status === "queued" || cell.status === "running") {
          cell.status = "failed";
          cell.passed = false;
          cell.error = `Matrix execution aborted: ${message}`;
          cell.completedAt = run.completedAt;
        }
      }
      run.completed = run.cells.filter((cell) =>
        cell.status === "completed" || cell.status === "failed"
      ).length;
      run.failed = run.cells.filter((cell) => cell.status === "failed").length;
      try {
        await this.persist(run);
      } catch (persistError) {
        this.deps.logger?.error("Failed to persist terminal eval matrix state", {
          runId: run.id,
          error: persistError instanceof Error ? persistError.message : String(persistError),
        });
      }
      this.deps.logger?.error("Eval matrix execution failed", {
        runId: run.id,
        error: message,
      });
    });
    return summarizeEvalMatrixRun(run);
  }

  /** Marks process-local work interrupted by a restart as terminal instead of leaving stale runs. */
  async recoverInterruptedRuns(): Promise<number> {
    const runs = await this.deps.store.listRecent(200);
    let recovered = 0;
    for (const run of runs) {
      if (run.status !== "queued" && run.status !== "running") continue;
      const completedAt = new Date().toISOString();
      run.status = "failed";
      run.completedAt = completedAt;
      for (const cell of run.cells) {
        if (cell.status !== "queued" && cell.status !== "running") continue;
        cell.status = "failed";
        cell.passed = false;
        cell.error = "Runtime restarted before this cell completed; restart the matrix run.";
        cell.completedAt = completedAt;
      }
      run.completed = run.cells.filter((cell) =>
        cell.status === "completed" || cell.status === "failed"
      ).length;
      run.failed = run.cells.filter((cell) => cell.status === "failed").length;
      await this.persist(run);
      recovered += 1;
    }
    return recovered;
  }

  async get(id: string): Promise<EvalMatrixRunSummary | undefined> {
    const run = await this.deps.store.get(id);
    return run === undefined ? undefined : summarizeEvalMatrixRun(run);
  }

  async list(limit?: number): Promise<EvalMatrixRunSummary[]> {
    return (await this.deps.store.listRecent(limit)).map((run) =>
      summarizeEvalMatrixRun(run, false)
    );
  }

  async getTrace(runId: string, cellId: string): Promise<DebugTrace | undefined> {
    const run = await this.deps.store.get(runId);
    return run?.cells.find((cell) => cell.id === cellId)?.trace;
  }

  private async execute(run: EvalMatrixRun): Promise<void> {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    await this.persist(run);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const cell = run.cells[index];
        if (cell === undefined) return;
        await this.executeCell(run, cell);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(run.concurrency, run.cells.length) }, worker),
    );
    run.status = run.failed === run.total ? "failed" : "completed";
    run.completedAt = new Date().toISOString();
    await this.persist(run);
  }

  private async executeCell(
    run: EvalMatrixRun,
    cell: EvalMatrixCell,
  ): Promise<void> {
    const task = run.tasks.find((candidate) => candidate.id === cell.taskId);
    if (task === undefined) return;
    const started = Date.now();
    cell.status = "running";
    cell.startedAt = new Date(started).toISOString();
    cell.executionId = crypto.randomUUID();
    await this.persist(run);

    const chunks: string[] = [];
    let finalResponse = "";
    let usage: TokenUsage | undefined;
    const context: RequestContext = {
      // Never forward the operator-plane bearer into a user-token-aware MCP tool.
      // Flows requiring delegated end-user authority fail closed during admission.
      ssoToken: "",
      executionId: cell.executionId,
      userName: run.createdBy,
      requestParams: {
        eval_matrix_run_id: run.id,
        eval_matrix_cell_id: cell.id,
        eval_task_id: task.id,
      },
    };

    try {
      await this.deps.admit?.(cell.flowId, context);
      await this.deps.graphEngine.executeFlow(
        cell.flowId,
        [{ role: "user", content: task.prompt }],
        context,
        async (chunk: ChatCompletionChunk) => {
          const content = chunk.choices[0]?.delta?.content;
          if (typeof content === "string") chunks.push(content);
        },
        async (result) => { usage = result; },
        this.deps.monitoring,
        undefined,
        async (response) => { finalResponse = response; },
      );
      const trace = this.deps.debugTraceStore.getTrace(cell.executionId);
      const responseText = finalResponse || chunks.join("");
      const toolCalls = trace?.nodes.flatMap((node) => node.tool_calls.map((call) => call.name));
      const totalTokens = usage?.total_tokens;
      const cost = traceCost(trace);
      const latencyMs = Date.now() - started;
      const assertions = (task.assert ?? []).map((assertion) =>
        evaluateAssertion(assertion, {
          text: responseText,
          latencyMs,
          cost,
          ...(toolCalls !== undefined ? { toolCalls } : {}),
          ...(typeof totalTokens === "number" ? { totalTokens } : {}),
        }),
      );
      const reference =
        task.expected !== undefined ? scoreAgainstReference(responseText, task.expected) : undefined;
      const assertionRate =
        assertions.length > 0 ? assertions.filter((a) => a.passed).length / assertions.length : undefined;
      const score =
        reference !== undefined && assertionRate !== undefined
          ? Math.min(reference, assertionRate)
          : (reference ?? assertionRate ?? 0);
      cell.status = "completed";
      cell.responseText = responseText;
      cell.score = Math.round(score * 1000) / 1000;
      cell.passed =
        (reference === undefined || reference >= 0.7) && assertions.every((a) => a.passed);
      if (assertions.length > 0) cell.assertions = assertions;
      cell.flowVersion = trace?.flow_version;
      cell.trace = trace === undefined ? undefined : sanitizeTraceForArchive(trace);
      cell.cost = traceCost(trace);
      if (cell.cost === 0 && usage !== undefined && "cost_usd" in usage) {
        const cost = (usage as TokenUsage & { cost_usd?: number }).cost_usd;
        if (typeof cost === "number") cell.cost = cost;
      }
    } catch (error) {
      const trace = this.deps.debugTraceStore.getTrace(cell.executionId);
      cell.status = "failed";
      cell.passed = false;
      cell.score = 0;
      cell.responseText = finalResponse || chunks.join("");
      cell.error = error instanceof Error ? error.message : String(error);
      cell.flowVersion = trace?.flow_version;
      cell.trace = trace === undefined ? undefined : sanitizeTraceForArchive(trace);
      cell.cost = traceCost(trace);
      run.failed += 1;
    } finally {
      cell.latencyMs = Date.now() - started;
      cell.completedAt = new Date().toISOString();
      run.completed += 1;
      await this.persist(run);
    }
  }
}

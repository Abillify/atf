"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useFlows } from "../hooks/useFlows";
import { FlowMultiSelect } from "./FlowMultiSelect";
import {
  Badge,
  Button,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";

interface AssertionResult {
  assertion: { type: string };
  passed: boolean;
  detail?: string;
  score?: number;
}

interface CaseResult {
  id: string;
  flow: string;
  passed: boolean;
  latencyMs: number;
  cost: number;
  responseText: string;
  assertions: AssertionResult[];
  score?: number;
  error?: string;
}

interface EvalReport {
  name: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  totalCost: number;
  avgLatencyMs: number;
  avgScore?: number;
  cases: CaseResult[];
}

interface EvalRunRecord {
  id: string;
  name: string;
  source: "ci" | "manual";
  recordedAt: string;
  report: EvalReport;
}

type MatrixStatus = "queued" | "running" | "completed" | "failed";

interface MatrixTask {
  id: string;
  prompt: string;
  expected: string;
}

interface MatrixCell {
  id: string;
  taskId: string;
  flowId: string;
  status: MatrixStatus;
  executionId?: string;
  flowVersion?: string | null;
  responseText?: string;
  score?: number;
  passed?: boolean;
  latencyMs?: number;
  cost?: number;
  error?: string;
  traceAvailable: boolean;
}

interface MatrixRun {
  id: string;
  name: string;
  status: MatrixStatus;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  concurrency: number;
  total: number;
  completed: number;
  failed: number;
  tasks: MatrixTask[];
  flows: string[];
  cells: MatrixCell[];
}

interface TraceResponse {
  trace: Record<string, unknown>;
}

const DEFAULT_TASKS = JSON.stringify(
  [
    {
      id: "task-1",
      prompt: "Insert the task prompt here",
      expected: "Insert the perfect answer here",
    },
  ],
  null,
  2,
);

function fetchEvalRuns(token: string | undefined, limit: number): Promise<EvalRunRecord[]> {
  return authFetch(backendUrl(`/admin/eval/runs?limit=${limit}`), token)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<{ runs: EvalRunRecord[] }>;
    })
    .then((data) => data.runs);
}

function fetchMatrixRuns(token: string | undefined, limit: number): Promise<MatrixRun[]> {
  return authFetch(backendUrl(`/admin/eval/matrix-runs?limit=${limit}`), token)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<{ runs?: unknown[] }>;
    })
    .then((data) => (data.runs ?? []).filter(
      (run): run is MatrixRun =>
        typeof run === "object" && run !== null && Array.isArray((run as MatrixRun).cells),
    ));
}

function fetchMatrixRun(token: string | undefined, id: string): Promise<MatrixRun> {
  return authFetch(
    backendUrl(`/admin/eval/matrix-runs/${encodeURIComponent(id)}`),
    token,
  ).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<{ run: MatrixRun }>;
  }).then((data) => data.run);
}

function statusVariant(status: MatrixStatus): "default" | "secondary" | "destructive" {
  if (status === "failed") return "destructive";
  if (status === "completed") return "default";
  return "secondary";
}

function scoreColor(score: number): string {
  if (score >= 0.9) return "text-green-600";
  if (score >= 0.7) return "text-amber-600";
  return "text-red-600";
}

function TraceDetail({ runId, cell, token }: {
  runId: string;
  cell: MatrixCell;
  token: string | undefined;
}): React.JSX.Element {
  const [enabled, setEnabled] = React.useState(false);
  const { data, isLoading, error } = useQuery<TraceResponse, Error>({
    queryKey: ["eval", "matrix-trace", runId, cell.id],
    queryFn: async () => {
      const response = await authFetch(
        backendUrl(`/admin/eval/matrix-runs/${encodeURIComponent(runId)}/cells/${encodeURIComponent(cell.id)}/trace`),
        token,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<TraceResponse>;
    },
    enabled,
    staleTime: Infinity,
  });

  if (!cell.traceAvailable) {
    return <span className="text-xs text-muted-foreground">No trace archived</span>;
  }
  return (
    <div className="mt-2">
      <Button type="button" size="sm" variant="outline" onClick={() => setEnabled((value) => !value)}>
        {enabled ? "Close trace" : "Open trace"}
      </Button>
      {enabled && isLoading && <p className="mt-2 text-xs text-muted-foreground">Loading trace…</p>}
      {enabled && error && <p className="mt-2 text-xs text-red-600">Failed to load trace: {error.message}</p>}
      {enabled && data && (
        <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted p-3 text-[11px] text-foreground">
          {JSON.stringify(data.trace, null, 2)}
        </pre>
      )}
    </div>
  );
}

function MatrixRunDetail({ run, token }: { run: MatrixRun; token: string | undefined }): React.JSX.Element {
  return (
    <div className="space-y-4 border-t border-border p-4">
      {run.tasks.map((task) => {
        const cells = run.cells.filter((cell) => cell.taskId === task.id);
        return (
          <section key={task.id} className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 grid gap-2 lg:grid-cols-2">
              <div>
                <div className="text-[11px] font-semibold uppercase text-muted-foreground">Task · {task.id}</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{task.prompt}</p>
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase text-muted-foreground">Perfect answer</div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{task.expected}</p>
              </div>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {cells.map((cell) => (
                <article key={cell.id} className="rounded-md border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-mono text-xs font-semibold text-foreground">
                      {cell.flowId}{cell.flowVersion ? ` · v${cell.flowVersion}` : ""}
                    </div>
                    <Badge variant={statusVariant(cell.status)}>{cell.status}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>Score: {cell.score === undefined ? "—" : <strong className={scoreColor(cell.score)}>{(cell.score * 100).toFixed(1)}%</strong>}</span>
                    <span>Latency: {cell.latencyMs === undefined ? "—" : `${cell.latencyMs}ms`}</span>
                    <span>Cost: {cell.cost === undefined ? "—" : `$${cell.cost.toFixed(6)}`}</span>
                  </div>
                  {cell.executionId && <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">Execution: {cell.executionId}</div>}
                  {cell.error && <div className="mt-2 text-xs text-red-600">{cell.error}</div>}
                  <div className="mt-3 text-[11px] font-semibold uppercase text-muted-foreground">Response</div>
                  <p className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-sm text-foreground">
                    {cell.responseText || (cell.status === "running" ? "Flow running…" : "Not started yet")}
                  </p>
                  <TraceDetail runId={run.id} cell={cell} token={token} />
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function MatrixRunCard({ run, token }: { run: MatrixRun; token: string | undefined }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const { data: detail, isLoading, error } = useQuery<MatrixRun, Error>({
    queryKey: ["eval", "matrix-run", run.id],
    queryFn: () => fetchMatrixRun(token, run.id),
    enabled: expanded,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return expanded && (status === "queued" || status === "running") ? 2_000 : false;
    },
  });
  const progress = run.total === 0 ? 0 : run.completed / run.total;
  return (
    <details
      className="overflow-hidden rounded-lg border border-border bg-card shadow-sm"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="cursor-pointer list-none p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-semibold text-foreground">{run.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {run.tasks.length} tasks × {run.flows.length} flows · {new Date(run.createdAt).toLocaleString()}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{run.completed}/{run.total}</span>
            <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
          </div>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
        </div>
      </summary>
      {expanded && isLoading && <p className="border-t border-border p-4 text-xs text-muted-foreground">Loading details…</p>}
      {expanded && error && <p className="border-t border-border p-4 text-xs text-red-600">Failed to load details: {error.message}</p>}
      {expanded && detail && <MatrixRunDetail run={detail} token={token} />}
    </details>
  );
}

function MatrixRuns({ runs, token }: { runs: MatrixRun[]; token: string | undefined }): React.JSX.Element {
  if (runs.length === 0) {
    return <div className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">No matrix evaluation started yet.</div>;
  }
  return (
    <div className="space-y-3">
      {runs.map((run) => <MatrixRunCard key={run.id} run={run} token={token} />)}
    </div>
  );
}

function passRateColor(rate: number): string {
  if (rate >= 0.9) return "text-green-600";
  if (rate >= 0.7) return "text-amber-600";
  return "text-red-600";
}

function RunRow({ run, expanded, onToggle }: {
  run: EvalRunRecord;
  expanded: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { report } = run;
  const failedCases = report.cases.filter((evalCase) => !evalCase.passed);
  return (
    <>
      <TableRow onClick={onToggle} className="cursor-pointer hover:bg-muted/50">
        <TableCell className="font-mono text-xs text-foreground">{report.name}</TableCell>
        <TableCell><Badge variant={run.source === "ci" ? "secondary" : "default"}>{run.source}</Badge></TableCell>
        <TableCell className={`font-semibold ${passRateColor(report.passRate)}`}>
          {(report.passRate * 100).toFixed(1)}% ({report.passed}/{report.total})
        </TableCell>
        <TableCell className="text-muted-foreground">{report.avgLatencyMs.toFixed(0)}ms</TableCell>
        <TableCell className="text-muted-foreground">${report.totalCost.toFixed(6)}</TableCell>
        <TableCell className="text-muted-foreground">{report.avgScore !== undefined ? `${(report.avgScore * 100).toFixed(0)}%` : "—"}</TableCell>
        <TableCell className="text-muted-foreground">{new Date(run.recordedAt).toLocaleString()}</TableCell>
      </TableRow>
      {expanded && failedCases.length > 0 && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/30 p-3">
            <div className="mb-2 text-xs font-semibold text-foreground">Failed cases ({failedCases.length})</div>
            <div className="flex flex-col gap-1.5">
              {failedCases.map((evalCase) => (
                <div key={evalCase.id} className="rounded border border-border bg-card px-2 py-1.5 text-xs">
                  <div className="font-mono text-muted-foreground">{evalCase.id} ({evalCase.flow})</div>
                  {evalCase.error && <div className="text-red-600">error: {evalCase.error}</div>}
                  {evalCase.assertions.filter((assertion) => !assertion.passed).map((assertion, index) => (
                    <div key={index} className="text-red-600">✗ {assertion.assertion.type}: {assertion.detail ?? "failed"}</div>
                  ))}
                </div>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export interface EvalRunsPanelProps {
  limit?: number;
}

export function EvalRunsPanel({ limit = 20 }: EvalRunsPanelProps): React.JSX.Element {
  // isAuthenticated statt !!token: laedt auch bei AUTHN_MODE=disabled (kein
  // Token; Backend bedient die Operator-Plane anonym). authFetch laesst den
  // Authorization-Header bei undefined-Token weg.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("Flow comparison");
  const [selectedFlows, setSelectedFlows] = React.useState<string[]>([]);
  const [tasksJson, setTasksJson] = React.useState(DEFAULT_TASKS);
  const [concurrency, setConcurrency] = React.useState(2);
  const [formError, setFormError] = React.useState<string | null>(null);
  const { flows } = useFlows({ token: token ?? undefined, enabled: ready && isAuthenticated });

  const { data: runs = [], isLoading, error } = useQuery<EvalRunRecord[], Error>({
    queryKey: ["eval", "runs", limit],
    queryFn: () => fetchEvalRuns(token, limit),
    enabled: ready && isAuthenticated,
  });
  const { data: matrixRuns = [], error: matrixError } = useQuery<MatrixRun[], Error>({
    queryKey: ["eval", "matrix-runs", limit],
    queryFn: () => fetchMatrixRuns(token, limit),
    enabled: ready && isAuthenticated,
    refetchInterval: (query) => {
      const current = query.state.data;
      return Array.isArray(current) && current.some((run) =>
        run.status === "queued" || run.status === "running"
      ) ? 2_000 : false;
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      setFormError(null);
      let tasks: unknown;
      try {
        tasks = JSON.parse(tasksJson) as unknown;
      } catch {
        throw new Error("Tasks must be valid JSON.");
      }
      if (!Array.isArray(tasks)) throw new Error("Tasks must be a JSON array.");
      if (selectedFlows.length === 0) throw new Error("Select at least one flow.");
      const response = await authFetch(backendUrl("/admin/eval/matrix-runs"), token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, tasks, flows: selectedFlows, concurrency }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      return body;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["eval", "matrix-runs"] }),
    onError: (mutationError) => setFormError(
      mutationError instanceof Error ? mutationError.message : String(mutationError),
    ),
  });

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-foreground">Evaluate a new flow matrix</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every task is executed against every selected flow. Runs continue asynchronously; for each result the execution ID, flow version and the full bounded debug trace are archived.
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_12rem]">
          <label className="text-xs font-medium text-foreground">
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm" />
          </label>
          <label className="text-xs font-medium text-foreground">
            Concurrency
            <input type="number" min={1} max={10} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm" />
          </label>
        </div>
        <div className="mt-4">
          <FlowMultiSelect label="Select flows" options={flows.map((flow) => flow.id)} value={selectedFlows} onChange={setSelectedFlows} />
        </div>
        <label className="mt-4 block text-xs font-medium text-foreground">
          Tasks and perfect answers (JSON)
          <textarea value={tasksJson} onChange={(event) => setTasksJson(event.target.value)} rows={12} spellCheck={false} className="mt-1 w-full rounded-md border border-border bg-background p-3 font-mono text-xs" />
        </label>
        {formError && <div role="alert" className="mt-3 rounded bg-red-50 p-3 text-xs text-red-700">{formError}</div>}
        <Button type="button" className="mt-4" loading={startMutation.isPending} onClick={() => startMutation.mutate()}>
          Start matrix ({selectedFlows.length} flows)
        </Button>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Asynchronous matrix runs</h2>
        {matrixError && <div role="alert" className="mb-3 rounded bg-red-50 p-3 text-xs text-red-700">Failed to load matrix runs: {matrixError.message}</div>}
        <MatrixRuns runs={matrixRuns} token={token ?? ""} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Recorded Eval Runs</h2>
        <p className="text-xs text-muted-foreground">Results from replaying an eval dataset against a flow (<code className="font-mono">bun run src/eval/run.ts</code>, typically CI). Click a row to see failed cases.</p>
        {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true"><div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />Loading eval runs…</div>}
        {error && <div role="alert" className="rounded-md bg-red-50 p-4 text-sm text-red-700">Failed to load eval runs: {error.message}</div>}
        {!isLoading && !error && runs.length === 0 && <div className="rounded-lg border border-dashed border-border bg-card py-8 text-center text-sm text-muted-foreground">No eval runs recorded yet. Record one with <code className="font-mono text-xs">POST /admin/eval/runs</code> (see the eval:regression CI job).</div>}
        {runs.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <Table>
              <TableHead><TableRow><TableHeaderCell>Dataset</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell><TableHeaderCell>Pass rate</TableHeaderCell><TableHeaderCell>Avg latency</TableHeaderCell><TableHeaderCell>Total cost</TableHeaderCell><TableHeaderCell>Avg score</TableHeaderCell><TableHeaderCell>Recorded</TableHeaderCell></TableRow></TableHead>
              <TableBody>{runs.map((run) => <RunRow key={run.id} run={run} expanded={expandedId === run.id} onToggle={() => setExpandedId((current) => current === run.id ? null : run.id)} />)}</TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

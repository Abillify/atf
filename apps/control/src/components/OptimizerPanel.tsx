"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useState } from "react";
import { Badge, Button } from "../lib/ui";
import type {
  OptimizationRun,
  OptimizationRunStatus,
  OptimizerCaseResult,
  VariantEvalResult,
  OptimizerRunOptions,
} from "../types/optimizer";

export interface OptimizerFlowOption {
  id: string;
  name: string;
}

export interface OptimizerPanelProps {
  /** Flows the operator can optimize (id + display name). */
  flows: OptimizerFlowOption[];
  /** Currently selected flow id (drives the polled run list). */
  selectedFlowId: string;
  onSelectFlow: (flowId: string) => void;
  runs: OptimizationRun[];
  isLoading?: boolean;
  error?: string | null;
  isTriggering?: boolean;
  onRun: (flowId: string, options: OptimizerRunOptions) => void;
  onPromote: (runId: string, variantLabel: string) => void;
}

const STATUS_STYLE: Record<OptimizationRunStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  mining: "bg-blue-100 text-blue-700",
  generating: "bg-blue-100 text-blue-700",
  evaluating: "bg-amber-100 text-amber-700",
  promoting: "bg-purple-100 text-purple-700",
  done: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-700",
  skipped: "bg-muted text-muted-foreground",
};

const RUNNING_STATES: OptimizationRunStatus[] = [
  "pending",
  "mining",
  "generating",
  "evaluating",
  "promoting",
];

function pct(n: number | undefined): string {
  return n === undefined ? "—" : `${(n * 100).toFixed(0)}%`;
}

function scoreDelta(
  variant: number | undefined,
  baseline: number | undefined,
): React.JSX.Element {
  if (variant === undefined || baseline === undefined)
    return <span className="text-muted-foreground">—</span>;
  const d = variant - baseline;
  const cls =
    d > 0.001
      ? "text-green-600"
      : d < -0.001
        ? "text-red-600"
        : "text-muted-foreground";
  const sign = d > 0 ? "+" : "";
  return (
    <span className={`tabular-nums ${cls}`}>
      {sign}
      {(d * 100).toFixed(1)}pp
    </span>
  );
}

// ---------------------------------------------------------------------------
// Per-case eval comparison (traceability): baseline vs a variant, per prompt
// ---------------------------------------------------------------------------

function CaseComparison({
  baselineCases,
  variantCases,
}: {
  baselineCases: OptimizerCaseResult[];
  variantCases: OptimizerCaseResult[];
}): React.JSX.Element {
  const baselineById = new Map(baselineCases.map((c) => [c.caseId, c]));
  return (
    <div className="mt-2 space-y-2">
      {variantCases.map((vc) => {
        const bc = baselineById.get(vc.caseId);
        return (
          <div
            key={vc.caseId}
            className="rounded border border-border bg-card p-2 text-xs"
          >
            <div className="font-medium text-foreground">
              <span className="text-muted-foreground">Prompt:</span>{" "}
              {vc.userPrompt || <em className="text-muted-foreground">(empty)</em>}
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded bg-muted p-1.5">
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="font-semibold uppercase tracking-wide text-muted-foreground">
                    Baseline
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    Score {pct(bc?.score)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-foreground">
                  {bc?.error ? (
                    <span className="text-red-600 dark:text-red-400">error: {bc.error}</span>
                  ) : (
                    bc?.responseText || <em className="text-muted-foreground">—</em>
                  )}
                </p>
              </div>
              <div className="rounded bg-accent/10 p-1.5">
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="font-semibold uppercase tracking-wide text-accent">
                    Variant
                  </span>
                  <span className="tabular-nums text-accent">
                    Score {pct(vc.score)}
                  </span>
                </div>
                <p className="whitespace-pre-wrap break-words text-foreground">
                  {vc.error ? (
                    <span className="text-red-600 dark:text-red-400">error: {vc.error}</span>
                  ) : (
                    vc.responseText || <em className="text-muted-foreground">—</em>
                  )}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One variant row (expandable to per-case detail)
// ---------------------------------------------------------------------------

function VariantRow({
  variant,
  baselineScore,
  baselineCases,
  isPromoted,
  canPromote,
  onPromote,
}: {
  variant: VariantEvalResult;
  baselineScore: number | undefined;
  baselineCases: OptimizerCaseResult[];
  isPromoted: boolean;
  canPromote: boolean;
  onPromote: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 p-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <span className="font-mono text-sm font-semibold text-foreground">
            {variant.label}
          </span>
          {isPromoted && <Badge variant="success">promoted</Badge>}
          {variant.error && <Badge variant="destructive">error</Badge>}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Score <b>{pct(variant.avgScore)}</b>
          </span>
          <span>Δ {scoreDelta(variant.avgScore, baselineScore)}</span>
          <span className="tabular-nums">Pass {pct(variant.passRate)}</span>
          <span className="tabular-nums">
            {Math.round(variant.avgLatencyMs)}ms
          </span>
          <span className="tabular-nums">
            ${variant.totalCost.toFixed(4)}
          </span>
          {canPromote && !variant.error && (
            <Button variant="primary" size="sm" onClick={onPromote}>
              Promote
            </Button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border p-2.5">
          <details className="mb-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              System prompt
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs text-foreground">
              {variant.systemPrompt}
            </pre>
          </details>
          <div className="text-xs font-medium text-muted-foreground">
            Per-case evaluation ({variant.cases.length} cases) — baseline vs
            variant
          </div>
          <CaseComparison
            baselineCases={baselineCases}
            variantCases={variant.cases}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One run card
// ---------------------------------------------------------------------------

function RunCard({
  run,
  onPromote,
}: {
  run: OptimizationRun;
  onPromote: (runId: string, variantLabel: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(RUNNING_STATES.includes(run.status));
  const running = RUNNING_STATES.includes(run.status);
  const canPromote = run.status === "done";

  return (
    <div className="rounded-lg border border-border bg-muted shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{open ? "▾" : "▸"}</span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[run.status]}`}
          >
            {run.status}
            {running && <span className="ml-1 animate-pulse">…</span>}
          </span>
          <span className="font-mono text-xs text-muted-foreground">{run.id}</span>
          {run.targetNodeId && (
            <span className="text-xs text-muted-foreground">
              node: {run.targetNodeId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="tabular-nums">{run.sampleCount} cases</span>
          <span className="tabular-nums">
            baseline {pct(run.baselineScore)}
          </span>
          <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
          {run.promotedVariant && (
            <Badge variant="success">
              → {run.promotedVariant} (v{run.promotedVersion})
            </Badge>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border p-3">
          {run.error && (
            <p className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-600">
              {run.error}
            </p>
          )}
          {run.status === "skipped" && !run.error && (
            <p className="mb-2 text-xs text-muted-foreground">Run skipped.</p>
          )}

          {run.baselineSystemPrompt !== undefined && (
            <details className="mb-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Baseline system prompt
              </summary>
              <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs text-foreground">
                {run.baselineSystemPrompt || "(none)"}
              </pre>
            </details>
          )}

          {run.variants.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {running ? "Evaluating…" : "No variants produced."}
            </p>
          ) : (
            <div className="space-y-2">
              {run.variants.map((v) => (
                <VariantRow
                  key={v.label}
                  variant={v}
                  baselineScore={run.baselineScore}
                  baselineCases={run.baselineCases ?? []}
                  isPromoted={run.promotedVariant === v.label}
                  canPromote={canPromote && run.promotedVariant === undefined}
                  onPromote={() => onPromote(run.id, v.label)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger form
// ---------------------------------------------------------------------------

function RunForm({
  selectedFlowId,
  isTriggering,
  onRun,
}: {
  selectedFlowId: string;
  isTriggering: boolean;
  onRun: (flowId: string, options: OptimizerRunOptions) => void;
}): React.JSX.Element {
  const [goal, setGoal] = useState("");
  const [variantCount, setVariantCount] = useState(3);
  const [minSamples, setMinSamples] = useState(5);
  const [autoPromote, setAutoPromote] = useState(false);

  const disabled = selectedFlowId === "" || isTriggering;

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Optimization goal (optional)
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Improve factual precision for German legal text"
            className="mt-0.5 w-full rounded border border-border px-2 py-1 text-sm"
          />
        </label>
        <div className="flex items-end gap-3">
          <label className="text-xs text-muted-foreground">
            Variants
            <input
              type="number"
              min={1}
              max={10}
              value={variantCount}
              onChange={(e) => setVariantCount(Number(e.target.value))}
              className="mt-0.5 w-16 rounded border border-border px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            Min samples
            <input
              type="number"
              min={1}
              value={minSamples}
              onChange={(e) => setMinSamples(Number(e.target.value))}
              className="mt-0.5 w-16 rounded border border-border px-2 py-1 text-sm tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={autoPromote}
              onChange={(e) => setAutoPromote(e.target.checked)}
            />
            Auto-promote winner
          </label>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() =>
            onRun(selectedFlowId, {
              variantCount,
              minSamples,
              autoPromote,
              ...(goal.trim() !== "" ? { optimizationGoal: goal.trim() } : {}),
            })
          }
        >
          {isTriggering ? "Starting…" : "Run optimization"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Self-optimizing flow control panel. Trigger an optimization cycle for a flow,
 * watch it progress live (mining → generating → evaluating → done), inspect
 * baseline vs variant scores, drill into per-case eval comparisons for full
 * traceability, and promote a winning variant.
 */
export function OptimizerPanel({
  flows,
  selectedFlowId,
  onSelectFlow,
  runs,
  isLoading,
  error,
  isTriggering,
  onRun,
  onPromote,
}: OptimizerPanelProps): React.JSX.Element {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          Self-optimizing flows
        </h3>
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </div>

      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground">Flow</label>
        <select
          value={selectedFlowId}
          onChange={(e) => onSelectFlow(e.target.value)}
          aria-label="Flow to optimize"
          className="rounded border border-border px-2 py-1 text-sm"
        >
          <option value="">— select a flow —</option>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.id})
            </option>
          ))}
        </select>
      </div>

      {selectedFlowId !== "" && (
        <RunForm
          selectedFlowId={selectedFlowId}
          isTriggering={isTriggering ?? false}
          onRun={onRun}
        />
      )}

      {selectedFlowId === "" ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Select a flow to view and run optimizations.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Requires <span className="font-mono">OPTIMIZER_ENABLED</span>,{" "}
            <span className="font-mono">REPLAY_ENABLED</span> and{" "}
            <span className="font-mono">FLOW_EDITOR_ENABLED</span>.
          </p>
        </div>
      ) : isLoading && runs.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card py-10 text-center text-sm text-muted-foreground">
          No optimization runs yet for this flow. Trigger one above.
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} onPromote={onPromote} />
          ))}
        </div>
      )}
    </section>
  );
}

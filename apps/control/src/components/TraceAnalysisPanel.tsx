"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { withCurrency } from "../lib/currency";
import type {
  Severity,
  TraceAnalysis,
  TraceFinding,
  TraceSuggestion,
} from "../types/trace-analysis";
import { Badge, Button } from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { translate } from "../lib/i18n";

export interface TraceAnalysisPanelProps {
  /** The analysis to render, or null when none/failed. */
  analysis: TraceAnalysis | null;
  /** True while an analysis request is in flight. */
  isAnalyzing?: boolean;
  /** Error / notice from the last attempt (e.g. 501 not-configured, 404 aged-out). */
  error?: string | null;
  /** Dismisses the panel. */
  onClear?: () => void;
  /**
   * When provided (and the analysis has a flowId), renders a "Create variant"
   * action on each suggestion that carries an auto-applicable edit. Seeds an
   * optimizer run from that single suggestion.
   */
  onCreateVariant?: (suggestion: TraceSuggestion) => void;
  /** Suggestion id whose variant run is currently being started. */
  creatingSuggestionId?: string | null;
  /** Error from the last create-variant attempt, shown above the suggestions. */
  variantError?: string | null;
}

function severityVariant(severity: Severity): BadgeVariant {
  if (severity === "critical") return "destructive";
  if (severity === "warn") return "warning";
  return "secondary";
}

function formatCost(cost: number): string {
  const bare =
    cost === 0
      ? "0"
      : cost < 0.01
        ? cost.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
        : cost.toFixed(cost < 1 ? 4 : 2);
  return withCurrency(bare);
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "error" | "cost";
}): React.JSX.Element {
  const valueClass =
    accent === "error"
      ? "text-danger"
      : accent === "cost"
        ? "text-success"
        : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={`tabular-nums text-sm font-semibold ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function FindingRow({ finding }: { finding: TraceFinding }): React.JSX.Element {
  return (
    <li className="rounded-md border border-border bg-background p-2.5 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant={severityVariant(finding.severity)}>
          {finding.severity}
        </Badge>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {finding.category}
        </span>
        {finding.nodeId && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {finding.nodeId}
          </span>
        )}
      </div>
      <p className="text-foreground">{finding.observation}</p>
      {finding.evidence && (
        <p className="mt-1 text-xs text-muted-foreground">
          {translate("traceAnalysisPanel.evidenceEvidence", { evidence: finding.evidence })}
        </p>
      )}
    </li>
  );
}

function SuggestionRow({
  suggestion,
  onCreateVariant,
  isCreating,
  canCreateVariant,
}: {
  suggestion: TraceSuggestion;
  onCreateVariant?: (suggestion: TraceSuggestion) => void;
  isCreating?: boolean;
  canCreateVariant?: boolean;
}): React.JSX.Element {
  const hasEdit = suggestion.edit !== undefined;
  const showCreate = hasEdit && canCreateVariant && onCreateVariant !== undefined;
  return (
    <li className="rounded-md border border-border bg-background p-2.5 text-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant={severityVariant(suggestion.severity)}>
          {suggestion.severity}
        </Badge>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {suggestion.category}
        </span>
        <span className="font-medium text-foreground">{suggestion.title}</span>
        {hasEdit && (
          <Badge variant="default" title={translate("traceAnalysisPanel.theOptimizerCanBuildA")}>
            auto-applicable
          </Badge>
        )}
        {showCreate && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => onCreateVariant(suggestion)}
            disabled={isCreating}
            title={translate("traceAnalysisPanel.evaluateThisSuggestionAsAn")}
          >
            {isCreating ? translate("traceAnalysisPanel.starting") : translate("traceAnalysisPanel.createVariant")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground">{suggestion.rationale}</p>
      {suggestion.expectedImpact && (
        <p className="mt-1 text-xs text-foreground">
          {translate("traceAnalysisPanel.expectedImpactExpectedImpact", { expectedImpact: suggestion.expectedImpact })}
        </p>
      )}
    </li>
  );
}

/**
 * Renders the result of an LLM trace post-mortem (summary, root cause, hard
 * metrics, findings and improvement suggestions) triggered from the History
 * tab. Also surfaces the in-flight and error/notice states so a not-configured
 * (501) or aged-out (404) trace is explained rather than silently doing nothing.
 */
export function TraceAnalysisPanel({
  analysis,
  isAnalyzing,
  error,
  onClear,
  onCreateVariant,
  creatingSuggestionId,
  variantError,
}: TraceAnalysisPanelProps): React.JSX.Element | null {
  if (!analysis && !error && !isAnalyzing) return null;

  const canCreateVariant =
    onCreateVariant !== undefined &&
    analysis !== null &&
    analysis.flowId !== null &&
    analysis.flowId !== "";

  return (
    <section className="mb-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("traceAnalysisPanel.traceAnalysis")}
          {analysis && (
            <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
              {analysis.executionId.slice(0, 8)}
              {analysis.flowId ? ` · ${analysis.flowId}` : ""}
            </span>
          )}
        </h3>
        {onClear && (
          <Button variant="secondary" size="sm" onClick={onClear}>
            {translate("traceAnalysisPanel.dismiss")}
          </Button>
        )}
      </div>

      {isAnalyzing && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {translate("traceAnalysisPanel.analysingTraceLLMPostMortem")}
        </p>
      )}

      {!isAnalyzing && error && (
        <p
          role="alert"
          className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning dark:border-warning-border dark:bg-warning-soft dark:text-warning"
        >
          {error}
        </p>
      )}

      {!isAnalyzing && analysis && (
        <div className="space-y-4">
          {/* Summary */}
          <p className="text-sm text-foreground">{analysis.summary}</p>

          {/* Root cause */}
          {analysis.rootCause && (
            <div className="rounded-md border border-danger-border bg-danger-soft px-3 py-2 dark:border-danger-border dark:bg-danger-soft">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-danger">
                {translate("traceAnalysisPanel.rootCause")}
              </div>
              <p className="text-sm text-danger">
                {analysis.rootCause}
              </p>
            </div>
          )}

          {/* Scope note */}
          {analysis.scopeNodeIds && analysis.scopeNodeIds.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {translate("traceAnalysisPanel.scopedTo")}{" "}
              <span className="font-mono">
                {analysis.scopeNodeIds.join(", ")}
              </span>
            </p>
          )}

          {/* Metrics */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            <Metric label={translate("traceAnalysisPanel.nodes")} value={String(analysis.metrics.nodeCount)} />
            <Metric
              label={translate("traceAnalysisPanel.errors")}
              value={String(analysis.metrics.errorNodeCount)}
              accent={analysis.metrics.errorNodeCount > 0 ? "error" : undefined}
            />
            <Metric
              label={translate("traceAnalysisPanel.latency")}
              value={`${analysis.metrics.totalLatencyMs} ms`}
            />
            {analysis.metrics.wallClockMs !== undefined && (
              <Metric
                label={translate("traceAnalysisPanel.wallClock")}
                value={`${analysis.metrics.wallClockMs} ms`}
              />
            )}
            <Metric
              label={translate("traceAnalysisPanel.cost")}
              value={formatCost(analysis.metrics.totalCost)}
              accent="cost"
            />
            <Metric
              label={translate("traceAnalysisPanel.tokens")}
              value={String(analysis.metrics.totalTokens)}
            />
            <Metric
              label={translate("traceAnalysisPanel.toolCalls")}
              value={`${analysis.metrics.toolCallCount}${
                analysis.metrics.toolErrorCount > 0
                  ? ` (${analysis.metrics.toolErrorCount} err)`
                  : ""
              }`}
              accent={
                analysis.metrics.toolErrorCount > 0 ? "error" : undefined
              }
            />
            <Metric
              label={translate("traceAnalysisPanel.diagnostics")}
              value={`${analysis.metrics.diagnosticCounts.warn}w / ${analysis.metrics.diagnosticCounts.error}e`}
            />
            {analysis.metrics.groundednessFailures > 0 && (
              <Metric
                label={translate("traceAnalysisPanel.groundednessFails")}
                value={String(analysis.metrics.groundednessFailures)}
                accent="error"
              />
            )}
            {analysis.metrics.slowestNode && (
              <Metric
                label={translate("traceAnalysisPanel.slowestNode")}
                value={`${analysis.metrics.slowestNode.nodeId} (${analysis.metrics.slowestNode.latencyMs} ms)`}
              />
            )}
            {analysis.metrics.costliestNode &&
              analysis.metrics.costliestNode.cost > 0 && (
                <Metric
                  label={translate("traceAnalysisPanel.costliestNode")}
                  value={`${analysis.metrics.costliestNode.nodeId} (${formatCost(analysis.metrics.costliestNode.cost)})`}
                />
              )}
          </div>

          {/* Findings */}
          {analysis.findings.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {translate("traceAnalysisPanel.findingsLength", { length: analysis.findings.length })}
              </h4>
              <ul className="space-y-1.5">
                {analysis.findings.map((f, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: findings have no unique id; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                  <FindingRow key={i} finding={f} />
                ))}
              </ul>
            </div>
          )}

          {/* Suggestions */}
          {analysis.suggestions.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {translate("traceAnalysisPanel.suggestionsLength", { length: analysis.suggestions.length })}
              </h4>
              {variantError && (
                <p
                  role="alert"
                  className="mb-1.5 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning dark:border-warning-border dark:bg-warning-soft dark:text-warning"
                >
                  {variantError}
                </p>
              )}
              <ul className="space-y-1.5">
                {analysis.suggestions.map((s) => (
                  <SuggestionRow
                    key={s.id}
                    suggestion={s}
                    {...(onCreateVariant !== undefined
                      ? { onCreateVariant }
                      : {})}
                    isCreating={creatingSuggestionId === s.id}
                    canCreateVariant={canCreateVariant}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

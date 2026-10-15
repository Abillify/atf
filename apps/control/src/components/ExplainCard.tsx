"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ExplainCard — Decision-Provenance Explainability Card panel.
 *
 * Renders `GET /monitoring/explain/:executionId`: the node/tool path actually
 * taken, models used, routing decisions, groundedness verdict, PII vault
 * actions, and operator actions recorded against the run — the "why did the
 * agent answer this way" artefact for EU AI Act Art. 13/14 transparency and
 * human-oversight evidence.
 *
 * Used as a tab on the `/traces` execution viewer, scoped to whichever
 * execution id is currently loaded there.
 */

import type React from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { backendUrl } from "../lib/backend-url";
import { formatCost } from "../lib/currency";
import { authFetch } from "../lib/auth-fetch";
import { Badge, Button } from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { translate, formatDateTime } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Types (mirror src/observability/explain.ts)
// ---------------------------------------------------------------------------

interface ExplainStep {
  nodeId: string;
  label?: string;
  kind: "node" | "tool";
  status: "running" | "completed" | "error";
  sequence?: number;
  latencyMs: number | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  toolCalls?: Array<{ id: string; name: string; execTimeSeconds?: number | null }>;
  routing?: {
    target: string;
    matched_condition?: string;
    matched_label?: string;
    candidates: Array<{ target: string; condition?: string; label?: string; matched: boolean }>;
  };
  groundedness?: {
    score: number;
    passed: boolean;
    checked_sentences: number;
    unsupported: Array<{ sentence: string; support: number }>;
  };
  /**
   * The Objective-Driven Routing / Solver-Loop's decision for this step, when
   * the node declared `config.objective` — every candidate tried, in
   * cost-ascending order, and which declared clauses each one cleared.
   */
  objectiveSolver?: {
    selected: string;
    satisfiedObjective: boolean;
    fallbackUsed: boolean;
    attempts: Array<{
      candidate: string;
      estimatedCostUsd?: number;
      observedQuality?: number;
      qualitySamples?: number;
      satisfied: boolean;
      clauses: Array<{
        clause: { metric: "quality" | "cost"; op: "gte" | "lte"; value: number };
        observedValue?: number;
        proven: boolean;
        met: boolean;
      }>;
    }>;
  };
  errorMessage?: string;
}

interface ExplainModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  callCount: number;
}

interface AuditRecord {
  id: number;
  at: string;
  actor: string;
  role?: string;
  action: string;
  target?: string;
  outcome?: string;
}

interface ExplainCardData {
  executionId: string;
  flowId: string | null;
  status: "running" | "completed" | "error";
  startedAt: string;
  finishedAt: string | null;
  totalLatencyMs: number | null;
  totalCost: number | null;
  userName: string | null;
  userPrompt: string | null;
  steps: ExplainStep[];
  modelsUsed: ExplainModelUsage[];
  routingDecisions: Array<{ nodeId: string; decision: ExplainStep["routing"] }>;
  groundedness?: ExplainStep["groundedness"] & { nodeId: string };
  piiActions?: {
    totalTokenized: number;
    byType: Record<string, number>;
    byDetector: Record<string, number>;
  };
  auditEntries: AuditRecord[];
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

async function fetchExplainCard(
  executionId: string,
  token: string | undefined,
): Promise<ExplainCardData> {
  const res = await authFetch(
    backendUrl(`/monitoring/explain/${encodeURIComponent(executionId)}`),
    token,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { card: ExplainCardData };
  return data.card;
}

function statusVariant(status: ExplainStep["status"]): BadgeVariant {
  return status === "error" ? "destructive" : status === "running" ? "warning" : "success";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ExplainCardProps {
  executionId: string;
  token: string | null | undefined;
  enabled: boolean;
}

export function ExplainCard({
  executionId,
  token,
  enabled,
}: ExplainCardProps): React.JSX.Element {
  const [downloading, setDownloading] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);

  const {
    data: card,
    isLoading,
    error,
  } = useQuery<ExplainCardData, Error>({
    queryKey: ["explain-card", executionId],
    queryFn: () => fetchExplainCard(executionId, token ?? undefined),
    enabled: enabled && !!executionId,
  });

  // Download the Markdown via an authenticated fetch → blob, rather than a
  // plain <a href> — the operator token travels as an Authorization header
  // (never in the URL), and the download works under MONITORING_AUTH.
  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    try {
      const res = await authFetch(
        backendUrl(
          `/monitoring/explain/${encodeURIComponent(executionId)}?format=markdown`,
        ),
        token ?? undefined,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const url = URL.createObjectURL(
        new Blob([text], { type: "text/markdown" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `explain-${executionId}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* best-effort download */
    } finally {
      setDownloading(false);
    }
  };

  // Downloads the signed Verifiable Evidence Bundle (JSON) — the artefact
  // `scripts/cli.ts verify-bundle` checks offline. Unlike the plain Markdown
  // export above, this is a machine-verifiable file: it embeds a content
  // hash + HMAC signature so a recipient can prove it was not altered after
  // the platform generated it, without trusting whoever hands it to them.
  // 404 here means EVIDENCE_BUNDLE_SECRET (or AUDIT_ANCHOR_SECRET) is not
  // configured on the server — surfaced as a best-effort no-op, same as the
  // Markdown download above.
  const handleDownloadBundle = async (): Promise<void> => {
    setDownloadingBundle(true);
    try {
      const res = await authFetch(
        backendUrl(`/monitoring/explain/${encodeURIComponent(executionId)}/bundle`),
        token ?? undefined,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `evidence-bundle-${executionId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      /* best-effort download */
    } finally {
      setDownloadingBundle(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        {translate("explainCard.loadingExplainabilityCard")}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">
        {translate("explainCard.failedToLoadExplainabilityCard", { message: error.message })}
      </div>
    );
  }

  if (!card) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {translate("explainCard.noExplainabilityCardAvailableFor")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <div>
          <h2 className="font-semibold text-foreground">
            {translate("explainCard.decisionProvenanceCard")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {card.flowId ?? translate("explainCard.unknownFlow")} ·{" "}
            {card.userName ?? "anonymous"} ·{" "}
            {formatDateTime(card.startedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(card.status)}>{card.status}</Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleDownload()}
            disabled={downloading}
          >
            {downloading ? translate("explainCard.downloading") : translate("explainCard.downloadMarkdown")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleDownloadBundle()}
            disabled={downloadingBundle}
            title={translate("explainCard.signedMachineVerifiableJSONArtefact")}
          >
            {downloadingBundle ? translate("explainCard.downloading") : translate("explainCard.downloadEvidenceBundle")}
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{translate("explainCard.latency")}</dt>
          <dd className="text-lg font-semibold text-foreground">
            {card.totalLatencyMs !== null ? `${card.totalLatencyMs} ms` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{translate("explainCard.cost")}</dt>
          <dd className="text-lg font-semibold text-foreground">
            {card.totalCost !== null ? formatCost(card.totalCost) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{translate("explainCard.steps")}</dt>
          <dd className="text-lg font-semibold text-foreground">{card.steps.length}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{translate("explainCard.models")}</dt>
          <dd className="text-lg font-semibold text-foreground">{card.modelsUsed.length}</dd>
        </div>
      </dl>

      {card.userPrompt && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {translate("explainCard.userPrompt")}
          </h3>
          <p className="text-sm text-foreground">{card.userPrompt}</p>
        </div>
      )}

      {/* Execution path */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          {translate("explainCard.executionPath")}
        </h3>
        <ol className="flex flex-col gap-2">
          {card.steps.map((step, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a node can appear as several steps, so the position disambiguates; the card is replaced atomically
              key={`${step.nodeId}-${i}`}
              className="rounded-md border border-border bg-muted p-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <Badge variant={statusVariant(step.status)}>{step.status}</Badge>
                <span className="font-medium text-foreground">
                  {step.label ?? step.nodeId}
                </span>
                {step.kind === "tool" && (
                  <span className="text-muted-foreground">{translate("explainCard.tool")}</span>
                )}
                {step.model !== undefined && (
                  <span className="ml-auto font-mono text-muted-foreground">
                    {step.model}
                  </span>
                )}
              </div>
              {step.routing !== undefined && (
                <p className="mt-1 text-muted-foreground">
                  {translate("explainCard.routedTo")} <code>{step.routing.target}</code>
                  {step.routing.matched_condition !== undefined &&
                    ` (${step.routing.matched_condition})`}
                </p>
              )}
              {step.toolCalls !== undefined && step.toolCalls.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {step.toolCalls.map((tc) => (
                    <li key={tc.id}>{tc.name}</li>
                  ))}
                </ul>
              )}
              {step.groundedness !== undefined && (
                <p className="mt-1 text-muted-foreground">
                  groundedness: {(step.groundedness.score * 100).toFixed(0)}%
                  ({step.groundedness.passed ? "passed" : "failed"})
                </p>
              )}
              {step.objectiveSolver !== undefined && (
                <div className="mt-1">
                  <p className="text-muted-foreground">
                    {translate("explainCard.objectiveDrivenRoutingSelected")}{" "}
                    <code>{step.objectiveSolver.selected}</code>{" "}
                    <Badge
                      variant={
                        step.objectiveSolver.satisfiedObjective
                          ? "success"
                          : "warning"
                      }
                    >
                      {step.objectiveSolver.satisfiedObjective
                        ? translate("explainCard.objectiveSatisfied")
                        : translate("explainCard.fallbackUsed")}
                    </Badge>
                  </p>
                  {step.objectiveSolver.attempts.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-muted-foreground">
                      {step.objectiveSolver.attempts.map((a, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: the same candidate can be attempted twice; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                        <li key={`${a.candidate}-${i}`}>
                          <code>{a.candidate}</code>
                          {a.estimatedCostUsd !== undefined &&
                            ` · ${formatCost(a.estimatedCostUsd)}`}
                          {a.observedQuality !== undefined &&
                            translate("explainCard.qualityValueValue2Samples", { value: (a.observedQuality * 100).toFixed(0), value2: a.qualitySamples ?? 0 })}
                          {" — "}
                          {a.satisfied ? "satisfied" : translate("explainCard.didNotSatisfy")}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {step.errorMessage !== undefined && (
                <p className="mt-1 text-danger">⚠️ {step.errorMessage}</p>
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* Models used */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          {translate("explainCard.modelsUsed")}
        </h3>
        {card.modelsUsed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{translate("explainCard.noPricedLLMCallsRecorded")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {card.modelsUsed.map((m) => (
              <li key={m.model} className="flex items-center justify-between">
                <span className="font-mono text-foreground">{m.model}</span>
                <span className="text-muted-foreground">
                  {translate("explainCard.callCountCallSInputTokensOutputTokens", { callCount: m.callCount, inputTokens: m.inputTokens, outputTokens: m.outputTokens, value: formatCost(m.cost) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Groundedness */}
      {card.groundedness !== undefined && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {translate("explainCard.groundednessLowestScoringNode")}
          </h3>
          <p className="text-sm text-foreground">
            <code>{card.groundedness.nodeId}</code> —{" "}
            {(card.groundedness.score * 100).toFixed(0)}% (
            {card.groundedness.passed ? "passed" : "failed"}),{" "}
            {translate("explainCard.checkedSentencesSentenceSChecked", { checked_sentences: card.groundedness.checked_sentences })}
          </p>
          {card.groundedness.unsupported.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
              {card.groundedness.unsupported.slice(0, 5).map((u, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: sentences are not unique; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
                <li key={i}>
                  {translate("explainCard.sentenceSupportValue", { sentence: u.sentence, value: (u.support * 100).toFixed(0) })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* PII vault actions */}
      {card.piiActions !== undefined && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {translate("explainCard.pIIVaultActions")}
          </h3>
          <p className="text-sm text-foreground">
            {translate("explainCard.totalTokenizedPIISpanSTokenized", { totalTokenized: card.piiActions.totalTokenized })}
          </p>
          <ul className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {Object.entries(card.piiActions.byType).map(([type, count]) => (
              <li key={type} className="rounded bg-muted px-2 py-0.5">
                {type}: {count}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Operator actions */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          {translate("explainCard.operatorActions")}
        </h3>
        {card.auditEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {translate("explainCard.noOperatorActionsRecordedAgainst")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {card.auditEntries.map((a) => (
              <li key={a.id} className="text-muted-foreground">
                {formatDateTime(a.at)} — <b className="text-foreground">{a.actor}</b>{" "}
                {a.action} ({a.outcome ?? "success"})
              </li>
            ))}
          </ul>
        )}
      </div>

      {card.degraded.length > 0 && (
        <div className="rounded-lg border border-warning-border bg-warning-soft p-3 text-xs text-warning">
          {card.degraded.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: degradation notices are plain strings without ids; list is rendered once from an immutable API result payload; item order is the display order and never mutates in place
            <p key={i}>⚠️ {d}</p>
          ))}
        </div>
      )}
    </div>
  );
}

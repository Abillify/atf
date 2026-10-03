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
        Loading explainability card…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">
        Failed to load explainability card: {error.message}
      </div>
    );
  }

  if (!card) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No explainability card available for this execution.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card p-4">
        <div>
          <h2 className="font-semibold text-foreground">
            Decision-Provenance Card
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {card.flowId ?? "(unknown flow)"} ·{" "}
            {card.userName ?? "anonymous"} ·{" "}
            {new Date(card.startedAt).toLocaleString()}
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
            {downloading ? "Downloading…" : "Download Markdown"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleDownloadBundle()}
            disabled={downloadingBundle}
            title="Signed, machine-verifiable JSON artefact (verify offline with: bun run scripts/cli.ts verify-bundle)"
          >
            {downloadingBundle ? "Downloading…" : "Download Evidence Bundle"}
          </Button>
        </div>
      </div>

      {/* Summary stats */}
      <dl className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Latency</dt>
          <dd className="text-lg font-semibold text-foreground">
            {card.totalLatencyMs !== null ? `${card.totalLatencyMs} ms` : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Cost</dt>
          <dd className="text-lg font-semibold text-foreground">
            {card.totalCost !== null ? formatCost(card.totalCost) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Steps</dt>
          <dd className="text-lg font-semibold text-foreground">{card.steps.length}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Models</dt>
          <dd className="text-lg font-semibold text-foreground">{card.modelsUsed.length}</dd>
        </div>
      </dl>

      {card.userPrompt && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            User prompt
          </h3>
          <p className="text-sm text-foreground">{card.userPrompt}</p>
        </div>
      )}

      {/* Execution path */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Execution path
        </h3>
        <ol className="flex flex-col gap-2">
          {card.steps.map((step, i) => (
            <li
              key={`${step.nodeId}-${i}`}
              className="rounded-md border border-border bg-muted p-2 text-xs"
            >
              <div className="flex items-center gap-2">
                <Badge variant={statusVariant(step.status)}>{step.status}</Badge>
                <span className="font-medium text-foreground">
                  {step.label ?? step.nodeId}
                </span>
                {step.kind === "tool" && (
                  <span className="text-muted-foreground">(tool)</span>
                )}
                {step.model !== undefined && (
                  <span className="ml-auto font-mono text-muted-foreground">
                    {step.model}
                  </span>
                )}
              </div>
              {step.routing !== undefined && (
                <p className="mt-1 text-muted-foreground">
                  routed to <code>{step.routing.target}</code>
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
                    objective-driven routing: selected{" "}
                    <code>{step.objectiveSolver.selected}</code>{" "}
                    <Badge
                      variant={
                        step.objectiveSolver.satisfiedObjective
                          ? "success"
                          : "warning"
                      }
                    >
                      {step.objectiveSolver.satisfiedObjective
                        ? "objective satisfied"
                        : "fallback used"}
                    </Badge>
                  </p>
                  {step.objectiveSolver.attempts.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-muted-foreground">
                      {step.objectiveSolver.attempts.map((a, i) => (
                        <li key={`${a.candidate}-${i}`}>
                          <code>{a.candidate}</code>
                          {a.estimatedCostUsd !== undefined &&
                            ` · ${formatCost(a.estimatedCostUsd)}`}
                          {a.observedQuality !== undefined &&
                            ` · quality ${(a.observedQuality * 100).toFixed(0)}% (${a.qualitySamples ?? 0} samples)`}
                          {" — "}
                          {a.satisfied ? "satisfied" : "did not satisfy"}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {step.errorMessage !== undefined && (
                <p className="mt-1 text-red-600">⚠️ {step.errorMessage}</p>
              )}
            </li>
          ))}
        </ol>
      </div>

      {/* Models used */}
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">
          Models used
        </h3>
        {card.modelsUsed.length === 0 ? (
          <p className="text-sm text-muted-foreground">No priced LLM calls recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {card.modelsUsed.map((m) => (
              <li key={m.model} className="flex items-center justify-between">
                <span className="font-mono text-foreground">{m.model}</span>
                <span className="text-muted-foreground">
                  {m.callCount} call(s) · {m.inputTokens}/{m.outputTokens} tok ·
                  {formatCost(m.cost)}
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
            Groundedness (lowest-scoring node)
          </h3>
          <p className="text-sm text-foreground">
            <code>{card.groundedness.nodeId}</code> —{" "}
            {(card.groundedness.score * 100).toFixed(0)}% (
            {card.groundedness.passed ? "passed" : "failed"}),{" "}
            {card.groundedness.checked_sentences} sentence(s) checked
          </p>
          {card.groundedness.unsupported.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
              {card.groundedness.unsupported.slice(0, 5).map((u, i) => (
                <li key={i}>
                  &ldquo;{u.sentence}&rdquo; (support {(u.support * 100).toFixed(0)}%)
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
            PII vault actions
          </h3>
          <p className="text-sm text-foreground">
            {card.piiActions.totalTokenized} PII span(s) tokenized before
            reaching any LLM provider.
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
          Operator actions
        </h3>
        {card.auditEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No operator actions recorded against this execution.
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {card.auditEntries.map((a) => (
              <li key={a.id} className="text-muted-foreground">
                {new Date(a.at).toLocaleString()} — <b className="text-foreground">{a.actor}</b>{" "}
                {a.action} ({a.outcome ?? "success"})
              </li>
            ))}
          </ul>
        )}
      </div>

      {card.degraded.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
          {card.degraded.map((d, i) => (
            <p key={i}>⚠️ {d}</p>
          ))}
        </div>
      )}
    </div>
  );
}

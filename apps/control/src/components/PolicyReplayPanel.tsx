"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * PolicyReplayPanel — dry-run policy replay simulator (Req 16, task 22.3).
 *
 * Lets an operator paste CANDIDATE tool-authz / compliance policies and replay
 * them over stored executions via `POST /admin/policy-replay`. The backend
 * simulator is side-effect-free (Property 17): nothing is written except a
 * best-effort audit entry for the replay itself.
 *
 * The panel renders the aggregate summary (evaluated / changed / newly denied
 * / newly allowed + highlight lines) and a per-execution old-vs-new diff with
 * the flipped tool calls and their deciding rule ids.
 */

import { useState } from "react";
import { authFetch } from "../lib/auth-fetch";
import { backendUrl } from "../lib/backend-url";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../lib/ui";
import type { BadgeVariant } from "../lib/ui";
import { translate, formatTime } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Result shapes mirrored from the runtime replay API (kept structural so the
// Control app does not depend on runtime internals).
// ---------------------------------------------------------------------------

type PolicyDecision = "allow" | "deny" | "require-approval";

interface ToolCallDiff {
  tool: string;
  oldAllowed: boolean;
  newAllowed: boolean;
  oldRuleId: string;
  newRuleId: string;
  changed: boolean;
}

interface ExecutionDiff {
  execution_id: string;
  flow_id: string | null;
  tenant_id: string | null;
  started_at: string;
  user_name: string | null;
  old_outcome: PolicyDecision;
  new_outcome: PolicyDecision;
  changed: boolean;
  tool_calls: ToolCallDiff[];
  guardrail?: { score: number; flagged: boolean; matched: string[] };
}

interface ReplaySummary {
  evaluated: number;
  changed: number;
  newlyDenied: number;
  newlyAllowed: number;
  toolCallsEvaluated: number;
  toolCallFlips: number;
  highlights: string[];
}

interface ReplayResult {
  errors: string[];
  results: ExecutionDiff[];
  summary: ReplaySummary;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function outcomeBadge(decision: PolicyDecision): {
  variant: BadgeVariant;
  label: string;
} {
  if (decision === "allow") return { variant: "success", label: "allow" };
  if (decision === "deny") return { variant: "destructive", label: "deny" };
  return { variant: "warning", label: "require-approval" };
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function PolicyReplayPanel({
  token,
}: {
  token: string | undefined;
}) {
  const [toolAuthz, setToolAuthz] = useState("");
  const [compliance, setCompliance] = useState("");
  const [maxExecutions, setMaxExecutions] = useState("50");
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReplayResult | null>(null);

  const run = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (toolAuthz.trim() !== "") {
        try {
          body["candidateToolAuthzPolicy"] = JSON.parse(toolAuthz);
        } catch {
          throw new Error(translate("policyReplayPanel.toolAuthzNotJson"));
        }
      }
      if (compliance.trim() !== "") {
        try {
          body["candidateCompliancePolicy"] = JSON.parse(compliance);
        } catch {
          throw new Error(translate("policyReplayPanel.complianceNotJson"));
        }
      }
      const max = Number.parseInt(maxExecutions, 10);
      if (Number.isFinite(max) && max > 0) body["maxExecutions"] = max;

      const r = await authFetch(backendUrl("/admin/policy-replay"), token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await r.json()) as ReplayResult & {
        error?: { message?: string };
      };
      if (!r.ok) throw new Error(data.error?.message ?? `HTTP ${r.status}`);
      if (data.errors.length > 0) throw new Error(data.errors.join("; "));
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const rows =
    result === null
      ? []
      : onlyChanged
        ? result.results.filter((row) => row.changed)
        : result.results;

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-foreground">
        {translate("policyReplayPanel.policyReplaySimulator")}
      </h2>
      <p className="text-xs text-muted-foreground">
        {translate("policyReplayPanel.replayStoredExecutionsAgainstCandidate")}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="replay-toolauthz"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            {translate("policyReplayPanel.candidateToolAuthzPolicyJSON")}
          </label>
          <textarea
            id="replay-toolauthz"
            value={toolAuthz}
            onChange={(e) => setToolAuthz(e.target.value)}
            placeholder={translate("policyReplayPanel.rulesIdDenyWriteTools")}
            rows={5}
            spellCheck={false}
            className="w-full rounded border border-border bg-background px-3 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label
            htmlFor="replay-compliance"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            {translate("policyReplayPanel.candidateCompliancePolicyJSONOptional")}
          </label>
          <textarea
            id="replay-compliance"
            value={compliance}
            onChange={(e) => setCompliance(e.target.value)}
            placeholder="{}"
            rows={5}
            spellCheck={false}
            className="w-full rounded border border-border bg-background px-3 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label
            htmlFor="replay-max"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            {translate("policyReplayPanel.maxExecutions")}
          </label>
          <input
            id="replay-max"
            type="number"
            min={1}
            max={500}
            value={maxExecutions}
            onChange={(e) => setMaxExecutions(e.target.value)}
            className="w-28 rounded border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => void run()} disabled={loading}>
          {loading ? translate("policyReplayPanel.replaying") : translate("policyReplayPanel.runReplay")}
        </Button>
      </div>

      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {result !== null && (
        <div className="space-y-3">
          {/* Aggregate summary */}
          <div className="rounded border border-border bg-muted p-3 space-y-2">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                <span className="font-medium">{translate("policyReplayPanel.evaluated")} </span>
                {result.summary.evaluated}
              </span>
              <span>
                <span className="font-medium">{translate("policyReplayPanel.changed")} </span>
                {result.summary.changed}
              </span>
              <span>
                <span className="font-medium">{translate("policyReplayPanel.newlyDenied")} </span>
                <span className={result.summary.newlyDenied > 0 ? "text-danger font-medium" : undefined}>
                  {result.summary.newlyDenied}
                </span>
              </span>
              <span>
                <span className="font-medium">{translate("policyReplayPanel.newlyAllowed")} </span>
                <span className={result.summary.newlyAllowed > 0 ? "text-warning font-medium" : undefined}>
                  {result.summary.newlyAllowed}
                </span>
              </span>
              <span>
                <span className="font-medium">{translate("policyReplayPanel.toolCallFlips")} </span>
                {result.summary.toolCallFlips} / {result.summary.toolCallsEvaluated}
              </span>
            </div>
            {result.summary.highlights.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {result.summary.highlights.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Per-execution diff */}
          <div className="flex items-center gap-2">
            <label htmlFor="replay-only-changed" className="text-xs text-muted-foreground">
              <input
                id="replay-only-changed"
                type="checkbox"
                checked={onlyChanged}
                onChange={(e) => setOnlyChanged(e.target.checked)}
                className="mr-1 align-middle"
              />
              {translate("policyReplayPanel.onlyChangedExecutions")}
            </label>
            <span className="text-xs text-muted-foreground">
              ({rows.length} of {result.results.length})
            </span>
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {result.results.length === 0
                ? translate("policyReplayPanel.noStoredExecutionsMatchedThe")
                : translate("policyReplayPanel.noExecutionChangedItsOutcome")}
            </p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>{translate("policyReplayPanel.execution")}</TableHeaderCell>
                  <TableHeaderCell>{translate("policyReplayPanel.flow")}</TableHeaderCell>
                  <TableHeaderCell>{translate("policyReplayPanel.started")}</TableHeaderCell>
                  <TableHeaderCell>{translate("policyReplayPanel.outcome")}</TableHeaderCell>
                  <TableHeaderCell>{translate("policyReplayPanel.toolCalls")}</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => {
                  const oldBadge = outcomeBadge(row.old_outcome);
                  const newBadge = outcomeBadge(row.new_outcome);
                  const flips = row.tool_calls.filter((t) => t.changed);
                  return (
                    <TableRow key={row.execution_id}>
                      <TableCell className="font-mono text-xs" title={row.execution_id}>
                        {shortId(row.execution_id)}
                      </TableCell>
                      <TableCell className="text-xs">{row.flow_id ?? "—"}</TableCell>
                      <TableCell className="text-xs">{formatTime(row.started_at)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        <Badge variant={oldBadge.variant}>{oldBadge.label}</Badge>
                        <span className="mx-1 text-muted-foreground">→</span>
                        <Badge variant={newBadge.variant}>{newBadge.label}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {flips.length === 0 ? (
                          <span className="text-muted-foreground">{translate("policyReplayPanel.noFlips")}</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {flips.map((t) => (
                              <li key={`${row.execution_id}:${t.tool}`}>
                                <span className="font-mono">{t.tool}</span>{" "}
                                {t.oldAllowed ? "allow" : "deny"}
                                <span className="mx-1 text-muted-foreground">→</span>
                                {t.newAllowed ? "allow" : "deny"}
                                <span className="ml-1 text-muted-foreground">
                                  ({t.oldRuleId} → {t.newRuleId})
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </section>
  );
}

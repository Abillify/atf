"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * AutopilotPanel — Dashboard panel for the Continuous Safety & Quality Autopilot.
 *
 * Shows:
 *  - Recent autopilot runs (status, trigger, bypass rate, promoted version)
 *  - Manual trigger button
 *  - Live status polling (refreshes every 5 s while any run is in progress)
 *
 * Designed to fit in the studio sidebar (≈280 px wide) or a full page.
 */

import type React from "react";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { Badge, Button } from "../lib/ui";
import { useDocumentVisibility } from "../hooks/useDocumentVisibility";

// ---------------------------------------------------------------------------
// Types (mirrors src/autopilot/autopilot-engine.ts)
// ---------------------------------------------------------------------------

type AutopilotRunStatus =
  | "pending"
  | "optimizing"
  | "registering-canary"
  | "done"
  | "skipped"
  | "error";

interface AutopilotRun {
  id: string;
  flowId: string;
  trigger: "red-team" | "manual" | "schedule";
  startedAt: string;
  finishedAt?: string;
  status: AutopilotRunStatus;
  bypassRate?: number;
  optimizerRunId?: string;
  canaryRegistered?: boolean;
  promotedVersion?: number;
  optimizationGoal?: string;
  error?: string;
}

/** Mirrors the governance-relevant fields of src/autopilot/autopilot-engine.ts AutopilotConfig. */
interface AutopilotGovernanceConfig {
  requireHumanApproval: boolean;
  maxAutoPromotionsPerWindow: number;
  driftWindowMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<AutopilotRunStatus, string> = {
  pending: "text-muted-foreground",
  optimizing: "text-blue-600",
  "registering-canary": "text-purple-600",
  done: "text-green-600",
  skipped: "text-muted-foreground",
  error: "text-red-600",
};

const STATUS_ICONS: Record<AutopilotRunStatus, string> = {
  pending: "○",
  optimizing: "⟳",
  "registering-canary": "⟳",
  done: "✓",
  skipped: "–",
  error: "✗",
};

function RunRow({ run }: { run: AutopilotRun }) {
  const isActive =
    run.status === "optimizing" || run.status === "registering-canary";
  return (
    <div className="rounded border border-border bg-muted px-3 py-2 text-xs space-y-1">
      <div className="flex items-center gap-2">
        <span
          className={`font-medium ${STATUS_COLORS[run.status]} ${isActive ? "animate-spin inline-block" : ""}`}
        >
          {STATUS_ICONS[run.status]}
        </span>
        <span className="font-mono text-foreground">{run.flowId}</span>
        <span className="ml-auto text-muted-foreground">
          {new Date(run.startedAt).toLocaleTimeString()}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">{run.trigger}</span>
        <span className={`rounded px-1.5 py-0.5 ${STATUS_COLORS[run.status]} bg-opacity-10`}>
          {run.status}
        </span>
        {run.bypassRate !== undefined && (
          <span className="text-amber-600">
            bypass: {(run.bypassRate * 100).toFixed(1)}%
          </span>
        )}
        {run.promotedVersion !== undefined && (
          <span className="text-green-600">→ v{run.promotedVersion}</span>
        )}
        {run.canaryRegistered === true && (
          <span className="text-purple-600">canary ↗</span>
        )}
      </div>

      {run.error && (
        <p className="text-red-600 text-[10px]">{run.error}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface AutopilotPanelProps {
  /** Limit to a specific flow (omit for all flows). */
  flowId?: string;
  /** Maximum number of runs to show. Default 10. */
  limit?: number;
  /** Known flows — renders a picker for the manual trigger instead of a free-text id. */
  flows?: { id: string; name: string }[];
  /**
   * The flow is chosen by the host page (e.g. the Studio's flow picker): show
   * it instead of offering yet another selector.
   */
  fixedFlow?: boolean;
}

export function AutopilotPanel({
  flowId,
  limit = 10,
  flows,
  fixedFlow = false,
}: AutopilotPanelProps): React.JSX.Element {
  // isAuthenticated statt !!token: bei AUTHN_MODE=disabled gibt es kein Token,
  // die Operator-Plane ist trotzdem erreichbar. Header nur mit echtem Token.
  const { token, ready, isAuthenticated } = useAuth();
  const authHeaders = useMemo((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  }, [token]);
  const [runs, setRuns] = useState<AutopilotRun[]>([]);
  const [governance, setGovernance] = useState<AutopilotGovernanceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerFlowId, setTriggerFlowId] = useState(flowId ?? "");
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  /** Set when the backend reports the feature as unavailable (503). */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  // Follow the Studio's flow selection.
  useEffect(() => {
    setTriggerFlowId(flowId ?? "");
  }, [flowId]);

  const fetchGovernance = useCallback(async () => {
    if (!ready || !isAuthenticated) return;
    try {
      const resp = await fetch(backendUrl("/autopilot/config"), {
        headers: authHeaders,
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as { config: AutopilotGovernanceConfig };
      setGovernance(data.config ?? null);
    } catch {
      /* governance display is best-effort; runs list is the primary content */
    }
  }, [authHeaders, ready, isAuthenticated]);

  const fetchRuns = useCallback(async () => {
    if (!ready) return;
    if (!isAuthenticated) {
      setLoading(false);
      setError("Not signed in.");
      return;
    }
    try {
      const url = flowId
        ? backendUrl(`/autopilot/runs/flow/${encodeURIComponent(flowId)}?limit=${limit}`)
        : backendUrl(`/autopilot/runs?limit=${limit}`);
      const resp = await fetch(url, { headers: authHeaders });
      if (!resp.ok) {
        const d = (await resp.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        const message = d.error?.message ?? `HTTP ${resp.status}`;
        if (resp.status === 503 || resp.status === 501) {
          setUnavailable(message);
          setError(null);
        } else {
          setError(message);
        }
        setRuns([]);
        return;
      }
      const data = (await resp.json()) as { runs: AutopilotRun[] };
      setRuns(data.runs ?? []);
      setUnavailable(null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // The flagged "runs" below is `data.runs` (from the `as { runs: ... }`
    // cast above), not the `runs` state. @babel/eslint-parser has no
    // TypeScript type info, so exhaustive-deps' scope analysis can't tell the
    // cast's property name apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeaders, ready, isAuthenticated, flowId, limit]);

  // Initial load + poll while any run is in progress.
  // Two separate effects: one for initial/refetch-on-deps-change, one for polling.
  useEffect(() => {
    void fetchRuns();
  }, [fetchRuns]);

  useEffect(() => {
    void fetchGovernance();
  }, [fetchGovernance]);

  const isVisible = useDocumentVisibility();

  useEffect(() => {
    const hasActive = runs.some(
      (r) => r.status === "optimizing" || r.status === "registering-canary",
    );
    if (!hasActive || !isVisible) return;
    const interval = setInterval(() => void fetchRuns(), 5_000);
    return () => clearInterval(interval);
  }, [fetchRuns, runs, isVisible]);

  const handleTrigger = useCallback(async () => {
    if (!isAuthenticated || !triggerFlowId.trim()) return;
    setTriggering(true);
    setTriggerMsg(null);
    try {
      const resp = await fetch(backendUrl("/autopilot/trigger"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: JSON.stringify({ flowId: triggerFlowId.trim() }),
      });
      if (resp.ok) {
        setTriggerMsg("Autopilot cycle started.");
        void fetchRuns();
      } else {
        const d = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
        setTriggerMsg(`Failed: ${d.error?.message ?? `HTTP ${resp.status}`}`);
      }
    } catch (err) {
      setTriggerMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTriggering(false);
    }
    // The flagged "error" below is `d.error` (from the `as { error?: ... }`
    // cast above), not the `error` state. @babel/eslint-parser has no
    // TypeScript type info, so exhaustive-deps' scope analysis can't tell the
    // cast's property name apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authHeaders, isAuthenticated, triggerFlowId, fetchRuns]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          🔄 Autopilot
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchRuns()}
          aria-label="Refresh autopilot runs"
        >
          ↻
        </Button>
      </div>

      {/* Governance posture */}
      {governance && (
        <div className="rounded border border-border bg-muted px-3 py-2 text-[10px] flex flex-wrap gap-2">
          <Badge variant={governance.requireHumanApproval ? "default" : "warning"}>
            {governance.requireHumanApproval
              ? "Human approval required"
              : "Auto-promote enabled"}
          </Badge>
          <Badge variant="secondary">
            drift-guard: max {governance.maxAutoPromotionsPerWindow} auto-promotion(s) /{" "}
            {Math.round(governance.driftWindowMs / 3_600_000)}h
          </Badge>
        </div>
      )}

      {unavailable && (
        <div className="rounded border border-dashed border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Not available: </span>
          {unavailable}
        </div>
      )}

      {/* Manual trigger */}
      <div className="flex flex-col gap-1.5">
        <div className="flex gap-1.5">
          {fixedFlow ? (
            <span
              className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground"
              title="Chosen in the Studio's flow picker"
            >
              {triggerFlowId || "no flow selected"}
            </span>
          ) : flows ? (
            <select
              value={triggerFlowId}
              onChange={(e) => setTriggerFlowId(e.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-xs"
              aria-label="Flow for manual autopilot trigger"
            >
              <option value="">— select flow —</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.id})
                </option>
              ))}
            </select>
          ) : (
            <input
              value={triggerFlowId}
              onChange={(e) => setTriggerFlowId(e.target.value)}
              placeholder="flow-id"
              className="flex-1 rounded border border-border px-2 py-1 text-xs font-mono"
              aria-label="Flow ID for manual autopilot trigger"
            />
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={triggering || !triggerFlowId.trim() || unavailable !== null}
            onClick={() => void handleTrigger()}
          >
            {triggering ? "…" : "Trigger"}
          </Button>
        </div>
        {triggerMsg && (
          <p className={`text-[10px] ${triggerMsg.startsWith("Failed") || triggerMsg.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
            {triggerMsg}
          </p>
        )}
      </div>

      {/* Runs list */}
      {unavailable ? null : loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="text-xs text-red-600">{error}</div>
      ) : runs.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No autopilot runs yet. Trigger one manually or enable RED_TEAM_ENABLED
          to start the automated loop.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

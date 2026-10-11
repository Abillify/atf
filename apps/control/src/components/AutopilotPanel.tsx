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
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth/useAuth";
import { request } from "../lib/control-api";
import { FlowPicker } from "./FlowPicker";
import { Badge, Button } from "../lib/ui";
import { useDocumentVisibility } from "../hooks/useDocumentVisibility";
import { formatTime } from "../lib/i18n";

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
  optimizing: "text-info",
  "registering-canary": "text-copilot",
  done: "text-success",
  skipped: "text-muted-foreground",
  error: "text-danger",
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
          {formatTime(run.startedAt)}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5">{run.trigger}</span>
        <span className={`rounded px-1.5 py-0.5 ${STATUS_COLORS[run.status]} bg-opacity-10`}>
          {run.status}
        </span>
        {run.bypassRate !== undefined && (
          <span className="text-warning">
            bypass: {(run.bypassRate * 100).toFixed(1)}%
          </span>
        )}
        {run.promotedVersion !== undefined && (
          <span className="text-success">→ v{run.promotedVersion}</span>
        )}
        {run.canaryRegistered === true && (
          <span className="text-copilot">canary ↗</span>
        )}
      </div>

      {run.error && (
        <p className="text-danger text-[10px]">{run.error}</p>
      )}
      {run.status === "done" && run.optimizerRunId !== undefined && (
        // The optimizer run holds the variants, scores and the promote action.
        <a
          href={`/optimizer?flow=${encodeURIComponent(run.flowId)}`}
          className="inline-block text-[10px] font-medium text-primary hover:underline"
        >
          Show variants &amp; scores →
        </a>
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
  /** The host renders its own heading (the Studio sidebar's accordion) —
      skip the panel's own "Autopilot" title; the refresh button stays. */
  hideHeading?: boolean;
}

/** Signal: the backend reports the autopilot as unavailable (501/503). */
class AutopilotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutopilotUnavailableError";
  }
}

/** A trigger request reached the backend but was refused (vs. a network error). */
class AutopilotTriggerRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutopilotTriggerRefusedError";
  }
}

export function AutopilotPanel({
  flowId,
  limit = 10,
  flows,
  fixedFlow = false,
  hideHeading = false,
}: AutopilotPanelProps): React.JSX.Element {
  // isAuthenticated instead of !!token: with AUTHN_MODE=disabled there is no token,
  // the operator plane is still reachable. Header only with a real token
  // (handled by lib/control-api).
  const { token, ready, isAuthenticated } = useAuth();
  const [triggerFlowId, setTriggerFlowId] = useState(flowId ?? "");
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);

  // Follow the Studio's flow selection.
  useEffect(() => {
    setTriggerFlowId(flowId ?? "");
  }, [flowId]);

  const isVisible = useDocumentVisibility();

  // Req 9.2: TanStack Query + lib/control-api instead of direct fetch/state.
  // retry:false: the panel never showed a retry backoff before either.
  const runsQuery = useQuery<{ runs: AutopilotRun[] }, Error>({
    queryKey: ["autopilot-runs", flowId ?? null, limit, token ?? null],
    enabled: ready,
    retry: false,
    queryFn: async () => {
      if (!isAuthenticated) throw new Error("Not signed in.");
      const path = flowId
        ? `/autopilot/runs/flow/${encodeURIComponent(flowId)}?limit=${limit}`
        : `/autopilot/runs?limit=${limit}`;
      const resp = await request(path, { target: "backend", token });
      if (!resp.ok) {
        const d = (await resp.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        const message = d.error?.message ?? `HTTP ${resp.status}`;
        if (resp.status === 503 || resp.status === 501) {
          throw new AutopilotUnavailableError(message);
        }
        throw new Error(message);
      }
      const data = (await resp.json()) as { runs?: AutopilotRun[] };
      return { runs: data.runs ?? [] };
    },
    // Poll while any run is in progress (only while the tab is visible).
    refetchInterval: (query) => {
      const hasActive = query.state.data?.runs.some(
        (r) => r.status === "optimizing" || r.status === "registering-canary",
      );
      return hasActive && isVisible ? 5_000 : false;
    },
  });

  // Governance display is best-effort; the runs list is the primary content.
  const governanceQuery = useQuery<AutopilotGovernanceConfig | null, Error>({
    queryKey: ["autopilot-governance", token ?? null],
    enabled: ready && isAuthenticated,
    retry: false,
    queryFn: async () => {
      const resp = await request("/autopilot/config", { target: "backend", token });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { config?: AutopilotGovernanceConfig };
      return data.config ?? null;
    },
  });

  const triggerMutation = useMutation<string, Error, string>({
    mutationFn: async (targetFlowId: string) => {
      const resp = await request("/autopilot/trigger", {
        method: "POST",
        target: "backend",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: targetFlowId }),
      });
      if (!resp.ok) {
        const d = (await resp.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new AutopilotTriggerRefusedError(
          d.error?.message ?? `HTTP ${resp.status}`,
        );
      }
      return "Autopilot cycle started.";
    },
    onSuccess: (message) => {
      setTriggerMsg(message);
      void runsQuery.refetch();
    },
    onError: (err) => {
      setTriggerMsg(
        err instanceof AutopilotTriggerRefusedError
          ? `Failed: ${err.message}`
          : `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });

  const runs = runsQuery.data?.runs ?? [];
  const governance = governanceQuery.data ?? null;
  const loading = runsQuery.isPending;
  /** Set when the backend reports the feature as unavailable (503). */
  const unavailable =
    runsQuery.error instanceof AutopilotUnavailableError
      ? runsQuery.error.message
      : null;
  const error =
    runsQuery.error && !(runsQuery.error instanceof AutopilotUnavailableError)
      ? runsQuery.error.message
      : null;
  const triggering = triggerMutation.isPending;

  const handleTrigger = (): void => {
    if (!isAuthenticated || !triggerFlowId.trim()) return;
    setTriggerMsg(null);
    triggerMutation.mutate(triggerFlowId.trim());
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        {!hideHeading && (
          <h3 className="text-sm font-semibold text-foreground">
            🔄 Autopilot
          </h3>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void runsQuery.refetch()}
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
            <div className="min-w-0 flex-1">
              <FlowPicker
                flows={flows}
                value={triggerFlowId}
                onChange={setTriggerFlowId}
                ariaLabel="Flow for manual autopilot trigger"
                className="w-full"
              />
            </div>
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
          <p className={`text-[10px] ${triggerMsg.startsWith("Failed") || triggerMsg.startsWith("Error") ? "text-danger" : "text-success"}`}>
            {triggerMsg}
          </p>
        )}
      </div>

      {/* Runs list */}
      {unavailable ? null : loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="text-xs text-danger">{error}</div>
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

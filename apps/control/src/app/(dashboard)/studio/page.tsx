"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /studio — Studio workspace route (Req. 14.1, 15.1, 16.1, 17.3, 21.1).
 *
 * Grid layout:
 *   - Builder (left/main): ReactFlow canvas + NodePropertyPanel
 *   - Playground (bottom): Prompt input + execution results
 *   - Optimize (right): Routing recommendations + Eval summary
 *
 * Write/mutation controls are gated with <RequireRole role="operator"> (Req. 21.1).
 *
 * Heavy components are lazy-loaded (code-splitting, Req. 12.3).
 */

import dynamic from "next/dynamic";
import React, { useState, useCallback } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { RequireRole } from "../../../lib/auth/RequireRole";
import { Button } from "../../../lib/ui";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FlowListEntry } from "../../../types/flow";
import type { PlaygroundResult } from "../../../components/StudioPlayground";
import {
  validateStudioEvalCase,
  buildStudioEvalCase,
} from "../../../lib/studio-eval-case";
import { backendUrl } from "../../../lib/backend-url";

// Lazy-load heavy components (Req. 12.3)
const FlowDiffPanel = dynamic(
  () =>
    import("../../../components/FlowDiffPanel").then((m) => m.FlowDiffPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <span>Loading diff…</span>
      </div>
    ),
  },
);

const AutopilotPanel = dynamic(
  () =>
    import("../../../components/AutopilotPanel").then((m) => m.AutopilotPanel),
  {
    ssr: false,
    loading: () => <div className="text-xs text-muted-foreground py-2">Loading…</div>,
  },
);

const StudioBuilder = dynamic(
  () =>
    import("../../../components/StudioBuilder").then((m) => m.StudioBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading builder…
      </div>
    ),
  },
);

const StudioPlayground = dynamic(
  () =>
    import("../../../components/StudioPlayground").then(
      (m) => m.StudioPlayground,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading playground…
      </div>
    ),
  },
);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchFlowList(token: string): Promise<FlowListEntry[]> {
  const resp = await fetch(backendUrl("/flows"), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as
    | { flows?: FlowListEntry[] }
    | FlowListEntry[];
  return Array.isArray(data) ? data : (data.flows ?? []);
}

async function postEvalCase(token: string, evalCase: unknown): Promise<void> {
  const resp = await fetch("/api/eval/cases", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(evalCase),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => `HTTP ${resp.status}`);
    throw new Error(detail);
  }
}

// ---------------------------------------------------------------------------
// Optimize panel (routing recommendations stub, Req. 17)
// ---------------------------------------------------------------------------

function OptimizePanel({
  selectedFlowId,
  token,
}: {
  selectedFlowId: string;
  token: string | null;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Optimize</h3>

      {!selectedFlowId ? (
        <p className="text-xs text-muted-foreground">
          Select a flow in the Builder to see routing recommendations.
        </p>
      ) : (
        <div className="space-y-2">
          <div className="rounded border border-dashed border-border bg-muted p-3 text-xs text-muted-foreground">
            <div className="font-medium text-muted-foreground mb-1">
              Routing Recommendations
            </div>
            <p>
              The routing advisor compares the current model&apos;s cost/quality
              against cheaper alternatives. Recommendations appear here when a
              cheaper model meets the configured quality threshold.
            </p>
            <p className="mt-1 text-muted-foreground">
              Flow: <span className="font-mono">{selectedFlowId}</span>
            </p>
          </div>

          <RequireRole role="operator" mode="disable">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                // In a full implementation this would call the routing-advisor API
                // and allow one-click canary start (Req. 17.3)
              }}
            >
              Check routing recommendations
            </Button>
          </RequireRole>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Eval case save status notification
// ---------------------------------------------------------------------------

function EvalCaseBanner({
  status,
  onDismiss,
}: {
  status: { kind: "ok" | "warn" | "error"; message: string } | null;
  onDismiss: () => void;
}) {
  if (!status) return null;
  const colors = {
    ok: "bg-green-50 text-green-700 border-green-200",
    warn: "bg-amber-50 text-amber-700 border-amber-200",
    error: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <div
      role="status"
      className={`flex items-center justify-between rounded border px-3 py-2 text-xs ${colors[status.kind]}`}
    >
      <span>{status.message}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        className="ml-2 h-auto px-1 py-0 text-current opacity-60 hover:bg-transparent hover:opacity-100"
        aria-label="Dismiss"
      >
        ×
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Studio page
// ---------------------------------------------------------------------------

export default function StudioPage() {
  const { token, ready } = useAuth();
  const queryClient = useQueryClient();

  const [selectedFlowId, setSelectedFlowId] = useState("");
  const [evalBanner, setEvalBanner] = useState<{
    kind: "ok" | "warn" | "error";
    message: string;
  } | null>(null);

  const { data: flows = [], isLoading: flowsLoading } = useQuery<
    FlowListEntry[],
    Error
  >({
    queryKey: ["flows"],
    queryFn: () => fetchFlowList(token!),
    enabled: ready && !!token,
  });

  const selectedFlow = flows.find((f) => f.id === selectedFlowId) ?? null;

  const evalCaseMutation = useMutation<
    void,
    Error,
    { prompt: string; flowId: string; result: PlaygroundResult }
  >({
    mutationFn: async ({ prompt, flowId, result }) => {
      if (!token) throw new Error("Not authenticated");

      // Build the Studio eval case (Req. 16.1)
      const newCase = buildStudioEvalCase({
        flowId,
        prompt,
        actual: result.content,
        // expected is intentionally omitted at creation time; user must supply it later
        createdBy: "operator", // real impl would use session identity
        tenantId: "default",
      });

      // Validate before adding to dataset (Req. 16.3)
      const validation = validateStudioEvalCase(newCase);
      if (!validation.valid) {
        const fields = validation.missingFields.join(", ");
        throw new Error(
          `Eval case created but cannot be added to dataset — missing required fields: ${fields}`,
        );
      }

      await postEvalCase(token, newCase);
    },
    onSuccess: () => {
      setEvalBanner({ kind: "ok", message: "Eval case saved to dataset." });
      void queryClient.invalidateQueries({ queryKey: ["eval", "cases"] });
    },
    onError: (err) => {
      // Req. 16.3: if missing fields, report them clearly; creation still succeeds
      const isMissingFields = err.message.includes("missing required fields");
      setEvalBanner({
        kind: isMissingFields ? "warn" : "error",
        message: err.message,
      });
    },
  });

  const handleSaveEvalCase = useCallback(
    (prompt: string, flowId: string, result: PlaygroundResult) => {
      evalCaseMutation.mutate({ prompt, flowId, result });
    },
    [evalCaseMutation],
  );

  const handleBuilderSaved = useCallback(
    (flowId: string) => {
      void queryClient.invalidateQueries({ queryKey: ["flows"] });
      void queryClient.invalidateQueries({ queryKey: ["flow", flowId] });
    },
    [queryClient],
  );

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold text-foreground">Studio</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {selectedFlowId && (
            <span className="rounded bg-muted px-2 py-0.5 font-mono">
              {selectedFlowId}
            </span>
          )}
          {flowsLoading && <span>Loading flows…</span>}
        </div>
      </div>

      {/* Eval case banner */}
      {evalBanner && (
        <div className="px-6 pt-2">
          <EvalCaseBanner
            status={evalBanner}
            onDismiss={() => setEvalBanner(null)}
          />
        </div>
      )}

      {/* Studio grid: Builder | Optimize on the right */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column: Builder + Playground stacked */}
        <div className="flex flex-1 flex-col overflow-hidden gap-0">
          {/* Builder panel — takes ~65% of the left column height. Laid out as
              a flex column so the header row stays fixed and the builder body
              fills the remaining height instead of overflowing (which used to
              clip the flow graph off the bottom). */}
          <div className="flex flex-col flex-[13] min-h-0 overflow-hidden border-b border-border bg-card p-4">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <h2 className="text-sm font-semibold text-foreground">Builder</h2>

              {/* Flow selector for the builder */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Flow</label>
                <select
                  value={selectedFlowId}
                  onChange={(e) => setSelectedFlowId(e.target.value)}
                  className="rounded border border-border px-2 py-1 text-xs"
                  aria-label="Select flow to edit in Builder"
                >
                  <option value="">— new flow —</option>
                  {flows.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.id})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Builder canvas — write controls gated by operator role (Req. 21.1) */}
            <div className="flex-1 min-h-0">
              <RequireRole
                role="operator"
                mode="disable"
                fallback={
                  <div className="flex h-64 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
                    You need the <strong className="mx-1">operator</strong> role
                    to edit flows.
                  </div>
                }
              >
                <div className="h-full">
                  <StudioBuilder
                    flow={selectedFlow}
                    onSaved={handleBuilderSaved}
                  />
                </div>
              </RequireRole>
            </div>
          </div>

          {/* Playground panel — takes ~35% of the left column height */}
          <div className="flex-[7] min-h-0 overflow-hidden bg-card p-4">
            <h2 className="text-sm font-semibold text-foreground mb-2">
              Playground
            </h2>
            <div className="h-full overflow-auto">
              <StudioPlayground
                flows={flows}
                selectedFlowId={selectedFlowId || undefined}
                onSelectFlow={setSelectedFlowId}
                onSaveEvalCase={handleSaveEvalCase}
              />
            </div>
          </div>
        </div>

        {/* Right column: Optimize + Diff + Autopilot panels */}
        <div className="w-80 shrink-0 overflow-auto border-l border-border bg-card p-4 flex flex-col gap-6">
          <OptimizePanel
            selectedFlowId={selectedFlowId}
            token={token ?? null}
          />

          {/* Flow Diff panel — shows draft vs. published */}
          {selectedFlowId && (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold text-foreground">
                Diff (draft → published)
              </h3>
              <FlowDiffPanel
                flowId={selectedFlowId}
                token={token ?? undefined}
                draftMode
              />
            </section>
          )}

          {/* Autopilot panel */}
          <section>
            <AutopilotPanel
              flowId={selectedFlowId || undefined}
              limit={5}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

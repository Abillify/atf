"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Optimize panel (routing recommendations, Req. 17): cheaper candidate models
 * for nodes that declare `config.routing.candidates`.
 *
 * Two sources:
 *  - Canvas: the definition in the builder — unsaved edits and drafts
 *    included — posted to `POST /optimizer/routing-advice`, which resolves it
 *    like a flow file. Nothing is saved.
 *  - Live: `GET /optimizer/routing-advice`, the flows the runtime has loaded.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth/useAuth";
import { useCanWrite } from "../lib/auth/useCanWrite";
import { Button } from "../lib/ui";
import { request } from "../lib/control-api";
import type { FlowDefinition } from "../types/flow";
import { translate } from "../lib/i18n";

export interface RoutingRecommendation {
  flowId: string;
  nodeId: string;
  currentModel: string;
  suggestedModel: string;
  expectedCostSavingPct: number;
  expectedQualityLossPct: number;
  source: "eval-judge" | "model-quality-registry" | "unknown";
  canary?: { flow: string; candidate: string; trafficPercent: number };
}

export interface RoutingAdvice {
  nodesExamined: number;
  qualityDataAvailable: boolean;
  recommendations: RoutingRecommendation[];
}

type AdviceSource = "canvas" | "live";

async function readAdvice(resp: Response): Promise<RoutingAdvice> {
  if (!resp.ok) {
    const d = (await resp.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(d.error?.message ?? `HTTP ${resp.status}`);
  }
  return (await resp.json()) as RoutingAdvice;
}

// Req 9.2: transport through lib/control-api; the functions are already the
// queryFn bodies of the panel queries.
export async function fetchRoutingAdvice(token: string | undefined): Promise<RoutingAdvice> {
  return readAdvice(
    await request("/optimizer/routing-advice", { target: "backend", token }),
  );
}

export async function fetchCanvasRoutingAdvice(
  definition: FlowDefinition,
  token: string | undefined,
): Promise<RoutingAdvice> {
  const resp = await request("/optimizer/routing-advice", {
    method: "POST",
    target: "backend",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definition }),
  });
  if (resp.status === 404 || resp.status === 405) {
    // An older runtime: no POST route (or no optimizer router at all).
    throw new Error(translate("optimizePanel.runtimeCannotCheckCanvas"));
  }
  return readAdvice(resp);
}

/** Nodes of `def` that declare routing candidates (before shortcut expansion). */
export function nodesWithCandidates(def: FlowDefinition | null | undefined): string[] {
  return (def?.nodes ?? [])
    .filter((n) => {
      const routing = (n.config as { routing?: { candidates?: unknown } } | undefined)?.routing;
      return Array.isArray(routing?.candidates) && routing.candidates.length > 0;
    })
    .map((n) => n.id);
}

/** Why a check found nothing — worded for the source that was checked. */
export function emptyAdviceMessage(opts: {
  source: AdviceSource;
  advice: RoutingAdvice;
  flowId: string;
  /** Nodes of the canvas that declare candidates (to explain a Live miss). */
  canvasCandidateNodes: string[];
  canvasLabel: string;
}): string {
  const { source, advice, flowId, canvasCandidateNodes, canvasLabel } = opts;
  let text: string;
  if (advice.nodesExamined === 0) {
    if (source === "canvas") {
      text =
        canvasCandidateNodes.length > 0
          ? `The ${canvasLabel} declares candidates (${canvasCandidateNodes.join(", ")}), but none differ from the node's current model — or the node has no model to compare against.`
          : `The ${canvasLabel} declares no routing candidates (config.routing.candidates on a node), so there is nothing to compare.`;
    } else {
      text =
        canvasCandidateNodes.length > 0
          ? `The live version of ${flowId} declares no routing candidates — only the ${canvasLabel} does (${canvasCandidateNodes.join(", ")}). Check the canvas, or publish it to check the live flow.`
          : "No loaded flow declares routing candidates (config.routing.candidates on a node), so there is nothing to compare yet.";
    }
  } else {
    text =
      source === "canvas"
        ? `No recommendation: none of the candidate models is cheaper within the quality threshold (${advice.nodesExamined} node(s) examined).`
        : `No recommendation for ${flowId}: none of its candidate models is cheaper within the quality threshold (${advice.nodesExamined} node(s) examined across all loaded flows).`;
  }
  if (!advice.qualityDataAvailable) text += " No quality data is recorded yet, so quality loss can't be estimated.";
  return text;
}

export interface OptimizePanelProps {
  selectedFlowId: string;
  token: string | null;
  /** The builder's current definition (source form); absent before it loaded. */
  getCanvasDefinition?: () => FlowDefinition | null;
  /** How the canvas is named in messages, e.g. "canvas (unsaved changes)". */
  canvasLabel?: string;
  /** The host renders its own heading (the Studio sidebar's accordion) —
      skip the panel's own "Optimize" title. */
  hideHeading?: boolean;
}

export function OptimizePanel({
  selectedFlowId,
  token,
  getCanvasDefinition,
  canvasLabel = "canvas",
  hideHeading = false,
}: OptimizePanelProps): React.JSX.Element {
  const writeGate = useCanWrite("admin");
  const { ready, isAuthenticated } = useAuth();
  const [source, setSource] = useState<AdviceSource>(getCanvasDefinition ? "canvas" : "live");
  const [canvasCandidates, setCanvasCandidates] = useState<string[]>([]);
  const [checkedId, setCheckedId] = useState<string>("");
  // Fetched on demand: Live scans every loaded flow, Canvas resolves the definition.
  const advice = useQuery<RoutingAdvice, Error>({
    queryKey: ["routing-advice", source],
    queryFn: () => {
      const def = getCanvasDefinition?.() ?? null;
      setCanvasCandidates(nodesWithCandidates(def));
      if (source === "canvas") {
        if (!def) throw new Error(translate("optimizePanel.canvasNotLoaded"));
        setCheckedId(def.id);
        return fetchCanvasRoutingAdvice(def, token ?? undefined);
      }
      setCheckedId(selectedFlowId);
      return fetchRoutingAdvice(token ?? undefined);
    },
    enabled: false,
    staleTime: 60_000,
  });
  const flowId = source === "canvas" ? checkedId : selectedFlowId;
  const results = advice.data?.recommendations.filter((r) => r.flowId === flowId) ?? [];

  const sourceBtn = (s: AdviceSource, label: string, title: string) => (
    <button
      type="button"
      aria-pressed={source === s}
      onClick={() => setSource(s)}
      disabled={s === "canvas" && !getCanvasDefinition}
      title={title}
      className={`flex-1 px-2 py-0.5 text-[11px] disabled:opacity-40 ${
        source === s ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="space-y-3">
      {!hideHeading && (
        <h3 className="text-sm font-semibold text-foreground">{translate("optimizePanel.optimize")}</h3>
      )}

      {!selectedFlowId && !getCanvasDefinition ? (
        <p className="text-xs text-muted-foreground">{translate("optimizePanel.selectAFlowToSee")}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {translate("optimizePanel.cheaperModelsForThisFlow")} <code className="font-mono">config.routing.candidates</code> {translate("optimizePanel.areConsidered")}
          </p>

          <fieldset className="m-0 flex overflow-hidden rounded border border-border p-0">
            <legend className="sr-only">{translate("optimizePanel.whatToCheck")}</legend>
            {sourceBtn("canvas", "Canvas", "The definition in the builder — drafts and unsaved edits included. Nothing is saved.")}
            {sourceBtn("live", "Live", "The flow versions the runtime has loaded and serves.")}
          </fieldset>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!ready || !isAuthenticated || !writeGate.allowed || advice.isFetching}
            title={writeGate.title}
            onClick={() => void advice.refetch()}
          >
            {advice.isFetching ? translate("optimizePanel.checking") : advice.data ? translate("optimizePanel.checkAgain") : translate("optimizePanel.checkRoutingRecommendations")}
          </Button>

          {advice.error && <p className="text-xs text-danger">{advice.error.message}</p>}

          {advice.data && results.length === 0 && (
            <p className="rounded border border-dashed border-border bg-muted p-2 text-xs text-muted-foreground">
              {emptyAdviceMessage({
                source,
                advice: advice.data,
                flowId: flowId || selectedFlowId,
                canvasCandidateNodes: canvasCandidates,
                canvasLabel,
              })}
            </p>
          )}

          {results.map((r) => (
            <div
              key={`${r.nodeId}-${r.suggestedModel}`}
              className="space-y-1 rounded border border-border bg-muted p-2 text-xs"
            >
              <div className="font-medium text-foreground">
                {translate("optimizePanel.node")} <span className="font-mono">{r.nodeId}</span>
              </div>
              <div className="font-mono text-[11px]">
                {r.currentModel} → <span className="text-success">{r.suggestedModel}</span>
              </div>
              <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="text-success">{translate("optimizePanel.valueCost", { value: r.expectedCostSavingPct.toFixed(0) })}</span>
                <span>{translate("optimizePanel.valueQuality", { value: r.expectedQualityLossPct.toFixed(1) })}</span>
                <span>({r.source})</span>
              </div>
              {r.canary && (
                <details>
                  <summary className="cursor-pointer text-[11px] text-muted-foreground">{translate("optimizePanel.trialItAsACanary")}</summary>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {translate("optimizePanel.createFlow")} <span className="font-mono">{r.canary.candidate}</span> {translate("optimizePanel.withTheSuggestedModelThen")} <span className="font-mono">flows/canary.yaml</span>:
                  </p>
                  <pre className="mt-1 overflow-auto rounded bg-card p-1.5 font-mono text-[10px]">{`- flow: ${r.canary.flow}
  candidate: ${r.canary.candidate}
  trafficPercent: ${r.canary.trafficPercent}`}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

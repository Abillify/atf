"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowCopilotPanel — Studio builder AI copilot (Phase 3).
 *
 * Natural-language flow edits: the operator describes a change ("add a
 * guardrail node before the LLM node"), the backend (`POST
 * /flows/:id/copilot`, `src/graph/flow-copilot.ts`) proposes a small patch,
 * already validated and diffed against the current flow. This panel never
 * applies anything by itself — it previews the proposed diff on the canvas
 * (via the same `buildDiffOverlay` Phase 2 uses for version comparisons) and
 * requires an explicit Accept. Reject discards the proposal; Accept replaces
 * the canvas state (and becomes a normal, undoable history entry).
 */

import type React from "react";
import { useEffect, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { Button } from "../lib/ui";
import { buildProposalOverlay, type DiffOverlay } from "../lib/flow-diff-view";
import type { RFNode, RFEdge } from "../lib/flow-graph";
import type { FlowDefinition, FlowValidationReport } from "../types/flow";

interface CopilotSuccessResponse {
  ok: true;
  proposed: FlowDefinition;
  diff: import("../types/flow").FlowDiff;
  explanation: string;
}
interface CopilotFailureResponse {
  ok: false;
  message: string;
  validation?: FlowValidationReport;
}
type CopilotResponse = CopilotSuccessResponse | CopilotFailureResponse;

export interface FlowCopilotPanelProps {
  flowId: string;
  token?: string;
  /** Reads the latest unsaved canvas state at request time (avoids staleness). */
  getDefinition: () => FlowDefinition;
  nodes: RFNode[];
  edges: RFEdge[];
  /** Feeds the computed preview overlay to FlowCanvas, or undefined to clear it. */
  onPreviewChange: (overlay: DiffOverlay | undefined) => void;
  /** Called when the operator accepts the proposal — replaces the canvas state. */
  onAccept: (proposed: FlowDefinition) => void;
  /** Set (and incremented) externally to prefill + focus the instruction field, e.g. from a "Fix with Copilot" button on a validation issue. */
  prefill?: { instruction: string; nonce: number };
}

export function FlowCopilotPanel({
  flowId,
  token,
  getDefinition,
  nodes,
  edges,
  onPreviewChange,
  onAccept,
  prefill,
}: FlowCopilotPanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationDetail, setValidationDetail] = useState<
    FlowValidationReport | undefined
  >(undefined);
  const [proposal, setProposal] = useState<
    { proposed: FlowDefinition; explanation: string; summary: string } | null
  >(null);

  useEffect(() => {
    if (!prefill) return;
    setInstruction(prefill.instruction);
    setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const handleAsk = async (): Promise<void> => {
    if (!instruction.trim()) return;
    setExpanded(true);
    setIsLoading(true);
    setError(null);
    setValidationDetail(undefined);
    setProposal(null);
    onPreviewChange(undefined);

    try {
      const resp = await fetch(
        backendUrl(`/flows/${encodeURIComponent(flowId)}/copilot`),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            definition: getDefinition(),
            instruction,
          }),
        },
      );
      const data = (await resp.json().catch(() => null)) as
        | CopilotResponse
        | { error?: { message?: string } }
        | null;

      // A structured `{ok:...}` body (success, refusal, or "not configured")
      // is meaningful regardless of the HTTP status (refusals/501 use non-2xx
      // codes but still carry a body worth showing) — only fall back to a
      // bare HTTP-status message when the body itself is unusable.
      if (!data || !("ok" in data)) {
        setError(
          (data as { error?: { message?: string } } | null)?.error?.message ??
            `HTTP ${resp.status}`,
        );
        return;
      }
      if (!data.ok) {
        setError(data.message);
        setValidationDetail(data.validation);
        return;
      }

      setProposal({
        proposed: data.proposed,
        explanation: data.explanation,
        summary: data.diff.summary,
      });
      onPreviewChange(
        // Proposal direction: current canvas -> proposed flow. Added nodes
        // aren't on the canvas yet, so they are drawn as ghosts.
        buildProposalOverlay(nodes, edges, data.proposed, data.diff),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleAccept = (): void => {
    if (!proposal) return;
    onAccept(proposal.proposed);
    setProposal(null);
    setInstruction("");
    onPreviewChange(undefined);
  };

  const handleReject = (): void => {
    setProposal(null);
    onPreviewChange(undefined);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-purple-200 dark:border-purple-900 bg-purple-50/40 dark:bg-purple-950/20 p-2.5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse copilot" : "Expand copilot"}
          className="text-xs text-purple-400 hover:text-purple-700 dark:hover:text-purple-200"
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className="text-xs font-semibold text-purple-700 dark:text-purple-300">
          ✨ Copilot
        </span>
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleAsk();
            }
          }}
          placeholder={
            'Describe an edit… e.g. "add a guardrail node before the LLM node"'
          }
          disabled={isLoading}
          aria-label="Copilot instruction"
          className="min-w-0 flex-1 rounded border border-purple-200 dark:border-purple-800 bg-card px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleAsk()}
          disabled={isLoading || !instruction.trim()}
        >
          {isLoading ? "Thinking…" : "Ask"}
        </Button>
      </div>

      {expanded && error && (
        <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
          <p role="alert">{error}</p>
          {validationDetail && (
            <ul className="mt-1 space-y-0.5 pl-3 list-disc">
              {validationDetail.errors.map((issue, i) => (
                <li key={i}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {expanded && proposal && (
        <div className="max-h-48 overflow-auto rounded border border-purple-200 dark:border-purple-800 bg-card px-2.5 py-2 text-xs space-y-2">
          <p className="text-foreground">{proposal.explanation}</p>
          <p className="italic text-muted-foreground">{proposal.summary}</p>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleAccept}>
              Accept
            </Button>
            <Button variant="secondary" size="sm" onClick={handleReject}>
              Reject
            </Button>
            <span className="text-muted-foreground">
              Preview shown on canvas — accept to apply, or keep editing.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

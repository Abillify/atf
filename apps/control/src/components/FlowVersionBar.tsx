"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowVersionBar — Studio builder toolbar segment for Phase 2
 * ("Versionierung & Diff als First-Class-Citizen").
 *
 * Lets the operator pick a past published version (or "draft vs published")
 * to compare against the latest/current state. The comparison is fetched via
 * the existing `GET /flows/:id/diff` and `GET /flows/:id/versions` endpoints
 * (unchanged — this is a rendering layer on data that already existed) and
 * projected onto the canvas via `buildDiffOverlay` (`lib/flow-diff-view.ts`)
 * so added/changed/removed nodes and edges are visible directly on the graph,
 * not only in the text-based `FlowDiffPanel`.
 *
 * Renders nothing when the backend has no `FlowStore` configured (file-based
 * only deployments — versions/rollback are a Stage 3 feature) or the flow has
 * no history yet.
 */

import React, { useCallback, useEffect, useState } from "react";
import { backendUrl } from "../lib/backend-url";
import { Button } from "../lib/ui";
import { buildDiffOverlay, type DiffOverlay } from "../lib/flow-diff-view";
import type { RFNode, RFEdge } from "../lib/flow-graph";
import type {
  FlowDefinition,
  FlowDiffResponse,
  FlowVersionEntry,
} from "../types/flow";

export interface FlowVersionBarProps {
  flowId: string;
  token?: string;
  /** Whether this flow currently has an unpublished draft (Req. FlowListEntry.hasDraft). */
  hasDraft: boolean;
  /** Live canvas state — used to resolve which rendered edge a diff entry refers to. */
  nodes: RFNode[];
  edges: RFEdge[];
  /** Reports the computed overlay (or undefined to clear it) for FlowCanvas to render. */
  onDiffOverlayChange: (overlay: DiffOverlay | undefined) => void;
  /** Called after a successful rollback so the parent can reload the flow. */
  onRolledBack: () => void;
}

type Comparison = { kind: "version"; version: number } | { kind: "draft" };

async function fetchJson<T>(
  url: string,
  token: string | undefined,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

export function FlowVersionBar({
  flowId,
  token,
  hasDraft,
  nodes,
  edges,
  onDiffOverlayChange,
  onRolledBack,
}: FlowVersionBarProps): React.JSX.Element | null {
  const [versions, setVersions] = useState<FlowVersionEntry[]>([]);
  const [selected, setSelected] = useState<Comparison | null>(null);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setSelected(null);
    setConfirmingRollback(false);
    setStatus(null);
    onDiffOverlayChange(undefined);
    fetchJson<{ versions: FlowVersionEntry[] }>(
      backendUrl(`/flows/${encodeURIComponent(flowId)}/versions`),
      token,
    ).then((data) => setVersions(data?.versions ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowId, token]);

  const runComparison = useCallback(
    async (comparison: Comparison): Promise<void> => {
      setStatus("Loading comparison…");
      if (comparison.kind === "draft") {
        const [diffResp, detail] = await Promise.all([
          fetchJson<FlowDiffResponse>(
            backendUrl(`/flows/${encodeURIComponent(flowId)}/diff?draft=true`),
            token,
          ),
          fetchJson<{ published: FlowDefinition | null }>(
            backendUrl(`/flows/${encodeURIComponent(flowId)}`),
            token,
          ),
        ]);
        if (!diffResp || !detail?.published) {
          setStatus("Could not load draft/published comparison.");
          onDiffOverlayChange(undefined);
          return;
        }
        setStatus(diffResp.diff.summary);
        onDiffOverlayChange(
          buildDiffOverlay(detail.published, nodes, edges, diffResp.diff),
        );
        return;
      }

      const latest = versions[0]?.version;
      if (latest === undefined) return;
      const fromDef = versions.find((v) => v.version === comparison.version)
        ?.definition;
      if (!fromDef) return;

      const diffResp = await fetchJson<FlowDiffResponse>(
        backendUrl(
          `/flows/${encodeURIComponent(flowId)}/diff?from=${comparison.version}&to=${latest}`,
        ),
        token,
      );
      if (!diffResp) {
        setStatus("Could not load version comparison.");
        onDiffOverlayChange(undefined);
        return;
      }
      setStatus(diffResp.diff.summary);
      onDiffOverlayChange(buildDiffOverlay(fromDef, nodes, edges, diffResp.diff));
    },
    [flowId, token, versions, nodes, edges, onDiffOverlayChange],
  );

  const handleSelectChange = (value: string): void => {
    setConfirmingRollback(false);
    if (value === "") {
      setSelected(null);
      setStatus(null);
      onDiffOverlayChange(undefined);
      return;
    }
    const comparison: Comparison =
      value === "draft" ? { kind: "draft" } : { kind: "version", version: Number(value) };
    setSelected(comparison);
    void runComparison(comparison);
  };

  const handleRollback = async (): Promise<void> => {
    if (!selected || selected.kind !== "version") return;
    setStatus("Rolling back…");
    const result = await fetchJson<{ record: unknown }>(
      backendUrl(`/flows/${encodeURIComponent(flowId)}/rollback`),
      token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: selected.version }),
      },
    );
    if (!result) {
      setStatus("Rollback failed.");
      return;
    }
    setStatus(`Rolled back to v${selected.version}.`);
    setConfirmingRollback(false);
    setSelected(null);
    onDiffOverlayChange(undefined);
    onRolledBack();
  };

  if (versions.length === 0 && !hasDraft) return null;

  const latestVersion = versions[0]?.version;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label htmlFor="version-compare" className="text-muted-foreground">
        Compare
      </label>
      <select
        id="version-compare"
        value={
          selected === null
            ? ""
            : selected.kind === "draft"
              ? "draft"
              : String(selected.version)
        }
        onChange={(e) => handleSelectChange(e.target.value)}
        className="rounded border border-border bg-card px-1.5 py-0.5 text-xs"
      >
        <option value="">— none —</option>
        {hasDraft && <option value="draft">Draft ↔ Published</option>}
        {versions
          .filter((v) => v.version !== latestVersion)
          .map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version} → v{latestVersion} ({new Date(v.publishedAt).toLocaleDateString()})
            </option>
          ))}
      </select>

      {selected?.kind === "version" && (
        <>
          {confirmingRollback ? (
            <span className="flex items-center gap-1">
              <span className="text-muted-foreground">Really roll back?</span>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleRollback()}
              >
                Yes, rollback
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmingRollback(false)}
              >
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmingRollback(true)}
            >
              Rollback to v{selected.version}
            </Button>
          )}
        </>
      )}

      {status && <span className="italic text-muted-foreground">{status}</span>}
    </div>
  );
}

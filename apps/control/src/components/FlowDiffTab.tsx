"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowDiffTab — Flow Diff Viewer panel (Req. 13.2, consolidated into
 * /flows?tab=diff under Req. 9.9).
 *
 * Two searchable dropdowns pick the comparison endpoints (any flow/draft
 * combination) and fetch GET /flows/diff/compare, rendering the structural
 * diff (added/removed/changed nodes and edges) returned by
 * `src/graph/flow-diff.ts`. With "draft" checked, each dropdown also lists
 * the flow's named drafts, grouped and indented under their flow.
 */

import type React from "react";
import { useMemo, useState } from "react";
import { useAuth } from "../lib/auth/useAuth";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../lib/ui";
import { useFlows } from "../hooks/useFlows";
import {
  FlowEndpointPicker,
  type FlowEndpoint,
} from "./FlowEndpointPicker";

interface FieldChange<T = unknown> {
  from: T;
  to: T;
}

interface NodeChange {
  id: string;
  changedFields: string[];
}

interface EdgeChange {
  key: string;
  changedFields: string[];
}

interface FlowDiff {
  changed: boolean;
  name?: FieldChange<string>;
  description?: FieldChange<string | undefined>;
  metadataChanged: boolean;
  nodes: { added: string[]; removed: string[]; changed: NodeChange[] };
  edges: { added: string[]; removed: string[]; changed: EdgeChange[] };
  summary: string;
}

interface DiffEndpoint {
  kind: "published" | "draft" | "file" | "version";
  flowId?: string;
  draftId?: string;
  version?: number;
  file?: string;
}

interface FlowDiffResponse {
  from: DiffEndpoint;
  to: DiffEndpoint;
  diff: FlowDiff;
}

function endpointLabel(e: DiffEndpoint): string {
  const parts: string[] = [];
  if (e.kind === "draft")
    parts.push(e.draftId !== undefined ? `draft:${e.draftId}` : "draft");
  else if (e.kind === "file") parts.push("file");
  else if (e.version !== undefined) parts.push(`v${e.version}`);
  else parts.push(e.kind);
  return parts.join(" · ");
}

function IdList({
  ids,
  emptyLabel,
  tone,
}: {
  ids: string[];
  emptyLabel: string;
  tone: "added" | "removed";
}) {
  if (ids.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  const cls =
    tone === "added"
      ? "bg-success-soft text-success"
      : "bg-danger-soft text-danger";
  return (
    <ul className="space-y-1">
      {ids.map((id) => (
        <li key={id} className={`rounded px-2 py-1 font-mono text-xs ${cls}`}>
          {tone === "added" ? "+" : "-"} {id}
        </li>
      ))}
    </ul>
  );
}

interface SubmittedComparison {
  from: FlowEndpoint;
  to: FlowEndpoint;
}

export function FlowDiffTab(): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();
  const {
    flows,
    compare,
    isLoading: flowsLoading,
  } = useFlows({
    token: token ?? undefined,
    enabled: ready && isAuthenticated,
  });
  const [showDrafts, setShowDrafts] = useState(false);
  const [from, setFrom] = useState<FlowEndpoint | null>(null);
  const [to, setTo] = useState<FlowEndpoint | null>(null);
  const [submitted, setSubmitted] = useState<SubmittedComparison | null>(null);

  const flowNames = useMemo(
    () => new Map(flows.map((f) => [f.id, f.name])),
    [flows],
  );

  const { data, isLoading, error } = useQuery<FlowDiffResponse, Error>({
    queryKey: ["flow", "diff", "compare", submitted],
    queryFn: (): Promise<FlowDiffResponse> => {
      // `enabled` keeps the query idle until a comparison was submitted.
      if (submitted === null) {
        return Promise.reject(new Error("No comparison submitted."));
      }
      const { from: fromEndpoint, to: toEndpoint } = submitted;
      return compare({
        from: fromEndpoint.flowId,
        ...(fromEndpoint.draftId !== undefined
          ? { fromDraft: fromEndpoint.draftId }
          : {}),
        to: toEndpoint.flowId,
        ...(toEndpoint.draftId !== undefined
          ? { toDraft: toEndpoint.draftId }
          : {}),
        // The panel renders a narrower view of the shared response type
        // (endpoint `kind` as a union, typed diff sections).
      }) as Promise<FlowDiffResponse>;
    },
    enabled: submitted !== null && ready && isAuthenticated,
  });

  const canSubmit = from !== null && to !== null;
  const diff = data?.diff;
  const labelOf = (e: FlowEndpoint): string =>
    flowNames.get(e.flowId) ?? e.flowId;

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-foreground">
        Flow Diff Viewer
      </h2>

      {/* Endpoint pickers */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Von</span>
          <FlowEndpointPicker
            flows={flows}
            value={from}
            onChange={setFrom}
            loading={flowsLoading}
            showDrafts={showDrafts}
            placeholder="— Flow wählen —"
            ariaLabel="Vergleichsquelle (von)"
            className="w-full"
          />
        </div>
        <div className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Nach
          </span>
          <FlowEndpointPicker
            flows={flows}
            value={to}
            onChange={setTo}
            loading={flowsLoading}
            showDrafts={showDrafts}
            placeholder="— Flow wählen —"
            ariaLabel="Vergleichsziel (nach)"
            className="w-full"
          />
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showDrafts}
            onChange={(e) => setShowDrafts(e.target.checked)}
          />
          Draft
        </label>
        <Button
          variant="primary"
          onClick={() =>
            from !== null && to !== null && setSubmitted({ from, to })
          }
          disabled={!canSubmit}
        >
          Show Diff
        </Button>
      </div>

      {/* Idle */}
      {!submitted && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          Two flows to compare. With “Draft” checked, each dropdown also lists
          the drafts under its flow.
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Fetching diff…
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="rounded-md bg-danger-soft p-4 text-sm text-danger"
        >
          Failed to load diff: {error.message}
        </div>
      )}

      {/* Data */}
      {!isLoading && !error && data && diff && submitted && (
        <div className="rounded-lg border border-border bg-card shadow-sm">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div className="text-sm text-foreground">
              <span className="font-medium">{labelOf(submitted.from)}</span>
              <span className="mx-1 text-muted-foreground">·</span>
              <code className="text-xs text-muted-foreground">
                {endpointLabel(data.from)}
              </code>
              <span className="mx-2 text-muted-foreground">→</span>
              <span className="font-medium">{labelOf(submitted.to)}</span>
              <span className="mx-1 text-muted-foreground">·</span>
              <code className="text-xs text-muted-foreground">
                {endpointLabel(data.to)}
              </code>
            </div>
            <div className="text-xs text-muted-foreground">{diff.summary}</div>
          </div>

          {!diff.changed ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No changes between versions.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
              {(diff.name || diff.description || diff.metadataChanged) && (
                <div className="md:col-span-2 rounded-md border border-border bg-muted p-3 text-xs">
                  {diff.name && (
                    <div className="mb-1">
                      <span className="font-medium text-muted-foreground">
                        name:
                      </span>{" "}
                      <span className="text-danger">{diff.name.from}</span> →{" "}
                      <span className="text-success">{diff.name.to}</span>
                    </div>
                  )}
                  {diff.description && (
                    <div className="mb-1">
                      <span className="font-medium text-muted-foreground">
                        description:
                      </span>{" "}
                      <span className="text-danger">
                        {diff.description.from ?? "—"}
                      </span>{" "}
                      →{" "}
                      <span className="text-success">
                        {diff.description.to ?? "—"}
                      </span>
                    </div>
                  )}
                  {diff.metadataChanged && (
                    <div className="text-muted-foreground">
                      metadata changed
                    </div>
                  )}
                </div>
              )}

              <div>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Nodes
                </h2>
                <div className="space-y-2">
                  <IdList
                    ids={diff.nodes.added}
                    emptyLabel="No nodes added."
                    tone="added"
                  />
                  <IdList
                    ids={diff.nodes.removed}
                    emptyLabel="No nodes removed."
                    tone="removed"
                  />
                  {diff.nodes.changed.length > 0 && (
                    <ul className="space-y-1">
                      {diff.nodes.changed.map((n) => (
                        <li
                          key={n.id}
                          className="rounded bg-warning-soft px-2 py-1 text-xs text-warning"
                        >
                          ~ <span className="font-mono">{n.id}</span>{" "}
                          <span className="text-warning">
                            ({n.changedFields.join(", ")})
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Edges
                </h2>
                <div className="space-y-2">
                  <IdList
                    ids={diff.edges.added}
                    emptyLabel="No edges added."
                    tone="added"
                  />
                  <IdList
                    ids={diff.edges.removed}
                    emptyLabel="No edges removed."
                    tone="removed"
                  />
                  {diff.edges.changed.length > 0 && (
                    <ul className="space-y-1">
                      {diff.edges.changed.map((e) => (
                        <li
                          key={e.key}
                          className="rounded bg-warning-soft px-2 py-1 text-xs text-warning"
                        >
                          ~ <span className="font-mono">{e.key}</span>{" "}
                          <span className="text-warning">
                            ({e.changedFields.join(", ")})
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

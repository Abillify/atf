"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /flow-diff — Flow Diff Viewer (Req. 13.2).
 *
 * Fetches GET /flows/:id/diff and renders the structural diff (added/removed/
 * changed nodes and edges) returned by `src/graph/flow-diff.ts`. Supports the
 * two comparison modes the backend exposes: two published versions
 * (`?from=`/`?to=`, defaulting to the latest two), or published vs. draft
 * (`?draft=true`).
 */

import React, { useState } from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery } from "@tanstack/react-query";
import { Button } from "../../../lib/ui";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";

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
  kind: "published" | "draft" | "version";
  version?: number;
}

interface FlowDiffResponse {
  from: DiffEndpoint;
  to: DiffEndpoint;
  diff: FlowDiff;
}

function endpointLabel(e: DiffEndpoint): string {
  if (e.kind === "draft") return "draft";
  if (e.version !== undefined) return `v${e.version}`;
  return e.kind;
}

function fetchFlowDiff(
  flowId: string,
  compareDraft: boolean,
  token: string,
): Promise<FlowDiffResponse> {
  const qs = compareDraft ? "?draft=true" : "";
  return authFetch(
    backendUrl(`/flows/${encodeURIComponent(flowId)}/diff${qs}`),
    token,
  ).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<FlowDiffResponse>;
  });
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
      ? "bg-green-50 text-green-800"
      : "bg-red-50 text-red-800";
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

export default function FlowDiffPage() {
  const { token, ready } = useAuth();
  const [flowId, setFlowId] = useState("");
  const [compareDraft, setCompareDraft] = useState(false);
  const [submittedId, setSubmittedId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<FlowDiffResponse, Error>({
    queryKey: ["flow", submittedId, "diff", compareDraft],
    queryFn: () => fetchFlowDiff(submittedId!, compareDraft, token!),
    enabled: !!submittedId && ready && !!token,
  });

  const diff = data?.diff;

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        Flow Diff Viewer
      </h1>

      {/* Flow ID input */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={flowId}
          onChange={(e) => setFlowId(e.target.value)}
          placeholder="Flow ID…"
          className="flex-1 min-w-[200px] rounded-md border border-border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter" && flowId.trim())
              setSubmittedId(flowId.trim());
          }}
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={compareDraft}
            onChange={(e) => setCompareDraft(e.target.checked)}
          />
          Compare against draft
        </label>
        <Button
          variant="primary"
          onClick={() => flowId.trim() && setSubmittedId(flowId.trim())}
          disabled={!flowId.trim()}
        >
          Show Diff
        </Button>
      </div>

      {/* Idle */}
      {!submittedId && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          Enter a flow ID to compare versions.
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
          className="rounded-md bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load diff: {error.message}
        </div>
      )}

      {/* Data */}
      {!isLoading && !error && data && diff && (
        <div className="rounded-lg border border-border bg-card shadow-sm">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm text-foreground">
              <span className="font-medium">{submittedId}</span>
              <span className="mx-1 text-muted-foreground">·</span>
              <code className="text-xs text-muted-foreground">
                {endpointLabel(data.from)}
              </code>
              <span className="mx-1 text-muted-foreground">→</span>
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
                      <span className="font-medium text-muted-foreground">name:</span>{" "}
                      <span className="text-red-600">{diff.name.from}</span>{" "}
                      →{" "}
                      <span className="text-green-700">{diff.name.to}</span>
                    </div>
                  )}
                  {diff.description && (
                    <div className="mb-1">
                      <span className="font-medium text-muted-foreground">
                        description:
                      </span>{" "}
                      <span className="text-red-600">
                        {diff.description.from ?? "—"}
                      </span>{" "}
                      →{" "}
                      <span className="text-green-700">
                        {diff.description.to ?? "—"}
                      </span>
                    </div>
                  )}
                  {diff.metadataChanged && (
                    <div className="text-muted-foreground">metadata changed</div>
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
                          className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800"
                        >
                          ~ <span className="font-mono">{n.id}</span>{" "}
                          <span className="text-amber-600">
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
                          className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800"
                        >
                          ~ <span className="font-mono">{e.key}</span>{" "}
                          <span className="text-amber-600">
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

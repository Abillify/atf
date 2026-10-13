"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowDiffPanel — Structural diff viewer for flow versions.
 *
 * Shows what changed between two published flow versions, or between the
 * current draft and the published version (draft=true mode). Uses the
 * `GET /flows/:id/diff` backend endpoint.
 *
 * Design:
 *  - Green rows = added nodes/edges
 *  - Red rows = removed nodes/edges
 *  - Yellow rows = changed nodes/edges (shows which fields changed)
 *  - Blue badge for name/description changes
 *
 * Fits naturally into the Studio sidebar (width ≈ 320 px) or the flows page.
 */

import type React from "react";
import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/control-api";
import { DiffView } from "./FormulaEditor";

// ---------------------------------------------------------------------------
// Types (mirrors backend FlowDiff)
// ---------------------------------------------------------------------------

interface FieldChange {
  from: unknown;
  to: unknown;
}

/** One changed value, addressed by its path (e.g. `config.routing.strategy`). */
export interface ValueChange {
  path: string;
  kind: "added" | "removed" | "changed";
  from?: unknown;
  to?: unknown;
}

interface NodeChange {
  id: string;
  changedFields: string[];
  /** Absent from older runtimes. */
  details?: ValueChange[];
}

interface EdgeChange {
  key: string;
  changedFields: string[];
  details?: ValueChange[];
}

interface FlowDiff {
  changed: boolean;
  name?: FieldChange;
  description?: FieldChange;
  metadataChanged: boolean;
  nodes: {
    added: string[];
    removed: string[];
    changed: NodeChange[];
  };
  edges: {
    added: string[];
    removed: string[];
    changed: EdgeChange[];
  };
  summary: string;
  /** Full definitions of added/removed nodes and edges (newer runtimes). */
  values?: {
    nodes: { added: Record<string, unknown>; removed: Record<string, unknown> };
    edges: { added: Record<string, unknown>; removed: Record<string, unknown> };
  };
  metadataDetails?: ValueChange[];
}

interface DiffResponse {
  from: { kind: string; version?: number; file?: string };
  to: { kind: string; version?: number; file?: string };
  diff: FlowDiff;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Badge({
  children,
  color,
}: {
  children: React.ReactNode;
  color: "green" | "red" | "yellow" | "blue" | "gray";
}) {
  const cls = {
    green: "bg-success-soft text-success",
    red: "bg-danger-soft text-danger",
    yellow: "bg-warning-soft text-warning",
    blue: "bg-info-soft text-info",
    gray: "bg-muted text-muted-foreground",
  }[color];
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

const pretty = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v));

/** One changed value: a word-level diff for changes, the value for additions/removals. */
function ValueDetail({ change }: { change: ValueChange }): React.JSX.Element {
  const badge = { added: "text-success", removed: "text-danger", changed: "text-warning" }[change.kind];
  return (
    <div className="space-y-0.5" data-testid="diff-value">
      <div className="flex items-baseline gap-1.5 text-[10px]">
        <span className={`font-semibold uppercase ${badge}`}>{change.kind}</span>
        <code className="break-all font-mono text-foreground">{change.path || "(value)"}</code>
      </div>
      {change.kind === "changed" ? (
        <DiffView before={pretty(change.from)} after={pretty(change.to)} ariaLabel={`Change of ${change.path}`} />
      ) : (
        <ValueBlock value={change.kind === "added" ? change.to : change.from} kind={change.kind} />
      )}
    </div>
  );
}

function ValueBlock({ value, kind }: { value: unknown; kind: "added" | "removed" }): React.JSX.Element {
  return (
    <pre
      className={`max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border p-2 font-mono text-[11px] ${
        kind === "added"
          ? "border-success-border bg-success-soft text-success dark:border-success-border dark:bg-success-soft dark:text-success"
          : "border-danger-border bg-danger-soft text-danger line-through decoration-danger/60 dark:border-danger-border dark:bg-danger-soft dark:text-danger"
      }`}
    >
      {pretty(value)}
    </pre>
  );
}

function DiffRow({
  kind,
  label,
  detail,
  children,
}: {
  kind: "added" | "removed" | "changed" | "meta";
  label: string;
  detail?: string;
  /** Expandable details (values); the row becomes a disclosure when given. */
  children?: React.ReactNode;
}) {
  const config = {
    added: { color: "bg-success-soft border-success-border", badge: "green" as const, prefix: "+" },
    removed: { color: "bg-danger-soft border-danger-border", badge: "red" as const, prefix: "−" },
    changed: { color: "bg-warning-soft border-warning-border", badge: "yellow" as const, prefix: "~" },
    meta: { color: "bg-info-soft border-info-border", badge: "blue" as const, prefix: "M" },
  }[kind];

  const head = (
    <>
      <Badge color={config.badge}>{config.prefix}</Badge>
      <div className="min-w-0 flex-1">
        <span className="font-mono text-xs text-foreground break-all">{label}</span>
        {detail && <p className="text-[10px] text-muted-foreground mt-0.5">{detail}</p>}
      </div>
    </>
  );
  if (!children) {
    return <div className={`flex items-start gap-2 rounded border px-2 py-1.5 ${config.color}`}>{head}</div>;
  }
  return (
    <details className={`group rounded border ${config.color}`}>
      <summary className="flex cursor-pointer list-none items-start gap-2 px-2 py-1.5" title="Show the details">
        {head}
        <span aria-hidden className="text-[10px] text-muted-foreground transition-transform group-open:rotate-90">
          ▸
        </span>
      </summary>
      <div className="space-y-2 border-t border-border/60 bg-card px-2 py-2">{children}</div>
    </details>
  );
}

/** Detail list for a changed entity, or nothing (an older runtime sends none). */
function detailsOf(details: ValueChange[] | undefined): React.ReactNode {
  if (!details || details.length === 0) return undefined;
  // biome-ignore lint/suspicious/noArrayIndexKey: the same path can change several times per entity; details are replaced atomically with the diff
  return details.map((c, i) => <ValueDetail key={`${c.path}-${i}`} change={c} />);
}

/** A metadata row lists how many values changed when details are there. */
function detailProps(details: ValueChange[] | undefined): { detail?: string } {
  return details && details.length > 0 ? { detail: `${details.length} value(s)` } : {};
}

/** Full definition of an added/removed entity, or nothing when not sent. */
function entityValue(value: unknown, kind: "added" | "removed"): React.ReactNode {
  return value === undefined ? undefined : <ValueBlock value={value} kind={kind} />;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface FlowDiffPanelProps {
  flowId: string;
  token?: string;
  /** When true, show draft vs. published. When false, compare versions. */
  draftMode?: boolean;
  fromVersion?: number;
  toVersion?: number;
}

export function FlowDiffPanel({
  flowId,
  token,
  draftMode = false,
  fromVersion,
  toVersion,
}: FlowDiffPanelProps): React.JSX.Element {
  // Req 9.2: TanStack Query + lib/control-api instead of fetch/useState.
  const diffQuery = useQuery<DiffResponse, Error>({
    queryKey: [
      "flow-diff",
      flowId,
      token ?? null,
      draftMode,
      fromVersion ?? null,
      toVersion ?? null,
    ],
    enabled: !!flowId,
    retry: false,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (draftMode) {
        params.set("draft", "true");
      } else {
        if (fromVersion !== undefined) params.set("from", String(fromVersion));
        if (toVersion !== undefined) params.set("to", String(toVersion));
      }
      const qs = params.toString();
      const path = `/flows/${encodeURIComponent(flowId)}/diff${qs ? `?${qs}` : ""}`;
      const resp = await request(path, { target: "backend", token });
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        throw new Error(data.error?.message ?? `HTTP ${resp.status}`);
      }
      return (await resp.json()) as DiffResponse;
    },
  });

  const response = diffQuery.data ?? null;
  // Without a flowId the query is disabled (isPending would stay true); then
  // show "No diff available." as before.
  const loading = !!flowId && diffQuery.isPending;
  const error = diffQuery.error ? diffQuery.error.message : null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <span className="animate-spin">⟳</span> Loading diff…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-danger-border bg-danger-soft px-3 py-2 text-xs text-danger">
        {error}
      </div>
    );
  }

  if (!response) {
    return (
      <div className="text-xs text-muted-foreground py-2">No diff available.</div>
    );
  }

  const { diff, from, to } = response;

  const fromLabel =
    from.kind === "draft"
      ? "draft"
      : from.kind === "file"
        ? `live file${from.file ? ` (${from.file})` : ""}`
        : `v${from.version ?? "?"}`;
  const toLabel = to.kind === "draft" ? "draft" : `v${to.version ?? "?"}`;

  return (
    <div className="flex flex-col gap-3 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono font-semibold text-foreground">
          {flowId}
        </span>
        <span>
          {fromLabel} → {toLabel}
        </span>
        <button type="button"
          onClick={() => void diffQuery.refetch()}
          className="ml-auto text-accent hover:text-accent/80"
          title="Refresh diff"
          aria-label="Refresh diff"
        >
          ↻
        </button>
      </div>

      {!diff.changed ? (
        <div className="rounded border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          ✓ No changes between {fromLabel} and {toLabel}.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {/* Summary */}
          <p className="text-[10px] text-muted-foreground italic">{diff.summary}</p>

          {/* Scalar changes */}
          {diff.name && (
            <DiffRow
              kind="meta"
              label="name"
              detail={`"${String(diff.name.from)}" → "${String(diff.name.to)}"`}
            />
          )}
          {diff.description && (
            <DiffRow
              kind="meta"
              label="description"
              detail={`"${String(diff.description.from ?? "")}" → "${String(diff.description.to ?? "")}"`}
            />
          )}
          {diff.metadataChanged && (
            <DiffRow kind="meta" label="metadata" {...detailProps(diff.metadataDetails)}>
              {detailsOf(diff.metadataDetails)}
            </DiffRow>
          )}

          {/* Node changes */}
          {diff.nodes.added.map((id) => (
            <DiffRow key={`na-${id}`} kind="added" label={`node: ${id}`}>
              {entityValue(diff.values?.nodes.added[id], "added")}
            </DiffRow>
          ))}
          {diff.nodes.removed.map((id) => (
            <DiffRow key={`nr-${id}`} kind="removed" label={`node: ${id}`}>
              {entityValue(diff.values?.nodes.removed[id], "removed")}
            </DiffRow>
          ))}
          {diff.nodes.changed.map((nc) => (
            <DiffRow
              key={`nc-${nc.id}`}
              kind="changed"
              label={`node: ${nc.id}`}
              detail={nc.changedFields.join(", ")}
            >
              {detailsOf(nc.details)}
            </DiffRow>
          ))}

          {/* Edge changes */}
          {diff.edges.added.map((key) => (
            <DiffRow key={`ea-${key}`} kind="added" label={`edge: ${key}`}>
              {entityValue(diff.values?.edges.added[key], "added")}
            </DiffRow>
          ))}
          {diff.edges.removed.map((key) => (
            <DiffRow key={`er-${key}`} kind="removed" label={`edge: ${key}`}>
              {entityValue(diff.values?.edges.removed[key], "removed")}
            </DiffRow>
          ))}
          {diff.edges.changed.map((ec) => (
            <DiffRow
              key={`ec-${ec.key}`}
              kind="changed"
              label={`edge: ${ec.key}`}
              detail={ec.changedFields.join(", ")}
            >
              {detailsOf(ec.details)}
            </DiffRow>
          ))}
        </div>
      )}
    </div>
  );
}

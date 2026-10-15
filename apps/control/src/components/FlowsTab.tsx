"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useCanWrite } from "../lib/auth/useCanWrite";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Workflow } from "lucide-react";
import { useFlows } from "../hooks/useFlows";
import { useFlowStats } from "../hooks/useFlowStats";
import { formatCost } from "../lib/currency";
import {
  Button,
  Badge,
  type BadgeVariant,
  EmptyState,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
  useConfirm,
} from "../lib/ui";
import type { FlowDefinition, FlowListEntry } from "../types/flow";
import { translate } from "../lib/i18n";

export interface FlowsTabProps {
  token?: string;
  enabled?: boolean;
}

/** Flows are edited and inspected in Studio; /flows is the registry. */
export function studioHref(flowId?: string): string {
  return flowId ? `/studio?flow=${encodeURIComponent(flowId)}` : "/studio";
}

/** Stats time window presets — mirrors the /limits panel's range selector. */
type StatsRange = "1h" | "1d" | "1w" | "1m";

const STATS_RANGE_MS: Record<StatsRange, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

/** Compact runtime: ms below a second, seconds to one decimal, else minutes. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** Cost with the configured currency symbol, trailing zeros trimmed. */
function formatCostCompact(value: number): string {
  return formatCost(value, 6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function statusBadge(f: FlowListEntry): { label: string; variant: BadgeVariant } {
  if (f.source === "file") return { label: "file", variant: "secondary" };
  if (f.status === "published")
    return {
      label: f.draftDirty ? "published · draft" : "published",
      variant: f.draftDirty ? "warning" : "success",
    };
  return { label: "draft", variant: "default" };
}

// Links styled like the sm Buttons they sit next to.
const LINK_BASE =
  "inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";
const LINK_OUTLINE = `${LINK_BASE} border border-border bg-transparent text-foreground hover:bg-muted`;
const LINK_PRIMARY = `${LINK_BASE} bg-accent text-accent-foreground hover:opacity-90`;

function download(name: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function FlowsTab({
  token,
  enabled = true,
}: FlowsTabProps): React.JSX.Element {
  const writeGate = useCanWrite("admin");
  const actions = useFlows({
    enabled,
    ...(token !== undefined ? { token } : {}),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [range, setRange] = useState<StatsRange>("1d");
  // Req 9.5: confirmations through the dialog primitive instead of window.confirm.
  const { confirm: confirmDialog } = useConfirm();
  // Window start is frozen per range change (not per render) so the stats
  // query key stays stable while the table re-renders.
  const sinceIso = useMemo(
    () => new Date(Date.now() - STATS_RANGE_MS[range]).toISOString(),
    [range],
  );
  const { stats: flowStats } = useFlowStats(sinceIso, {
    enabled,
    ...(token !== undefined ? { token } : {}),
  });

  const exportFlow = async (id: string): Promise<void> => {
    setBusyId(id);
    setErr(null);
    try {
      const d = await actions.get(id);
      const def = d.draft ?? d.published ?? d.sourceDefinition;
      if (!def) throw new Error(`flow "${id}" has no definition`);
      download(`${id}.json`, JSON.stringify(def, null, 2));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to export flow");
    } finally {
      setBusyId(null);
    }
  };

  const deleteFlow = async (id: string): Promise<void> => {
    if (
      !(await confirmDialog({
        title: translate("flowsTab.deleteFlow"),
        message: translate("flowsTab.deleteFlowIdThisRemoves", { id }),
        confirmLabel: translate("flowsTab.delete"),
        destructive: true,
      }))
    ) {
      return;
    }
    setBusyId(id);
    setErr(null);
    try {
      if (!(await actions.remove(id))) setErr(`Deleting "${id}" failed.`);
    } finally {
      setBusyId(null);
    }
  };

  // Stores the imported definition as a draft under its own id, then opens it
  // in Studio for review — nothing goes live until it is published there.
  const importFlow = async (file: File): Promise<void> => {
    setErr(null);
    let def: FlowDefinition;
    try {
      def = JSON.parse(await file.text()) as FlowDefinition;
    } catch {
      setErr("Import failed: invalid JSON");
      return;
    }
    const id = typeof def.id === "string" ? def.id.trim() : "";
    if (!id) {
      setErr("Import failed: the flow has no id");
      return;
    }
    if (
      actions.flows.some((f) => f.id === id) &&
      !(await confirmDialog({
        title: translate("flowsTab.replaceExistingFlow"),
        message: translate("flowsTab.flowIdExistsReplaceIts", { id }),
        confirmLabel: translate("flowsTab.replace"),
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await actions.saveDraft(id, def);
      window.location.assign(studioHref(id));
    } catch (e) {
      setErr(
        e instanceof Error ? `Import failed: ${e.message}` : "Import failed",
      );
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          {translate("flowsTab.flows")}{" "}
          <span className="font-normal text-muted-foreground">
            ({actions.flows.length})
          </span>
        </h3>
        <div className="flex items-center gap-2">
          {(err || actions.error) && (
            <span className="text-xs text-danger">{err ?? actions.error}</span>
          )}
          {/* Stats window — same preset-button style as the /limits panel. */}
          {/* biome-ignore lint/a11y/useSemanticElements: toolbar of toggle buttons, not a form control — <fieldset> would be wrong here */}
          <div
            className="flex overflow-hidden rounded border border-border text-xs"
            role="group"
            aria-label={translate("flowsTab.statsTimeRange")}
          >
            {(["1h", "1d", "1w", "1m"] as StatsRange[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setRange(p)}
                aria-pressed={range === p}
                className={`px-2 py-1 ${
                  range === p
                    ? "bg-accent text-accent-foreground"
                    : "bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => actions.refresh()}>
            {translate("flowsTab.refresh")}
          </Button>
          {actions.onlineEditing && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={!writeGate.allowed}
                title={writeGate.title}
              >
                {translate("flowsTab.import")}
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label={translate("flowsTab.importFlowJSON")}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFlow(f);
                  e.target.value = "";
                }}
              />
              <Link href={studioHref()} className={LINK_PRIMARY}>
                {translate("flowsTab.newFlow")}
              </Link>
            </>
          )}
        </div>
      </div>

      {!actions.onlineEditing && (
        <p className="rounded border border-dashed border-border bg-card p-3 text-xs text-muted-foreground">
          {translate("flowsTab.onlineEditingIsDisabledFlows")}{" "}
          <span className="font-mono">{translate("flowsTab.fLOWEDITORENABLEDTrue")}</span> {translate("flowsTab.with")}{" "}
          <span className="font-mono">DATABASE_URL</span> {translate("flowsTab.forDurabilityToAuthorFlows")}
        </p>
      )}

      {actions.flows.length === 0 ? (
        actions.isLoading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {translate("flowsTab.loading")}
          </p>
        ) : (
          <EmptyState
            icon={Workflow}
            title={translate("flowsTab.noFlowsYet")}
            description={translate("flowsTab.flowsDescribeHowRequestsAre")}
            action={
              actions.onlineEditing ? (
                <Link href={studioHref()} className={LINK_PRIMARY}>
                  {translate("flowsTab.newFlow")}
                </Link>
              ) : undefined
            }
          />
        )
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>{translate("flowsTab.flow")}</TableHeaderCell>
              <TableHeaderCell>{translate("flowsTab.source")}</TableHeaderCell>
              <TableHeaderCell className="text-center">{translate("flowsTab.status")}</TableHeaderCell>
              <TableHeaderCell className="text-right">{translate("flowsTab.nodes")}</TableHeaderCell>
              <TableHeaderCell className="text-right">{translate("flowsTab.ver")}</TableHeaderCell>
              <TableHeaderCell
                className="text-right"
                title={translate("flowsTab.executionsInTheLastRange", { range })}
              >
                {translate("flowsTab.runs")}
              </TableHeaderCell>
              <TableHeaderCell
                className="text-right"
                title={translate("flowsTab.averageRunDurationInThe", { range })}
              >
                {translate("flowsTab.avgRuntime")}
              </TableHeaderCell>
              <TableHeaderCell
                className="text-right"
                title={translate("flowsTab.averageCostPerRunIn", { range })}
              >
                {translate("flowsTab.avgCost")}
              </TableHeaderCell>
              <TableHeaderCell
                className="text-right"
                title={translate("flowsTab.totalCostInTheLast", { range })}
              >
                {translate("flowsTab.totalCost")}
              </TableHeaderCell>
              <TableHeaderCell className="text-right">{translate("flowsTab.actions")}</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {actions.flows.map((f) => {
              const b = statusBadge(f);
              const s = flowStats.get(f.id);
              return (
                <TableRow key={f.id}>
                  <TableCell>
                    <span className="font-medium text-foreground">
                      {f.name}
                    </span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {f.id}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {f.source}
                    {f.shadowsFile ? translate("flowsTab.overridesFile") : ""}
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant={b.variant}>{b.label}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.nodeCount}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {f.version}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s !== undefined ? s.runs : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s?.avg_latency_ms != null
                      ? formatDuration(s.avg_latency_ms)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s?.avg_cost != null ? formatCostCompact(s.avg_cost) : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {s?.total_cost != null
                      ? formatCostCompact(s.total_cost)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Link href={studioHref(f.id)} className={LINK_OUTLINE}>
                        {f.editable ? translate("flowsTab.edit") : translate("flowsTab.inspect")}
                      </Link>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void exportFlow(f.id)}
                        disabled={busyId === f.id}
                        title={translate("flowsTab.downloadTheFlowDefinitionAs")}
                      >
                        {translate("flowsTab.export")}
                      </Button>
                      {actions.onlineEditing &&
                        f.source === "online" &&
                        f.editable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void deleteFlow(f.id)}
                            disabled={busyId === f.id || !writeGate.allowed}
                            title={writeGate.title}
                            className="text-danger"
                          >
                            {translate("flowsTab.delete")}
                          </Button>
                        )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

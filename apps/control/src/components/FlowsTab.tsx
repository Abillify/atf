"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useRef, useState } from "react";
import Link from "next/link";
import { useFlows } from "../hooks/useFlows";
import {
  Button,
  Badge,
  type BadgeVariant,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";
import type { FlowDefinition, FlowListEntry } from "../types/flow";

export interface FlowsTabProps {
  token?: string;
  enabled?: boolean;
}

/** Flows are edited and inspected in Studio; /flows is the registry. */
export function studioHref(flowId?: string): string {
  return flowId ? `/studio?flow=${encodeURIComponent(flowId)}` : "/studio";
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
  const actions = useFlows({
    enabled,
    ...(token !== undefined ? { token } : {}),
  });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      !window.confirm(
        `Delete flow "${id}"? This removes its draft, published version and history.`,
      )
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
      !window.confirm(`Flow "${id}" exists. Replace its draft with the imported flow?`)
    ) {
      return;
    }
    try {
      await actions.saveDraft(id, def);
      window.location.assign(studioHref(id));
    } catch (e) {
      setErr(e instanceof Error ? `Import failed: ${e.message}` : "Import failed");
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Flows{" "}
          <span className="font-normal text-muted-foreground">
            ({actions.flows.length})
          </span>
        </h3>
        <div className="flex items-center gap-2">
          {(err || actions.error) && (
            <span className="text-xs text-red-600 dark:text-red-400">{err ?? actions.error}</span>
          )}
          <Button variant="outline" size="sm" onClick={() => actions.refresh()}>
            Refresh
          </Button>
          {actions.onlineEditing && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
              >
                Import
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="Import flow JSON"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importFlow(f);
                  e.target.value = "";
                }}
              />
              <Link href={studioHref()} className={LINK_PRIMARY}>
                + New flow
              </Link>
            </>
          )}
        </div>
      </div>

      {!actions.onlineEditing && (
        <p className="rounded border border-dashed border-border bg-card p-3 text-xs text-muted-foreground">
          Online editing is disabled — flows are inspected read-only and
          validated in Studio. Set{" "}
          <span className="font-mono">FLOW_EDITOR_ENABLED=true</span> (with{" "}
          <span className="font-mono">DATABASE_URL</span> for durability) to
          author flows online.
        </p>
      )}

      {actions.flows.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {actions.isLoading ? "Loading…" : "No flows yet."}
        </p>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Flow</TableHeaderCell>
              <TableHeaderCell>Source</TableHeaderCell>
              <TableHeaderCell className="text-center">Status</TableHeaderCell>
              <TableHeaderCell className="text-right">Nodes</TableHeaderCell>
              <TableHeaderCell className="text-right">Ver.</TableHeaderCell>
              <TableHeaderCell className="text-right">Actions</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {actions.flows.map((f) => {
              const b = statusBadge(f);
              return (
                <TableRow key={f.id}>
                  <TableCell>
                    <span className="font-medium text-foreground">{f.name}</span>{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {f.id}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {f.source}
                    {f.shadowsFile ? " (overrides file)" : ""}
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
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      <Link href={studioHref(f.id)} className={LINK_OUTLINE}>
                        {f.editable ? "Edit" : "Inspect"}
                      </Link>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void exportFlow(f.id)}
                        disabled={busyId === f.id}
                        title="Download the flow definition as JSON"
                      >
                        Export
                      </Button>
                      {actions.onlineEditing && f.source === "online" && f.editable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void deleteFlow(f.id)}
                          disabled={busyId === f.id}
                          className="text-red-600 dark:text-red-400"
                        >
                          Delete
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

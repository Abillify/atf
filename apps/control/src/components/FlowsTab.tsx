"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useState } from "react";
import { FlowEditor } from "./FlowEditor";
import { useFlows } from "../hooks/useFlows";
import { emptyFlow } from "../lib/flow-graph";
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
import type { FlowDetail, FlowListEntry } from "../types/flow";

export interface FlowsTabProps {
  token?: string;
  enabled?: boolean;
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

export function FlowsTab({
  token,
  enabled = true,
}: FlowsTabProps): React.JSX.Element {
  const actions = useFlows({
    enabled,
    ...(token !== undefined ? { token } : {}),
  });
  const [open, setOpen] = useState<FlowDetail | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const openFlow = async (id: string): Promise<void> => {
    setLoadingId(id);
    setErr(null);
    try {
      setOpen(await actions.get(id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "failed to load flow");
    } finally {
      setLoadingId(null);
    }
  };

  const newFlow = (): void => {
    const id = window.prompt("New flow id (lowercase, no spaces):")?.trim();
    if (!id) return;
    if (actions.flows.some((f) => f.id === id)) {
      setErr(`A flow with id "${id}" already exists.`);
      return;
    }
    setOpen({
      id,
      source: "online",
      editable: true,
      version: 0,
      published: null,
      draft: emptyFlow(id),
    });
  };

  if (open !== null) {
    return (
      <FlowEditor
        detail={open}
        actions={actions}
        onBack={() => setOpen(null)}
      />
    );
  }

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
            <Button variant="primary" size="sm" onClick={newFlow}>
              + New flow
            </Button>
          )}
        </div>
      </div>

      {!actions.onlineEditing && (
        <p className="rounded border border-dashed border-border bg-card p-3 text-xs text-muted-foreground">
          Online editing is disabled — flows are inspected read-only and
          validated. Set{" "}
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
              <TableHeaderCell className="text-right">Open</TableHeaderCell>
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void openFlow(f.id)}
                      disabled={loadingId === f.id}
                    >
                      {loadingId === f.id
                        ? "…"
                        : f.editable
                          ? "Edit"
                          : "Inspect"}
                    </Button>
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

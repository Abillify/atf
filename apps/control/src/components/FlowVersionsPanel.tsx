"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useEffect, useState, useCallback } from "react";
import type { FlowVersionEntry, FlowDiff } from "../types/flow";
import type { useFlows } from "../hooks/useFlows";
import {
  Button,
  Badge,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeaderCell,
  TableCell,
} from "../lib/ui";

export interface FlowVersionsPanelProps {
  flowId: string;
  editable: boolean;
  actions: ReturnType<typeof useFlows>;
  onClose: () => void;
  /** Called after a successful rollback so the editor can reload. */
  onRolledBack?: () => void;
}

/**
 * Version history + structural diff + rollback for an online flow. Completes
 * the "Quality CI/CD for prompts" loop in the UI: see exactly what changed
 * between two published versions (or published → draft) before rolling back.
 */
export function FlowVersionsPanel({
  flowId,
  editable,
  actions,
  onClose,
  onRolledBack,
}: FlowVersionsPanelProps): React.JSX.Element {
  const [versions, setVersions] = useState<FlowVersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<FlowDiff | null>(null);
  const [diffLabel, setDiffLabel] = useState<string>("");
  const [busy, setBusy] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setVersions(await actions.listVersions(flowId));
    setLoading(false);
  }, [actions, flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showDiff = async (from: number, to: number): Promise<void> => {
    setStatus(null);
    const res = await actions.diff(flowId, { from, to });
    if (res === null) {
      setStatus("Diff unavailable for these versions.");
      setDiff(null);
      return;
    }
    setDiff(res.diff);
    setDiffLabel(`v${from} → v${to}`);
  };

  const showDraftDiff = async (): Promise<void> => {
    setStatus(null);
    const res = await actions.diff(flowId, { draft: true });
    if (res === null) {
      setStatus("No draft to compare.");
      setDiff(null);
      return;
    }
    setDiff(res.diff);
    setDiffLabel("published → draft");
  };

  const doRollback = async (version: number): Promise<void> => {
    if (
      !window.confirm(
        `Roll back "${flowId}" to version ${version}? This publishes v${version} as live.`,
      )
    ) {
      return;
    }
    setBusy(version);
    setStatus(null);
    const ok = await actions.rollback(flowId, version);
    setBusy(null);
    if (ok) {
      setStatus(`Rolled back to v${version} — live now.`);
      await load();
      onRolledBack?.();
    } else {
      setStatus(`Rollback to v${version} failed.`);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="flow-versions-panel">
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          ← Editor
        </Button>
        <span className="text-sm font-semibold text-foreground">
          Version history{" "}
          <span className="font-mono text-muted-foreground">{flowId}</span>
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void showDraftDiff()}>
            Diff published → draft
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      {status && <div className="mt-2 text-xs text-muted-foreground">{status}</div>}

      <div className="mt-3 flex flex-1 gap-3 overflow-hidden">
        {/* Version list */}
        <div className="w-1/2 overflow-auto">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No published versions yet.
            </p>
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Ver.</TableHeaderCell>
                  <TableHeaderCell>Published</TableHeaderCell>
                  <TableHeaderCell className="text-right">
                    Actions
                  </TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {versions.map((v, i) => {
                  const prev = versions[i + 1];
                  return (
                    <TableRow key={v.version} className="align-top">
                      <TableCell className="font-mono tabular-nums">
                        v{v.version}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(v.publishedAt).toLocaleString()}
                        {v.publishedBy ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {v.publishedBy}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {prev !== undefined && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                void showDiff(prev.version, v.version)
                              }
                            >
                              Diff
                            </Button>
                          )}
                          {editable && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void doRollback(v.version)}
                              disabled={busy === v.version}
                            >
                              {busy === v.version ? "…" : "Rollback"}
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
        </div>

        {/* Diff viewer */}
        <div className="w-1/2 overflow-auto rounded-lg border border-border bg-card p-3">
          {diff === null ? (
            <p className="text-xs text-muted-foreground">
              Select <span className="font-medium">Diff</span> on a version to
              see what changed.
            </p>
          ) : (
            <FlowDiffView diff={diff} label={diffLabel} />
          )}
        </div>
      </div>
    </div>
  );
}

function FlowDiffView({
  diff,
  label,
}: {
  diff: FlowDiff;
  label: string;
}): React.JSX.Element {
  return (
    <div className="space-y-2 text-xs" data-testid="flow-diff">
      <div className="flex items-center gap-2">
        <span className="font-mono text-muted-foreground">{label}</span>
        <Badge variant={diff.changed ? "warning" : "success"}>
          {diff.summary}
        </Badge>
      </div>
      {!diff.changed ? (
        <p className="text-muted-foreground">No structural differences.</p>
      ) : (
        <>
          <DiffGroup
            title="Nodes"
            added={diff.nodes.added}
            removed={diff.nodes.removed}
            changed={diff.nodes.changed.map(
              (c) => `${c.id} (${c.changedFields.join(", ")})`,
            )}
          />
          <DiffGroup
            title="Edges"
            added={diff.edges.added}
            removed={diff.edges.removed}
            changed={diff.edges.changed.map(
              (c) => `${c.key} (${c.changedFields.join(", ")})`,
            )}
          />
          {diff.name && (
            <p>
              <span className="text-muted-foreground">name:</span>{" "}
              <span className="text-red-600 line-through">
                {diff.name.from}
              </span>{" "}
              → <span className="text-green-700">{diff.name.to}</span>
            </p>
          )}
          {diff.metadataChanged && (
            <p className="text-muted-foreground">metadata changed</p>
          )}
        </>
      )}
    </div>
  );
}

function DiffGroup({
  title,
  added,
  removed,
  changed,
}: {
  title: string;
  added: string[];
  removed: string[];
  changed: string[];
}): React.JSX.Element | null {
  if (added.length === 0 && removed.length === 0 && changed.length === 0)
    return null;
  return (
    <div>
      <div className="font-semibold text-foreground">{title}</div>
      {added.map((a) => (
        <div key={`a-${a}`} className="text-green-700">
          + {a}
        </div>
      ))}
      {removed.map((r) => (
        <div key={`r-${r}`} className="text-red-600">
          − {r}
        </div>
      ))}
      {changed.map((c) => (
        <div key={`c-${c}`} className="text-amber-700">
          ~ {c}
        </div>
      ))}
    </div>
  );
}

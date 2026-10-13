"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * The Studio's "Subflows" section: create a new sub-flow (from the selected
 * nodes, or with a first node) and include an existing sub-flow file. The
 * builder does the canvas work; files are written on save.
 *
 * Expanded (the sidebar's Subflows tab) every sub-flow file on disk is
 * listed as a card: drag it onto the canvas — or double-click / press
 * Include — to place it there. Collapsed (the classic palette rail) an
 * icon opens the include dialog instead.
 */

import { FilePlus2, FolderInput, RefreshCw, Search } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { Dialog } from "../lib/ui";
import { fetchSubflows, type SubflowInfo, subflowLabel, subflowPathFor } from "../lib/subflows";

/** dataTransfer payload of a sub-flow card dragged onto the canvas (the file path). */
export const SUBFLOW_DND_TYPE = "application/x-aiperator-subflow";

export interface SubflowActions {
  /** Nodes selected on the canvas (moved into a new sub-flow). */
  selectedCount: number;
  /** Sub-flow files already on the canvas. */
  included: string[];
  /** Includes a file; resolves to a status message. */
  onInclude: (path: string) => Promise<string>;
  /** Creates a sub-flow; returns an error message or null. */
  onCreate: (name: string) => string | null;
  token?: string | undefined;
}

function IncludeDialog({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: SubflowActions;
}): React.JSX.Element {
  const [list, setList] = useState<SubflowInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMessage(null);
    fetchSubflows(actions.token).then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [open, actions.token]);
  const query = q.trim().toLowerCase();
  const shown = (list ?? []).filter(
    (s) =>
      !query ||
      [s.path, s.name ?? "", s.description ?? "", ...s.nodeIds].some((t) => t.toLowerCase().includes(query)),
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Include a sub-flow"
      description="Its nodes and edges are placed on the canvas in their own box and stay in their file; saving adds the file to this flow's metadata.$include."
      className="max-w-2xl"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 rounded border border-border px-2 py-1">
          <Search size={12} aria-hidden className="text-muted-foreground" />
          <input
            aria-label="Search sub-flows"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by file, name, description or node id…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
          />
        </div>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        {message && <p className="text-xs text-subflow">{message}</p>}
        {list === null && !error && <p className="text-xs text-muted-foreground">Loading…</p>}
        {list !== null && list.length === 0 && (
          <p className="text-xs text-muted-foreground">No files in subflows/ yet — create one with “New subflow”.</p>
        )}
        <ul className="max-h-96 space-y-1.5 overflow-auto">
          {shown.map((s) => {
            const onCanvas = actions.included.includes(s.path);
            return (
              <li key={s.path} className="rounded border border-border p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-semibold text-foreground">📄 {subflowLabel(s.path)}</p>
                    {s.name && <p className="text-[11px] text-foreground">{s.name}</p>}
                    {s.description && (
                      <p className="line-clamp-2 text-[10px] text-muted-foreground" title={s.description}>
                        {s.description}
                      </p>
                    )}
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {s.nodeIds.length} node(s): <code>{s.nodeIds.slice(0, 6).join(", ")}{s.nodeIds.length > 6 ? ", …" : ""}</code>
                      {s.edgeCount > 0 ? ` · ${s.edgeCount} edge(s)` : ""}
                      {s.usedBy.length > 0 ? ` · used by ${s.usedBy.join(", ")}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={onCanvas || busy !== null}
                    onClick={() => {
                      setBusy(s.path);
                      setError(null);
                      actions.onInclude(s.path).then(
                        (msg) => {
                          setMessage(msg);
                          setBusy(null);
                        },
                        (e: unknown) => {
                          setError(e instanceof Error ? e.message : String(e));
                          setBusy(null);
                        },
                      );
                    }}
                    className="shrink-0 rounded bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  >
                    {onCanvas ? "On canvas" : busy === s.path ? "Including…" : "Include"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Dialog>
  );
}

export function SubflowPalette({
  actions,
  collapsed = false,
}: {
  actions: SubflowActions;
  collapsed?: boolean;
}): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [including, setIncluding] = useState(false);
  // The file list of the expanded section (the sidebar's Subflows tab).
  const [list, setList] = useState<SubflowInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const path = subflowPathFor(name);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadNonce is the reload button's trigger, not an input
  useEffect(() => {
    if (collapsed) return;
    setListError(null);
    fetchSubflows(actions.token).then(setList, (e: unknown) =>
      setListError(e instanceof Error ? e.message : String(e)),
    );
  }, [collapsed, actions.token, reloadNonce]);

  const include = (p: string): void => {
    setBusy(p);
    setError(null);
    actions.onInclude(p).then(
      (msg) => {
        setMessage(msg);
        setBusy(null);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(null);
      },
    );
  };

  const create = (): void => {
    const err = actions.onCreate(name);
    if (err) setError(err);
    else {
      setCreating(false);
      setName("");
      setError(null);
    }
  };

  const dialog = <IncludeDialog open={including} onClose={() => setIncluding(false)} actions={actions} />;

  if (collapsed) {
    return (
      <>
        <button
          type="button"
          onClick={() => setIncluding(true)}
          title="Include a sub-flow"
          aria-label="Include a sub-flow"
          className="flex h-8 w-8 items-center justify-center rounded-md border border-subflow-border bg-subflow-soft text-subflow hover:bg-subflow-soft dark:border-subflow-border dark:bg-subflow-soft dark:text-subflow"
        >
          <FolderInput size={15} aria-hidden />
        </button>
        {dialog}
      </>
    );
  }

  const query = q.trim().toLowerCase();
  const shown = (list ?? []).filter(
    (s) =>
      !query ||
      [s.path, s.name ?? "", s.description ?? "", ...s.nodeIds].some((t) =>
        t.toLowerCase().includes(query),
      ),
  );

  return (
    <section aria-label="Subflows" className="rounded-md border border-subflow-border bg-subflow-soft p-2 dark:border-subflow-border dark:bg-subflow-soft">
      <div className="mb-1.5 flex items-center gap-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-subflow">Subflows</p>
        <button
          type="button"
          onClick={() => setReloadNonce((n) => n + 1)}
          title="Reload the sub-flow list"
          aria-label="Reload the sub-flow list"
          className="ml-auto rounded p-0.5 text-subflow hover:bg-subflow-soft dark:text-subflow dark:hover:bg-subflow-solid-hover/40"
        >
          <RefreshCw size={12} aria-hidden />
        </button>
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => {
            setCreating((c) => !c);
            setError(null);
          }}
          aria-expanded={creating}
          className="flex flex-1 items-center justify-center gap-1 rounded border border-subflow-border bg-card px-1.5 py-1 text-[11px] font-medium text-subflow hover:bg-subflow-soft dark:border-subflow-border dark:text-subflow dark:hover:bg-subflow-solid-hover/40"
        >
          <FilePlus2 size={13} aria-hidden />
          New subflow
        </button>
      </div>
      {creating && (
        <div className="mt-2 space-y-1">
          <div className="flex gap-1">
            <input
              aria-label="New sub-flow name"
              value={name}
              // Focus on mount (the field only exists while creating): replaces
              // autoFocus, which Biome flags (WCAG 3.2.2).
              ref={(el) => el?.focus()}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
                if (e.key === "Escape") setCreating(false);
              }}
              placeholder="name, e.g. retrieval"
              className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-xs"
            />
            <button
              type="button"
              onClick={create}
              disabled={!path}
              className="rounded bg-subflow-solid px-2 py-1 text-[11px] font-medium text-on-solid hover:bg-subflow-solid-hover disabled:opacity-40"
            >
              Create
            </button>
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            {path ? <code>{path}</code> : "subflows/<name>.yaml"} —{" "}
            {actions.selectedCount > 0
              ? `the ${actions.selectedCount} selected node(s) move into it.`
              : "starts with one node; drop more nodes onto its box. Select nodes first to move them in."}
          </p>
          {error && <p role="alert" className="text-[10px] text-danger">{error}</p>}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1">
        <Search size={12} aria-hidden className="shrink-0 text-muted-foreground" />
        <input
          aria-label="Search sub-flows"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by file, name, description or node id…"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      </div>
      {message && <p className="mt-1.5 text-[10px] leading-snug text-subflow">{message}</p>}
      {listError && <p role="alert" className="mt-1.5 text-[10px] text-danger">{listError}</p>}
      {list === null && !listError && <p className="mt-1.5 text-[10px] text-muted-foreground">Loading…</p>}
      {list !== null && list.length === 0 && (
        <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
          No files in subflows/ yet — create one with “New subflow”.
        </p>
      )}
      {list !== null && list.length > 0 && shown.length === 0 && (
        <p className="mt-1.5 text-[10px] text-muted-foreground">No match.</p>
      )}
      <ul className="mt-1.5 max-h-72 space-y-1.5 overflow-auto pr-0.5">
        {shown.map((s) => {
          const onCanvas = actions.included.includes(s.path);
          return (
            <li
              key={s.path}
              draggable={!onCanvas && busy === null}
              onDragStart={(e) => {
                e.dataTransfer.setData(SUBFLOW_DND_TYPE, s.path);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDoubleClick={() => {
                if (!onCanvas && busy === null) include(s.path);
              }}
              title={
                onCanvas
                  ? "Already on the canvas."
                  : `${s.path} — drag onto the canvas, or double-click to include`
              }
              className={`rounded border border-border bg-card p-1.5 ${
                onCanvas ? "opacity-60" : "cursor-grab select-none transition-colors hover:border-subflow-border active:cursor-grabbing"
              }`}
            >
              <div className="flex items-start gap-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] font-semibold text-foreground">📄 {subflowLabel(s.path)}</p>
                  {s.name && <p className="truncate text-[10px] text-foreground">{s.name}</p>}
                  {s.description && (
                    <p className="line-clamp-2 text-[10px] leading-snug text-muted-foreground" title={s.description}>
                      {s.description}
                    </p>
                  )}
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={`${s.nodeIds.length} node(s): ${s.nodeIds.join(", ")}`}>
                    {s.nodeIds.length} node(s): <code>{s.nodeIds.slice(0, 4).join(", ")}{s.nodeIds.length > 4 ? ", …" : ""}</code>
                    {s.edgeCount > 0 ? ` · ${s.edgeCount} edge(s)` : ""}
                    {s.usedBy.length > 0 ? ` · used by ${s.usedBy.join(", ")}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={onCanvas || busy !== null}
                  onClick={() => include(s.path)}
                  className="shrink-0 rounded bg-subflow-solid px-1.5 py-0.5 text-[10px] font-medium text-on-solid hover:bg-subflow-solid-hover disabled:bg-muted disabled:text-muted-foreground"
                >
                  {onCanvas ? "On canvas" : busy === s.path ? "…" : "Include"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {dialog}
    </section>
  );
}

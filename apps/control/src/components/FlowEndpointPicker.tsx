"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowEndpointPicker — the searchable one-endpoint selector for the diff page.
 *
 * Like {@link FlowPicker}, flows are listed alphabetically and filtered by
 * name or id as you type. On top of that, when `showDrafts` is on, each flow's
 * named drafts appear grouped (indented) under it, so a draft can be picked as
 * the comparison endpoint directly — the selection is a (flowId, draftId?)
 * pair, where no draftId means "the flow's published (or file) definition".
 *
 * Keyboard: ↑/↓ to move, Enter to pick, Escape to close.
 */

import type React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, GitBranch, Search } from "lucide-react";
import { sortFlowsByName } from "../lib/flow-sort";
import { translate } from "../lib/i18n";

/** One selectable endpoint: a flow (published/file) or one of its drafts. */
export interface FlowEndpoint {
  flowId: string;
  /** Absent (or undefined) = the flow's published / file definition. */
  draftId?: string;
}

/** What the picker needs of a flow; `drafts` feeds the grouped draft rows. */
export interface FlowEndpointPickerFlow {
  id: string;
  name: string;
  source?: string;
  drafts?: { draftId: string; label: string }[];
}

export interface FlowEndpointPickerProps {
  flows: FlowEndpointPickerFlow[];
  value: FlowEndpoint | null;
  onChange: (endpoint: FlowEndpoint) => void;
  loading?: boolean;
  /** Show each flow's drafts, indented under it. */
  showDrafts?: boolean;
  /** Button text while nothing is selected. */
  placeholder?: string;
  /** Accessible name of the button. */
  ariaLabel: string;
  /** Width classes of the button (the list keeps at least 26rem). */
  className?: string;
  disabled?: boolean;
}

/** Stable key for an option — a flow and its drafts must not collide. */
function optionKey(e: FlowEndpoint): string {
  return e.draftId !== undefined ? `${e.flowId}\u0000${e.draftId}` : e.flowId;
}

interface PickerOption {
  key: string;
  endpoint: FlowEndpoint;
  name: string;
  flowId: string;
  isDraft: boolean;
  /** Draft rows are indented under their flow. */
  indent: boolean;
}

export function FlowEndpointPicker({
  flows,
  value,
  onChange,
  loading = false,
  showDrafts = false,
  placeholder = "— select flow —",
  ariaLabel,
  className = "w-104 max-w-full",
  disabled = false,
}: FlowEndpointPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Several pickers share a page — keep their option ids apart.
  const uid = useId();
  const listId = `flow-endpoint-picker-list${uid}`;

  const sorted = useMemo(() => sortFlowsByName(flows), [flows]);

  const selected =
    value !== null
      ? (() => {
          const flow = sorted.find((f) => f.id === value.flowId);
          const draft =
            value.draftId !== undefined
              ? flow?.drafts?.find((d) => d.draftId === value.draftId)
              : undefined;
          return { flow, draft };
        })()
      : null;

  // Flows matching the query, each followed (indented) by its drafts when
  // `showDrafts` is on. A draft whose own label matches pulls its flow in too.
  const options = useMemo<PickerOption[]>(() => {
    const q = query.trim().toLowerCase();
    const out: PickerOption[] = [];
    for (const f of sorted) {
      const flowMatches =
        !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q);
      const drafts = showDrafts ? (f.drafts ?? []) : [];
      const matchingDrafts = drafts.filter(
        (d) =>
          flowMatches ||
          d.label.toLowerCase().includes(q) ||
          d.draftId.toLowerCase().includes(q),
      );
      if (!flowMatches && matchingDrafts.length === 0) continue;
      out.push({
        key: optionKey({ flowId: f.id }),
        endpoint: { flowId: f.id },
        name: f.name,
        flowId: f.id,
        isDraft: false,
        indent: false,
      });
      for (const d of flowMatches ? drafts : matchingDrafts) {
        out.push({
          key: optionKey({ flowId: f.id, draftId: d.draftId }),
          endpoint: { flowId: f.id, draftId: d.draftId },
          name: d.label,
          flowId: f.id,
          isDraft: true,
          indent: true,
        });
      }
    }
    return out;
  }, [sorted, query, showDrafts]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openPicker = (): void => {
    setActive(Math.max(0, options.findIndex((o) => o.key === (value !== null ? optionKey(value) : ""))));
    setOpen(true);
  };

  const pick = (o: PickerOption | undefined): void => {
    if (o === undefined) return;
    setOpen(false);
    setQuery("");
    onChange(o.endpoint);
  };

  const selectedKey = value !== null ? optionKey(value) : "";

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-left text-xs hover:bg-muted disabled:opacity-50 ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected?.flow ? (
            <>
              {selected.flow.name}{" "}
              <span className="font-mono text-muted-foreground">({selected.flow.id})</span>
              {selected.draft !== undefined && (
                <span className="ml-1 inline-flex items-center gap-1 rounded bg-warning-soft px-1 text-[10px] text-warning">
                  <GitBranch size={9} aria-hidden />
                  {selected.draft.label}
                </span>
              )}
              {selected.flow.source !== undefined && (
                <span className="ml-1 shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                  {selected.flow.source}
                </span>
              )}
            </>
          ) : value !== null ? (
            <span className="font-mono">
              {value.flowId}
              {value.draftId !== undefined ? ` · ${value.draftId}` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        {loading && <span className="text-muted-foreground">{translate("flowEndpointPicker.loading")}</span>}
        <ChevronDown size={13} aria-hidden className="shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-104 max-w-[90vw] rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search size={13} aria-hidden className="text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(options.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  pick(options[active]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={translate("flowEndpointPicker.searchLengthFlowsByName", { length: flows.length })}
              aria-label={translate("flowEndpointPicker.ariaLabelSearchFlows", { ariaLabel })}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={`${listId}-${active}`}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
          </div>
          <div id={listId} role="listbox" className="max-h-80 overflow-auto py-1">
            {options.map((o, i) => (
              <div
                key={o.key}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={o.key === selectedKey}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
                className={`flex cursor-pointer items-center gap-2 py-1 pr-2 text-xs ${
                  o.indent ? "pl-7" : "pl-2"
                } ${i === active ? "bg-muted" : ""} ${
                  o.key === selectedKey ? "font-medium" : ""
                }`}
              >
                {o.isDraft ? (
                  <>
                    <GitBranch
                      size={11}
                      aria-hidden
                      className="shrink-0 text-warning"
                    />
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <span className="shrink-0 rounded bg-warning-soft px-1 text-[10px] text-warning">
                      draft
                    </span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {o.flowId}
                    </span>
                    {o.flowId === value?.flowId && value.draftId === undefined && (
                      <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                        published
                      </span>
                    )}
                  </>
                )}
              </div>
            ))}
            {options.length === 0 && query && (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                {translate("flowEndpointPicker.noFlowMatchesQuery", { query })}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowPicker — the searchable flow selector used wherever one flow is chosen
 * (Studio header, Optimizer, Autopilot, Security, metrics filter).
 *
 * A native <select> with two dozen long German flow names is hard to scan; this
 * lists flows alphabetically and filters by name or id as you type. Keyboard:
 * ↑/↓ to move, Enter to pick, Escape to close. An optional first entry stands
 * for the empty value "" — "+ New flow" in the Studio, "All flows" in a filter.
 */

import type React from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { sortFlowsByName } from "../lib/flow-sort";
import { translate } from "../lib/i18n";

const EMPTY = "";

/** What the picker needs of a flow; `source`/`hasDraft` add the Studio's badges. */
export interface FlowPickerFlow {
  id: string;
  name: string;
  source?: string;
  hasDraft?: boolean;
}

export interface FlowPickerProps {
  flows: FlowPickerFlow[];
  /** Selected flow id, or "" for none / the empty option. */
  value: string;
  onChange: (flowId: string) => void;
  loading?: boolean;
  /** Label of a first entry that picks "" (e.g. "+ New flow", "All flows"). Omitted: no such entry. */
  emptyOption?: string;
  /** Button text while `value` is "". */
  placeholder?: string;
  /** Accessible name of the button. */
  ariaLabel?: string;
  /** Width classes of the button (the list keeps at least 26rem). */
  className?: string;
  disabled?: boolean;
}

export function FlowPicker({
  flows,
  value,
  onChange,
  loading = false,
  emptyOption,
  placeholder = "— select flow —",
  ariaLabel = "Select flow",
  className = "w-[26rem] max-w-full",
  disabled = false,
}: FlowPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Several pickers can share a page — keep their option ids apart.
  const uid = useId();
  const listId = `flow-picker-list${uid}`;

  const selected = flows.find((f) => f.id === value);

  // Alphabetical by name (then id), case-insensitive, numbers in order.
  const sorted = useMemo(() => sortFlowsByName(flows), [flows]);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = sorted.filter(
      (f) => !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
    );
    return [
      ...(emptyOption !== undefined
        ? [{ id: EMPTY, name: emptyOption, entry: undefined as FlowPickerFlow | undefined }]
        : []),
      ...matches.map((f) => ({ id: f.id, name: f.name, entry: f as FlowPickerFlow | undefined })),
    ];
  }, [sorted, query, emptyOption]);
  const offset = emptyOption !== undefined ? 1 : 0;

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
    // Start on the current selection (after the empty entry, when there is one).
    setActive(Math.max(0, sorted.findIndex((f) => f.id === value) + offset));
    setOpen(true);
  };

  const pick = (id: string): void => {
    setOpen(false);
    setQuery("");
    onChange(id);
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-left text-xs hover:bg-muted disabled:opacity-50 ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              {selected.name} <span className="font-mono text-muted-foreground">({selected.id})</span>
            </>
          ) : value ? (
            <span className="font-mono">{value}</span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        {loading && <span className="text-muted-foreground">{translate("flowPicker.loading")}</span>}
        <ChevronDown size={13} aria-hidden className="shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[26rem] max-w-[90vw] rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search size={13} aria-hidden className="text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                // While searching, Enter takes the first match, not the empty entry.
                setActive(e.target.value.trim() ? offset : 0);
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
                  const o = options[active];
                  if (o) pick(o.id);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={translate("flowPicker.searchLengthFlowsByName", { length: flows.length })}
              aria-label={translate("flowPicker.searchFlows")}
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
                key={o.id || "__empty"}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={o.id === value}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o.id);
                }}
                className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-xs ${
                  i === active ? "bg-muted" : ""
                } ${o.id === value ? "font-medium" : ""}`}
              >
                {o.entry ? (
                  <>
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{o.id}</span>
                    {o.entry.hasDraft && (
                      <span className="shrink-0 rounded bg-warning-soft px-1 text-[10px] text-warning">draft</span>
                    )}
                    {o.entry.source !== undefined && (
                      <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                        {o.entry.source}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground">{o.name}</span>
                )}
              </div>
            ))}
            {options.length === offset && query && (
              <p className="px-2 py-2 text-xs text-muted-foreground">{translate("flowPicker.noFlowMatchesQuery", { query })}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * FlowPicker — searchable flow selector for the Studio header.
 *
 * A native <select> with two dozen long German flow names is hard to scan; this
 * filters by name or id as you type. Keyboard: ↑/↓ to move, Enter to pick,
 * Escape to close. The first entry starts a new flow.
 */

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { FlowListEntry } from "../types/flow";

const NEW_FLOW = "";

export function FlowPicker({
  flows,
  value,
  onChange,
  loading = false,
}: {
  flows: FlowListEntry[];
  /** Selected flow id, or "" for a new flow. */
  value: string;
  onChange: (flowId: string) => void;
  loading?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = flows.find((f) => f.id === value);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = flows.filter(
      (f) => !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
    );
    return [
      { id: NEW_FLOW, name: "New flow", entry: undefined as FlowListEntry | undefined },
      ...matches.map((f) => ({ id: f.id, name: f.name, entry: f })),
    ];
  }, [flows, query]);

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
    // Start on the current selection (index 0 is "New flow").
    setActive(Math.max(0, flows.findIndex((f) => f.id === value) + 1));
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
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select flow to edit in Builder"
        className="flex w-[26rem] max-w-full items-center gap-2 rounded border border-border bg-card px-2 py-1 text-left text-xs hover:bg-muted"
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              {selected.name} <span className="font-mono text-muted-foreground">({selected.id})</span>
            </>
          ) : value ? (
            <span className="font-mono">{value}</span>
          ) : (
            <span className="text-muted-foreground">— new flow —</span>
          )}
        </span>
        {loading && <span className="text-muted-foreground">loading…</span>}
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
                  const o = options[active];
                  if (o) pick(o.id);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder={`Search ${flows.length} flows by name or id…`}
              aria-label="Search flows"
              role="combobox"
              aria-expanded
              aria-controls="flow-picker-list"
              aria-activedescendant={`flow-option-${active}`}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
          </div>
          <div id="flow-picker-list" role="listbox" className="max-h-80 overflow-auto py-1">
            {options.map((o, i) => (
              <div
                key={o.id || "__new"}
                id={`flow-option-${i}`}
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
                      <span className="shrink-0 rounded bg-amber-50 px-1 text-[10px] text-amber-700">draft</span>
                    )}
                    <span className="shrink-0 rounded bg-muted px-1 text-[10px] uppercase text-muted-foreground">
                      {o.entry.source}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">+ New flow</span>
                )}
              </div>
            ))}
            {options.length === 1 && query && (
              <p className="px-2 py-2 text-xs text-muted-foreground">No flow matches “{query}”.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

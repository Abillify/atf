"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";

export interface FlowMultiSelectProps {
  label: string;
  options: string[];
  value: string[];
  onChange: (flows: string[]) => void;
}

/** Compact checkbox-based multi-select used by Live Graph and History. */
export function FlowMultiSelect({
  label,
  options,
  value,
  onChange,
}: FlowMultiSelectProps): React.JSX.Element {
  const selected = new Set(value);
  const toggle = (flow: string): void => {
    onChange(
      selected.has(flow)
        ? value.filter((item) => item !== flow)
        : [...value, flow],
    );
  };

  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground">
        {label}{value.length > 0 ? ` (${value.length})` : ""}
      </summary>
      <div className="absolute left-0 z-30 mt-1 max-h-56 min-w-52 overflow-y-auto rounded-md border border-border bg-card p-2 shadow-lg">
        {options.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">Keine Flows verfügbar</p>
        ) : (
          options.map((flow) => (
            <label key={flow} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs text-foreground hover:bg-muted">
              <input
                type="checkbox"
                checked={selected.has(flow)}
                onChange={() => toggle(flow)}
              />
              <span className="truncate">{flow}</span>
            </label>
          ))
        )}
        {value.length > 0 && (
          <button
            type="button"
            className="mt-1 w-full border-t border-border px-1 pt-2 text-left text-xs text-accent"
            onClick={() => onChange([])}
          >
            Auswahl löschen
          </button>
        )}
      </div>
    </details>
  );
}

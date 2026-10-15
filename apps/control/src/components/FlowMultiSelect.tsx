"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useMemo, useState } from "react";
import { sortFlowsByName } from "../lib/flow-sort";
import { translate } from "../lib/i18n";

export interface FlowMultiSelectProps {
  label: string;
  /** Flow ids. */
  options: string[];
  value: string[];
  onChange: (flows: string[]) => void;
  /** Flow names by id — listed and searched by name when known. */
  names?: ReadonlyMap<string, string>;
}

/**
 * Compact checkbox-based multi-select used by Live Graph, History and Eval —
 * sorted and searchable by name or id like the single-flow FlowPicker.
 */
export function FlowMultiSelect({
  label,
  options,
  value,
  onChange,
  names,
}: FlowMultiSelectProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortFlowsByName(options.map((id) => ({ id, name: names?.get(id) ?? id }))).filter(
      (f) => !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q),
    );
  }, [options, names, query]);
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
        {options.length > 0 && (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={translate("flowMultiSelect.searchByNameOrId")}
            aria-label={translate("flowMultiSelect.labelSearchFlows", { label })}
            className="mb-1 w-full rounded border border-border bg-background px-1.5 py-1 text-xs outline-none"
          />
        )}
        {options.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{translate("flowMultiSelect.keineFlowsVerfuGbar")}</p>
        ) : listed.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{translate("flowMultiSelect.noFlowMatchesQuery", { query })}</p>
        ) : (
          listed.map((flow) => (
            <label key={flow.id} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs text-foreground hover:bg-muted">
              <input
                type="checkbox"
                checked={selected.has(flow.id)}
                onChange={() => toggle(flow.id)}
              />
              <span className="min-w-0 flex-1 truncate">{flow.name}</span>
              {flow.name !== flow.id && (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{flow.id}</span>
              )}
            </label>
          ))
        )}
        {value.length > 0 && (
          <button
            type="button"
            className="mt-1 w-full border-t border-border px-1 pt-2 text-left text-xs text-accent"
            onClick={() => onChange([])}
          >
            {translate("flowMultiSelect.auswahlLoSchen")}
          </button>
        )}
      </div>
    </details>
  );
}

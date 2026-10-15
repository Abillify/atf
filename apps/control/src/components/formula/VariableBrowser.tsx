"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: variable browser (type icons, symbol row, collapsible, search),
// moved out of FormulaEditor.tsx without behavior change.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Hash,
  List,
  Search,
  Sigma,
  ToggleLeft,
  Type,
} from "lucide-react";
import {
  getPath,
  symbolType,
  type FormulaGroup,
  type FormulaKind,
  type FormulaSymbol,
} from "../../lib/formula";
import { snippet } from "./formulaUtils";
import { translate } from "../../lib/i18n";

const TYPE_ICON: Record<ReturnType<typeof symbolType>, React.ComponentType<{ size?: number; className?: string }>> = {
  text: Type,
  number: Hash,
  boolean: ToggleLeft,
  list: List,
  object: Braces,
  function: Sigma,
};

function SymbolRow({
  sym,
  kind,
  onPick,
  compact,
  value,
}: {
  /** Sample value from the pinned run, if any. */
  value?: unknown;
  sym: FormulaSymbol;
  kind: FormulaKind;
  onPick: (text: string, symbol: FormulaSymbol) => void;
  compact: boolean;
}): React.JSX.Element {
  const Icon = TYPE_ICON[symbolType(sym)];
  const shown = sym.label ?? sym.insert ?? snippet(sym.path, kind);
  if (sym.unavailable !== undefined && sym.path.endsWith(".none")) {
    // Placeholder row of an empty group: just the explanation.
    return <p className="px-1.5 py-1 text-[10px] italic text-muted-foreground">{sym.unavailable}</p>;
  }
  return (
    <button
      type="button"
      disabled={sym.unavailable !== undefined}
      title={sym.unavailable ?? sym.description}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(sym.insert ?? snippet(sym.path, kind), sym)}
      className="flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <Icon size={12} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <code className="block truncate font-mono text-[11px] text-foreground">{shown}</code>
        {value !== undefined && typeof value !== "object" && !sym.path.startsWith("vars.") && !sym.path.startsWith("const.") && !sym.path.startsWith("env.") && (
          <span className="block truncate font-mono text-[10px] text-success" title={translate("variableBrowser.valueInThePinnedRun")}>
            📌 {JSON.stringify(value)}
          </span>
        )}
        {(!compact || sym.insert !== undefined) && (sym.unavailable ?? sym.description) && (
          <span className="block truncate text-[10px] text-muted-foreground">{sym.unavailable ?? sym.description}</span>
        )}
      </span>
    </button>
  );
}

function Collapsible({
  title,
  count,
  hint,
  open,
  onToggle,
  level,
  children,
}: {
  title: string;
  count: number;
  hint?: string | undefined;
  open: boolean;
  onToggle: () => void;
  level: 0 | 1;
  children: React.ReactNode;
}): React.JSX.Element {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className={level === 1 ? "ml-3" : "mb-1"}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full items-center gap-1 rounded px-1 py-1 text-left hover:bg-muted ${
          level === 0
            ? "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            : "font-mono text-[11px] font-medium text-foreground"
        }`}
      >
        <Chevron size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="text-[10px] font-normal text-muted-foreground">{count}</span>
      </button>
      {open && (
        <div>
          {hint && level === 0 && <p className="ml-5 mb-0.5 text-[10px] text-muted-foreground">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The data context as a tree: groups (Flow variables, Constants, Node results,
 * …), optional sub-sections (the node a field belongs to), and entries with a
 * type icon. Unavailable entries stay visible, disabled, with the reason.
 * Searching filters and expands everything.
 */
export function VariableBrowser({
  groups,
  kind,
  onPick,
  autoFocus = false,
  compact = false,
  emptyText,
  sample,
}: {
  /** Pinned/sample values, shown next to the entries they fill. */
  sample?: Record<string, unknown> | undefined;
  groups: FormulaGroup[];
  /** Shown when there is nothing to offer at all. */
  emptyText?: string;
  kind: FormulaKind;
  /** Receives the ready-to-insert text (and the picked entry). */
  onPick: (text: string, symbol: FormulaSymbol) => void;
  autoFocus?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);
  const query = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      symbols: g.symbols.filter(
        (s) =>
          !query ||
          (!s.path.endsWith(".none") &&
            [s.path, s.label ?? "", s.insert ?? "", s.description, s.section ?? ""].some((t) =>
              t.toLowerCase().includes(query),
            )),
      ),
    }))
    .filter((g) => g.symbols.length > 0);
  // Groups with usable entries start open; searching opens everything.
  const isOpen = (key: string, usable: boolean): boolean => (query ? true : (toggled[key] ?? usable));
  const toggle = (key: string, usable: boolean): void =>
    setToggled((t) => ({ ...t, [key]: !(t[key] ?? usable) }));

  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1">
        <Search size={12} aria-hidden className="text-muted-foreground" />
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={translate("variableBrowser.searchVariablesFieldsFunctions")}
          aria-label={translate("variableBrowser.searchVariables")}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      </div>
      <div className={`min-h-0 overflow-auto ${compact ? "max-h-64" : "flex-1"}`}>
        {filtered.map((g) => {
          const usable = g.symbols.some((s) => s.unavailable === undefined);
          const sections = [...new Set(g.symbols.map((s) => s.section ?? ""))];
          return (
            <Collapsible
              key={g.title}
              title={g.title}
              count={g.symbols.filter((s) => !s.path.endsWith(".none")).length}
              hint={g.hint}
              open={isOpen(g.title, usable)}
              onToggle={() => toggle(g.title, usable)}
              level={0}
            >
              {sections.map((sec) => {
                const rows = g.symbols
                  .filter((s) => (s.section ?? "") === sec)
                  .map((s) => (
                    <SymbolRow
                      key={s.path}
                      sym={s}
                      kind={kind}
                      onPick={onPick}
                      compact={compact}
                      value={sample ? getPath(sample, s.path) : undefined}
                    />
                  ));
                if (sec === "") return <div key="-" className="ml-3">{rows}</div>;
                const key = `${g.title}/${sec}`;
                return (
                  <Collapsible
                    key={key}
                    title={sec}
                    count={rows.length}
                    open={isOpen(key, false)}
                    onToggle={() => toggle(key, false)}
                    level={1}
                  >
                    <div className="ml-3">{rows}</div>
                  </Collapsible>
                );
              })}
            </Collapsible>
          );
        })}
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {groups.length === 0 ? (emptyText ?? translate("variableBrowser.nothingToInsertHere")) : translate("variableBrowser.noMatch")}
          </p>
        )}
      </div>
    </div>
  );
}

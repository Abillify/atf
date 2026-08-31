"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, type LucideIcon } from "lucide-react";
import { useModalBehavior, usePresence } from "./useModalBehavior";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  icon?: LucideIcon;
  /** Extra searchable text (not displayed). */
  keywords?: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
  onSelect: (item: CommandItem) => void;
  placeholder?: string;
}

/** Case-insensitive substring score; lower is better. -1 = no match. */
function score(item: CommandItem, q: string): number {
  if (q === "") return 0;
  const hay = `${item.label} ${item.hint ?? ""} ${item.group ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  const label = item.label.toLowerCase();
  const i = hay.indexOf(q);
  if (i === -1) return -1;
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  return 2 + i / 1000;
}

/**
 * ⌘K command palette: fuzzy-search launcher over a set of destinations/actions.
 * Real focus trap + scroll-lock + Escape (via useModalBehavior), enter/exit
 * animation (reduced-motion aware), and ARIA combobox/listbox semantics with
 * `aria-activedescendant` for screen-reader-announced keyboard navigation.
 * See UI-STYLE-GUIDE.md §8.
 */
export function CommandPalette({
  open,
  onClose,
  items,
  onSelect,
  placeholder = "Search pages…",
}: CommandPaletteProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { mounted, visible } = usePresence(open);

  useModalBehavior({
    open,
    onClose,
    containerRef: panelRef,
    initialFocusRef: inputRef,
  });

  // Reset query/selection whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .map((item) => ({ item, s: score(item, q) }))
      .filter((r) => r.s >= 0)
      .sort((a, b) => a.s - b.s || a.item.label.localeCompare(b.item.label))
      .map((r) => r.item);
  }, [items, query]);

  // Keep the active index in range as results change.
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)));
  }, [results.length]);

  // Group the (already ranked) results for display, preserving encounter order.
  const grouped = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, { item: CommandItem; index: number }[]>();
    results.forEach((item, index) => {
      const g = item.group ?? "";
      if (!byGroup.has(g)) {
        byGroup.set(g, []);
        order.push(g);
      }
      byGroup.get(g)!.push({ item, index });
    });
    return order.map((g) => ({ group: g, entries: byGroup.get(g)! }));
  }, [results]);

  const optionId = (i: number) => `${listId}-opt-${i}`;

  const commit = (item: CommandItem | undefined) => {
    if (item === undefined) return;
    onSelect(item);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length === 0 ? 0 : (a + 1) % results.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) =>
        results.length === 0 ? 0 : (a - 1 + results.length) % results.length,
      );
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(results[active]);
    }
  };

  // Scroll the active option into view on keyboard navigation.
  useEffect(() => {
    if (!mounted) return;
    const el = panelRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(optionId(active))}`,
    );
    if (typeof el?.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mounted]);

  if (!mounted) return null;

  return (
    <div
      className={[
        "fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh] bg-black/50",
        "transition-opacity duration-150 motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
      ].join(" ")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={[
          "w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl",
          "transition duration-150 motion-reduce:transition-none",
          visible ? "scale-100 opacity-100" : "scale-95 opacity-0",
        ].join(" ")}
      >
        {/* Search input (combobox) */}
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              results.length > 0 ? optionId(active) : undefined
            }
            aria-label={placeholder}
            placeholder={placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block">
            Esc
          </kbd>
        </div>

        {/* Results (listbox) */}
        <ul
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-[50vh] overflow-y-auto p-2"
        >
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches for “{query}”.
            </li>
          ) : (
            grouped.map(({ group, entries }) => (
              <li key={group || "_"}>
                {group && (
                  <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group}
                  </p>
                )}
                <ul role="presentation">
                  {entries.map(({ item, index }) => {
                    const Icon = item.icon;
                    const isActive = index === active;
                    return (
                      <li
                        key={item.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isActive}
                        onClick={() => commit(item)}
                        onMouseMove={() => setActive(index)}
                        className={[
                          "flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-foreground",
                        ].join(" ")}
                      >
                        {Icon && (
                          <Icon
                            className={[
                              "h-4 w-4 shrink-0",
                              isActive
                                ? "text-accent-foreground"
                                : "text-muted-foreground",
                            ].join(" ")}
                            aria-hidden="true"
                          />
                        )}
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.hint && (
                          <span
                            className={[
                              "hidden truncate text-xs sm:block",
                              isActive
                                ? "text-accent-foreground/80"
                                : "text-muted-foreground",
                            ].join(" ")}
                          >
                            {item.hint}
                          </span>
                        )}
                        {isActive && (
                          <CornerDownLeft
                            className="h-3.5 w-3.5 shrink-0 text-accent-foreground/80"
                            aria-hidden="true"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

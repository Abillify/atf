"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useMemo, useState } from "react";
import { Check, Search } from "lucide-react";
import { translate } from "../lib/i18n";

export interface UserSelectFilterProps {
  label: string;
  /** Distinct user names offered by the history facets. */
  options: string[];
  /** Currently selected user name ("" = all users). */
  value: string;
  onChange: (userName: string) => void;
}

/**
 * Compact searchable single-select for the user filter, used by the History
 * and Live Graph filter popovers. The search box narrows the option list
 * (case-insensitive substring on the display name); selecting a user applies
 * the exact facet value so it matches the runtime's `user` filter.
 */
export function UserSelectFilter({
  label,
  options,
  value,
  onChange,
}: UserSelectFilterProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...options]
      .sort((a, b) => a.localeCompare(b))
      .filter((u) => !q || u.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="relative">
        <Search
          size={12}
          aria-hidden
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={translate("userSelectFilter.userSuchen")}
          aria-label={translate("userSelectFilter.labelUserSuchen", { label })}
          className="w-full rounded border border-border bg-background py-1 pl-6 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-accent"
        />
      </div>
      <div className="max-h-40 overflow-y-auto rounded border border-border">
        <button
          type="button"
          onClick={() => onChange("")}
          aria-pressed={value === ""}
          className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted ${
            value === "" ? "text-accent" : "text-foreground"
          }`}
        >
          <Check
            size={12}
            aria-hidden
            className={value === "" ? "opacity-100" : "opacity-0"}
          />
          {translate("userSelectFilter.alleBenutzer")}
        </button>
        {options.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {translate("userSelectFilter.keineUsersVerfuGbar")}
          </p>
        ) : listed.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {translate("userSelectFilter.keinUserPasstZuQuery", { query })}
          </p>
        ) : (
          listed.map((user) => (
            <button
              key={user}
              type="button"
              onClick={() => onChange(user)}
              aria-pressed={user === value}
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted ${
                user === value ? "text-accent" : "text-foreground"
              }`}
            >
              <Check
                size={12}
                aria-hidden
                className={user === value ? "opacity-100" : "opacity-0"}
              />
              <span className="min-w-0 flex-1 truncate">{user}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

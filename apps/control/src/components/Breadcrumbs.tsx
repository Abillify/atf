"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import { ChevronRight } from "lucide-react";
import { matchNavItem } from "../lib/nav";

export interface Crumb {
  label: string;
  current?: boolean;
}

/** Derives breadcrumb trail ("Group ▸ Page") from a pathname + nav metadata. */
export function buildBreadcrumbs(pathname: string): Crumb[] {
  const match = matchNavItem(pathname);
  if (!match) return [];
  return [{ label: match.group }, { label: match.label, current: true }];
}

/**
 * Compact contextual breadcrumb bar. Renders the current destination's group
 * and page from the shared nav metadata, so it never drifts from the sidebar.
 */
export function Breadcrumbs({
  pathname,
  className = "",
}: {
  pathname: string;
  className?: string;
}): React.JSX.Element | null {
  const crumbs = buildBreadcrumbs(pathname);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 && (
              <li aria-hidden="true">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </li>
            )}
            <li
              className={
                c.current
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              }
              {...(c.current ? { "aria-current": "page" as const } : {})}
            >
              {c.label}
            </li>
          </React.Fragment>
        ))}
      </ol>
    </nav>
  );
}

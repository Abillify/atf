"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";
import { ChevronRight } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { MessageKey } from "../lib/i18n";
import { matchNavItem } from "../lib/nav";

export interface Crumb {
  /** i18n key for the crumb's display label (Req 9.7). */
  labelKey: MessageKey;
  current?: boolean;
}

/** Derives breadcrumb trail ("Group ▸ Page") from a pathname + nav metadata. */
export function buildBreadcrumbs(pathname: string): Crumb[] {
  const match = matchNavItem(pathname);
  if (!match) return [];
  return [
    { labelKey: match.groupKey },
    { labelKey: match.labelKey, current: true },
  ];
}

/**
 * Compact contextual breadcrumb bar. Renders the current destination's group
 * and page from the shared nav metadata, so it never drifts from the sidebar.
 * Labels resolve through the i18n layer (Req 9.7).
 */
export function Breadcrumbs({
  pathname,
  className = "",
}: {
  pathname: string;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const crumbs = buildBreadcrumbs(pathname);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={t("chrome.breadcrumb")} className={className}>
      <ol className="flex items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the same label can appear twice in a path, so the position disambiguates; crumbs are rebuilt atomically
          <React.Fragment key={`${c.labelKey}-${i}`}>
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
              {t(c.labelKey)}
            </li>
          </React.Fragment>
        ))}
      </ol>
    </nav>
  );
}

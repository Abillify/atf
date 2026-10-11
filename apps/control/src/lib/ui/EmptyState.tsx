"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * EmptyState — design-system primitive for "no data yet" surfaces (Req 9.9).
 *
 * Every list/monitoring surface renders the same dashed card when its data
 * set is empty: an optional icon, a title, an optional explanation, and an
 * optional call-to-action. Consolidates the ad-hoc empty divs the routes had
 * grown individually; token classes only (UI-STYLE-GUIDE.md §3/§9).
 */

import type React from "react";
import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  /** Optional lucide icon rendered in a muted circle above the title. */
  icon?: LucideIcon;
  /** Primary line — what is missing. */
  title: string;
  /** Optional secondary line — why it is empty or what fills it. */
  description?: string;
  /** Optional call-to-action (Button/Link) below the text. */
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps): React.JSX.Element {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center rounded-lg",
        "border border-dashed border-border bg-card px-6 py-12 text-center",
        className,
      ].join(" ")}
    >
      {Icon && (
        <div
          aria-hidden
          className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          <Icon size={22} />
        </div>
      )}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex items-center gap-2">{action}</div>}
    </div>
  );
}

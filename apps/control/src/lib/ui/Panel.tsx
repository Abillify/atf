"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";

export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  as?: React.ElementType;
  /** Optional heading shown at the top of the panel */
  heading?: React.ReactNode;
  /** Optional accessible label — defaults to heading text if heading is a string */
  "aria-label"?: string;
}

export function Panel({
  as: As = "section",
  heading,
  className = "",
  children,
  "aria-label": ariaLabel,
  ...props
}: PanelProps): React.JSX.Element {
  const label =
    ariaLabel ?? (typeof heading === "string" ? heading : undefined);

  return (
    <As
      aria-label={label}
      className={[
        "rounded-lg border border-border bg-card text-card-foreground",
        "flex flex-col overflow-hidden",
        className,
      ].join(" ")}
      {...props}
    >
      {heading !== undefined && (
        <div className="border-b border-border px-[var(--ui-card-p)] py-[var(--ui-cell-py)]">
          {typeof heading === "string" ? (
            <h2 className="text-sm font-semibold text-foreground">{heading}</h2>
          ) : (
            heading
          )}
        </div>
      )}
      <div className="flex-1 overflow-auto p-[var(--ui-card-p)]">{children}</div>
    </As>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";

export type BadgeVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline"
  | "success"
  | "warning";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: "bg-accent text-accent-foreground",
  secondary: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive text-destructive-foreground",
  outline: "border border-border bg-transparent text-foreground",
  // Labels are 12px, so the text needs body-text contrast. A translucent
  // `*-solid/20` fill is not an approved surface (UI-STYLE-GUIDE.md §3) and
  // dropped `text-success` to 3.6:1; the `*-soft` slot is the theme-aware
  // surface designed for this and clears 4.5:1 in light and dark.
  success: "bg-success-soft text-success border border-success-border",
  warning: "bg-warning-soft text-warning border border-warning-border",
};

export function Badge({
  variant = "default",
  className = "",
  children,
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <span
      role="status"
      className={[
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </span>
  );
}

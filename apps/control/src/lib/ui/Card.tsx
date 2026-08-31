"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Removes default padding */
  noPadding?: boolean;
}

export function Card({
  noPadding = false,
  className = "",
  children,
  ...props
}: CardProps): React.JSX.Element {
  return (
    <div
      role="region"
      className={[
        "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
        noPadding ? "" : "p-[var(--ui-card-p)]",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export function CardHeader({
  className = "",
  children,
  ...props
}: CardHeaderProps): React.JSX.Element {
  return (
    <div
      className={["mb-3 flex flex-col gap-1", className].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardTitleProps
  extends React.HTMLAttributes<HTMLHeadingElement> {}

export function CardTitle({
  className = "",
  children,
  ...props
}: CardTitleProps): React.JSX.Element {
  return (
    <h3
      className={[
        "text-base font-semibold leading-none tracking-tight",
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </h3>
  );
}

export interface CardContentProps
  extends React.HTMLAttributes<HTMLDivElement> {}

export function CardContent({
  className = "",
  children,
  ...props
}: CardContentProps): React.JSX.Element {
  return (
    <div className={className} {...props}>
      {children}
    </div>
  );
}

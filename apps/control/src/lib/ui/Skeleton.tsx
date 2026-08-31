"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React from "react";

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Explicit width (e.g. "w-32") — defaults to w-full */
  width?: string;
  /** Explicit height (e.g. "h-4") — defaults to h-4 */
  height?: string;
  /** Render as a circle (useful for avatars) */
  circle?: boolean;
}

export function Skeleton({
  width,
  height,
  circle = false,
  className = "",
  ...props
}: SkeletonProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Loading…"
      aria-busy="true"
      className={[
        "animate-pulse bg-muted motion-reduce:animate-none",
        circle ? "rounded-full" : "rounded-md",
        width ?? "w-full",
        height ?? "h-4",
        className,
      ].join(" ")}
      {...props}
    />
  );
}

/** Convenience: a block of stacked skeleton lines */
export interface SkeletonBlockProps {
  lines?: number;
  className?: string;
}

export function SkeletonBlock({
  lines = 3,
  className = "",
}: SkeletonBlockProps): React.JSX.Element {
  return (
    <div className={["flex flex-col gap-2", className].join(" ")}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? "w-3/4" : "w-full"} />
      ))}
    </div>
  );
}

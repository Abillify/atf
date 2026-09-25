"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { Check } from "lucide-react";

/**
 * Show/hide switch for a layout panel. Renders as a checkbox-style chip so the
 * current state is visible at a glance (not just a hover tint), with a tooltip
 * that names the action a click performs.
 */
export function PanelToggle({
  label,
  icon,
  on,
  onToggle,
  what,
  disabled = false,
}: {
  label: string;
  icon: React.ReactNode;
  on: boolean;
  onToggle: () => void;
  /** Longer description of the panel for the tooltip, e.g. "the node palette". */
  what: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      disabled={disabled}
      title={`${on ? "Hide" : "Show"} ${what}`}
      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
        on
          ? "border-border bg-muted text-foreground"
          : "border-dashed border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      <span
        aria-hidden
        className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
          on ? "border-foreground/60 bg-foreground/80 text-background" : "border-muted-foreground/60"
        }`}
      >
        {on && <Check size={10} strokeWidth={3} />}
      </span>
      <span aria-hidden className="flex items-center">
        {icon}
      </span>
      {label}
    </button>
  );
}

/** Small caption in front of a group of PanelToggles. */
export function PanelToggleGroup({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
      <legend className="sr-only">{caption}</legend>
      <span
        aria-hidden
        className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        {caption}
      </span>
      {children}
    </fieldset>
  );
}

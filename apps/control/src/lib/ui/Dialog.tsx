"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import { useId, useRef } from "react";
import { useModalBehavior, usePresence } from "./useModalBehavior";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  /** Additional class for the dialog panel */
  className?: string;
}

/**
 * Modal dialog with a real `Tab` focus trap, background scroll-lock,
 * `Escape`-to-close, backdrop-click close, focus restoration, and an
 * enter/exit animation (reduced-motion aware). ARIA: `role="dialog"
 * aria-modal`. See UI-STYLE-GUIDE.md §8.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className = "",
}: DialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const { mounted, visible } = usePresence(open);

  useModalBehavior({ open, onClose, containerRef: dialogRef });

  if (!mounted) return null;

  return (
    /* Backdrop */
    /* biome-ignore lint/a11y/useKeyWithClickEvents: click-outside-to-close on the backdrop; Escape is handled by useModalBehavior and focus is trapped in the panel */
    /* biome-ignore lint/a11y/noStaticElementInteractions: transparent backdrop surface, not a control — the dialog panel itself carries the interactive semantics */
    <div
      className={[
        "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4",
        "transition-opacity duration-200 motion-reduce:transition-none",
        visible ? "opacity-100" : "opacity-0",
      ].join(" ")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Panel */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={[
          "relative w-full max-w-lg rounded-lg border border-border bg-popover text-popover-foreground shadow-xl",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "max-h-[90vh] overflow-y-auto",
          "transition duration-200 motion-reduce:transition-none",
          visible ? "scale-100 opacity-100" : "scale-95 opacity-0",
          className,
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-border p-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <button type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className={[
              "ml-4 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground",
              "hover:bg-muted hover:text-foreground transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ].join(" ")}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

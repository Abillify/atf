"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useEffect, useRef, useState } from "react";

/**
 * Modal behavior for overlays (Dialog, command palette, mobile nav drawer):
 * a real `Tab` focus trap, background scroll-lock, `Escape`-to-close, and focus
 * restoration to the element that was focused before opening. Shared so every
 * overlay is consistently accessible (UI-STYLE-GUIDE.md §8, §10).
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useModalBehavior({ open, onClose, containerRef: ref });
 *   return open ? <div ref={ref} role="dialog" aria-modal>…</div> : null;
 */
export interface UseModalBehaviorOptions {
  open: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Focus this element on open instead of the first focusable child. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function useModalBehavior({
  open,
  onClose,
  containerRef,
  initialFocusRef,
}: UseModalBehaviorOptions): void {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Move focus in (next frame so the container is laid out).
    const raf = requestAnimationFrame(() => {
      const target =
        initialFocusRef?.current ??
        (container ? focusable(container)[0] : null) ??
        container;
      target?.focus();
    });

    // Background scroll-lock.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || container === null) return;
      const items = focusable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, containerRef, initialFocusRef]);
}

/**
 * Mount/enter/exit presence for CSS-transitioned overlays. Keeps the node
 * mounted through its exit transition, then unmounts. Pair with
 * `motion-reduce:transition-none` so reduced-motion users get an instant toggle.
 *
 *   const { mounted, visible } = usePresence(open);
 *   {mounted && <div className={`transition ${visible ? "opacity-100" : "opacity-0"}`} />}
 */
export function usePresence(
  open: boolean,
  durationMs = 200,
): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), durationMs);
    return () => clearTimeout(t);
  }, [open, durationMs]);

  return { mounted, visible };
}

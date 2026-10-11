"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Keyboard shortcuts of the Studio builder (Req 9.3, Task 13.4). Split out
 * of `components/StudioBuilder.tsx` without behavior change.
 *
 * Shortcuts (Cmd/Ctrl+A, Backspace, …) only act on the canvas while the
 * operator works in the builder; after a click elsewhere on the page the
 * browser behavior applies again.
 */

import { useEffect, useRef, type RefObject } from "react";

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

export interface StudioShortcutHandlers {
  handleUndo: () => void;
  handleRedo: () => void;
  handleDuplicateSelected: () => void;
  handleSelectAll: () => void;
  handleCopySelected: () => void;
  handlePaste: () => void;
  handleBulkDelete: () => void;
  selectedNodeIds: string[];
  selEdge: string | null;
  deleteEdge: (id: string) => void;
}

/**
 * Registers the builder shortcuts and returns the ref to the builder root
 * element, which is used to detect whether the operator works in the builder.
 */
export function useStudioShortcuts(
  handlers: StudioShortcutHandlers,
): RefObject<HTMLDivElement | null> {
  const {
    handleUndo,
    handleRedo,
    handleDuplicateSelected,
    handleSelectAll,
    handleCopySelected,
    handlePaste,
    handleBulkDelete,
    selectedNodeIds,
    selEdge,
    deleteEdge,
  } = handlers;

  const rootRef = useRef<HTMLDivElement>(null);
  const builderActiveRef = useRef(false);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      builderActiveRef.current =
        rootRef.current?.contains(e.target as Node) ?? false;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isEditableTarget(e.target)) return;
      const focusInBuilder =
        e.target instanceof Node && e.target !== document.body
          ? (rootRef.current?.contains(e.target) ?? false)
          : builderActiveRef.current;
      if (!focusInBuilder) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (mod && ((key === "z" && e.shiftKey) || key === "y")) {
        e.preventDefault();
        handleRedo();
      } else if (mod && key === "d") {
        e.preventDefault();
        handleDuplicateSelected();
      } else if (mod && key === "a") {
        e.preventDefault();
        handleSelectAll();
      } else if (mod && key === "c") {
        handleCopySelected();
      } else if (mod && key === "v") {
        handlePaste();
      } else if (key === "delete" || key === "backspace") {
        if (selectedNodeIds.length > 0) {
          e.preventDefault();
          handleBulkDelete();
        } else if (selEdge) {
          e.preventDefault();
          deleteEdge(selEdge);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    handleUndo,
    handleRedo,
    handleDuplicateSelected,
    handleSelectAll,
    handleCopySelected,
    handlePaste,
    handleBulkDelete,
    selectedNodeIds,
    selEdge,
    deleteEdge,
  ]);

  return rootRef;
}

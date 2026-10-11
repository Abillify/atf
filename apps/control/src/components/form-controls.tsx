"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Small form building blocks shared by the Studio's properties panel and the
 * catalog-driven node settings form (`ConfigForm`).
 */

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormulaEditorDialog, FormulaInput, FxPicker } from "./FormulaEditor";
import type { FormulaKind } from "../lib/formula";
import { jsonKeyPathAt } from "../lib/json-key-path";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  // The hint sits outside the <label> so it isn't read as part of the
  // field's accessible name.
  return (
    <div className="min-w-0 flex-1">
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {children}
      </label>
      {hint && (
        <span className="mt-0.5 block text-[10px] text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Section({
  title,
  defaultOpen = true,
  children,
  sectionId,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  /** Marks the section (`data-section`) so the panel can jump to it. */
  sectionId?: string;
}): React.JSX.Element {
  return (
    <details
      open={defaultOpen}
      className="group scroll-mt-2 rounded-sm border-t border-border pt-2 transition-shadow"
      {...(sectionId ? { "data-section": sectionId } : {})}
    >
      <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide text-foreground">
        {title}
      </summary>
      <div className="mt-2 space-y-3">{children}</div>
    </details>
  );
}

export const inputCls =
  "w-full rounded border border-border bg-card px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function numberOrUndefined(v: string): number | undefined {
  return v === "" ? undefined : Number(v);
}

/**
 * Numeric setting that may also hold a `{{vars.*}}` placeholder in the source
 * form: plain numbers are stored as numbers, anything else as the raw string,
 * so a variable reference is shown and kept instead of being blanked.
 */
export function NumberOrVarInput({
  label,
  value,
  onChange,
  ariaLabel,
  onFocus,
}: {
  label: string;
  value: unknown;
  onChange: (next: number | string | undefined) => void;
  /** Accessible name when rendered without a visible label. */
  ariaLabel?: string;
  /** Reports focus for the docs panel (the input sits behind the label). */
  onFocus?: () => void;
}): React.JSX.Element {
  const input = (
    <FormulaInput
      kind="vars"
      replace
      ariaLabel={ariaLabel ?? label}
      inputMode="decimal"
      className={`${inputCls} ${typeof value === "string" ? "font-mono text-xs" : ""}`}
      value={value === undefined || value === null ? "" : String(value)}
      onFocus={onFocus}
      onChange={(raw) => {
        const v = raw.trim();
        if (v === "") onChange(undefined);
        else if (/^-?\d+(\.\d+)?$/.test(v)) onChange(Number(v));
        else onChange(raw);
      }}
    />
  );
  if (!label) return input;
  return <Field label={label}>{input}</Field>;
}

/** Drops keys whose value is `undefined` so cleared fields vanish from the file. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as T;
}

// ---------------------------------------------------------------------------
// JSON editor — keeps the operator's text while it is invalid and only reports
// parsed values upward. Re-syncs when the value changes from outside (undo,
// Copilot accept, another field) and no longer matches what is being typed.
// ---------------------------------------------------------------------------

export function JsonEditor({
  value,
  onChange,
  label,
  hint,
  rows = 8,
  allowEmpty = true,
  formulaKind = "vars",
  onCursorKey,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  label: string;
  hint?: string;
  rows?: number;
  /** When true an empty textarea reports `undefined` (field removed). */
  allowEmpty?: boolean;
  /** What the ƒx picker offers (`template` for tool arguments). */
  formulaKind?: FormulaKind;
  /**
   * Reports the dotted key path the cursor moved into (`llm.parameters`,
   * `config.toolArgs`, …) so the docs panel can follow it. Works on invalid,
   * mid-edit JSON; `undefined` at the document root.
   */
  onCursorKey?: (key: string | undefined) => void;
}): React.JSX.Element {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const reportCursor = useCallback((): void => {
    if (onCursorKey === undefined) return;
    const el = areaRef.current;
    if (el === null) return;
    onCursorKey(jsonKeyPathAt(el.value, el.selectionStart));
  }, [onCursorKey]);
  const serialized = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  // Read through a ref so the sync below runs only on outside value changes,
  // not on every keystroke.
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    const typed = textRef.current;
    let current: string;
    try {
      current = typed.trim() === "" ? "" : JSON.stringify(JSON.parse(typed), null, 2);
    } catch {
      return; // operator is mid-edit on invalid JSON — don't clobber it
    }
    if (current !== serialized) {
      setText(serialized);
      setError(null);
    }
  }, [serialized]);

  const apply = (next: string): void => {
    setText(next);
    if (next.trim() === "") {
      if (allowEmpty) {
        setError(null);
        onChange(undefined);
      } else {
        setError("Must not be empty.");
      }
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      setError(null);
      onChange(parsed);
    } catch (err) {
      setError(
        `Invalid JSON — not applied (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  };

  const insertSnippet = (snippetText: string): void => {
    const el = areaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    // Inside a JSON string the placeholder goes in as is; elsewhere it must be
    // a JSON string itself.
    const before = text.slice(0, start);
    const inString = (before.match(/(?<!\\)"/g)?.length ?? 0) % 2 === 1;
    const piece = inString ? snippetText : JSON.stringify(snippetText);
    const next = text.slice(0, start) + piece + text.slice(end);
    apply(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + piece.length, start + piece.length);
    });
  };

  const area = (
    <div className="relative">
      <textarea
        ref={areaRef}
        {...(label ? {} : { "aria-label": "JSON" })}
        className={`${inputCls} resize-y pr-9 font-mono text-xs ${error ? "border-danger-border" : ""}`}
        rows={rows}
        spellCheck={false}
        value={text}
        onChange={(e) => apply(e.target.value)}
        // Caret moves report the key under it: `select` only fires on text
        // selection, so clicks and arrow keys need their own listeners.
        onSelect={reportCursor}
        onClick={reportCursor}
        onKeyUp={reportCursor}
        onFocus={reportCursor}
      />
      <FxPicker
        kind={formulaKind}
        label={label || "JSON"}
        onPick={insertSnippet}
        onOpenEditor={() => setEditorOpen(true)}
        className="right-1.5 top-1.5"
      />
      {editorOpen && (
        <FormulaEditorDialog
          open
          title={label || "JSON"}
          kind={formulaKind}
          value={text}
          onApply={(next) => {
            apply(next);
            setEditorOpen(false);
          }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
  if (!label) {
    return (
      <div>
        {area}
        {(error ?? hint) && (
          <span className={`mt-0.5 block text-[10px] ${error ? "text-danger" : "text-muted-foreground"}`}>
            {error ?? hint}
          </span>
        )}
      </div>
    );
  }
  return (
    <Field label={label} hint={error ?? hint}>
      {area}
    </Field>
  );
}

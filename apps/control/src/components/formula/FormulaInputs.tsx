"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: inputs with the ƒx picker (FxPicker, FormulaInput, FormulaTextarea),
// moved out of FormulaEditor.tsx without behavior change. Imports the dialog
// directly (not through the barrel) and so avoids the circular reference.

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  insideCalculation,
  type FormulaGroup,
  type FormulaSymbol,
  type FormulaKind,
} from "../../lib/formula";
import { useVocabulary } from "./FormulaContext";
import { VariableBrowser } from "./VariableBrowser";
import { insertAt } from "./formulaUtils";
import { FormulaEditorDialog } from "./FormulaEditorDialog";
import { translate } from "../../lib/i18n";

/** The ƒx chip: clearly visible inside the right edge of a field. */
const FX_BUTTON =
  "flex h-5 min-w-[22px] items-center justify-center rounded border border-primary/30 bg-primary/5 px-1 text-primary hover:border-primary/60 hover:bg-primary/15";

function FxGlyph(): React.JSX.Element {
  return (
    <span aria-hidden className="font-serif text-[12px] font-semibold italic leading-none">
      ƒx
    </span>
  );
}

/**
 * ƒx chip + variable picker. `onPick` receives the ready-to-insert snippet;
 * `onOpenEditor` adds the "Open editor" action.
 */
export function FxPicker({
  kind,
  label,
  onPick,
  onOpenEditor,
  className = "",
  groups: groupsOverride,
}: {
  kind: FormulaKind;
  /** Name of the field, for the button's accessible name. */
  label: string;
  onPick: (snippet: string, symbol?: FormulaSymbol) => void;
  onOpenEditor?: () => void;
  className?: string;
  /** Offer these entries instead of the flow's vocabulary. */
  groups?: FormulaGroup[];
}): React.JSX.Element {
  const vocabulary = useVocabulary(kind);
  const groups = groupsOverride ?? vocabulary.groups;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // The popover lives in a portal with fixed coordinates: inside the
  // properties panel it would otherwise be clipped by the scroll container and
  // painted under the following fields.
  const place = useCallback((): void => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 320;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = r.bottom + 4;
    const top = below + 360 > window.innerHeight ? Math.max(8, r.top - 364) : below;
    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    // Follow the field when the panel scrolls (focus changes can scroll it).
    const onScroll = (e: Event): void => {
      if (!popRef.current?.contains(e.target as Node)) place();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);
  const hint = onOpenEditor
    ? "Open the expression builder"
    : groupsOverride
    ? `Pick a value (${groupsOverride.map((g) => g.title).join(", ")})`
    : kind === "condition"
      ? "Insert a variable / open the condition editor"
      : kind === "vars"
        ? "Insert a flow variable ({{vars.name}})"
        : "Insert a variable (e.g. {{vars.x}}, {{classification.x}}) / open the editor";
  return (
    <div ref={rootRef} className={`absolute ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={onOpenEditor ? translate("formulaInputs.openTheExpressionBuilderFor", { label }) : translate("formulaInputs.insertAVariableIntoLabel", { label })}
        aria-expanded={open}
        title={hint}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (onOpenEditor ? onOpenEditor() : setOpen((v) => !v))}
        className={FX_BUTTON}
      >
        <FxGlyph />
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <div
          ref={popRef}
          style={{ position: "fixed", top: pos.top, left: pos.left, width: 320 }}
          className="z-[90] rounded-md border border-border bg-card p-2 text-left text-foreground shadow-lg"
        >
          <VariableBrowser
            groups={groups}
            kind={kind}
            {...(groupsOverride
              ? { emptyText: "Nothing to pick — the runtime reported no model shortcuts or models." }
              : {})}
            onPick={(text, symbol) => {
              onPick(text, symbol);
              setOpen(false);
            }}
            autoFocus
            compact
          />
          {onOpenEditor && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onOpenEditor();
              }}
              className="mt-1.5 w-full rounded border border-border px-2 py-1 text-[11px] hover:bg-muted"
            >
              {translate("formulaInputs.openEditor")}{kind === "condition" ? translate("formulaInputs.checkTest") : translate("formulaInputs.preview")}…
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input with ƒx picker
// ---------------------------------------------------------------------------

export function FormulaInput({
  value,
  onChange,
  kind = "template",
  ariaLabel,
  placeholder,
  className = "",
  title,
  onFocus,
  list,
  inputMode,
  replace = false,
  groups,
  evaluate,
}: {
  value: string;
  onChange: (next: string) => void;
  kind?: FormulaKind;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  /** Dialog title; defaults to the aria label. */
  title?: string;
  onFocus?: () => void;
  /** id of a <datalist> with suggestions. */
  list?: string;
  inputMode?: "decimal" | "text";
  /**
   * Single-value field (a number, a model, a shortcut): a picked variable
   * REPLACES the value instead of being inserted at the cursor.
   */
  replace?: boolean;
  /** Offer these entries in the ƒx picker instead of the flow's vocabulary. */
  groups?: FormulaGroup[];
  /** Runtime evaluation of the value, shown as the builder's result. */
  evaluate?: (draft: string) => Promise<{ value?: unknown; error?: string }>;
}): React.JSX.Element {
  const [editorOpen, setEditorOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (text: string, symbol?: FormulaSymbol): void => {
    const el = inputRef.current;
    const inCalc =
      symbol?.calcInsert !== undefined &&
      insideCalculation(value, el?.selectionStart ?? value.length);
    const piece = inCalc ? (symbol?.calcInsert as string) : text;
    const { value: next, caret } = (symbol?.replace ?? replace)
      ? { value: piece, caret: piece.length }
      : insertAt(el, value, piece);
    onChange(next);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="relative flex items-center">
      <input
        ref={inputRef}
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        onFocus={onFocus}
        list={list}
        inputMode={inputMode}
        onChange={(e) => onChange(e.target.value)}
        className={`${className} pr-9`}
      />
      <FxPicker
        kind={kind}
        label={ariaLabel}
        onPick={pick}
        {...(groups ? { groups } : {})}
        onOpenEditor={() => setEditorOpen(true)}
        className="right-1.5 top-1/2 -translate-y-1/2"
      />
      {editorOpen && (
        <FormulaEditorDialog
          open={editorOpen}
          title={title ?? ariaLabel}
          kind={kind}
          {...(groups ? { groups } : {})}
          {...(evaluate ? { evaluate } : {})}
          replace={replace}
          value={value}
          onApply={(next) => {
            onChange(next);
            setEditorOpen(false);
          }}
          onClose={() => setEditorOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Textarea with ƒx editor
// ---------------------------------------------------------------------------

export function FormulaTextarea({
  value,
  onChange,
  kind = "template",
  ariaLabel,
  placeholder,
  rows = 4,
  className = "",
  title,
  onFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  kind?: FormulaKind;
  ariaLabel: string;
  placeholder?: string;
  rows?: number;
  className?: string;
  title?: string;
  onFocus?: () => void;
}): React.JSX.Element {
  const [editorOpen, setEditorOpen] = useState(false);
  return (
    <div className="relative">
      <textarea
        aria-label={ariaLabel}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
        className={`${className} pr-9`}
      />
      <button
        type="button"
        aria-label={translate("formulaInputs.openTheFormulaEditorFor", { ariaLabel })}
        title={kind === "condition" ? translate("formulaInputs.openTheConditionEditorVariables") : translate("formulaInputs.openTheEditorVariablesPreview")}
        onClick={() => setEditorOpen(true)}
        className={`${FX_BUTTON} absolute right-1.5 top-1.5`}
      >
        <FxGlyph />
      </button>
      {editorOpen && (
      <FormulaEditorDialog
        open={editorOpen}
        title={title ?? ariaLabel}
        kind={kind}
        value={value}
        onApply={(next) => {
          onChange(next);
          setEditorOpen(false);
        }}
        onClose={() => setEditorOpen(false)}
      />
      )}
    </div>
  );
}

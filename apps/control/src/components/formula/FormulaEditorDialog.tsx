"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: complete formula editor dialog, moved out of FormulaEditor.tsx
 * without behavior change. FormulaEditor.tsx is now a barrel that
 * re-exports these modules.
 */

import type React from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Braces, X } from "lucide-react";
import { useAuth } from "../../lib/auth/useAuth";
import { request } from "../../lib/control-api";
import {
  defaultSample,
  getPath,
  parseSampleValue,
  referencedPaths,
  renderTemplatePreview,
  setPath,
  type FormulaGroup,
  type FormulaSymbol,
  insideCalculation,
  type FormulaKind,
} from "../../lib/formula";
import { useVocabulary } from "./FormulaContext";
import { VariableBrowser } from "./VariableBrowser";
import { ExpressionCopilot } from "./ExpressionCopilot";
import { OperatorToolbar } from "./OperatorToolbar";
import { BuilderHelp } from "./BuilderHelp";
import { type ConditionCheck, ValueResult, ConditionResult } from "./ResultViews";
import { RunPicker } from "./RunPicker";
import { insertAt } from "./formulaUtils";

/** Load-time references in a draft: variables, constants, env, calculations. */
const LOAD_TIME_RE = /\{\{\s*(=|vars\.|const\.|env\.)/;
/** Scratch variable name used to evaluate a field's draft with the flow's variables. */
const DRAFT_KEY = "__studio_draft__";

export function FormulaEditorDialog({
  open,
  title,
  kind,
  value,
  onApply,
  onClose,
  groups: groupsOverride,
  evaluate,
  replace = false,
}: {
  open: boolean;
  /** Single-value field: a picked entry replaces the draft instead of being inserted. */
  replace?: boolean;
  title: string;
  kind: FormulaKind;
  value: string;
  onApply: (next: string) => void;
  onClose: () => void;
  /** Offer these entries instead of the flow's vocabulary. */
  groups?: FormulaGroup[];
  /**
   * Evaluates the draft the way the runtime does (flow variable values:
   * references, constants, env, calculations) — shown as the result.
   */
  evaluate?: (draft: string) => Promise<{ value?: unknown; error?: string }>;
}): React.JSX.Element | null {
  const { token } = useAuth();
  const vocabulary = useVocabulary(kind);
  const groups = groupsOverride ?? vocabulary.groups;
  const variables = vocabulary.variables;
  // Any field: what it resolves to when the flow loads (variables, constants,
  // env, calculations), evaluated by the runtime with the flow's variables.
  const flowEvaluate = vocabulary.evaluateVariables;
  const loadTimeEvaluate = useMemo(() => {
    if (evaluate || kind === "condition" || !flowEvaluate) return undefined;
    return async (d: string): Promise<{ value?: unknown; error?: string }> => {
      const r = await flowEvaluate({ ...(variables ?? {}), [DRAFT_KEY]: d });
      const error = r.errors.find((e) => e.name === DRAFT_KEY)?.message;
      return error ? { error } : { value: r.values[DRAFT_KEY] };
    };
  }, [evaluate, kind, flowEvaluate, variables]);
  const [evaluated, setEvaluated] = useState<
    { state: "idle" | "checking" } | { state: "done"; value?: unknown; error?: string }
  >({ state: "idle" });
  // Mounted when opened (callers render it conditionally), so props seed state.
  const [draft, setDraft] = useState(value);
  // Sample values: the pinned run's values, completed with defaults for
  // anything the formula reads that the run did not record.
  const pinned = vocabulary.runs?.pinned ?? null;
  const seedSample = useCallback(
    (text: string): Record<string, unknown> => {
      let seeded: Record<string, unknown> = pinned ? structuredClone(pinned.sample) : {};
      const defaults = defaultSample(referencedPaths(text, kind), groups);
      for (const p of referencedPaths(text, kind)) {
        if (getPath(seeded, p) === undefined && getPath(defaults, p) !== undefined) {
          seeded = setPath(seeded, p, getPath(defaults, p));
        }
      }
      return seeded;
    },
    [pinned, kind, groups],
  );
  const [sample, setSample] = useState<Record<string, unknown>>(() => seedSample(value));
  const pinnedId = pinned?.executionId;
  const draftRef = useRef(value);
  draftRef.current = draft;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-seed only when another run is pinned, not on every edit
  useEffect(() => {
    // Another run pinned while the builder is open: re-seed from it.
    setSample(seedSample(draftRef.current));
  }, [pinnedId]);
  const [check, setCheck] = useState<ConditionCheck>({ state: "idle" });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /** Caret / selected range in the editor, for the copilot (null until the user placed it). */
  const [areaSel, setAreaSel] = useState<{ start: number; end: number } | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (open) requestAnimationFrame(() => areaRef.current?.focus());
  }, [open]);

  const paths = useMemo(
    () => referencedPaths(draft, kind).filter((p) => !p.startsWith("vars.") && !p.startsWith("now.")),
    [draft, kind],
  );

  // Conditions: syntax check + evaluation by the runtime, debounced.
  useEffect(() => {
    if (!open || kind !== "condition") return;
    let alive = true;
    setCheck({ state: "checking" });
    const t = setTimeout(() => {
      // Req 9.2: transport through lib/control-api (debounced live check, imperative).
      request("/flows/expressions/evaluate", {
        method: "POST",
        target: "backend",
        token,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression: draft, sample }),
      })
        .then(async (r) => {
          if (!r.ok) throw new Error(r.status === 404 ? "runtime too old for live checks" : `HTTP ${r.status}`);
          return (await r.json()) as { valid: boolean; result?: boolean; error?: string; empty?: boolean };
        })
        .then((res) => {
          if (!alive) return;
          setCheck(
            res.valid
              ? { state: "done", valid: true, result: res.result === true, ...(res.empty ? { empty: true } : {}) }
              : { state: "done", valid: false, error: res.error ?? "invalid expression" },
          );
        })
        .catch((err) => alive && setCheck({ state: "offline", error: err instanceof Error ? err.message : String(err) }));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, kind, draft, sample, token]);

  // Load-time result, evaluated by the runtime, debounced.
  const hasLoadTime = LOAD_TIME_RE.test(draft);
  const activeEvaluate = evaluate ?? (hasLoadTime ? loadTimeEvaluate : undefined);
  useEffect(() => {
    if (!open || !activeEvaluate) return;
    let alive = true;
    setEvaluated({ state: "checking" });
    const t = setTimeout(() => {
      activeEvaluate(draft).then(
        (r) => alive && setEvaluated({ state: "done", ...r }),
        (err) =>
          alive &&
          setEvaluated({
            state: "done",
            error: `Live result unavailable (${err instanceof Error ? err.message : String(err)})`,
          }),
      );
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, draft, activeEvaluate]);

  // Run-time preview (templates): rendered on the load-time result when there
  // is one, so both stages show.
  const loadTimeText =
    activeEvaluate && evaluated.state === "done" && evaluated.error === undefined
      ? typeof evaluated.value === "string"
        ? evaluated.value
        : JSON.stringify(evaluated.value)
      : undefined;
  const preview = useMemo(
    () =>
      kind === "template" || (kind === "vars" && !activeEvaluate)
        ? renderTemplatePreview(loadTimeText ?? draft, sample, variables)
        : undefined,
    [kind, draft, sample, variables, activeEvaluate, loadTimeText],
  );
  const hasCalculation = groups.some((g) => g.title === "Calculation");

  const insert = useCallback(
    (text: string, symbol?: FormulaSymbol) => {
      const el = areaRef.current;
      if (symbol?.replace ?? replace) {
        setDraft(text);
        requestAnimationFrame(() => el?.focus());
        return;
      }
      const piece =
        symbol?.calcInsert !== undefined &&
        insideCalculation(draft, el?.selectionStart ?? draft.length)
          ? symbol.calcInsert
          : text;
      const { value: next, caret } = insertAt(el, draft, piece);
      setDraft(next);
      requestAnimationFrame(() => {
        areaRef.current?.focus();
        areaRef.current?.setSelectionRange(caret, caret);
      });
    },
    [draft, replace],
  );

  if (!open) return null;

  const dialog = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* Backdrop: clicking outside the dialog cancels. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Dismiss editor"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onApply(draft);
          }
        }}
        className="relative flex h-[min(86vh,760px)] w-[min(96vw,1180px)] flex-col overflow-hidden rounded-lg border border-border bg-card text-foreground shadow-2xl"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Braces size={16} aria-hidden className="text-muted-foreground" />
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          {vocabulary.runs && <RunPicker runs={vocabulary.runs} />}
          <span className="rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
            {kind === "condition"
              ? "condition expression"
              : hasCalculation
                ? "value · placeholders & calculations"
                : "text with placeholders"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close formula editor"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_320px]">
          <aside className="flex min-h-0 flex-col border-r border-border p-3">
            <VariableBrowser groups={groups} kind={kind} onPick={insert} sample={sample} />
          </aside>

          <section className="flex min-h-0 flex-col gap-2 p-3">
            <ExpressionCopilot
              kind={kind}
              field={title}
              current={draft}
              groups={groups}
              sample={sample}
              variables={variables}
              token={token}
              selection={areaSel}
              onAccept={(next) => {
                setDraft(next);
                setAreaSel(null);
                requestAnimationFrame(() => areaRef.current?.focus());
              }}
            />
            <OperatorToolbar
              label={kind === "condition" ? "Operators" : "Calculation operators"}
              operators={
                kind === "condition"
                  ? (vocabulary.reference?.conditionOperators ?? [])
                  : hasCalculation
                    ? (vocabulary.reference?.calculationOperators ?? [])
                    : []
              }
              onInsert={(text) => insert(text)}
              onClear={() => {
                setDraft("");
                requestAnimationFrame(() => areaRef.current?.focus());
              }}
            />
            <textarea
              ref={areaRef}
              aria-label={title}
              value={draft}
              spellCheck={kind === "template"}
              onChange={(e) => setDraft(e.target.value)}
              onSelect={(e) =>
                setAreaSel({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })
              }
              className="min-h-0 flex-1 resize-none rounded border border-border bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <BuilderHelp
              kind={kind}
              calculations={hasCalculation}
              functions={vocabulary.reference?.calculationFunctions ?? []}
              onInsert={(text) => insert(text)}
              onInsertFunction={(fn) =>
                insert(`{{= ${fn} }}`, { path: `fn.${fn}`, description: "", calcInsert: fn })
              }
            />
          </section>

          <aside className="flex min-h-0 flex-col gap-3 overflow-auto border-l border-border p-3">
            <div className="space-y-3">
              {kind === "condition" ? (
                <div>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Result</h3>
                  <ConditionResult check={check} />
                </div>
              ) : (
                <>
                  {activeEvaluate && (
                    <div>
                      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        When the flow loads
                      </h3>
                      <ValueResult result={evaluated} />
                    </div>
                  )}
                  {(kind === "template" || !activeEvaluate) && (
                    <div className="space-y-1">
                      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {kind === "template" ? "At run time (preview)" : "Preview"}
                      </h3>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px]">
                        {preview?.text || <span className="text-muted-foreground">(empty)</span>}
                      </pre>
                      {preview && preview.unresolved.length > 0 && (
                        <p className="text-[10px] text-warning">
                          Without a value (renders empty): {preview.unresolved.join(", ")}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Sample values
              </h3>
              {paths.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  The formula reads no run values{kind === "template" ? " (flow variables and date/time are filled automatically)" : ""}.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {paths.map((p) => {
                    const v = getPath(sample, p);
                    return (
                      <label key={p} className="block">
                        <code className="block truncate font-mono text-[10px] text-muted-foreground">{p}</code>
                        <input
                          aria-label={`Sample value for ${p}`}
                          value={v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)}
                          placeholder="(no value)"
                          onChange={(e) => setSample((s) => setPath(s, p, parseSampleValue(e.target.value)))}
                          className="w-full rounded border border-border bg-card px-2 py-1 font-mono text-[11px]"
                        />
                      </label>
                    );
                  })}
                  <p className="text-[10px] text-muted-foreground">
                    Numbers, true/false, null and JSON are typed; anything else is text.
                  </p>
                </div>
              )}
            </div>
          </aside>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 text-xs hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onApply(draft)}
            className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}

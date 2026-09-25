"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Formula editing for Studio fields.
 *
 *  - `FormulaInput`: a text input with an ƒx button on the right that opens a
 *    searchable picker; picking inserts the variable at the cursor (`{{path}}`
 *    in templates, the bare path in conditions). "Open editor" switches to the
 *    full editor.
 *  - `FormulaTextarea`: a textarea with an ƒx button that opens the full editor.
 *  - `FormulaEditorDialog`: large editor with a variable browser, operator
 *    palette (conditions), live syntax check and a preview with sample values —
 *    conditions are evaluated by the runtime itself
 *    (`POST /flows/expressions/evaluate`), templates are rendered locally.
 *
 * The vocabulary (flow variables, classification fields, node outputs, …)
 * comes from the flow on the canvas via `FormulaProvider`; without a provider
 * the editor still offers the generic entries.
 */

import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Braces, Search, X } from "lucide-react";
import type { FlowReference } from "../lib/node-types";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import {
  buildVocabulary,
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
} from "../lib/formula";
import type { FlowDefinition } from "../types/flow";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface FormulaContextValue {
  flow: Pick<FlowDefinition, "nodes" | "variables">;
  /** Placeholders, condition grammar, calculations (runtime reference data). */
  reference: FlowReference | undefined;
}

const FormulaContext = createContext<FormulaContextValue | null>(null);

export function FormulaProvider({
  flow,
  reference,
  children,
}: {
  flow: Pick<FlowDefinition, "nodes" | "variables">;
  /** From the node type catalog; without it only flow-derived entries are offered. */
  reference?: FlowReference | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo(() => ({ flow, reference }), [flow, reference]);
  return <FormulaContext.Provider value={value}>{children}</FormulaContext.Provider>;
}

function useVocabulary(kind: FormulaKind): {
  groups: FormulaGroup[];
  variables: Record<string, unknown> | undefined;
  reference: FlowReference | undefined;
} {
  const ctx = useContext(FormulaContext);
  return useMemo(
    () => ({
      groups: buildVocabulary(ctx?.flow ?? { nodes: [] }, kind, ctx?.reference),
      variables: ctx?.flow.variables,
      reference: ctx?.reference,
    }),
    [ctx, kind],
  );
}

const snippet = (path: string, kind: FormulaKind): string =>
  kind === "condition" ? path : `{{${path}}}`;

/** Inserts `text` at the element's selection, returning new value + caret. */
function insertAt(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
  text: string,
): { value: string; caret: number } {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  const next = value.slice(0, start) + text + value.slice(end);
  // Place the caret inside quotes/parentheses of snippets like " =~ ''",
  // "round()" or "{{= round() }}", and inside an empty "{{=  }}".
  const paren = text.lastIndexOf("()");
  const inner = text.endsWith("''")
    ? text.length - 1
    : paren >= 0
      ? paren + 1
      : text === "{{=  }}"
        ? 4
        : text.length;
  return { value: next, caret: start + inner };
}

// ---------------------------------------------------------------------------
// Variable browser (shared by picker and editor)
// ---------------------------------------------------------------------------

function VariableBrowser({
  groups,
  kind,
  onPick,
  autoFocus = false,
  compact = false,
  emptyText,
}: {
  groups: FormulaGroup[];
  /** Shown when there is nothing to offer at all. */
  emptyText?: string;
  kind: FormulaKind;
  /** Receives the ready-to-insert text (and the picked entry). */
  onPick: (text: string, symbol: FormulaSymbol) => void;
  autoFocus?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);
  const filtered = groups
    .map((g) => ({
      ...g,
      symbols: g.symbols.filter(
        (s) =>
          !q ||
          s.path.toLowerCase().includes(q.toLowerCase()) ||
          (s.insert ?? "").toLowerCase().includes(q.toLowerCase()) ||
          s.description.toLowerCase().includes(q.toLowerCase()),
      ),
    }))
    .filter((g) => g.symbols.length > 0);
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1">
        <Search size={12} aria-hidden className="text-muted-foreground" />
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search variables…"
          aria-label="Search variables"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      </div>
      <div className={`min-h-0 overflow-auto ${compact ? "max-h-64" : "flex-1"}`}>
        {filtered.map((g) => (
          <div key={g.title} className="mb-1.5">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {g.title}
            </div>
            {g.symbols.map((s) => (
              <button
                type="button"
                key={s.path}
                disabled={s.unavailable !== undefined}
                title={s.unavailable ?? s.description}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(s.insert ?? snippet(s.path, kind), s)}
                className="block w-full rounded px-1.5 py-1 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <code className="block truncate font-mono text-[11px] text-foreground">
                  {s.insert ?? snippet(s.path, kind)}
                </code>
                {(!compact || s.insert !== undefined) && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {s.unavailable ?? s.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {groups.length === 0
              ? emptyText ?? "This flow has no variables yet. Define them in Flow settings (click an empty spot on the canvas) and use them here as {{vars.name}}."
              : "No variable matches."}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full editor dialog
// ---------------------------------------------------------------------------

type ConditionCheck =
  | { state: "idle" | "checking" }
  | { state: "done"; valid: true; result: boolean; empty?: boolean }
  | { state: "done"; valid: false; error: string }
  | { state: "offline"; error: string };

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
  const [evaluated, setEvaluated] = useState<
    { state: "idle" | "checking" } | { state: "done"; value?: unknown; error?: string }
  >({ state: "idle" });
  // Mounted when opened (callers render it conditionally), so props seed state.
  const [draft, setDraft] = useState(value);
  const [sample, setSample] = useState<Record<string, unknown>>(() =>
    defaultSample(referencedPaths(value, kind), groups),
  );
  const [check, setCheck] = useState<ConditionCheck>({ state: "idle" });
  const areaRef = useRef<HTMLTextAreaElement>(null);
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
      fetch(backendUrl("/flows/expressions/evaluate"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
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

  // Variable values: evaluated by the runtime, debounced.
  useEffect(() => {
    if (!open || !evaluate) return;
    let alive = true;
    setEvaluated({ state: "checking" });
    const t = setTimeout(() => {
      evaluate(draft).then(
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
  }, [open, draft, evaluate]);

  const preview = useMemo(
    () =>
      kind === "template" || (kind === "vars" && !evaluate)
        ? renderTemplatePreview(draft, sample, variables)
        : undefined,
    [kind, draft, sample, variables, evaluate],
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
            <VariableBrowser groups={groups} kind={kind} onPick={insert} />
          </aside>

          <section className="flex min-h-0 flex-col gap-2 p-3">
            {hasCalculation && (
              <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Calculation operators">
                {(vocabulary.reference?.calculationOperators ?? []).map((op) => (
                  <button
                    type="button"
                    key={op.label}
                    title={op.description}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(op.text)}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                  >
                    {op.label}
                  </button>
                ))}
              </div>
            )}
            {kind === "condition" && (
              <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Operators">
                {(vocabulary.reference?.conditionOperators ?? []).map((op) => (
                  <button
                    type="button"
                    key={op.label}
                    title={op.description}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insert(op.text)}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] hover:bg-muted"
                  >
                    {op.label}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={areaRef}
              aria-label={title}
              value={draft}
              spellCheck={kind === "template"}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-0 flex-1 resize-none rounded border border-border bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-[10px] text-muted-foreground">
              {kind === "condition"
                ? "Evaluated by the runtime's safe evaluator. Identifiers read the run state; strings in single quotes. Cmd/Ctrl+Enter applies, Esc cancels."
                : hasCalculation
                  ? "{{vars.x}}, {{const.x}}, {{env.FLOW_PUBLIC_X}} are replaced when the flow loads; {{= … }} calculates (inside it write vars.x without braces, strings in single quotes). Cmd/Ctrl+Enter applies, Esc cancels."
                  : "Placeholders {{path}} are filled in at run time; #[[file:prompts/x.md]] includes a prompt file. Cmd/Ctrl+Enter applies, Esc cancels."}
            </p>
          </section>

          <aside className="flex min-h-0 flex-col gap-3 overflow-auto border-l border-border p-3">
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {kind === "condition" || evaluate ? "Result" : "Preview"}
              </h3>
              {kind === "condition" ? (
                <ConditionResult check={check} />
              ) : evaluate ? (
                <ValueResult result={evaluated} />
              ) : (
                <div className="space-y-1">
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px]">
                    {preview?.text || <span className="text-muted-foreground">(empty)</span>}
                  </pre>
                  {preview && preview.unresolved.length > 0 && (
                    <p className="text-[10px] text-amber-600">
                      Without a value (renders empty): {preview.unresolved.join(", ")}
                    </p>
                  )}
                </div>
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


function ValueResult({
  result,
}: {
  result: { state: "idle" | "checking" } | { state: "done"; value?: unknown; error?: string };
}): React.JSX.Element {
  if (result.state !== "done") return <p className="text-[11px] text-muted-foreground">Evaluating…</p>;
  if (result.error) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
        {result.error}
      </p>
    );
  }
  const v = result.value;
  const type = Array.isArray(v) ? "list" : v === null ? "null" : typeof v;
  return (
    <div className="space-y-1">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-green-200 bg-green-50 p-2 font-mono text-[12px] text-green-800 dark:bg-green-950/30 dark:text-green-300">
        {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
      </pre>
      <p className="text-[10px] text-muted-foreground">Type: {type}</p>
    </div>
  );
}

function ConditionResult({ check }: { check: ConditionCheck }): React.JSX.Element {
  if (check.state === "offline") {
    return <p className="text-[11px] text-muted-foreground">Live check unavailable ({check.error}).</p>;
  }
  if (check.state !== "done") {
    return <p className="text-[11px] text-muted-foreground">Checking…</p>;
  }
  if (!check.valid) {
    return (
      <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
        Syntax error: {check.error}
      </p>
    );
  }
  if (check.empty) {
    return <p className="text-[11px] text-muted-foreground">Empty — the edge is unconditional (always taken).</p>;
  }
  return (
    <p
      className={`rounded border p-2 text-[12px] font-semibold ${
        check.result ? "border-green-200 bg-green-50 text-green-700" : "border-border bg-muted text-foreground"
      }`}
    >
      {check.result ? "true — would match with these values" : "false — would not match with these values"}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Input with ƒx picker
// ---------------------------------------------------------------------------

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
        aria-label={onOpenEditor ? `Open the expression builder for ${label}` : `Insert a variable into ${label}`}
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
              Open editor{kind === "condition" ? " (check & test)" : " (preview)"}…
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
        aria-label={`Open the formula editor for ${ariaLabel}`}
        title={kind === "condition" ? "Open the condition editor (variables, operators, live test)" : "Open the editor (variables, preview)"}
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

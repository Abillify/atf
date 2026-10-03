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
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Eraser,
  Hash,
  List,
  Search,
  Sigma,
  Sparkles,
  ToggleLeft,
  Type,
  X,
} from "lucide-react";
import type { FlowReference } from "../lib/node-types";
import { diffText } from "../lib/text-diff";
import {
  fetchFlowRuns,
  fetchRunSample,
  isStudioRun,
  type PinnedRun,
  type RunSummary,
} from "../lib/run-samples";
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
  type VocabularyCatalog,
  insideCalculation,
  symbolType,
  type FormulaKind,
} from "../lib/formula";
import type { FlowDefinition } from "../types/flow";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Evaluates a variables map like the runtime (POST /flows/variables/evaluate). */
export type VariablesEvaluator = (
  variables: Record<string, unknown>,
) => Promise<{ values: Record<string, unknown>; errors: Array<{ name: string; message: string }> }>;

interface FormulaContextValue {
  flow: Pick<FlowDefinition, "nodes" | "variables">;
  /** Reference data, constants and public env from the node type catalog. */
  catalog: (VocabularyCatalog & { reference?: FlowReference }) | undefined;
  evaluateVariables: VariablesEvaluator | undefined;
  runs: RunsContext | undefined;
}

/** Recorded runs of the flow and the one pinned as sample data. */
export interface RunsContext {
  flowId: string;
  pinned: PinnedRun | null;
  onPin: (run: PinnedRun | null) => void;
  token?: string | undefined;
}

const FormulaContext = createContext<FormulaContextValue | null>(null);

export function FormulaProvider({
  flow,
  catalog,
  reference,
  evaluateVariables,
  runs,
  children,
}: {
  flow: Pick<FlowDefinition, "nodes" | "variables">;
  /** From the node type catalog; without it only flow-derived entries are offered. */
  catalog?: (VocabularyCatalog & { reference?: FlowReference }) | undefined;
  /** Shorthand for `catalog={{ reference }}`. */
  reference?: FlowReference | undefined;
  /** Lets the builder show what a field resolves to when the flow loads. */
  evaluateVariables?: VariablesEvaluator | undefined;
  /** Enables pinning a recorded run as sample data. */
  runs?: RunsContext | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useMemo(
    () => ({
      flow,
      catalog: catalog ?? (reference ? { reference } : undefined),
      evaluateVariables,
      runs,
    }),
    [flow, catalog, reference, evaluateVariables, runs],
  );
  return <FormulaContext.Provider value={value}>{children}</FormulaContext.Provider>;
}

function useVocabulary(kind: FormulaKind): {
  groups: FormulaGroup[];
  variables: Record<string, unknown> | undefined;
  reference: FlowReference | undefined;
  evaluateVariables: VariablesEvaluator | undefined;
  runs: RunsContext | undefined;
} {
  const ctx = useContext(FormulaContext);
  return useMemo(
    () => ({
      groups: buildVocabulary(ctx?.flow ?? { nodes: [] }, kind, ctx?.catalog),
      variables: ctx?.flow.variables,
      reference: ctx?.catalog?.reference,
      evaluateVariables: ctx?.evaluateVariables,
      runs: ctx?.runs,
    }),
    [ctx, kind],
  );
}

/** Load-time references in a draft: variables, constants, env, calculations. */
const LOAD_TIME_RE = /\{\{\s*(=|vars\.|const\.|env\.)/;
/** Scratch variable name used to evaluate a field's draft with the flow's variables. */
const DRAFT_KEY = "__studio_draft__";

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

const TYPE_ICON: Record<ReturnType<typeof symbolType>, React.ComponentType<{ size?: number; className?: string }>> = {
  text: Type,
  number: Hash,
  boolean: ToggleLeft,
  list: List,
  object: Braces,
  function: Sigma,
};

function SymbolRow({
  sym,
  kind,
  onPick,
  compact,
  value,
}: {
  /** Sample value from the pinned run, if any. */
  value?: unknown;
  sym: FormulaSymbol;
  kind: FormulaKind;
  onPick: (text: string, symbol: FormulaSymbol) => void;
  compact: boolean;
}): React.JSX.Element {
  const Icon = TYPE_ICON[symbolType(sym)];
  const shown = sym.label ?? sym.insert ?? snippet(sym.path, kind);
  if (sym.unavailable !== undefined && sym.path.endsWith(".none")) {
    // Placeholder row of an empty group: just the explanation.
    return <p className="px-1.5 py-1 text-[10px] italic text-muted-foreground">{sym.unavailable}</p>;
  }
  return (
    <button
      type="button"
      disabled={sym.unavailable !== undefined}
      title={sym.unavailable ?? sym.description}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(sym.insert ?? snippet(sym.path, kind), sym)}
      className="flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <Icon size={12} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <code className="block truncate font-mono text-[11px] text-foreground">{shown}</code>
        {value !== undefined && typeof value !== "object" && !sym.path.startsWith("vars.") && !sym.path.startsWith("const.") && !sym.path.startsWith("env.") && (
          <span className="block truncate font-mono text-[10px] text-emerald-700 dark:text-emerald-400" title="Value in the pinned run">
            📌 {JSON.stringify(value)}
          </span>
        )}
        {(!compact || sym.insert !== undefined) && (sym.unavailable ?? sym.description) && (
          <span className="block truncate text-[10px] text-muted-foreground">{sym.unavailable ?? sym.description}</span>
        )}
      </span>
    </button>
  );
}

function Collapsible({
  title,
  count,
  hint,
  open,
  onToggle,
  level,
  children,
}: {
  title: string;
  count: number;
  hint?: string | undefined;
  open: boolean;
  onToggle: () => void;
  level: 0 | 1;
  children: React.ReactNode;
}): React.JSX.Element {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className={level === 1 ? "ml-3" : "mb-1"}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex w-full items-center gap-1 rounded px-1 py-1 text-left hover:bg-muted ${
          level === 0
            ? "text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            : "font-mono text-[11px] font-medium text-foreground"
        }`}
      >
        <Chevron size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="text-[10px] font-normal text-muted-foreground">{count}</span>
      </button>
      {open && (
        <div>
          {hint && level === 0 && <p className="ml-5 mb-0.5 text-[10px] text-muted-foreground">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * The data context as a tree: groups (Flow variables, Constants, Node results,
 * …), optional sub-sections (the node a field belongs to), and entries with a
 * type icon. Unavailable entries stay visible, disabled, with the reason.
 * Searching filters and expands everything.
 */
function VariableBrowser({
  groups,
  kind,
  onPick,
  autoFocus = false,
  compact = false,
  emptyText,
  sample,
}: {
  /** Pinned/sample values, shown next to the entries they fill. */
  sample?: Record<string, unknown> | undefined;
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
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) searchRef.current?.focus();
  }, [autoFocus]);
  const query = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({
      ...g,
      symbols: g.symbols.filter(
        (s) =>
          !query ||
          (!s.path.endsWith(".none") &&
            [s.path, s.label ?? "", s.insert ?? "", s.description, s.section ?? ""].some((t) =>
              t.toLowerCase().includes(query),
            )),
      ),
    }))
    .filter((g) => g.symbols.length > 0);
  // Groups with usable entries start open; searching opens everything.
  const isOpen = (key: string, usable: boolean): boolean => (query ? true : (toggled[key] ?? usable));
  const toggle = (key: string, usable: boolean): void =>
    setToggled((t) => ({ ...t, [key]: !(t[key] ?? usable) }));

  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1">
        <Search size={12} aria-hidden className="text-muted-foreground" />
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search variables, fields, functions…"
          aria-label="Search variables"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
      </div>
      <div className={`min-h-0 overflow-auto ${compact ? "max-h-64" : "flex-1"}`}>
        {filtered.map((g) => {
          const usable = g.symbols.some((s) => s.unavailable === undefined);
          const sections = [...new Set(g.symbols.map((s) => s.section ?? ""))];
          return (
            <Collapsible
              key={g.title}
              title={g.title}
              count={g.symbols.filter((s) => !s.path.endsWith(".none")).length}
              hint={g.hint}
              open={isOpen(g.title, usable)}
              onToggle={() => toggle(g.title, usable)}
              level={0}
            >
              {sections.map((sec) => {
                const rows = g.symbols
                  .filter((s) => (s.section ?? "") === sec)
                  .map((s) => (
                    <SymbolRow
                      key={s.path}
                      sym={s}
                      kind={kind}
                      onPick={onPick}
                      compact={compact}
                      value={sample ? getPath(sample, s.path) : undefined}
                    />
                  ));
                if (sec === "") return <div key="-" className="ml-3">{rows}</div>;
                const key = `${g.title}/${sec}`;
                return (
                  <Collapsible
                    key={key}
                    title={sec}
                    count={rows.length}
                    open={isOpen(key, false)}
                    onToggle={() => toggle(key, false)}
                    level={1}
                  >
                    <div className="ml-3">{rows}</div>
                  </Collapsible>
                );
              })}
            </Collapsible>
          );
        })}
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {groups.length === 0 ? (emptyText ?? "Nothing to insert here.") : "No match."}
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
                        <p className="text-[10px] text-amber-600">
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


/** What the copilot is told about the field's data: every entry with its ref, value and availability. */
function vocabularyForCopilot(
  groups: FormulaGroup[],
  kind: FormulaKind,
  sample: Record<string, unknown>,
): Array<{ title: string; entries: Array<{ ref: string; description?: string; value?: unknown; unavailable?: string }> }> {
  return groups.map((g) => ({
    title: g.title,
    entries: g.symbols
      .filter((sym) => !sym.path.endsWith(".none"))
      .map((sym) => {
        const pinned = getPath(sample, sym.path);
        const value = pinned !== undefined ? pinned : sym.example;
        return {
          ref: sym.label && sym.type === "function" ? sym.label : (sym.insert ?? snippet(sym.path, kind)),
          ...(sym.description ? { description: sym.description } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(sym.unavailable !== undefined ? { unavailable: sym.unavailable } : {}),
        };
      }),
  }));
}

type CopilotState =
  | { state: "idle" }
  | { state: "asking" }
  | { state: "proposal"; expression: string; explanation: string; changed: boolean }
  | { state: "error"; message: string };

/** "cursor at line 3, column 5" or "selected “…”" for the copilot hint. */
export function describeEditorSelection(value: string, sel: { start: number; end: number }): string {
  const start = Math.min(sel.start, sel.end);
  const end = Math.max(sel.start, sel.end);
  if (start === end) {
    const before = value.slice(0, start);
    const line = before.split("\n").length;
    const column = start - before.lastIndexOf("\n");
    return start === value.length ? "cursor at the end" : `cursor at line ${line}, column ${column}`;
  }
  const t = value.slice(start, end).replace(/\s+/g, " ");
  return `selected “${t.length > 50 ? `${t.slice(0, 49)}…` : t}”`;
}

/**
 * The builder's copilot: writes or changes the field from an instruction,
 * using exactly the data the builder offers (with pinned values) and the
 * field's grammar. The proposal — already checked by the runtime — is shown
 * as a diff against the current value and applied only on Accept.
 */
function ExpressionCopilot({
  kind,
  field,
  current,
  groups,
  sample,
  variables,
  token,
  selection,
  onAccept,
}: {
  kind: FormulaKind;
  field: string;
  current: string;
  groups: FormulaGroup[];
  sample: Record<string, unknown>;
  variables: Record<string, unknown> | undefined;
  token: string | undefined;
  /** Caret or selected range in the editor; "here" / "this" in the instruction refer to it. */
  selection?: { start: number; end: number } | null;
  onAccept: (next: string) => void;
}): React.JSX.Element {
  const [instruction, setInstruction] = useState("");
  const [useSelection, setUseSelection] = useState(true);
  const sel =
    selection && selection.start <= current.length && selection.end <= current.length ? selection : null;
  const selectionLabel = sel ? describeEditorSelection(current, sel) : null;
  const [st, setSt] = useState<CopilotState>({ state: "idle" });
  const base = useRef(current);
  // Run-time placeholders are usable here when the builder offers any of them.
  const runtimeAllowed =
    kind === "vars" &&
    groups.some((g) =>
      g.symbols.some((sym) => /^(context|node|turn|classification|classLabel|query|now)\b/.test(sym.path) && sym.unavailable === undefined),
    );

  const ask = (): void => {
    if (!instruction.trim() || st.state === "asking") return;
    base.current = current;
    setSt({ state: "asking" });
    fetch(backendUrl("/flows/expressions/copilot"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        kind,
        field,
        current,
        instruction,
        vocabulary: vocabularyForCopilot(groups, kind, sample),
        variables: variables ?? {},
        runtimeAllowed,
        ...(sel && useSelection ? { selection: sel } : {}),
      }),
    })
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as
          | { ok: true; expression: string; explanation: string; changed: boolean }
          | { ok: false; message: string }
          | { error?: { message?: string } }
          | null;
        if (body && "ok" in body && body.ok) {
          setSt({ state: "proposal", expression: body.expression, explanation: body.explanation, changed: body.changed });
        } else {
          const message =
            (body && "message" in body && body.message) ||
            (body && "error" in body && body.error?.message) ||
            `HTTP ${r.status}`;
          setSt({ state: "error", message: String(message) });
        }
      })
      .catch((e: unknown) => setSt({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  };

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/50 p-2 dark:border-violet-900 dark:bg-violet-950/20">
      <div className="flex items-center gap-1.5">
        <Sparkles size={13} aria-hidden className="shrink-0 text-violet-600" />
        <input
          aria-label="Ask the expression copilot"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              ask();
            }
          }}
          placeholder={
            kind === "condition"
              ? "Describe the condition, e.g. “route is RETOURE or the user asks about parking”"
              : "Describe what to write or change, e.g. “half of the worker budget, rounded”"
          }
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="button"
          onClick={ask}
          disabled={!instruction.trim() || st.state === "asking"}
          className="rounded bg-violet-600 px-2 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {st.state === "asking" ? "Thinking…" : "Ask"}
        </button>
      </div>
      {selectionLabel && (
        <label
          className="mt-1 flex items-center gap-1.5 pl-5 text-[11px] text-muted-foreground"
          title="Send the cursor / selection so “here” or “this part” refer to it"
          data-testid="expression-copilot-selection"
        >
          <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} />
          <span className="shrink-0">Refers to:</span>
          <span className={`truncate ${useSelection ? "text-foreground" : "line-through"}`}>{selectionLabel}</span>
        </label>
      )}
      {st.state === "error" && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-600">
          {st.message}
        </p>
      )}
      {st.state === "proposal" && (
        <div className="mt-2 space-y-1.5" aria-label="Copilot proposal">
          <p className="text-[11px] text-foreground">{st.explanation}</p>
          {st.changed ? (
            <DiffView before={base.current} after={st.expression} />
          ) : (
            <p className="text-[11px] italic text-muted-foreground">No change proposed.</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setSt({ state: "idle" })}
              className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
            >
              Discard
            </button>
            {st.changed && (
              <button
                type="button"
                onClick={() => {
                  onAccept(st.expression);
                  setSt({ state: "idle" });
                  setInstruction("");
                }}
                className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
              >
                Accept
              </button>
            )}
          </div>
          {current !== base.current && (
            <p className="text-[10px] text-amber-600">
              The field changed since you asked — Accept replaces it with the proposal.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Before → after, removed parts struck through in red, added parts in green. */
export function DiffView({
  before,
  after,
  ariaLabel = "Proposed change",
}: {
  before: string;
  after: string;
  ariaLabel?: string;
}): React.JSX.Element {
  const parts = useMemo(() => diffText(before, after), [before, after]);
  return (
    <pre
      aria-label={ariaLabel}
      className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-[11px] leading-relaxed"
    >
      {parts.map((p, i) =>
        p.type === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.type === "del" ? (
          <del key={i} className="bg-red-100 text-red-800 decoration-red-500 dark:bg-red-950/50 dark:text-red-300">
            {p.text}
          </del>
        ) : (
          <ins key={i} className="bg-green-100 text-green-800 no-underline dark:bg-green-950/50 dark:text-green-300">
            {p.text}
          </ins>
        ),
      )}
    </pre>
  );
}

/** Pick a recorded run of the flow whose values fill the previews (📌 pinned). */
export function RunPicker({ runs, className = "ml-4" }: { runs: RunsContext; className?: string }): React.JSX.Element {
  const [list, setList] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setError(null);
    fetchFlowRuns(runs.flowId, runs.token).then(setList, (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  }, [runs.flowId, runs.token]);
  useEffect(load, [load]);
  const choose = (id: string): void => {
    if (id === "") {
      runs.onPin(null);
      return;
    }
    setBusy(true);
    setError(null);
    fetchRunSample(id, runs.token).then(
      (run) => {
        runs.onPin(run);
        setBusy(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };
  const label = (r: { started_at?: string; startedAt?: string; preview: string; flow_id?: string | null; flowId?: string | null }): string => {
    const at = new Date(r.started_at ?? r.startedAt ?? "").toLocaleString(undefined, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const studio = isStudioRun(r.flow_id ?? r.flowId ?? null) ? "Studio test · " : "";
    return `${studio}${at} · ${r.preview || "(no message)"}`;
  };
  const pinned = runs.pinned;
  const options = [...(list ?? [])];
  if (pinned && !options.some((r) => r.execution_id === pinned.executionId)) {
    options.unshift({
      execution_id: pinned.executionId,
      flow_id: pinned.flowId,
      started_at: pinned.startedAt,
      status: "completed",
      preview: pinned.preview,
    });
  }
  return (
    <div className={`${className} flex min-w-0 items-center gap-1.5 text-[11px]`}>
      <span className="shrink-0 text-muted-foreground" title="Values of a recorded run fill the previews and the tree">
        📌 Sample data
      </span>
      <select
        aria-label="Pinned run"
        value={pinned?.executionId ?? ""}
        disabled={busy}
        onChange={(e) => choose(e.target.value)}
        className="min-w-0 max-w-[26rem] truncate rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
      >
        <option value="">— none (example values) —</option>
        {options.map((r) => (
          <option key={r.execution_id} value={r.execution_id}>
            {label(r)}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={load}
        title="Reload the list of runs (run the flow in Run & Trace to add one)"
        className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        ↻
      </button>
      {list !== null && list.length === 0 && !pinned && (
        <span className="text-muted-foreground">No runs yet — run the flow in Run &amp; Trace.</span>
      )}
      {error && <span role="alert" className="truncate text-red-600">{error}</span>}
    </div>
  );
}

type OperatorCategory = "start" | "arithmetic" | "comparison" | "logic" | "text" | "other";

function operatorCategory(text: string): OperatorCategory {
  const t = text.trim();
  if (t.startsWith("{{=")) return "start";
  if (["+", "-", "*", "/", "%"].includes(t)) return "arithmetic";
  if (["==", "!=", ">", ">=", "<", "<="].includes(t)) return "comparison";
  if (["&&", "||", "!"].includes(t)) return "logic";
  if (t.startsWith(".") || t.startsWith("=~")) return "text";
  return "other";
}

const CATEGORY_STYLE: Record<OperatorCategory, string> = {
  start: "border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  arithmetic: "hover:bg-purple-50 hover:text-purple-700 dark:hover:bg-purple-900/30 dark:hover:text-purple-300",
  comparison: "hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-blue-900/30 dark:hover:text-blue-300",
  logic: "hover:bg-green-50 hover:text-green-700 dark:hover:bg-green-900/30 dark:hover:text-green-300",
  text: "hover:bg-pink-50 hover:text-pink-700 dark:hover:bg-pink-900/30 dark:hover:text-pink-300",
  other: "hover:bg-muted",
};

const CATEGORY_ORDER: OperatorCategory[] = ["start", "arithmetic", "comparison", "logic", "text", "other"];

/** Operators grouped by category (colour-coded), plus a Clear action. */
function OperatorToolbar({
  label,
  operators,
  onInsert,
  onClear,
}: {
  label: string;
  operators: Array<{ text: string; label: string; description: string }>;
  onInsert: (text: string) => void;
  onClear: () => void;
}): React.JSX.Element {
  const byCategory = CATEGORY_ORDER.map((c) => operators.filter((o) => operatorCategory(o.text) === c)).filter(
    (g) => g.length > 0,
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={label}>
      {byCategory.map((ops, i) => (
        <div key={ops[0]?.label ?? i} className={`flex flex-wrap gap-1 ${i > 0 ? "border-l border-border pl-1.5" : ""}`}>
          {ops.map((op) => (
            <button
              type="button"
              key={op.label}
              title={op.description}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(op.text)}
              className={`min-w-[28px] rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] transition-colors ${CATEGORY_STYLE[operatorCategory(op.text)]}`}
            >
              {op.label}
            </button>
          ))}
        </div>
      ))}
      <button
        type="button"
        onClick={onClear}
        title="Clear the expression"
        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
      >
        <Eraser size={12} aria-hidden />
        Clear
      </button>
    </div>
  );
}

const EXAMPLES: Record<FormulaKind, string[]> = {
  condition: [
    "classification.route == 'RETOURE'",
    "groups.includes('staff') && language == 'de'",
    "lastMessageText =~ 'parkplatz|stellplatz'",
    "!hasErrors && messageCount > 2",
  ],
  template: [
    "Hallo {{context.userName}}, heute ist {{now.weekday}}, der {{now.date}}.",
    "{{classification.client}}",
    "{{= round(vars.max_tokens / 2) }}",
  ],
  vars: [
    "{{const.research_max_tokens}}",
    "{{= round(vars.max_tokens * 0.8) }}",
    "{{= vars.language == 'de' ? 'Hallo' : 'Hello' }}",
    "{{= concat('flow-', env.FLOW_PUBLIC_ENVIRONMENT) }}",
  ],
};

/** Clickable examples and a short guide (conditions or calculations). */
function BuilderHelp({
  kind,
  calculations,
  functions,
  onInsert,
  onInsertFunction,
}: {
  kind: FormulaKind;
  calculations: boolean;
  functions: Array<{ text: string; label: string; description: string }>;
  onInsert: (text: string) => void;
  /** Inserts a function — bare inside a calculation, else wrapped in {{= }}. */
  onInsertFunction: (fn: string) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2 text-[11px]">
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Examples</p>
        <div className="flex flex-wrap gap-1">
          {EXAMPLES[kind].map((ex) => (
            <button
              type="button"
              key={ex}
              title="Insert this example"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(ex)}
              className="rounded bg-muted px-1.5 py-0.5 text-left font-mono text-[10px] hover:bg-muted/70"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
      {kind === "condition" ? (
        <details className="rounded border border-border p-2">
          <summary className="cursor-pointer font-medium">How conditions work</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>Names read the run state: classification fields, node results, user and request data, run state (see the tree).</li>
            <li>Text in single quotes: <code>route == 'RETOURE'</code>. Combine with <code>&amp;&amp;</code>, <code>||</code>, <code>!</code> and parentheses.</li>
            <li><code>=~</code> is a case-insensitive regex match; <code>.includes()</code>, <code>.startsWith()</code>, <code>.endsWith()</code>, <code>.length</code> work on text and lists.</li>
            <li>Flow variables and constants are replaced textually when the flow loads — quote text: <code>'{"{{vars.x}}"}'</code>.</li>
            <li>An empty condition means: always follow this edge.</li>
          </ul>
        </details>
      ) : (
        calculations && (
          <details className="rounded border border-border p-2">
            <summary className="cursor-pointer font-medium">How calculations work</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
              <li>
                Wrap a calculation in <code>{"{{= … }}"}</code>, e.g. <code>{"{{= round(vars.max_tokens / 2) }}"}</code>.
              </li>
              <li>
                Inside it, write references without braces: <code>vars.x</code>, <code>const.y</code>, <code>env.FLOW_PUBLIC_Z</code>; text in single quotes.
              </li>
              <li>
                Operators: <code>+ - * / %</code> (<code>+</code> joins text), comparisons, <code>&amp;&amp; || !</code>, and <code>a ? b : c</code>.
              </li>
              <li>
                Evaluated once when the flow loads — it cannot read run-time values such as <code>context.*</code> or <code>classification.*</code>.
              </li>
              <li>If the whole field is one calculation, the result keeps its type (a number stays a number).</li>
            </ul>
            {functions.length > 0 && (
              <table className="mt-2 w-full text-[10px]">
                <tbody>
                  {functions.map((fn) => (
                    <tr key={fn.label} className="align-top">
                      <td className="py-0.5 pr-2">
                        <button
                          type="button"
                          title="Insert"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => onInsertFunction(fn.text)}
                          className="font-mono text-primary hover:underline"
                        >
                          {fn.label}
                        </button>
                      </td>
                      <td className="py-0.5 text-muted-foreground">{fn.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        )
      )}
    </div>
  );
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

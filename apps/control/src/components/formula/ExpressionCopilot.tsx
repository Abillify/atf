"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: expression copilot (suggestion by instruction, diff, accept), moved
// out of FormulaEditor.tsx without behavior change.

import type React from "react";
import { useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { request } from "../../lib/control-api";
import { getPath, type FormulaGroup, type FormulaKind } from "../../lib/formula";
import { snippet } from "./formulaUtils";
import { DiffView } from "./DiffView";

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
export function ExpressionCopilot({
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
    // Req 9.2: lib/control-api; request() because the {ok:...} body is read
    // regardless of the HTTP status (rejections arrive as non-2xx with a body).
    request("/flows/expressions/copilot", {
      method: "POST",
      target: "backend",
      token,
      headers: { "Content-Type": "application/json" },
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
    <div className="rounded-md border border-copilot-border bg-copilot-soft p-2 dark:border-copilot-border dark:bg-copilot-soft">
      <div className="flex items-center gap-1.5">
        <Sparkles size={13} aria-hidden className="shrink-0 text-copilot" />
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
          className="rounded bg-copilot-solid px-2 py-1 text-xs font-medium text-on-solid hover:bg-copilot-solid-hover disabled:opacity-50"
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
          <input
            type="checkbox"
            checked={useSelection}
            onChange={(e) => setUseSelection(e.target.checked)}
          />
          <span className="shrink-0">Refers to:</span>
          <span
            className={`truncate ${useSelection ? "text-foreground" : "line-through"}`}
          >
            {selectionLabel}
          </span>
        </label>
      )}
      {st.state === "error" && (
        <p role="alert" className="mt-1.5 text-[11px] text-danger">
          {st.message}
        </p>
      )}
      {st.state === "proposal" && (
        // biome-ignore lint/a11y/useSemanticElements: labelled proposal container — <fieldset> is for form controls and would be wrong here
        <div
          className="mt-2 space-y-1.5"
          aria-label="Copilot proposal"
          role="group"
        >
          <p className="text-[11px] text-foreground">{st.explanation}</p>
          {st.changed ? (
            <DiffView before={base.current} after={st.expression} />
          ) : (
            <p className="text-[11px] italic text-muted-foreground">
              No change proposed.
            </p>
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
            <p className="text-[10px] text-warning">
              The field changed since you asked — Accept replaces it with the
              proposal.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: builder help (examples + short guide), moved out of FormulaEditor.tsx
// without behavior change.

import type React from "react";
import type { FormulaKind } from "../../lib/formula";

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
export function BuilderHelp({
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

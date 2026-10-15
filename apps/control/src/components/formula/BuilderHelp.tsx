"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: builder help (examples + short guide), moved out of FormulaEditor.tsx
// without behavior change.

import type React from "react";
import type { FormulaKind } from "../../lib/formula";
import { translate } from "../../lib/i18n";

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
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{translate("builderHelp.examples")}</p>
        <div className="flex flex-wrap gap-1">
          {EXAMPLES[kind].map((ex) => (
            <button
              type="button"
              key={ex}
              title={translate("builderHelp.insertThisSample")}
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
          <summary className="cursor-pointer font-medium">{translate("builderHelp.howConditionsWork")}</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>{translate("builderHelp.namesReadTheRunState")}</li>
            <li>{translate("builderHelp.textInSingleQuotes")} <code>route == 'RETOURE'</code>{translate("builderHelp.combineWith")} <code>&amp;&amp;</code>, <code>||</code>, <code>!</code> {translate("builderHelp.andParentheses")}</li>
            <li><code>=~</code> {translate("builderHelp.isACaseInsensitiveRegex")} <code>.includes()</code>, <code>.startsWith()</code>, <code>.endsWith()</code>, <code>.length</code> {translate("builderHelp.workOnTextAndLists")}</li>
            <li>{translate("builderHelp.flowVariablesAndConstantsAre")} <code>'{"{{vars.x}}"}'</code>.</li>
            <li>{translate("builderHelp.anEmptyConditionMeansAlways")}</li>
          </ul>
        </details>
      ) : (
        calculations && (
          <details className="rounded border border-border p-2">
            <summary className="cursor-pointer font-medium">{translate("builderHelp.howCalculationsWork")}</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
              <li>
                {translate("builderHelp.wrapACalculationIn")} <code>{"{{= … }}"}</code>, e.g. <code>{"{{= round(vars.max_tokens / 2) }}"}</code>.
              </li>
              <li>
                {translate("builderHelp.insideItWriteReferencesWithout")} <code>vars.x</code>, <code>const.y</code>, <code>env.FLOW_PUBLIC_Z</code>{translate("builderHelp.textInSingleQuotes2")}
              </li>
              <li>
                {translate("builderHelp.operators")} <code>+ - * / %</code> (<code>+</code> {translate("builderHelp.joinsTextComparisons")} <code>&amp;&amp; || !</code>{translate("builderHelp.and")} <code>a ? b : c</code>.
              </li>
              <li>
                {translate("builderHelp.evaluatedOnceWhenTheFlow")} <code>context.*</code> or <code>classification.*</code>.
              </li>
              <li>{translate("builderHelp.ifTheWholeFieldIs")}</li>
            </ul>
            {functions.length > 0 && (
              <table className="mt-2 w-full text-[10px]">
                <tbody>
                  {functions.map((fn) => (
                    <tr key={fn.label} className="align-top">
                      <td className="py-0.5 pr-2">
                        <button
                          type="button"
                          title={translate("builderHelp.insert")}
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

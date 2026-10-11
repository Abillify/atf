// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: snippet and insert helpers of the formula editor, moved out of
// FormulaEditor.tsx without behavior change.

import type { FormulaKind } from "../../lib/formula";

export const snippet = (path: string, kind: FormulaKind): string =>
  kind === "condition" ? path : `{{${path}}}`;

/** Inserts `text` at the element's selection, returning new value + caret. */
export function insertAt(
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

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: operator toolbar (categorized, color-coded), moved out of
// FormulaEditor.tsx without behavior change.

import type React from "react";
import { Eraser } from "lucide-react";
import { translate } from "../../lib/i18n";

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
  start: "border-warning-border bg-warning-soft text-warning hover:bg-warning-soft dark:border-warning-border dark:bg-warning-soft dark:text-warning",
  arithmetic: "hover:bg-copilot-soft hover:text-copilot dark:hover:bg-copilot-solid-hover/30 dark:hover:text-copilot",
  comparison: "hover:bg-info-soft hover:text-info dark:hover:bg-info-solid-hover/30 dark:hover:text-info",
  logic: "hover:bg-success-soft hover:text-success dark:hover:bg-success-solid-hover/30 dark:hover:text-success",
  text: "hover:bg-accent-2-soft hover:text-accent-2 dark:hover:bg-accent-2-solid-hover/30 dark:hover:text-accent-2",
  other: "hover:bg-muted",
};

const CATEGORY_ORDER: OperatorCategory[] = ["start", "arithmetic", "comparison", "logic", "text", "other"];

/** Operators grouped by category (colour-coded), plus a Clear action. */
export function OperatorToolbar({
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
        title={translate("operatorToolbar.clearTheExpression")}
        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger hover:bg-danger-soft dark:hover:bg-danger-solid-hover/20"
      >
        <Eraser size={12} aria-hidden />
        {translate("operatorToolbar.clear")}
      </button>
    </div>
  );
}

"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

// Req 9.3: result views (value / condition check), moved out of
// FormulaEditor.tsx without behavior change.

import type React from "react";

export type ConditionCheck =
  | { state: "idle" | "checking" }
  | { state: "done"; valid: true; result: boolean; empty?: boolean }
  | { state: "done"; valid: false; error: string }
  | { state: "offline"; error: string };

export function ValueResult({
  result,
}: {
  result: { state: "idle" | "checking" } | { state: "done"; value?: unknown; error?: string };
}): React.JSX.Element {
  if (result.state !== "done") return <p className="text-[11px] text-muted-foreground">Evaluating…</p>;
  if (result.error) {
    return (
      <p role="alert" className="rounded border border-danger-border bg-danger-soft p-2 text-[11px] text-danger">
        {result.error}
      </p>
    );
  }
  const v = result.value;
  const type = Array.isArray(v) ? "list" : v === null ? "null" : typeof v;
  return (
    <div className="space-y-1">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-success-border bg-success-soft p-2 font-mono text-[12px] text-success dark:bg-success-soft dark:text-success">
        {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
      </pre>
      <p className="text-[10px] text-muted-foreground">Type: {type}</p>
    </div>
  );
}

export function ConditionResult({ check }: { check: ConditionCheck }): React.JSX.Element {
  if (check.state === "offline") {
    return <p className="text-[11px] text-muted-foreground">Live check unavailable ({check.error}).</p>;
  }
  if (check.state !== "done") {
    return <p className="text-[11px] text-muted-foreground">Checking…</p>;
  }
  if (!check.valid) {
    return (
      <p role="alert" className="rounded border border-danger-border bg-danger-soft p-2 text-[11px] text-danger">
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
        check.result ? "border-success-border bg-success-soft text-success" : "border-border bg-muted text-foreground"
      }`}
    >
      {check.result ? "true — would match with these values" : "false — would not match with these values"}
    </p>
  );
}

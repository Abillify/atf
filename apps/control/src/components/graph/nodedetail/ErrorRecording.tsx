"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool-call entry and complete error recording including the diagnostics
 * timeline (Req 9.3, Task 13.4). Split out of `graph/NodeDetailPanel.tsx`
 * without behavior change.
 */

import { useState } from "react";
import type { NodeToolCall } from "../../../types/monitoring";
import type { NodeState } from "../graphUtils";
import { AccordionSection, ChevronIcon, JsonTree } from "./Shared";
import { formatTime } from "../../../lib/i18n";

// ---------------------------------------------------------------------------
// Tool call entry (shared)
// ---------------------------------------------------------------------------

export function ToolCallEntry({ tc }: { tc: NodeToolCall }) {
  const [expanded, setExpanded] = useState(false);
  let args: Record<string, unknown> | null = null;
  try {
    args = JSON.parse(tc.args_json) as Record<string, unknown>;
  } catch {
    /* raw */
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-muted hover:bg-muted text-left"
      >
        <div>
          <span className="font-mono text-xs font-semibold text-accent">
            {tc.name}
          </span>
          {tc.exec_time_seconds != null && (
            <span className="ml-2 text-[10px] text-muted-foreground">
              {(tc.exec_time_seconds * 1000).toFixed(0)}ms
            </span>
          )}
        </div>
        <ChevronIcon open={expanded} />
      </button>
      {expanded && (
        <div className="px-3 py-2 bg-card">
          {args !== null ? (
            <dl className="space-y-1">
              {Object.entries(args).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[auto_1fr] gap-x-2 text-xs">
                  <dt className="text-muted-foreground font-mono">{k}:</dt>
                  <dd className="font-mono break-all text-foreground">
                    {typeof v === "string" ? v : JSON.stringify(v)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <pre className="text-xs text-muted-foreground break-all whitespace-pre-wrap">
              {tc.args_json}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error recording (debug-trace backed)
// ---------------------------------------------------------------------------

const DIAG_LEVEL_CLASS: Record<string, string> = {
  info: "text-info",
  warn: "text-warning",
  error: "text-danger",
};

/**
 * Full error recording for one node. The monitoring event stream only
 * carries a bare `error_message`; when the execution's debug trace is still
 * in the runtime's in-memory buffer, the node additionally carries the
 * machine-readable error type, structured error details, the in-node
 * diagnostics timeline (retries, fallbacks, tool errors), and — for a failed
 * synthetic tool node — the failing call's full result payload. Everything
 * the trace did not provide simply is not rendered, so an evicted trace
 * degrades to the plain message exactly as before.
 */
export function ErrorRecording({ state }: { state: NodeState }) {
  const hasError =
    state.error_message !== undefined ||
    state.error_type !== undefined ||
    state.error_details !== undefined ||
    state.tool_error_result !== undefined;
  const diagnostics = state.diagnostics ?? [];
  if (!hasError && diagnostics.length === 0) return null;

  return (
    <>
      {hasError && (
        <section
          className="border border-danger-border rounded-lg overflow-hidden"
          data-testid="node-error-recording"
        >
          <div className="px-3 py-2 bg-danger-soft space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-semibold text-danger uppercase tracking-wide">
                Error
              </h4>
              {state.error_type && (
                <span className="rounded bg-danger-solid/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-danger">
                  {state.error_type}
                </span>
              )}
            </div>
            {state.error_message && (
              <pre className="text-xs text-danger break-words whitespace-pre-wrap">
                {state.error_message}
              </pre>
            )}
            {state.tool_error_result !== undefined && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-danger/80">
                  Tool result
                </div>
                <div className="mt-1 max-h-48 overflow-auto rounded border border-danger-border bg-card p-2 font-mono text-[11px] text-foreground">
                  <JsonTree data={state.tool_error_result} maxDepth={6} />
                </div>
              </div>
            )}
            {state.error_details !== undefined && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-danger/80">
                  Details
                </div>
                <div className="mt-1 max-h-48 overflow-auto rounded border border-danger-border bg-card p-2 font-mono text-[11px] text-foreground">
                  <JsonTree data={state.error_details} maxDepth={6} />
                </div>
              </div>
            )}
          </div>
        </section>
      )}
      {diagnostics.length > 0 && (
        <AccordionSection
          title={`Diagnostics (${diagnostics.length})`}
          defaultOpen={state.status === "error"}
        >
          <ol className="space-y-1.5" data-testid="node-diagnostics">
            {diagnostics.map((d, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics have no id and may repeat at/code; the list is append-only
                key={`${d.at}-${d.code}-${i}`}
                className="rounded border border-border bg-muted/50 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span
                    className={`font-mono text-[10px] font-bold uppercase ${DIAG_LEVEL_CLASS[d.level] ?? DIAG_LEVEL_CLASS.info}`}
                  >
                    {d.level}
                  </span>
                  <span className="font-mono text-xs font-semibold text-foreground">
                    {d.code}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {d.at ? formatTime(new Date(d.at)) : ""}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-foreground break-words whitespace-pre-wrap">
                  {d.message}
                </div>
                {d.details !== undefined &&
                  Object.keys(d.details).length > 0 && (
                    <div className="mt-1 max-h-40 overflow-auto rounded border border-border bg-card p-1.5 font-mono text-[10px] text-foreground">
                      <JsonTree data={d.details} maxDepth={5} />
                    </div>
                  )}
              </li>
            ))}
          </ol>
        </AccordionSection>
      )}
    </>
  );
}

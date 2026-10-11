"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * JSON-aware value display (SmartValue) and findings table (Req 9.3,
 * Task 13.4). Split out of `graph/NodeDetailPanel.tsx` without
 * behavior change.
 */

import { JsonTree } from "./Shared";
import { isJsonString, stripCodeFence } from "./parsers";

/**
 * Renders text as a JSON tree when it parses as JSON (incl. JSON wrapped in a
 * ```json code fence, as LLMs/classifiers often emit), else as preformatted
 * text. Crash-safe: the `JSON.parse` is guarded so malformed-but-bracketed
 * content (e.g. a truncated payload) falls back to raw text instead of throwing
 * during render.
 */
export function SmartValue({ text }: { text: string }) {
  const candidate = stripCodeFence(text);
  if (isJsonString(candidate)) {
    try {
      return <JsonTree data={JSON.parse(candidate) as unknown} />;
    } catch {
      /* fall through to preformatted */
    }
  }
  return (
    <pre className="whitespace-pre-wrap break-words max-h-48 overflow-auto">
      {text}
    </pre>
  );
}

/** Renders a list of RAG/search findings (id, title, score) + total count. */
export function FindingsTable({
  findings,
  totalMatches,
}: {
  findings: Array<{ id?: string; title?: string; score?: number }>;
  totalMatches: number;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground font-semibold mb-1">
        Total matches: {totalMatches}
      </div>
      {findings.length === 0 ? (
        <p className="text-[10px] text-muted-foreground italic">No findings.</p>
      ) : (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {findings.map((f, i) => (
            <div
              key={f.id ?? i}
              className="flex items-start gap-2 rounded border border-border px-2 py-1 bg-muted"
            >
              <span className="text-[10px] font-mono text-muted-foreground shrink-0">
                #{i + 1}
              </span>
              <div className="flex-1 min-w-0">
                {f.title && (
                  <div className="text-xs font-medium truncate" title={f.title}>
                    {f.title}
                  </div>
                )}
                {f.id && (
                  <div
                    className="text-[10px] text-muted-foreground font-mono truncate"
                    title={f.id}
                  >
                    {f.id}
                  </div>
                )}
              </div>
              {f.score != null && (
                <span className="text-[10px] font-semibold text-success shrink-0">
                  {(f.score <= 1 ? f.score * 100 : f.score).toFixed(1)}
                  {f.score <= 1 ? "%" : ""}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

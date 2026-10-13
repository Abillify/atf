"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import type React from "react";
import type { ReplayResult } from "../types/control";
import { Badge, Button } from "../lib/ui";

export interface ReplayResultCardProps {
  result: ReplayResult | null;
  isRunning?: boolean;
  error?: string | null;
  onClear?: () => void;
}

/** Side-by-side diff of an original answer vs. its time-travel replay. */
export function ReplayResultCard({
  result,
  isRunning,
  error,
  onClear,
}: ReplayResultCardProps): React.JSX.Element | null {
  if (isRunning) {
    return (
      <div className="mb-4 rounded-lg border border-accent/30 bg-accent/10 p-4 text-sm text-accent">
        Replaying execution…
      </div>
    );
  }
  if (error) {
    return (
      <div className="mb-4 flex items-center justify-between rounded-lg border border-danger-border bg-danger-soft p-4 text-sm text-danger">
        <span>Replay failed: {error}</span>
        {onClear && (
          <Button variant="ghost" size="sm" onClick={onClear} className="underline">
            dismiss
          </Button>
        )}
      </div>
    );
  }
  if (result === null) return null;

  const pct = Math.round(result.similarity * 100);
  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">
          Replay of{" "}
          <span className="font-mono">{result.executionId.slice(0, 8)}</span>
        </h4>
        <div className="flex items-center gap-2">
          <Badge variant={result.changed ? "warning" : "success"}>
            {result.changed ? "changed" : "identical"} · {pct}% similar
          </Badge>
          {onClear && (
            <Button variant="secondary" size="sm" onClick={onClear}>
              Close
            </Button>
          )}
        </div>
      </div>
      {result.originalFlowId !== result.replayedFlowId && (
        <p className="mb-2 text-xs text-muted-foreground">
          flow <span className="font-mono">{result.originalFlowId}</span> →{" "}
          <span className="font-mono text-accent">
            {result.replayedFlowId}
          </span>
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Original
          </div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs text-foreground">
            {result.originalResponse || "—"}
          </pre>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Replayed
          </div>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-accent/10 p-2 text-xs text-foreground">
            {result.replayedResponse || "—"}
          </pre>
        </div>
      </div>
    </div>
  );
}

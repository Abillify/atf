"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * StudioProblemsPanel: validation problems of the canvas with
 * "Fix with Copilot" actions.
 * Req 9.3 (Task 13.4): moved unchanged out of StudioBuilder.
 */

import type React from "react";
import type { FlowValidationReport } from "../../types/flow";

export interface StudioProblemsPanelProps {
  validation: FlowValidationReport | null;
  otherWarnings: FlowValidationReport["warnings"];
  unknownToolsByServer: Map<string, Set<string>>;
  /** Hands the issue message to the Copilot (prefill). */
  onFixWithCopilot: (message: string) => void;
}

export function StudioProblemsPanel({
  validation,
  otherWarnings,
  unknownToolsByServer,
  onFixWithCopilot,
}: StudioProblemsPanelProps): React.JSX.Element {
  return (
    <div className="max-h-48 overflow-auto rounded border border-border bg-muted p-2 text-xs space-y-1">
      {validation?.errors.map((issue, i) => (
        <div
          key={`err-${i}`}
          className="flex items-center gap-2 text-danger"
        >
          <span className="flex-1">
            ✗ {issue.path}: {issue.message}
          </span>
          <button
            type="button"
            onClick={() => onFixWithCopilot(issue.message)}
            className="shrink-0 rounded bg-copilot-soft px-1.5 py-0.5 text-[10px] font-medium text-copilot border border-copilot-border hover:bg-copilot-soft"
          >
            Fix with Copilot
          </button>
        </div>
      ))}
      {otherWarnings.map((issue, i) => (
        <div
          key={`warn-${i}`}
          className="flex items-center gap-2 text-warning"
        >
          <span className="flex-1">
            ⚠ {issue.path}: {issue.message}
          </span>
          <button
            type="button"
            onClick={() => onFixWithCopilot(issue.message)}
            className="shrink-0 rounded bg-copilot-soft px-1.5 py-0.5 text-[10px] font-medium text-copilot border border-copilot-border hover:bg-copilot-soft"
          >
            Fix with Copilot
          </button>
        </div>
      ))}
      {unknownToolsByServer.size > 0 && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">
            ⓘ{" "}
            {[...unknownToolsByServer.values()].reduce(
              (n, t) => n + t.size,
              0,
            )}{" "}
            tool reference(s) on {unknownToolsByServer.size} MCP
            server(s) this runtime isn&apos;t connected to — not
            checkable here, not an error in the flow.
          </summary>
          <ul className="mt-1 space-y-0.5 pl-4">
            {[...unknownToolsByServer.entries()].map(([server, tools]) => (
              <li key={server}>
                <span className="font-mono text-foreground">
                  {server}
                </span>
                :{" "}
                <span className="font-mono">
                  {[...tools]
                    .map((t) => t.slice(server.length + 1) || t)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

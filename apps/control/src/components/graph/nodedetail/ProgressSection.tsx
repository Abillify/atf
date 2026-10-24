"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * ProgressSection — shows the last structured `atf.progress` event of an
 * agent-harness node (phase, tasks done/total with percent, coverage
 * counters, elapsed time and ETA) from the execution's debug trace.
 * Renders nothing for nodes without progress.
 */

import type React from "react";
import type { HarnessProgress } from "../../../types/debug-trace";
import { translate } from "../../../lib/i18n";
import { AccordionSection, KvGrid } from "./Shared";

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function ProgressSection({
  progress,
}: {
  progress: HarnessProgress | undefined;
}) {
  if (progress === undefined) return null;
  const percent =
    progress.tasksTotal > 0
      ? Math.round((progress.tasksDone / progress.tasksTotal) * 100)
      : 0;
  return (
    <AccordionSection
      title={translate("progressSection.progress")}
      badge={progress.phase}
      defaultOpen
    >
      <div className="space-y-2">
        <KvGrid
          data={[
            [
              translate("progressSection.phase"),
              <span key="phase" data-testid="progress-phase">
                {progress.phase}
              </span>,
            ] as [string, React.ReactNode],
            [
              translate("progressSection.tasks"),
              <span key="tasks" data-testid="progress-tasks">
                {progress.tasksDone} / {progress.tasksTotal} ({percent}%)
              </span>,
            ] as [string, React.ReactNode],
            ...(progress.coverage !== undefined
              ? ([
                  [
                    translate("progressSection.coverage"),
                    <span key="coverage" data-testid="progress-coverage">
                      {translate("progressSection.coverageValue", {
                        covered: progress.coverage.covered,
                        total: progress.coverage.total,
                        open: progress.coverage.open,
                      })}
                    </span>,
                  ],
                ] as [string, React.ReactNode][])
              : []),
            [
              translate("progressSection.elapsed"),
              formatMs(progress.elapsedMs),
            ] as [string, React.ReactNode],
            ...(progress.etaMs !== undefined
              ? ([
                  [
                    translate("progressSection.eta"),
                    formatMs(progress.etaMs),
                  ],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
        {progress.message !== undefined && (
          <p
            data-testid="progress-message"
            className="break-words rounded border border-border bg-muted p-2 text-xs text-foreground"
          >
            {progress.message}
          </p>
        )}
      </div>
    </AccordionSection>
  );
}

// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Coverage assignment helpers for the agent harness (Req 13.6).
 *
 * Extracted verbatim from `loop.ts`: target resolution, task labelling, and
 * issuing the next coverage-queue assignment. The ledger itself stays owned by
 * the handler (it is seeded, folded, and reported there); this module mutates
 * it through the `getLedger`/`setLedger` accessors it is given.
 *
 * @module agent-harness/loop-coverage-assignment
 */

import type { FlowNode } from "../../types/flow.js";
import type { ExecRuntime } from "../graph-engine.js";
import type {
  CoverageAssignment,
  CoverageLedger,
  CoverageQueueConfig,
} from "./coverage.js";
import {
  isCoverageTerminal,
  markCoverageAssignmentIssued,
  nextCoverageAssignment,
} from "./coverage.js";
import type { HarnessProgress } from "./types.js";

export interface CoverageAssignmentDeps {
  runtime: ExecRuntime;
  node: FlowNode;
  progress: HarnessProgress;
  coverageConfig: CoverageQueueConfig | undefined;
  plannerlessTarget: string | undefined;
  getLedger: () => CoverageLedger | undefined;
  setLedger: (ledger: CoverageLedger) => void;
}

/**
 * Builds the harness coverage-assignment helpers for one handler invocation.
 */
export const createCoverageAssignmentRuntime = ({
  runtime,
  node,
  progress,
  coverageConfig,
  plannerlessTarget,
  getLedger,
  setLedger,
}: CoverageAssignmentDeps) => {
  const coverageTargetForAssignment = (
    assignment: CoverageAssignment | undefined,
  ): string | undefined => {
    if (assignment === undefined) return plannerlessTarget;
    const configured = coverageConfig?.targets?.[assignment.mode];
    return configured ?? plannerlessTarget;
  };

  /** Human-readable task label for a coverage assignment. */
  const coverageTaskLabel = (
    assignment: CoverageAssignment,
    prefix: string,
  ): string =>
    assignment.mode === "discovery"
      ? `${prefix} discovery: targeted hybrid search`
      : `${prefix} ${assignment.mode}: ${assignment.documents.length} document(s)`;

  /**
   * Issues the next assignment with a unique monotone id. Discovery attempts
   * are counted here, but successful discovery rounds are counted only after
   * the required runtime-observed searches return successfully.
   *
   * When nothing can be issued while the queue is still non-terminal, this
   * reports the blockage once so a fail-closed stop is distinguishable from a
   * genuinely finished run.
   */
  let coverageUnassignableReported = false;
  const issueCoverageAssignment = (): CoverageAssignment | undefined => {
    const coverageLedger = getLedger();
    if (coverageLedger === undefined || coverageConfig === undefined) {
      return undefined;
    }
    const assignment = nextCoverageAssignment(coverageLedger, coverageConfig);
    if (assignment !== undefined) {
      const issued = markCoverageAssignmentIssued(
        coverageLedger,
        assignment,
      );
      setLedger(issued);
      progress.coverage = issued;
      return assignment;
    }
    // The queue owes work it can no longer hand out — an exhausted discovery
    // attempt budget, or a document whose ref/window state does not fit the
    // assignment budget. The run stays fail-closed either way, but without
    // this the only visible trace is a bare stop reason, which reads as "done"
    // rather than "blocked". Emitted once: the callers retry per iteration.
    if (
      !coverageUnassignableReported &&
      !isCoverageTerminal(coverageLedger, coverageConfig)
    ) {
      coverageUnassignableReported = true;
      const blocked = coverageLedger.documents.filter(
        (document) =>
          document.status === "open" ||
          document.status === "summary-reviewed",
      );
      runtime.onNodeDiagnostic?.(node.id, {
        level: "error",
        code: "harness_coverage_unassignable",
        message:
          "Coverage is not terminal but no further assignment could be " +
          "issued; the run stays fail-closed and reports a partial result.",
        details: {
          unsettled_documents: blocked.length,
          discovery_rounds: coverageLedger.discoveryRounds,
          required_discovery_rounds:
            coverageConfig.searchDiscovery?.rounds ?? 0,
          discovery_attempts: coverageLedger.discoveryAttempts,
          assignment_char_budget: coverageConfig.assignmentCharBudget,
        },
      });
    }
    return undefined;
  };

  return {
    coverageTargetForAssignment,
    coverageTaskLabel,
    issueCoverageAssignment,
  };
};

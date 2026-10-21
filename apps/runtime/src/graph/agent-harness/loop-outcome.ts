// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — delegation outcome folding.
 *
 * `incorporateOutcome` folds one delegation outcome into the harness
 * state: findings, citations, coverage-ledger updates, errors and
 * progress. Extracted verbatim from loop.ts (Req 13.6).
 *
 * @module agent-harness/loop-outcome
 */

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage } from "@langchain/core/messages";
import type { FlowNode } from "../../types/flow.js";
import type { Citation, StreamError } from "../../types/openai.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import type {
  CoverageAssignment,
  CoverageDocumentEvidence,
  CoverageLedger,
  CoverageQueueConfig,
  CoverageReport,
  CoverageSearchEvidence,
  CoverageSearchParseResult,
} from "./coverage.js";
import {
  applyCoverageReport,
  coverageFindingText,
  coverageSummary,
  describeCoverageReportDefect,
  freezeCoverageCandidates,
  hasRequiredHybridSearchEvidence,
  isCoverageTerminal,
  markCoverageDiscoveryCompleted,
  markCoverageQueriesObserved,
  mergeCoverageEvidence,
  novelCoverageSearchEvidence,
  parseCoverageReport,
  promoteCoverageSearchHits,
  qualifyingCoverageSearchEvidence,
  settleCoveragePhase,
} from "./coverage.js";
import {
  areNearDuplicateFindings,
  capCondensedFinding,
  condensedFindingText,
  finalAiAnswerText,
  isAiAnswer,
  isEmptyResponseFallback,
  isSubstantiveFinding,
  isTerminalBudgetErrorText,
  messageText,
  summarizeDelegateResult,
} from "./loop-findings.js";
import type { HarnessConfig, HarnessProgress, Task } from "./types.js";

/**
 * Mutable handler bindings are exposed as read/write properties; the context
 * object built in loop.ts implements them as accessors over the original
 * handler-scope `let` bindings, so the execution loop and this module always
 * observe the same values. Const helpers and accumulators are passed through.
 */
export interface OutcomeCtx {
  state: AgentState;
  coverageLedger: CoverageLedger | undefined;
  readonly currentCoverageAssignment: CoverageAssignment | undefined;
  /** Resolves the full assignment a task was created from (coverage lanes). */
  readonly assignmentForTask: (t: Task) => CoverageAssignment | undefined;
  coverageUpdates: number;
  coverageReportRejections: number;
  coverageProvenanceFailure: boolean;
  terminalBudgetFailure: boolean;
  readonly cfg: HarnessConfig;
  readonly node: FlowNode;
  readonly runtime: ExecRuntime;
  readonly errors: StreamError[];
  readonly progress: HarnessProgress;
  readonly answerMessages: BaseMessage[];
  readonly contextFindings: string[];
  readonly answerCitations: Citation[];
  readonly verificationNotes: BaseMessage[];
  readonly baseMessages: BaseMessage[];
  readonly coverageReportRejectionStreaks: Map<string, number>;
  readonly carryForward: "full" | "condensed";
  readonly coverageConfig: CoverageQueueConfig | undefined;
  readonly coverageAssignmentKey: (assignment: CoverageAssignment) => string;
  readonly maxTaskAttempts: number;
  readonly emitHarnessStatus: (text: string) => void;
}

/**
 * Folds ONE delegation outcome into the harness state.
 *
 * Extracted from the loop body because a batch produces several outcomes
 * that must be folded in TASK order (not completion order) — inlining it
 * would have meant duplicating the carryForward/citation/error handling per
 * code path. The mutable handler bindings it reads and writes
 * (`state`, `coverageLedger`, `coverageUpdates`,
 * `coverageReportRejections`, `coverageProvenanceFailure`,
 * `terminalBudgetFailure`) are threaded through `ctx`; `progress`,
 * `answerMessages`, `answerCitations` and `errors` are mutated in place.
 *
 * Returns whether this outcome carried the configured stop signal.
 */
export const incorporateOutcome = (ctx: OutcomeCtx, outcome: {
  task: Task;
  update: Partial<AgentState>;
  ok: boolean;
  coverageEvidence: CoverageDocumentEvidence[];
  searchEvidence: CoverageSearchEvidence[];
  searchParseStatuses: CoverageSearchParseResult["status"][];
  /**
   * Pre-computed report from the schema-enforced extraction call, present
   * only when `coverageQueue.structuredReport` is enabled. When set, it
   * REPLACES marker parsing of the worker text for this outcome.
   */
  coverageReportOverride?: { report: CoverageReport } | { defect: string };
}): boolean => {
  const {
    cfg,
    node,
    runtime,
    errors,
    progress,
    answerMessages,
    contextFindings,
    answerCitations,
    verificationNotes,
    baseMessages,
    coverageReportRejectionStreaks,
    carryForward,
    coverageConfig,
    coverageAssignmentKey,
    assignmentForTask,
    maxTaskAttempts,
    emitHarnessStatus,
  } = ctx;
  const {
    task: t,
    update,
    ok,
    coverageEvidence,
    searchEvidence,
    searchParseStatuses,
    coverageReportOverride,
  } = outcome;
  let signalHit = false;

  if (!ok) {
    const errorText = Array.isArray(update.errors)
      ? (update.errors as Array<{ message: string }>)
          .map((e) => e.message)
          .join("; ")
      : "Delegation failed";
    const terminalBudgetError = isTerminalBudgetErrorText(errorText);
    const safeErrorText = terminalBudgetError
      ? "Transaction budget exceeded."
      : "Delegated task failed.";

    // Retry BEFORE giving up: a delegated worker fails for transient
    // reasons (provider hiccup, a tool momentarily unavailable, an empty
    // completion from a local model) far more often than for reasons a
    // re-plan can fix. A shared budget failure is explicitly excluded: its
    // remaining allowance cannot recover during this execution.
    const attempts = t.attempts ?? 0;
    if (!terminalBudgetError && attempts < maxTaskAttempts) {
      t.attempts = attempts + 1;
      t.status = "pending";
      t.researchStatus =
        "The research step is being re-run after a technical error; a domain decision is still pending.";
      // Retain only a stable public failure category on task state. Raw
      // delegated errors may contain provider endpoints or credentials.
      t.error = safeErrorText;
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "harness_task_retry",
        message:
          `Task ${t.id} failed on attempt ${t.attempts} of ` +
          `${maxTaskAttempts + 1} and will be retried.`,
        details: {
          task_id: t.id,
          attempt: t.attempts,
          maxAttempts: maxTaskAttempts + 1,
        },
      });
      emitHarnessStatus(
        `Task ${t.id} → retry ${t.attempts}/${maxTaskAttempts} (${safeErrorText})`,
      );
      return false;
    }

    t.status = "failed";
    t.researchStatus =
      "The research step could not be completed technically; no domain decision is available.";
    t.error = safeErrorText;
    ctx.terminalBudgetFailure ||= terminalBudgetError;
    // Preserve failure control flow without copying provider/tool payloads
    // into the harness result or the execution error stream.
    if (Array.isArray(update.errors)) {
      errors.push({
        message: safeErrorText,
        type: "execution_error",
        details: { node_id: node.id, task_id: t.id },
      });
    }
    return false;
  }

  t.status = "completed";
  t.result = summarizeDelegateResult(update);

  // Incorporate the delegate's output so subsequent delegations and
  // re-plans see prior work. Strategy is governed by config.carryForward:
  //   - "condensed": carry ONLY a single condensed finding per task (the
  //     worker's final answer), rebuilt onto the immutable base context.
  //     The shared context grows by one bounded finding per iteration
  //     instead of the whole worker transcript (doc dumps, tool traffic).
  //   - "full" (default): append the worker's entire message output
  //     (legacy behaviour; context grows unbounded).
  if (update.messages) {
    const newMsgs = Array.isArray(update.messages)
      ? update.messages
      : [update.messages];
    let findingMsgs = newMsgs;
    const assignment = assignmentForTask(t);
    if (
      coverageConfig !== undefined &&
      ctx.coverageLedger !== undefined &&
      assignment !== undefined &&
      assignment.id === t.coverageAssignmentId
    ) {
      if (coverageEvidence.length > 0) {
        const evidenceStateBefore = JSON.stringify(
          ctx.coverageLedger.documents.map((document) => ({
            ref: document.ref,
            totalChars: document.totalChars,
            modified: document.modified,
            windows: document.windows,
          })),
        );
        ctx.coverageLedger = mergeCoverageEvidence(
          ctx.coverageLedger,
          coverageEvidence,
        );
        const evidenceStateAfter = JSON.stringify(
          ctx.coverageLedger.documents.map((document) => ({
            ref: document.ref,
            totalChars: document.totalChars,
            modified: document.modified,
            windows: document.windows,
          })),
        );
        if (evidenceStateAfter !== evidenceStateBefore)
          ctx.coverageUpdates += 1;
        progress.coverage = ctx.coverageLedger;
      }
      const workerText = condensedFindingText(newMsgs);
      // Coverage reports are a strict final-turn protocol. Findings may span
      // multiple turns, but aggregating them here turns valid final reports
      // into invalid multi-marker blobs whenever the worker had an interim
      // answer before its final report.
      const finalWorkerText = finalAiAnswerText(newMsgs);
      // Report acquisition has two contracts:
      //   - structuredReport: the report was already produced by the
      //     schema-enforced extraction call (coverageReportOverride).
      //   - marker contract: parse it from the worker's final text.
      // A discovery assignment decides nothing, so it owes no report; its
      // value is the observed search provenance handled above.
      const structuredMode = coverageReportOverride !== undefined;
      const parsed =
        assignment.mode === "discovery"
          ? undefined
          : structuredMode
            ? "report" in coverageReportOverride
              ? {
                  report: coverageReportOverride.report,
                  findingText: "",
                }
              : undefined
            : parseCoverageReport(
                finalWorkerText,
                assignment,
                coverageConfig.markers,
              );
      // Keep report JSON private. `coverageFindingText` deliberately uses
      // the aggregate so all pre-report factual findings remain available.
      // In structured mode the whole worker text is the finding (the report
      // is delivered out-of-band, not inline), so no marker split applies.
      const finding = structuredMode
        ? workerText
        : coverageFindingText(workerText, coverageConfig.markers);
      findingMsgs = finding === "" ? [] : [new AIMessage(finding)];
      if (parsed !== undefined) {
        coverageReportRejectionStreaks.delete(coverageAssignmentKey(assignment));
        const applied = applyCoverageReport(
          ctx.coverageLedger,
          assignment,
          parsed.report,
          searchEvidence,
          coverageConfig.mode === "staged"
            ? undefined
            : coverageConfig.hybridSearch,
          coverageConfig.mode === "staged",
        );
        ctx.coverageLedger = applied.ledger;
        progress.coverage = ctx.coverageLedger;
        ctx.coverageUpdates += applied.changed;
        if (applied.rejectedRefs.length > 0) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "harness_coverage_windows_incomplete",
            message:
              `Task ${t.id} reported terminal original decisions without ` +
              `gap-free runtime-observed get_document coverage; status stayed open.`,
            details: {
              task_id: t.id,
              assignment_id: assignment.id,
              rejected_document_count: applied.rejectedRefs.length,
            },
          });
        }
        if (applied.rejectedSearchRefs.length > 0) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "harness_coverage_hybrid_search_incomplete",
            message:
              `Task ${t.id} reported terminal original decisions without ` +
              `the required runtime-observed complementary hybrid searches; status stayed open.`,
            details: {
              task_id: t.id,
              assignment_id: assignment.id,
              rejected_document_count: applied.rejectedSearchRefs.length,
              observed_search_count: searchEvidence.length,
              hyde_search_count: searchEvidence.filter((item) => item.hyde)
                .length,
              grouped_search_count: searchEvidence.filter(
                (item) => item.groupByDocument,
              ).length,
            },
          });
        }
        if (applied.rejectedUnexpectedSearchRefs.length > 0) {
          runtime.onNodeDiagnostic?.(node.id, {
            level: "warn",
            code: "harness_coverage_unexpected_original_search",
            message:
              `Task ${t.id} used search during a staged original analysis; ` +
              "the terminal decision was rejected and the document stays open.",
            details: {
              task_id: t.id,
              assignment_id: assignment.id,
              rejected_document_count:
                applied.rejectedUnexpectedSearchRefs.length,
              observed_search_count: searchEvidence.length,
            },
          });
        }
      } else if (assignment.mode !== "discovery") {
        // In structured mode the extraction call already classified the
        // failure (schema-invalid object, empty output, or a decode error);
        // use that code. Otherwise fall back to the marker-defect classifier.
        const defect =
          structuredMode && coverageReportOverride !== undefined
            ? "defect" in coverageReportOverride
              ? coverageReportOverride.defect
              : "structured_output_failed"
            : describeCoverageReportDefect(
                finalWorkerText,
                assignment,
                coverageConfig.markers,
              );
        // The gate refused the report, so the assignment stays open and comes
        // back in the very next pass unchanged: whatever else the batch did,
        // this document did not move. Counted against
        // `maxStagnantIterations` below so the refusal cannot be masked by an
        // unrelated task's progress in the same batch.
        ctx.coverageReportRejections += 1;
        const assignmentKey = coverageAssignmentKey(assignment);
        const rejectionStreak =
          (coverageReportRejectionStreaks.get(assignmentKey) ?? 0) + 1;
        coverageReportRejectionStreaks.set(assignmentKey, rejectionStreak);
        runtime.onNodeDiagnostic?.(node.id, {
          level: "warn",
          code: "harness_coverage_report_invalid",
          message:
            `Task ${t.id} did not return a valid coverage report; ` +
            `coverage status was not changed (rule: ${defect}).`,
          details: {
            task_id: t.id,
            assignment_mode: assignment.mode,
            rejection_streak: rejectionStreak,
            defect_code: defect,
          },
        });
      }

      if (
        assignment.mode === "discovery" &&
        searchParseStatuses.includes("unparseable-success")
      ) {
        const message =
          `Task ${t.id} received a successful search response whose provenance ` +
          "could not be parsed; discovery stopped without retrying or invoking verification.";
        ctx.coverageProvenanceFailure = true;
        t.status = "failed";
        t.error = message;
        errors.push({
          message,
          type: "execution_error",
          details: {
            node_id: node.id,
            task_id: t.id,
            assignment_id: assignment.id,
            parse_statuses: searchParseStatuses,
          },
        });
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "harness_coverage_search_provenance_unparseable",
          message,
          details: {
            task_id: t.id,
            assignment_id: assignment.id,
            parse_statuses: searchParseStatuses,
          },
        });
        return false;
      }

      let discoveryCompleted = false;
      let promotionEvidence = searchEvidence;
      if (assignment.mode === "discovery") {
        const allNovelEvidence = novelCoverageSearchEvidence(
          ctx.coverageLedger,
          searchEvidence,
        );
        const expansionQueryLimit =
          coverageConfig.mode === "staged" &&
          (assignment.discoveryGeneration ?? 0) > 0
            ? coverageConfig.searchDiscovery
                ?.maxQueriesPerExpansionRound ?? Number.POSITIVE_INFINITY
            : Number.POSITIVE_INFINITY;
        const exceededExpansionQueryLimit =
          allNovelEvidence.length > expansionQueryLimit;
        const novelEvidence = allNovelEvidence.slice(0, expansionQueryLimit);
        const qualifiedEvidence = qualifyingCoverageSearchEvidence(
          novelEvidence,
          coverageConfig.hybridSearch,
        );
        if (coverageConfig.mode === "staged") {
          promotionEvidence = qualifiedEvidence;
        }
        discoveryCompleted =
          !exceededExpansionQueryLimit &&
          novelEvidence.length > 0 &&
          (coverageConfig.mode !== "staged" ||
            qualifiedEvidence.length === novelEvidence.length) &&
          hasRequiredHybridSearchEvidence(
            qualifiedEvidence,
            coverageConfig.hybridSearch,
          );
        if (discoveryCompleted) {
          ctx.coverageLedger = markCoverageDiscoveryCompleted(
            ctx.coverageLedger,
            qualifiedEvidence,
          );
          progress.coverage = ctx.coverageLedger;
          ctx.coverageUpdates += 1;
        } else {
          runtime.onNodeDiagnostic?.(node.id, {
            level: exceededExpansionQueryLimit ? "error" : "warn",
            code: exceededExpansionQueryLimit
              ? "harness_coverage_expansion_query_overflow"
              : "harness_coverage_discovery_incomplete",
            message: exceededExpansionQueryLimit
              ? `Task ${t.id} exceeded the configured expansion query limit; ` +
                "the discovery generation remains open fail-closed."
              : `Task ${t.id} did not produce the required successful, globally new ` +
                "complementary hybrid searches; the discovery round remains open.",
            details: {
              task_id: t.id,
              assignment_id: assignment.id,
              previous_search_count:
                ctx.coverageLedger.discoverySearches.length,
              observed_search_count: searchEvidence.length,
              novel_search_count: novelEvidence.length,
              hyde_search_count: searchEvidence.filter((item) => item.hyde)
                .length,
              grouped_search_count: searchEvidence.filter(
                (item) => item.groupByDocument,
              ).length,
              expansion_query_limit:
                Number.isFinite(expansionQueryLimit)
                  ? expansionQueryLimit
                  : null,
              expansion_query_limit_exceeded:
                exceededExpansionQueryLimit,
            },
          });
        }
        // Every staged query is globally consumed, including capped or
        // incomplete expansion attempts; retries must use a new perspective.
        // Legacy retries intentionally preserve their prior semantics.
        if (coverageConfig.mode === "staged") {
          ctx.coverageLedger = markCoverageQueriesObserved(
            ctx.coverageLedger,
            searchEvidence,
          );
          progress.coverage = ctx.coverageLedger;
        }
      }

      // Apply search promotion AFTER the summary report. This ordering is
      // deliberate: if a ref appears in both, the search hit wins and the
      // summary-only exclusion cannot immediately undo original review.
      const promotion = coverageConfig.searchDiscovery;
      if (
        promotion !== undefined &&
        promotionEvidence.length > 0 &&
        (coverageConfig.mode !== "staged" ||
          (assignment.mode === "discovery" && discoveryCompleted))
      ) {
        const promoted = promoteCoverageSearchHits(
          ctx.coverageLedger,
          promotionEvidence,
          promotion.maxHitsPerPass,
          coverageConfig.mode === "staged"
            ? promotion.rerankScoreThreshold
            : undefined,
        );
        ctx.coverageLedger = promoted.ledger;
        progress.coverage = ctx.coverageLedger;
        const candidateCount = new Set(
          promotionEvidence.flatMap((item) => item.resultRefs),
        ).size;
        const queuedForOriginalReview = ctx.coverageLedger.documents.filter(
          (document) => document.status === "summary-reviewed",
        ).length;
        const selectionRule =
          coverageConfig.mode === "staged" &&
          promotion.rerankScoreThreshold !== undefined
            ? `rerank score >= ${promotion.rerankScoreThreshold} (rank fallback: top ${promotion.maxHitsPerPass} per search pass without rerank)`
            : `top ${promotion.maxHitsPerPass} per search pass`;
        emitHarnessStatus(
          `Candidate selection: ${candidateCount} candidate documents · ` +
            `${selectionRule} · ${promoted.selectedRefs.length} considered · ` +
            `${promoted.promotedRefs.length} newly queued · ` +
            `${queuedForOriginalReview} queued for original review in total`,
        );
        if (promoted.promotedRefs.length > 0) {
          ctx.coverageUpdates += promoted.promotedRefs.length;
          runtime.onNodeDiagnostic?.(node.id, {
            level: "info",
            code: "harness_coverage_search_promoted",
            message:
              `Task ${t.id} promoted ${promoted.promotedRefs.length} document(s) ` +
              "to original review from targeted search hits.",
            details: {
              task_id: t.id,
              assignment_id: assignment.id,
              promoted_document_count: promoted.promotedRefs.length,
            },
          });
        }
      }

      if (
        coverageConfig.mode === "staged" &&
        assignment.mode === "discovery" &&
        discoveryCompleted
      ) {
        const frozen = freezeCoverageCandidates(
          ctx.coverageLedger,
          coverageConfig.searchDiscovery?.maxCandidates,
        );
        ctx.coverageLedger = frozen.ledger;
        progress.coverage = ctx.coverageLedger;
        runtime.onNodeDiagnostic?.(node.id, {
          level: frozen.overflowRefs.length > 0 ? "error" : "info",
          code:
            frozen.overflowRefs.length > 0
              ? "harness_coverage_candidate_overflow"
              : "harness_coverage_candidates_frozen",
          message:
            frozen.overflowRefs.length > 0
              ? "Staged candidate budget overflowed; completeness remains fail-closed."
              : `Staged candidate generation ${assignment.discoveryGeneration ?? 0} frozen.`,
          details: {
            assignment_id: assignment.id,
            generation: assignment.discoveryGeneration ?? 0,
            frozen_document_count: frozen.frozenRefs.length,
            expansion_seed_count: assignment.expansionSeeds?.length ?? 0,
            overflow_document_count: frozen.overflowRefs.length,
            candidate_count: ctx.coverageLedger.candidateRefs.length,
          },
        });
      }

      ctx.coverageLedger = settleCoveragePhase(
        ctx.coverageLedger,
        coverageConfig,
      );
      progress.coverage = ctx.coverageLedger;

      // Task progress/checkpoints must not retain the private JSON report.
      t.result =
        findingMsgs.length > 0
          ? summarizeDelegateResult({ messages: findingMsgs })
          : `(coverage report processed — ${coverageSummary(ctx.coverageLedger)})`;
    }
    // Detect the deterministic stop signal in the worker's finding text
    // (the same condensed text used for carryForward).
    if (cfg.stopSignal !== undefined) {
      const findingForSignal = condensedFindingText(findingMsgs);
      if (
        isSubstantiveFinding(
          findingForSignal,
          cfg.requiredFindingMarkers,
        ) &&
        findingForSignal
          .toLowerCase()
          .includes(cfg.stopSignal.toLowerCase())
      ) {
        signalHit = true;
      }
      if (
        ctx.coverageLedger !== undefined &&
        !isCoverageTerminal(ctx.coverageLedger, coverageConfig)
      ) {
        signalHit = false;
      }
    }
    if (carryForward === "condensed") {
      // Defensive ceiling: bound the finding carried forward so one
      // verbose/degenerate worker output cannot explode the shared
      // context across iterations (see CONDENSED_FINDING_MAX).
      const answerText = capCondensedFinding(
        condensedFindingText(findingMsgs),
        cfg.condensedFindingMaxChars,
      );
      const substantiveFinding = isSubstantiveFinding(
        answerText,
        cfg.requiredFindingMarkers,
      );
      const findingText = substantiveFinding
        ? answerText
        : "(abgeschlossen, kein neuer Textbefund)";
      const duplicateOf = contextFindings.findIndex((prior) =>
        areNearDuplicateFindings(prior, findingText),
      );
      if (substantiveFinding && duplicateOf < 0) {
        contextFindings.push(findingText);
        answerMessages.push(
          new AIMessage(`[${t.id}] ${t.description}\n${findingText}`),
        );
      } else if (!substantiveFinding) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "info",
          code: "harness_no_new_finding",
          message: `Task ${t.id} completed without a new substantive finding.`,
          details: { task_id: t.id },
        });
      } else {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "info",
          code: "harness_duplicate_finding_dropped",
          message:
            `Task ${t.id} produced a near-duplicate of finding ` +
            `${duplicateOf + 1}; it was not carried to the synthesizer.`,
          details: { task_id: t.id, duplicate_of: duplicateOf + 1 },
        });
      }
      // Rebuild from the immutable base (user goal + injected overview)
      // plus the unique condensed findings so far — never raw worker output.
      ctx.state = {
        ...ctx.state,
        messages: [
          ...baseMessages,
          ...answerMessages,
          ...verificationNotes,
        ],
      };
    } else {
      ctx.state = { ...ctx.state, messages: [...ctx.state.messages, ...findingMsgs] };
      // Capture the real assistant answers for the final output,
      // excluding injected RAG/context SystemMessages and tool messages.
      for (const m of findingMsgs) {
        if (!isAiAnswer(m)) continue;
        const text = messageText(m).trim();
        const substantiveFinding =
          !isEmptyResponseFallback(m) &&
          isSubstantiveFinding(text, cfg.requiredFindingMarkers);
        // In context mode, non-substantive worker placeholders must not
        // re-enter the synthesizer via stop()'s answerMessages fallback.
        // Delegated/user-facing mode preserves legacy visibility.
        if (substantiveFinding || cfg.resultMode !== "context") {
          answerMessages.push(m);
        }
        if (
          substantiveFinding &&
          !contextFindings.some((prior) =>
            areNearDuplicateFindings(prior, text),
          )
        ) {
          contextFindings.push(text);
        }
      }
    }
  }
  if (update.toolResults) {
    const newResults = Array.isArray(update.toolResults)
      ? update.toolResults
      : [update.toolResults];
    ctx.state = {
      ...ctx.state,
      toolResults: [...(ctx.state.toolResults ?? []), ...newResults],
    };
  }
  // Propagate citations emitted by delegated RAG steps to the client.
  if (update.citations) {
    const newCites = Array.isArray(update.citations)
      ? update.citations
      : [update.citations];
    for (const c of newCites) answerCitations.push(c);
  }
  return signalHit;
};

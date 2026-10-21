// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — verification gate.
 *
 * One verification round (`runVerification`), the completion gate
 * (`gateCompletion`) and the post-verification re-plan
 * (`replanAfterVerification`). Extracted verbatim from loop.ts
 * (Req 13.6).
 *
 * @module agent-harness/loop-verification
 */

import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import type { StreamError } from "../../types/openai.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import { baseMessagesToModelMessages } from "../message-mapping.js";
import type {
  CoverageAssignment,
  CoverageLedger,
  CoverageQueueConfig,
} from "./coverage.js";
import {
  coverageSummary,
  coverageVerificationManifest,
  isCoverageTerminal,
  reopenCoverageFromCritique,
} from "./coverage.js";
import { withChildDelegationDepth } from "./depth.js";
import { withDelegateRuntime } from "./loop-coverage-runtime.js";
import {
  budgetHarnessMessages,
  capCondensedFinding,
  condensedFindingText,
  coverageRequestMessages,
  DEFAULT_VERIFICATION_CONTEXT_MAX_CHARS,
  messageChars,
} from "./loop-findings.js";
import {
  filterMessagesForPlanner,
  transformRagForPlanner,
} from "./loop-planner-context.js";
import { mergeReplan, normalize, renderTaskList } from "./types.js";
import { coverageLabelText, statusText } from "./status-text.js";
import type { HarnessConfig, HarnessProgress, StopReason } from "./types.js";
import { plan, type PlannerBudget } from "./tools.js";

/**
 * Mutable handler bindings are exposed as read/write properties; the context
 * object built in loop.ts implements them as accessors over the original
 * handler-scope `let` bindings, so the execution loop and this module always
 * observe the same values. Const helpers are passed through as-is.
 */
export interface VerificationCtx {
  state: AgentState;
  coverageLedger: CoverageLedger | undefined;
  currentCoverageAssignment: CoverageAssignment | undefined;
  /** Full assignments issued this run, keyed by id (coverage lanes). */
  readonly coverageAssignments: Map<string, CoverageAssignment>;
  plannerlessSeq: number;
  issuedTaskIds: number;
  verificationRounds: number;
  verified: boolean;
  readonly cfg: HarnessConfig;
  readonly config: LangGraphRunnableConfig;
  readonly node: FlowNode;
  readonly runtime: ExecRuntime;
  readonly errors: StreamError[];
  readonly progress: HarnessProgress;
  readonly answerMessages: BaseMessage[];
  readonly contextFindings: string[];
  readonly verificationNotes: BaseMessage[];
  readonly baseMessages: BaseMessage[];
  readonly coverageConfig: CoverageQueueConfig | undefined;
  readonly emitHarnessStatus: (text: string) => void;
  readonly runDelegation: (
    target: string,
    taskKey: string,
    delegateState: AgentState,
    delegateConfig: LangGraphRunnableConfig,
  ) => Promise<{ update: Partial<AgentState>; ok: boolean }>;
  readonly runtimeForRemainingTime: () => ExecRuntime;
  readonly maxVerificationAttempts: number;
  readonly verificationActive: boolean;
  readonly coverageTargetForAssignment: (
    assignment: CoverageAssignment | undefined,
  ) => string | undefined;
  readonly coverageTaskLabel: (
    assignment: CoverageAssignment,
    prefix: string,
  ) => string;
  readonly issueCoverageAssignment: () => CoverageAssignment | undefined;
  readonly plannerless: boolean;
  readonly plannerlessTarget: string | undefined;
  readonly plannerLlm: LlmConfig | undefined;
  readonly validTargets: string[];
  readonly plannerOpts: {
    targetLabels?: Record<string, string>;
    plannerGuidance?: string;
    nodeId?: string;
    budget?: PlannerBudget;
  };
  readonly currentBudget: () => PlannerBudget;
  readonly _testOverrides?: {
    extractJson?: (text: string) => Record<string, unknown> | null;
  };
}

/**
 * Runs the verification gate once.
 *
 * Returns `"pass"` when the reviewer emitted the pass signal, `"fail"` when
 * it did not (its critique has then been recorded for the re-plan), or
 * `"unavailable"` when the delegation itself failed. The completion gate
 * then follows `verification.failClosed`: reject in strict mode, preserve
 * the legacy fail-open behaviour otherwise.
 */
export const runVerification = async (
  ctx: VerificationCtx,
): Promise<
  "pass" | "fail" | "unavailable"
> => {
  const {
    cfg,
    config,
    node,
    runtime,
    errors,
    progress,
    answerMessages,
    contextFindings,
    verificationNotes,
    baseMessages,
    runDelegation,
    runtimeForRemainingTime,
    maxVerificationAttempts,
    coverageConfig,
    emitHarnessStatus,
  } = ctx;
  // The verifier judges only the stable user/system request, compacted
  // findings and the complete sanitized ledger. The dossier RAG map is
  // useful to researchers but is neither original evidence nor part of the
  // verifier contract. Prior worker turns are rebuilt from contextFindings
  // under one aggregate budget instead of being replayed unbounded.
  const requestMessages = coverageRequestMessages(baseMessages);
  // `verificationActive` (checked by the sole caller, gateCompletion) is
  // exactly `cfg.verification !== undefined && verifierNode !== undefined`,
  // so this is never hit in practice — but the local narrowing lets us
  // avoid `cfg.verification!` throughout the rest of this closure.
  const verification = cfg.verification;
  if (verification === undefined) return "unavailable";

  const maxContextChars =
    cfg.verificationContextMaxChars ??
    DEFAULT_VERIFICATION_CONTEXT_MAX_CHARS;
  const verifierInstruction =
    "Review now according to your system instruction and emit either " +
    "the pass signal or exclusively the numbered rework list.";
  // Reserve request and fixed verifier instruction first; the manifest then
  // deterministically sheds only verbose fields while retaining every ref
  // and status. This applies the context limit to the real assembled turn,
  // not merely to the ledger in isolation.
  const manifestBudget = Math.max(
    0,
    maxContextChars - messageChars(requestMessages) - verifierInstruction.length - 2,
  );
  const manifest =
    ctx.coverageLedger === undefined
      ? undefined
      : coverageVerificationManifest(
          ctx.coverageLedger,
          coverageConfig,
          manifestBudget,
        );
  const manifestChars = manifest?.length ?? 0;
  // The ledger is the LAST message and must be a HUMAN turn, for two
  // reasons that both broke the gate in production:
  //
  //  1. Role semantics. As a trailing SystemMessage it is not provider-valid
  //     outside position 0, so `sanitizeSystemMessages` folds it into the
  //     preceding message — the last carried finding, an ASSISTANT turn. The
  //     verifier is then asked to distrust completeness claims in the free
  //     finding text while the authoritative ledger sits inside exactly that
  //     text, indistinguishable from it.
  //  2. Turn structure. The folded list then ENDS on an assistant turn, and
  //     a Qwen chat template renders that as a second consecutive assistant
  //     turn — answered with an immediate end token, i.e. an empty
  //     completion on every retry and every fallback candidate. That is how
  //     a 17-minute run died on "empty LLM response" in this fail-closed
  //     gate (see `ensureTrailingUserTurn` in exec-runtime.ts, which is the
  //     engine-wide backstop for the same shape).
  const manifestMessage =
    manifest === undefined
      ? undefined
      : new HumanMessage({
          content: `${manifest}\n\n${verifierInstruction}`,
        });
  const fixedMessages = [
    ...requestMessages,
    ...(manifestMessage === undefined ? [] : [manifestMessage]),
  ];
  const fixedChars = messageChars(fixedMessages);
  if (fixedChars > maxContextChars) {
    const message =
      `Verifier context requires ${fixedChars} characters for the request ` +
      `and complete ledger, above the ${maxContextChars}-character budget.`;
    errors.push({
      message: `Agent harness "${node.id}": ${message}`,
      type: "execution_error",
      details: { node_id: node.id },
    });
    runtime.onNodeDiagnostic?.(node.id, {
      level: "error",
      code: "harness_verifier_context_over_budget",
      message,
      details: {
        phase: "coverage-verifier",
        max_chars: maxContextChars,
        request_chars: messageChars(requestMessages),
        manifest_chars: manifestChars,
        ledger_documents: ctx.coverageLedger?.documents.length ?? 0,
        finding_count: contextFindings.length,
      },
    });
    return "unavailable";
  }

  const findingBudget = maxContextChars - fixedChars;
  const findingMessages = budgetHarnessMessages(
    [
      ...contextFindings.map((finding) => new AIMessage(finding)),
      ...verificationNotes,
    ],
    findingBudget,
  );
  const verifierMessages = [
    ...requestMessages,
    ...findingMessages,
    ...(manifestMessage === undefined ? [] : [manifestMessage]),
  ];

  ctx.verificationRounds += 1;
  runtime.onNodeDiagnostic?.(node.id, {
    level: "info",
    code: "harness_prompt_budget",
    message: "Built bounded coverage-verifier context.",
    details: {
      phase: "coverage-verifier",
      max_chars: maxContextChars,
      total_chars: messageChars(verifierMessages),
      request_chars: messageChars(requestMessages),
      findings_chars: messageChars(findingMessages),
      manifest_chars: manifestChars,
      message_count: verifierMessages.length,
      ledger_documents: ctx.coverageLedger?.documents.length ?? 0,
      finding_count: contextFindings.length,
    },
  });
  emitHarnessStatus(
    statusText(
      ctx.cfg.statusLanguage,
      "verificationRound",
      {
        round: ctx.verificationRounds,
        max: maxVerificationAttempts,
        target: verification.target,
      },
      `→ Verifikation (Runde ${ctx.verificationRounds}/${maxVerificationAttempts}) via ${verification.target}`,
    ),
  );

  const verificationState = { ...ctx.state, messages: verifierMessages };
  const { update, ok } = await runDelegation(
    verification.target,
    `verification-${ctx.verificationRounds}`,
    verificationState,
    withDelegateRuntime(
      withChildDelegationDepth(config, node.id),
      runtimeForRemainingTime(),
      cfg.streamDelegates !== false,
      verification.target,
    ),
  );
  // The verifier is a real delegated step and is billed as one iteration.
  progress.iterations += 1;

  if (!ok) {
    // Fail-closed semantics require an error, not the verifier's raw
    // provider/tool payload. The latter may contain credentials or private
    // endpoints and must not enter the parent execution stream.
    if (verification.failClosed === true && Array.isArray(update.errors)) {
      errors.push({
        message: "Verification worker failed.",
        type: "execution_error",
        details: { node_id: node.id },
      });
    }
    runtime.onNodeDiagnostic?.(node.id, {
      level: "warn",
      code: "harness_verifier_failed",
      message:
        `Verifier "${verification.target}" could not be run; the result ` +
        (verification.failClosed === true
          ? "is rejected by fail-closed verification."
          : "is reported as complete but UNVERIFIED."),
      details: {
        target: verification.target,
        fail_closed: verification.failClosed === true,
      },
    });
    return "unavailable";
  }

  const msgs = update.messages
    ? Array.isArray(update.messages)
      ? update.messages
      : [update.messages]
    : [];
  let verdictText = condensedFindingText(msgs);
  if (
    verdictText.trim().toLowerCase() ===
    verification.passSignal.toLowerCase()
  ) {
    const coverageIsTerminal =
      ctx.coverageLedger === undefined ||
      isCoverageTerminal(ctx.coverageLedger, coverageConfig);
    if (coverageIsTerminal) {
      emitHarnessStatus(
        statusText(
          ctx.cfg.statusLanguage,
          "verificationPassed",
          {},
          "Verifikation bestanden.",
        ),
      );
      return "pass";
    }
    // A reviewer may assess quality, but it may never override deterministic
    // queue invariants. Treat a premature PASS as a rejection and re-open
    // the bounded repair cycle instead of reporting completed coverage.
    runtime.onNodeDiagnostic?.(node.id, {
      level: "error",
      code: "harness_verifier_pass_nonterminal_coverage",
      message:
        `Verifier "${verification.target}" emitted PASS while deterministic ` +
        "coverage work remained open; the PASS was ignored.",
      details: {
        target: verification.target,
        coverage: ctx.coverageLedger
          ? coverageSummary(ctx.coverageLedger)
          : undefined,
      },
    });
    verdictText =
      "GLOBAL COVERAGE: Deterministic coverage remains non-terminal. " +
      "Complete every open document assignment and all required discovery rounds.";
  }

  if (ctx.coverageLedger !== undefined) {
    const reopened = reopenCoverageFromCritique(
      ctx.coverageLedger,
      verdictText,
      coverageConfig,
    );
    ctx.coverageLedger = reopened.ledger;
    progress.coverage = ctx.coverageLedger;
    if (reopened.discoveryReopened) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "harness_coverage_discovery_reopened",
        message:
          `Verification round ${ctx.verificationRounds} reopened one global ` +
          "discovery round while retaining prior query provenance.",
        details: {
          completed_rounds: ctx.coverageLedger.discoveryRounds,
          required_rounds: coverageConfig?.searchDiscovery?.rounds ?? 0,
        },
      });
    }
    if (reopened.reopenedRefs.length > 0) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "info",
        code: "harness_coverage_reopened",
        message:
          `Verification round ${ctx.verificationRounds} reopened ` +
          `${reopened.reopenedRefs.length} referenced coverage item(s).`,
        details: { reopened_document_count: reopened.reopenedRefs.length },
      });
    }
  }

  // Record the critique so the re-plan can act on something concrete rather
  // than merely learning that "verification failed".
  verificationNotes.push(
    new AIMessage(
      `[VERIFICATION FAILED — round ${ctx.verificationRounds}] ` +
        "The following critique must be resolved before the assignment " +
        `counts as done:\n${capCondensedFinding(verdictText, cfg.condensedFindingMaxChars)}`,
    ),
  );
  ctx.state = {
    ...ctx.state,
    messages: [...baseMessages, ...answerMessages, ...verificationNotes],
  };
  runtime.onNodeDiagnostic?.(node.id, {
    level: "info",
    code: "harness_verification_rejected",
    message:
      `Verification round ${ctx.verificationRounds} of ` +
      `${maxVerificationAttempts} rejected the result; re-planning.`,
    details: { round: ctx.verificationRounds, target: verification.target },
  });
  return "fail";
};

/**
 * Intercepts a would-be successful exit.
 *
 * Returns `undefined` when the run may finish (verification passed, was not
 * configured, or is unavailable), or a `StopReason` when it must stop
 * unverified. Returns `"retry"` to signal that the loop should re-plan and
 * keep going.
 */
export const gateCompletion = async (
  ctx: VerificationCtx,
): Promise<
  | { action: "finish" }
  | { action: "retry" }
  | { action: "stop"; reason: StopReason }
> => {
  const { cfg, verificationActive, maxVerificationAttempts } = ctx;
  if (cfg.verification === undefined || ctx.verified) {
    return { action: "finish" };
  }
  if (!verificationActive) {
    return cfg.verification.failClosed === true
      ? { action: "stop", reason: "verification-failed" }
      : { action: "finish" };
  }

  const verdict = await runVerification(ctx);
  if (verdict === "pass") {
    ctx.verified = true;
    return { action: "finish" };
  }
  if (verdict === "unavailable") {
    return cfg.verification.failClosed === true
      ? { action: "stop", reason: "verification-failed" }
      : { action: "finish" };
  }

  if (ctx.verificationRounds >= maxVerificationAttempts) {
    return { action: "stop", reason: "verification-failed" };
  }
  // Reopen the plan: everything settled, so without new pending work the
  // loop would immediately re-enter this gate. The re-plan below produces it.
  return { action: "retry" };
};

/**
 * Re-plans after a rejected verification and returns whether new actionable
 * work was produced.
 *
 * A dedicated call rather than falling through to the loop's normal re-plan:
 * at this point every task is settled, so the loop's `allSettled` branch
 * would re-enter the gate immediately and spin. New pending tasks are
 * required for the loop to make progress.
 *
 * In plannerless mode there is no planner to consult, so the single worker is
 * re-seeded once — it now sees the critique in context.
 */
export const replanAfterVerification = async (
  ctx: VerificationCtx,
): Promise<boolean> => {
  const {
    _testOverrides,
    coverageConfig,
    coverageLedger,
    coverageTargetForAssignment,
    coverageTaskLabel,
    currentBudget,
    emitHarnessStatus,
    issueCoverageAssignment,
    plannerLlm,
    plannerless,
    plannerlessTarget,
    plannerOpts,
    progress,
    runtime,
    state,
    validTargets,
  } = ctx;
  if (plannerless) {
    if (plannerlessTarget === undefined) return false;
    if (coverageLedger !== undefined && coverageConfig !== undefined) {
      ctx.currentCoverageAssignment = issueCoverageAssignment();
      if (ctx.currentCoverageAssignment === undefined) return false;
      ctx.coverageAssignments.set(
        ctx.currentCoverageAssignment.id,
        ctx.currentCoverageAssignment,
      );
    } else {
      ctx.currentCoverageAssignment = undefined;
    }
    ctx.plannerlessSeq += 1;
    progress.tasks.push({
      id: `v${ctx.verificationRounds}-${ctx.plannerlessSeq}`,
      description:
        ctx.currentCoverageAssignment === undefined
          ? statusText(
              ctx.cfg.statusLanguage,
              "reworkTaskDescription",
              { round: ctx.verificationRounds },
              `Nacharbeit nach Verifikation (${ctx.verificationRounds})`,
            )
          : coverageLabelText(
              ctx.cfg.statusLanguage,
              ctx.currentCoverageAssignment,
              "coverageRework",
              coverageTaskLabel(
                ctx.currentCoverageAssignment,
                "Coverage-Nacharbeit",
              ),
            ),
      target:
        coverageTargetForAssignment(ctx.currentCoverageAssignment) ??
        plannerlessTarget,
      status: "pending",
      ...(ctx.currentCoverageAssignment !== undefined
        ? {
            coverageAssignmentId: ctx.currentCoverageAssignment.id,
            coverageAssignmentMode: ctx.currentCoverageAssignment.mode,
            coverageRefs: ctx.currentCoverageAssignment.documents.map(
              (document) => document.ref,
            ),
          }
        : {}),
    });
    return true;
  }
  if (plannerLlm === undefined) return false;

  const filteredMsgs = filterMessagesForPlanner(
    transformRagForPlanner(state.messages, true),
  );
  const replanResult = await plan(
    runtime,
    plannerLlm,
    baseMessagesToModelMessages(filteredMsgs),
    validTargets,
    progress,
    _testOverrides?.extractJson,
    { ...plannerOpts, budget: currentBudget() },
  );
  if (replanResult === null) return false;
  const replanTasks = normalize(replanResult, validTargets, ctx.issuedTaskIds);
  if (replanTasks.length === 0) return false;
  progress.tasks = mergeReplan(progress.tasks, replanTasks);
  ctx.issuedTaskIds += replanTasks.length;
  emitHarnessStatus(
    statusText(
      ctx.cfg.statusLanguage,
      "reworkAfterVerification",
      { list: renderTaskList(progress.tasks, ctx.cfg.statusLanguage) },
      `Nacharbeit nach Verifikation:\n${renderTaskList(progress.tasks)}`,
    ),
  );
  return true;
};

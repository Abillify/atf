// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Agent Harness — Execution Loop Handler
 *
 * This module contains the `createAgentHarnessNodeHandler` factory and its
 * private helper functions. The handler orchestrates over the graph by
 * planning, delegating, re-planning, and stopping on limits.
 *
 * @module agent-harness/loop
 */

import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { FlowNode, LlmConfig } from "../../types/flow.js";
import type { Citation, StreamError } from "../../types/openai.js";
import { approvalRequestedBy } from "../approval-gate.js";
import {
  combineAbortSignals,
  isRagContextMessage,
  resolveTurnContext,
} from "../exec-runtime.js";
import { buildClassificationNamespaces } from "../classification-access.js";
import type { AgentState, ExecRuntime } from "../graph-engine.js";
import { baseMessagesToModelMessages } from "../message-mapping.js";
import type {
  CoverageAssignment,
  CoverageDocumentEvidence,
  CoverageLedger,
  CoverageReport,
  CoverageSearchEvidence,
  CoverageSearchParseResult,
} from "./coverage.js";
import {
  coverageOpenCount,
  coverageSummary,
  isCoverageTerminal,
  releaseCoverageDocuments,
  renderCoverageAssignment,
  reserveCoverageDocuments,
  seedCoverageLedger,
} from "./coverage.js";
import { applySummaryTriageRerank } from "./coverage-rerank.js";
import type { HarnessProgress, Task } from "./types.js";
import {
  buildHarnessProgress,
  emitHarnessProgress,
  type HarnessProgressCoverage,
  type HarnessProgressPhase,
} from "./progress-event.js";
import { createCoverageAssignmentRuntime } from "./loop-coverage-assignment.js";
import {
  formatCoverageSearchStatus,
  renderCoverageAssignmentForWorker,
  withCoverageEvidenceRuntime,
  withDelegateRuntime,
  COVERAGE_REPORT_EXTRACTION_MAX_TOKENS,
  buildCoverageReportExtractionSystemPrompt,
} from "./loop-coverage-runtime.js";
import { createDelegationRunner } from "./loop-delegation.js";
import {
  budgetHarnessMessages,
  compactStatusText,
  DEFAULT_COVERAGE_WORKER_CONTEXT_MAX_CHARS,
  describeResearchPhase,
  messageChars,
  messageText,
  coverageRequestMessages,
  latestHumanText,
} from "./loop-findings.js";
import { incorporateOutcome, type OutcomeCtx } from "./loop-outcome.js";
import {
  filterMessagesForPlanner,
  transformRagForPlanner,
} from "./loop-planner-context.js";
import { createStopHelper } from "./loop-stop.js";
import {
  gateCompletion,
  replanAfterVerification,
  type VerificationCtx,
} from "./loop-verification.js";
// Re-exported for the harness test suite (previously defined in loop.ts).
export { coverageToolKind } from "./loop-coverage-runtime.js";
export {
  budgetHarnessMessages,
  capCondensedFinding,
  collapseDuplicateLines,
  condensedFindingText,
  finalAiAnswerText,
} from "./loop-findings.js";

import {
  partitionCyclicTargets,
  readAncestorChain,
  readDelegationDepth,
  resolveMaxDelegationDepth,
  withChildDelegationDepth,
} from "./depth.js";
import {
  narrateProgress,
  type PlannerBudget,
  plan,
  requestCoverageReport,
} from "./tools.js";
import {
  checkLimits,
  DEFAULT_MAX_ITERATIONS,
  formatTaskReference,
  mergeReplan,
  normalize,
  parseHarnessConfig,
  renderTaskList,
  resolveAllowlist,
  resolveMaxConcurrentTasks,
  resolveMaxTaskAttempts,
  resolveVerificationAttempts,
  selectTaskBatch,
} from "./types.js";

// ---------------------------------------------------------------------------
// Handler factory — createAgentHarnessNodeHandler
// ---------------------------------------------------------------------------

/**
 * Creates the handler for an `agent-harness` node.
 *
 * The returned `NodeHandler` orchestrates over the graph by:
 * 1. Planning a task list from the user goal using a Planner LLM
 * 2. Iteratively delegating tasks to allowlisted worker nodes/subflows
 * 3. Re-planning after each delegation result
 * 4. Stopping when all tasks are done or a limit is reached
 *
 * Every exit goes through a local `stop()` helper that returns a well-typed
 * `Partial<AgentState>` with a non-error completion (AIMessage + harness
 * progress), even on limit/exhaustion stops.
 *
 * @param node    - The `agent-harness` FlowNode.
 * @param nodeMap - The compiled flow's full node map (for delegation).
 * @returns A NodeHandler `(state, config) => Promise<Partial<AgentState>>`.
 *
 * _Validates: Requirements 2.3, 3.3, 3.4, 4.1, 4.4, 4.5, 5.2, 6.2, 7.2,
 * 8.1, 8.2, 8.3, 10.3, 10.4, 12.1, 12.3, 12.4_
 */
export function createAgentHarnessNodeHandler(
  node: FlowNode,
  nodeMap: Map<string, FlowNode>,
  _testOverrides?: {
    registry?: {
      get(type: string):
        | {
            factory: (
              node: FlowNode,
              ctx: { nodeMap: Map<string, FlowNode> },
            ) => (
              state: AgentState,
              config?: LangGraphRunnableConfig,
            ) => Partial<AgentState> | Promise<Partial<AgentState>>;
          }
        | undefined;
    };
    extractJson?: (text: string) => Record<string, unknown> | null;
  },
): (
  state: AgentState,
  config?: LangGraphRunnableConfig,
) => Promise<Partial<AgentState>> {
  return async (state, config): Promise<Partial<AgentState>> => {
    // --- Extract runtime ---
    const configurable = config?.configurable as
      | { runtime?: ExecRuntime }
      | undefined;
    const runtime = configurable?.runtime;
    if (runtime === undefined || config === undefined) {
      // No runtime (e.g. validation pass) — no-op. `config` is undefined here
      // too, since `configurable` (and thus `runtime`) derive from it — this
      // also hoists `config`'s type to non-optional for the rest of the
      // handler, including closures created later (e.g. delegation calls),
      // which TS's control-flow narrowing does not otherwise reach into.
      return { currentNodeId: node.id };
    }

    runtime.onNodeStart(node.id);

    const { runDelegation } = createDelegationRunner({
      runtime,
      node,
      nodeMap,
      registry: _testOverrides?.registry,
    });

    // --- Parse config ---
    const cfg = parseHarnessConfig(
      node.config as Record<string, unknown> | undefined,
    );

    // --- Delegation depth guard ---
    // `delegate()` resolves handlers by NODE TYPE, and `agent-harness` is a
    // registered type — so a harness can enter another harness. That is what
    // makes hierarchical agents possible, and also what makes unbounded
    // recursion possible: a self-referential or cyclic allowlist re-enters
    // forever. The depth bound is checked BEFORE any planning so an over-deep
    // entry costs nothing.
    const currentDepth = readDelegationDepth(config);
    const ancestorChain = readAncestorChain(config);
    const maxDepth = resolveMaxDelegationDepth(cfg.maxDelegationDepth);

    // Concurrency cap for `parallelizable` task batches, and how many times a
    // failed task may be retried before it is recorded as failed.
    const maxConcurrentTasks = resolveMaxConcurrentTasks(
      cfg.maxConcurrentTasks,
    );
    const maxTaskAttempts = resolveMaxTaskAttempts(cfg.maxTaskAttempts);

    /**
     * How many task ids have been issued so far, used as the id offset for
     * re-plans.
     *
     * Without it every re-plan restarted numbering at `t1`, so a new pending task
     * could reuse the id of a settled one — and since task id is the merge key in
     * `mergeHarnessProgress`, the completed task's record was silently overwritten
     * by the new pending one.
     */
    let issuedTaskIds = 0;

    // --- Resolve allowlist ---
    const { valid: resolvedTargets, dropped } = resolveAllowlist(
      cfg.allowlist,
      nodeMap,
    );

    // Refuse targets that would re-enter this harness or an ancestor. Only the
    // offending entries are removed (not the whole node), mirroring how unknown
    // ids are handled — a flow with one bad allowlist entry keeps working.
    const { allowed: validTargets, cyclic } = partitionCyclicTargets(
      resolvedTargets,
      node.id,
      ancestorChain,
    );

    // Plannerless mode skips planner calls. Generic runs use the first
    // allowlist target; coverage assignments may select an allowlisted target
    // per mode and fall back to that first target when no override is set.
    const plannerless = cfg.plannerless === true;
    const plannerlessTarget = validTargets[0];
    const coverageConfig = plannerless ? cfg.coverageQueue : undefined;
    let coverageLedger: CoverageLedger | undefined;
    let currentCoverageAssignment: CoverageAssignment | undefined;
    let plannerlessSeq = 0;
    // Concurrent coverage lanes (1 = serial, the default). Each lane is its
    // own delegation instance of the target node; results are merged in
    // assignment order.
    const lanes = coverageConfig?.lanes ?? 1;
    // Coverage batches never exceed the lane count; planned mode keeps its
    // configured concurrency (coverageConfig is plannerless-only).
    const batchLimit =
      coverageConfig !== undefined
        ? Math.min(maxConcurrentTasks, lanes)
        : maxConcurrentTasks;
    // Full assignments issued this run, keyed by id. Tasks only carry the
    // assignment id, so result processing resolves the full assignment here.
    const coverageAssignments = new Map<string, CoverageAssignment>();
    const assignmentForTask = (
      t: Task,
    ): CoverageAssignment | undefined =>
      (t.coverageAssignmentId !== undefined
        ? coverageAssignments.get(t.coverageAssignmentId)
        : undefined) ??
      (currentCoverageAssignment?.id === t.coverageAssignmentId
        ? currentCoverageAssignment
        : undefined);

    // Counts completed plannerless passes that added no unique condensed
    // finding. Unlike deduplication alone, this turns repeated work into a
    // deterministic stop instead of silently spending every remaining limit.
    let consecutiveStagnantIterations = 0;

    // --- Planner enrichment (engine patch): give the planner each target's
    // human-readable label, and prepend the node's systemPrompt as domain
    // guidance when present. Both are optional and default to prior behaviour. ---
    const targetLabels: Record<string, string> = {};
    for (const id of validTargets) {
      const label = nodeMap.get(id)?.label;
      if (typeof label === "string" && label.length > 0) {
        targetLabels[id] = label;
      }
    }
    const plannerOpts: {
      targetLabels?: Record<string, string>;
      plannerGuidance?: string;
      nodeId?: string;
      budget?: PlannerBudget;
    } = {
      targetLabels,
      nodeId: node.id,
      ...(typeof node.systemPrompt === "string" && node.systemPrompt.length > 0
        ? { plannerGuidance: node.systemPrompt }
        : {}),
    };

    /**
     * Snapshot of what is still available, rendered into the planner prompt.
     *
     * Recomputed per planner call rather than once: on a re-plan the remaining
     * iterations/time have shrunk, and a planner that still believes it has the
     * initial budget keeps emitting plans that cannot finish — the run then stops
     * on a limit with most tasks untouched, which reads to the user as a failure
     * rather than a bounded answer.
     */
    const currentBudget = (): PlannerBudget => {
      const maxIter = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      return {
        remainingIterations: Math.max(0, maxIter - progress.iterations),
        ...(cfg.maxCost !== undefined
          ? { remainingCostUsd: Math.max(0, cfg.maxCost - progress.cost) }
          : {}),
        ...(cfg.maxTimeMs !== undefined
          ? {
              remainingTimeMs: Math.max(
                0,
                cfg.maxTimeMs - (Date.now() - startTime),
              ),
            }
          : {}),
        maxConcurrentTasks,
      };
    };

    // --- Record dropped-target errors (Req 2.3) ---
    const errors: StreamError[] = dropped.map((target) => ({
      message: `Allowlist target "${target}" not found in node map; excluded from selectable targets.`,
      type: "execution_error" as const,
      details: { node_id: node.id },
    }));

    // Cyclic targets are a flow-configuration error, not a runtime failure, so
    // they are surfaced as a diagnostic naming the cycle rather than as a
    // stream error that would surface to the end user.
    if (cyclic.length > 0) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: "warn",
        code: "harness_cyclic_target",
        message:
          `Allowlist target(s) ${cyclic.map((t) => `"${t}"`).join(", ")} would ` +
          `re-enter a harness already on the stack ` +
          `(${[...ancestorChain, node.id].join(" → ")}) and were excluded. ` +
          "Self-delegation cannot make progress; remove the entry.",
        details: {
          cyclicTargets: cyclic,
          stack: [...ancestorChain, node.id],
          depth: currentDepth,
        },
      });
    }

    // --- Snapshot start time and initial cost (Req 6.1, 7.1) ---
    const startTime = Date.now();
    const runtimeForRemainingTime = (): ExecRuntime => {
      if (cfg.maxTimeMs === undefined) return runtime;
      const remainingMs = Math.max(1, cfg.maxTimeMs - (Date.now() - startTime));
      return {
        ...runtime,
        signal: combineAbortSignals(
          runtime.signal,
          AbortSignal.timeout(remainingMs),
        ),
      };
    };
    // --- Initialize progress ---
    const progress: HarnessProgress = {
      tasks: [],
      iterations: 0,
      cost: 0,
      depth: currentDepth,
      ...(dropped.length > 0 ? { droppedTargets: dropped } : {}),
      ...(cyclic.length > 0 ? { cyclicTargets: cyclic } : {}),
    };

    // Phase of the loop at emit time. Set at the region boundaries below; the
    // status wrapper reads it lazily so call sites living in the helper modules
    // (outcome/verification/stop) report the phase they were reached from.
    let harnessPhase: HarnessProgressPhase = "planning";
    /** Coarse coverage counters for the progress event, absent without a queue. */
    const coverageProgressSnapshot = (): HarnessProgressCoverage | undefined => {
      if (coverageLedger === undefined) return undefined;
      const covered = coverageLedger.documents.filter(
        (d) => d.status === "reviewed" || d.status === "excluded",
      ).length;
      return {
        covered,
        total: coverageLedger.total,
        open: coverageLedger.total - covered,
      };
    };
    const emitHarnessStatus = (text: string): void => {
      const lineTerminated = `${text.replace(/\n+$/, "")}\n`;
      runtime.onReasoning(node.id, lineTerminated).catch(() => {});
      const event = buildHarnessProgress(
        progress,
        harnessPhase,
        startTime,
        coverageProgressSnapshot(),
        text,
      );
      runtime.onProgress?.(node.id, event);
      emitHarnessProgress(runtime.ctx.executionId, event);
    };
    // Emit a real reasoning-channel message before a potentially long planner
    // call. Open WebUI measures Thinking duration from the first to the last
    // reasoning delta, so this must happen before planning rather than after the
    // task list exists.
    emitHarnessStatus(
      "Starting research. I first survey the document inventory, break the question into verifiable sub-aspects, and then prioritise the documents with the strongest relation. Afterwards I reconcile relevant original passages and possible counter-evidence before accepting a finding as dependable.",
    );
    // We track cost via a running delta from the plan calls and delegate calls
    let accumulatedCost = 0;

    const {
      coverageTargetForAssignment,
      coverageTaskLabel,
      issueCoverageAssignment,
    } = createCoverageAssignmentRuntime({
      runtime,
      node,
      progress,
      coverageConfig,
      plannerlessTarget,
      getLedger: () => coverageLedger,
      setLedger: (ledger) => {
        coverageLedger = ledger;
      },
    });

    // --- Accumulators for the final user-facing output (engine patch) ---
    // Real assistant answers produced by delegated responders, plus citations
    // emitted by delegated RAG steps. These are returned as the harness's
    // output so the orchestrator path yields the full answer + sources instead
    // of a truncated status summary. Declared before `stop()` so its closure
    // observes the values accumulated during the Execution_Loop.
    const answerMessages: BaseMessage[] = [];
    // Task-marker-free findings used by `resultMode: "context"`. Kept separate
    // from answerMessages because task ids/descriptions are useful to the
    // planner, but are internal orchestration metadata a synthesizer must not
    // accidentally reproduce in the user-facing answer.
    const contextFindings: string[] = [];
    const answerCitations: Citation[] = [];
    let coverageUpdates = 0;
    // Reports the strict coverage gate refused. Monotonic like `coverageUpdates`:
    // the per-batch delta decides whether a pass counted as progress or as
    // stagnation (see `consecutiveStagnantIterations`).
    let coverageReportRejections = 0;

    // --- Verification gate state ---
    // Declared HERE, before `stop()`, because `stop()` reports the verification
    // outcome and is reachable from the early depth-limit exit above the gate's
    // own setup — a later `const` would be a temporal-dead-zone ReferenceError on
    // that path (which the depth tests caught).
    //
    // `verificationNotes` is deliberately separate from `answerMessages`: the
    // reviewer's critique must reach the PLANNER so a re-plan can act on it, but
    // must NOT become part of the user-facing answer.
    const verificationNotes: BaseMessage[] = [];
    let verificationRounds = 0;
    let verified = false;
    const verifierNode =
      cfg.verification !== undefined
        ? nodeMap.get(cfg.verification.target)
        : undefined;
    const verificationActive =
      cfg.verification !== undefined && verifierNode !== undefined;

    // Context strategy for carrying delegation results forward (see
    // HarnessConfig.carryForward). "condensed" rebuilds the shared context from
    // this immutable base + one condensed finding per task, so it never
    // accumulates the workers' raw output across iterations. Captured before
    // the loop, `baseMessages` is the entry context (user goal + any injected
    // overview from an upstream tool node).
    const carryForward = cfg.carryForward ?? "full";
    const baseMessages = state.messages;

    // --- Local stop helper (Req 8.1, 8.2, 8.3, 12.4) ---
    const stopRun = createStopHelper({
      node,
      runtime,
      cfg,
      emitHarnessStatus,
      answerMessages,
      contextFindings,
      answerCitations,
      verificationActive,
      getVerificationRounds: () => verificationRounds,
      getVerified: () => verified,
      getCoverageLedger: () => coverageLedger,
      coverageConfig,
    });
    // Every terminal stop is the run's conclusion, so the status lines the
    // stop helper emits report the synthesis phase.
    const stop: ReturnType<typeof createStopHelper> = (reason, prog, errs) => {
      harnessPhase = "synthesis";
      return stopRun(reason, prog, errs);
    };

    // --- Depth limit: refuse to run at all when entered too deep ---
    // Checked here (after `stop` is defined, before any planning) so the run
    // terminates without spending a planner call. Reported as its own stop
    // reason so an over-deep hierarchy is visible in the trace instead of
    // appearing only as latency and spend.
    if (currentDepth > maxDepth) {
      errors.push({
        message:
          `Agent harness "${node.id}" was entered at delegation depth ` +
          `${currentDepth}, above the configured maximum of ${maxDepth} ` +
          `(stack: ${[...ancestorChain, node.id].join(" → ")}). ` +
          "Raise `config.maxDelegationDepth` on the outer harness, or flatten " +
          "the hierarchy.",
        type: "execution_error",
        details: { node_id: node.id },
      });
      return stop("depth-limit", progress, errors);
    }

    // --- Determine planner LLM (Req 3.1) ---
    // Planner LLM is only required when a planner actually runs. In plannerless
    // mode there is no plan()/re-plan() call, so an absent LLM is fine.
    const plannerLlm: LlmConfig | undefined =
      cfg.plannerLlm ?? node.llm ?? runtime.appConfig.defaultLlm;

    if (!plannerless && plannerLlm === undefined) {
      errors.push({
        message: `Agent harness "${node.id}": no planner LLM configured and no default LLM available.`,
        type: "execution_error",
        details: { node_id: node.id },
      });
      return stop("planning-failure", progress, errors);
    }

    if (plannerless) {
      const invalidCoverageTargets = Object.entries(
        coverageConfig?.targets ?? {},
      ).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !validTargets.includes(entry[1]),
      );
      if (invalidCoverageTargets.length > 0) {
        errors.push({
          message:
            `Agent harness "${node.id}": coverage target(s) must resolve to ` +
            `allowlisted nodes (${invalidCoverageTargets
              .map(([mode, target]) => `${mode}=${target}`)
              .join(", ")}).`,
          type: "execution_error",
          details: { node_id: node.id },
        });
        return stop("no-tasks", progress, errors);
      }
      // No planner: the first allowlist target is the compatibility fallback;
      // coverage mode may override it per deterministic assignment mode.
      if (plannerlessTarget === undefined) {
        errors.push({
          message: `Agent harness "${node.id}": plannerless mode requires at least one valid allowlist target.`,
          type: "execution_error",
          details: { node_id: node.id },
        });
        return stop("no-tasks", progress, errors);
      }
      const seededTasks: Task[] = [];
      if (coverageConfig !== undefined) {
        const coverageSeedFailure = () => {
          errors.push({
            message: `Agent harness "${node.id}": coverage seed validation failed.`,
            type: "execution_error",
            details: {
              node_id: node.id,
              source_tool: coverageConfig.sourceTool,
            },
          });
          return stop("coverage-seed-failure", progress, errors);
        };
        let seededLedger: CoverageLedger;
        try {
          seededLedger = seedCoverageLedger(
            state.toolResults,
            coverageConfig.sourceTool,
          );
        } catch {
          return coverageSeedFailure();
        }
        // One-time summary rerank (staged only): score order for Stage 1 and
        // the freeze, plus deterministic decisions in hybrid/rerank mode. Never
        // throws; any reranker problem falls back to full LLM triage.
        if (coverageConfig.mode === "staged") {
          const rerankOutcome = await applySummaryTriageRerank({
            ledger: seededLedger,
            config: coverageConfig.summaryTriage,
            reranker: runtime.reranker,
            userText: latestHumanText(coverageRequestMessages(baseMessages)),
            resolveTemplate: (template) =>
              resolveTurnContext(
                template,
                state.context,
                buildClassificationNamespaces(state.turns),
              ) ?? "",
            ...(runtime.signal !== undefined ? { signal: runtime.signal } : {}),
          });
          seededLedger = rerankOutcome.ledger;
          if (rerankOutcome.configDiagnostic !== undefined) {
            runtime.onNodeDiagnostic?.(node.id, rerankOutcome.configDiagnostic);
          }
          if (rerankOutcome.diagnostic !== undefined) {
            runtime.onNodeDiagnostic?.(node.id, rerankOutcome.diagnostic);
          }
          if (rerankOutcome.status !== undefined) {
            emitHarnessStatus(rerankOutcome.status);
          }
        }
        try {
          coverageLedger = seededLedger;
          progress.coverage = coverageLedger;
          for (let lane = 0; lane < lanes; lane++) {
            const assignment = issueCoverageAssignment();
            if (assignment === undefined) break;
            coverageAssignments.set(assignment.id, assignment);
            // Reserve the documents so the next lane in this pass is handed
            // different ones (the ledger only advances when outcomes fold in).
            if (lanes > 1 && coverageLedger !== undefined)
              coverageLedger = reserveCoverageDocuments(
                coverageLedger,
                assignment,
              );
            if (lane === 0) currentCoverageAssignment = assignment;
            plannerlessSeq += 1;
            seededTasks.push({
              id: `t${plannerlessSeq}`,
              displayStep: plannerlessSeq,
              description: coverageTaskLabel(assignment, "Coverage"),
              target:
                coverageTargetForAssignment(assignment) ?? plannerlessTarget,
              status: "pending",
              coverageAssignmentId: assignment.id,
              coverageAssignmentMode: assignment.mode,
              coverageRefs: assignment.documents.map((document) => document.ref),
              ...(lanes > 1 ? { parallelizable: true } : {}),
            });
          }
        } catch {
          return coverageSeedFailure();
        }
        if (currentCoverageAssignment === undefined) {
          return stop(
            isCoverageTerminal(coverageLedger, coverageConfig)
              ? "completed"
              : "exhausted",
            progress,
            errors,
          );
        }
      } else {
        plannerlessSeq += 1;
        seededTasks.push({
          id: `t${plannerlessSeq}`,
          displayStep: plannerlessSeq,
          description: `Research step ${plannerlessSeq}`,
          target: plannerlessTarget,
          status: "pending",
        });
      }
      progress.tasks = seededTasks;
    } else {
      // --- Convert state.messages to ModelMessage[] for the planner ---
      // Filter out tool-related messages to avoid tool call/result mismatch
      // errors. The planner only needs user messages and final assistant
      // responses, not the detailed tool execution history from delegated
      // nodes. Initial plan: replace the full AKTEN-UEBERBLICK with a compact
      // folder digest so the planner plans by folder without carrying ~40k
      // chars (#4a).
      const filteredMessages = filterMessagesForPlanner(
        transformRagForPlanner(state.messages, false),
      );
      const modelMessages = baseMessagesToModelMessages(filteredMessages);

      if (plannerLlm === undefined) {
        // Unreachable: the guard above already returns when `!plannerless &&
        // plannerLlm === undefined`, and this is the `!plannerless` branch.
        throw new Error(
          `Agent harness "${node.id}": planner LLM missing (invariant violated).`,
        );
      }

      // --- Initial plan (Req 3.1, 3.2) ---
      const planResult = await plan(
        runtime,
        plannerLlm,
        modelMessages,
        validTargets,
        undefined,
        _testOverrides?.extractJson,
        { ...plannerOpts, budget: currentBudget() },
      );

      if (planResult === null) {
        // Planner output unparseable (Req 12.1)
        return stop("planning-failure", progress, errors);
      }

      // --- Normalize (Req 3.2, 2.4) ---
      progress.tasks = normalize(planResult, validTargets);
      issuedTaskIds = progress.tasks.length;

      if (progress.tasks.length === 0) {
        // No actionable tasks (Req 3.3)
        return stop("no-tasks", progress, errors);
      }
    }

    // --- Emit initial task list (Req 9.1) ---
    emitHarnessStatus(`Task list:\n${renderTaskList(progress.tasks)}`);

    // --- Write initial task list to state before the loop (Req 3.4, 10.3) ---
    // (The progress object is mutated in place and returned on every exit)

    // Tracks report-protocol failures by the logical assignment, rather than by
    // the transient monotone attempt id. A productive sibling must reset the
    // *global* no-progress guard, while this map preserves which document batch
    // still needs repair across retries.
    const coverageReportRejectionStreaks = new Map<string, number>();
    const coverageAssignmentKey = (assignment: CoverageAssignment): string =>
      `${assignment.mode}\u0000${assignment.documents
        .map((document) => document.ref)
        .sort((left, right) => left.localeCompare(right))
        .join("\u0000")}`;

    let coverageProvenanceFailure = false;
    let terminalBudgetFailure = false;

    if (cfg.verification !== undefined && verifierNode === undefined) {
      runtime.onNodeDiagnostic?.(node.id, {
        level: cfg.verification.failClosed === true ? "error" : "warn",
        code: "harness_verifier_missing",
        message:
          `Verification target "${cfg.verification.target}" was not found in the ` +
          (cfg.verification.failClosed === true
            ? "flow; fail-closed verification will reject completion."
            : "flow; the run will complete WITHOUT verification. Fix the id in config.verification.target."),
        details: {
          target: cfg.verification.target,
          fail_closed: cfg.verification.failClosed === true,
        },
      });
    }

    const maxVerificationAttempts = resolveVerificationAttempts(
      cfg.verification?.maxAttempts,
    );

    // Shared context for the extracted outcome-folding and verification
    // modules (Req 13.6). The mutable handler bindings are exposed through
    // accessors so the modules read and write the very same bindings the
    // execution loop below uses; const helpers pass through by reference.
    const ctx: OutcomeCtx & VerificationCtx = {
      get state() {
        return state;
      },
      set state(v: AgentState) {
        state = v;
      },
      get coverageLedger() {
        return coverageLedger;
      },
      set coverageLedger(v: CoverageLedger | undefined) {
        coverageLedger = v;
      },
      get currentCoverageAssignment() {
        return currentCoverageAssignment;
      },
      set currentCoverageAssignment(v: CoverageAssignment | undefined) {
        currentCoverageAssignment = v;
      },
      get plannerlessSeq() {
        return plannerlessSeq;
      },
      set plannerlessSeq(v: number) {
        plannerlessSeq = v;
      },
      get issuedTaskIds() {
        return issuedTaskIds;
      },
      set issuedTaskIds(v: number) {
        issuedTaskIds = v;
      },
      get coverageUpdates() {
        return coverageUpdates;
      },
      set coverageUpdates(v: number) {
        coverageUpdates = v;
      },
      get coverageReportRejections() {
        return coverageReportRejections;
      },
      set coverageReportRejections(v: number) {
        coverageReportRejections = v;
      },
      get coverageProvenanceFailure() {
        return coverageProvenanceFailure;
      },
      set coverageProvenanceFailure(v: boolean) {
        coverageProvenanceFailure = v;
      },
      get terminalBudgetFailure() {
        return terminalBudgetFailure;
      },
      set terminalBudgetFailure(v: boolean) {
        terminalBudgetFailure = v;
      },
      get verificationRounds() {
        return verificationRounds;
      },
      set verificationRounds(v: number) {
        verificationRounds = v;
      },
      get verified() {
        return verified;
      },
      set verified(v: boolean) {
        verified = v;
      },
      cfg,
      node,
      config,
      runtime,
      errors,
      progress,
      answerMessages,
      contextFindings,
      answerCitations,
      verificationNotes,
      coverageReportRejectionStreaks,
      carryForward,
      baseMessages,
      coverageConfig,
      coverageAssignmentKey,
      emitHarnessStatus,
      runDelegation,
      runtimeForRemainingTime,
      maxVerificationAttempts,
      verificationActive,
      maxTaskAttempts,
      coverageTargetForAssignment,
      coverageTaskLabel,
      issueCoverageAssignment,
      coverageAssignments,
      assignmentForTask,
      plannerless,
      plannerlessTarget,
      plannerLlm,
      validTargets,
      plannerOpts,
      currentBudget,
      _testOverrides,
    };

    // --- Execution Loop ---
    while (true) {
      // Back to research at the top of every pass — a verification re-plan
      // `continue`s here and the gate phase must not leak into the next batch.
      harnessPhase = "research";
      // Limit checks BEFORE starting another task (Req 5.2, 6.2, 7.2)
      const limitHit = checkLimits(progress, cfg, startTime);
      if (limitHit !== undefined) {
        return stop(limitHit, progress, errors);
      }

      // Select the next batch of pending tasks (Req 4.1). A batch holds more
      // than one task only when the planner marked contiguous pending tasks
      // `parallelizable` — otherwise it is a single task and behaviour is
      // identical to the previous strictly sequential loop.
      const batch = selectTaskBatch(
        progress.tasks,
        batchLimit,
        (t) =>
          cfg.consequentialTargets?.includes(t.target) === true &&
          runtime.approvalGate?.enabled === true,
        // Coverage lanes share the same target by design; each lane runs as
        // its own delegation instance.
        { allowSameTarget: lanes > 1 },
      );

      if (batch.length === 0) {
        // No pending tasks remain
        const anyCompleted = progress.tasks.some(
          (t) => t.status === "completed",
        );
        if (anyCompleted) {
          return stop("completed", progress, errors);
        } else {
          return stop("exhausted", progress, errors);
        }
      }

      for (const t of batch) {
        t.status = "in-progress";
        t.researchStatus =
          t.coverageAssignmentMode === "summary"
            ? "Summary triage in progress: the relevance of the assigned documents is being decided against the question."
            : t.coverageAssignmentMode === "discovery"
              ? "Targeted search in progress: hits are being assessed as candidates for original review."
              : t.coverageAssignmentMode === "original"
                ? "Original review in progress: evidence passages and possible counter-evidence are being reconciled for a dependable decision."
                : "Research in progress: the next sub-aspect is being examined against the available sources.";
      }
      const task = batch[0];
      if (task === undefined) {
        // Unreachable: `batch.length === 0` already returned above.
        return stop("exhausted", progress, errors);
      }
      emitHarnessStatus(
        batch.length === 1
          ? `Task ${formatTaskReference(task)} → in-progress`
          : `Tasks ${batch.map((t) => formatTaskReference(t)).join(", ")} → in-progress (parallel)`,
      );

      // The approval gate below handles a single task. `selectTaskBatch`
      // guarantees an approval-gated task is returned ALONE, so this is safe —
      // and it is why approval prompts can never interleave within a batch.

      // --- Approval gate for consequential targets (Req 11.1, 11.2, 11.3, 11.4) ---
      if (
        cfg.consequentialTargets?.includes(task.target) &&
        runtime.approvalGate?.enabled
      ) {
        const requestedBy = approvalRequestedBy(runtime.ctx);
        const decision = await runtime.approvalGate.request(
          {
            executionId: runtime.ctx.executionId,
            nodeId: node.id,
            tool: task.target,
            args: { taskId: task.id, description: task.description },
            ...(runtime.ctx.clientId !== undefined
              ? { tenantId: runtime.ctx.clientId }
              : {}),
            ...(requestedBy !== undefined ? { requestedBy } : {}),
          },
          runtime.onApprovalRequired,
        );

        if (!decision.approved) {
          // This path never reaches `incorporateOutcome`, so the lane
          // reservation of the rejected task is released here.
          if (lanes > 1 && coverageLedger !== undefined) {
            const released = assignmentForTask(task);
            if (released !== undefined)
              coverageLedger = releaseCoverageDocuments(
                coverageLedger,
                released.id,
              );
          }
          task.status = "failed";
          task.error = decision.reason ?? "approval rejected";
          errors.push({
            message: `Task "${task.id}" target "${task.target}" was not approved: ${task.error}`,
            type: "execution_error" as const,
            details: {
              node_id: node.id,
              task_id: task.id,
              target: task.target,
            },
          });
          emitHarnessStatus(
            `Task ${formatTaskReference(task)} → failed (approval rejected)`,
          );

          // Accumulate iteration for the rejected task
          progress.iterations += 1;
          progress.cost = accumulatedCost;

          // Re-plan after rejection (Req 11.4)
          // Filter out tool-related messages to avoid tool call/result mismatch
          // errors; drop the RAG overview entirely on re-plan (#1 — progress
          // + condensed findings suffice for the continue/stop decision).
          const filteredMsgs = filterMessagesForPlanner(
            transformRagForPlanner(state.messages, true),
          );
          const updatedModelMessages =
            baseMessagesToModelMessages(filteredMsgs);
          if (plannerLlm === undefined) {
            // Unreachable: re-planning only occurs in planned mode, where the
            // guard at the top of the handler already ensured a planner LLM.
            throw new Error(
              `Agent harness "${node.id}": planner LLM missing (invariant violated).`,
            );
          }
          const replanResult = await plan(
            runtime,
            plannerLlm,
            updatedModelMessages,
            validTargets,
            progress,
            _testOverrides?.extractJson,
            { ...plannerOpts, budget: currentBudget() },
          );
          if (replanResult !== null) {
            const replanTasks = normalize(
              replanResult,
              validTargets,
              issuedTaskIds,
            );
            if (replanTasks.length > 0) {
              progress.tasks = mergeReplan(progress.tasks, replanTasks);
              // Advance the id counter so the NEXT re-plan cannot reuse these ids.
              issuedTaskIds += replanTasks.length;
              emitHarnessStatus(
                `Updated task list:\n${renderTaskList(progress.tasks)}`,
              );
            }
          }
          continue;
        }
      }

      // Approval and progress callbacks may themselves consume the remaining
      // wall-clock budget. Re-check immediately before launching expensive
      // delegations; each child also receives a signal capped to the exact
      // remaining harness time via runtimeForRemainingTime().
      const preDelegationLimit = checkLimits(progress, cfg, startTime);
      if (preDelegationLimit !== undefined) {
        for (const pending of batch) {
          if (pending.status === "in-progress") pending.status = "pending";
        }
        return stop(preDelegationLimit, progress, errors);
      }

      // --- Delegate (Req 4.2) ---
      // The batch runs concurrently, but results are incorporated in TASK
      // order, not completion order. That matters beyond tidiness: the shared
      // context is rebuilt from the findings, so completion-order incorporation
      // would make the next prompt depend on network timing — losing prompt-cache
      // reuse and making runs irreproducible.
      emitHarnessStatus(
        batch.length === 1
          ? `→ delegating to ${task.target}`
          : `→ delegating in parallel to ${batch.map((t) => t.target).join(", ")}`,
      );

      const outcomes = await Promise.all(
        batch.map(async (t) => {
          const assignment = assignmentForTask(t);
          // A worker with config.refHandles sees handles in its tool results;
          // its assignment and coverage evidence must use the same registry.
          const workerRefHandles =
            runtime.refHandles !== undefined &&
            (nodeMap.get(t.target)?.config as { refHandles?: unknown } | undefined)
              ?.refHandles === true
              ? runtime.refHandles
              : undefined;
          const delegateState = (() => {
            if (
              assignment === undefined ||
              coverageConfig === undefined ||
              coverageLedger === undefined
            ) {
              return state;
            }

            const maxContextChars =
              cfg.coverageWorkerContextMaxChars ??
              DEFAULT_COVERAGE_WORKER_CONTEXT_MAX_CHARS;
            // Coverage assignments are self-contained. Replaying the global
            // dossier overview and every prior finding made prompt size grow
            // with dossier size and iteration count (trace cc79ff74). Preserve
            // only the stable request plus bounded verifier feedback.
            const requestMessages = coverageRequestMessages(baseMessages);
            const workerContext = budgetHarnessMessages(
              [...requestMessages, ...verificationNotes],
              maxContextChars,
            );
            // A HUMAN turn, not a trailing SystemMessage: from verification
            // round 2 on, `verificationNotes` puts an AIMessage last, so a
            // trailing system message would be folded into that assistant turn
            // by `sanitizeSystemMessages` — hiding the assignment inside the
            // reviewer's critique and leaving the prompt ending on an assistant
            // turn, which local Qwen answers with an empty completion. Same
            // reasoning as the verifier manifest above.
            const assignmentMessage = new HumanMessage({
              content: renderCoverageAssignmentForWorker(
                renderCoverageAssignment(
                  assignment,
                  coverageConfig,
                  coverageLedger,
                ),
                assignment,
                workerRefHandles,
              ),
            });
            const messages = [...workerContext, assignmentMessage];
            runtime.onNodeDiagnostic?.(node.id, {
              level: "info",
              code: "harness_prompt_budget",
              message: "Built bounded coverage-worker context.",
              details: {
                phase: "coverage-worker",
                target: t.target,
                assignment_id: assignment.id,
                assignment_mode: assignment.mode,
                max_context_chars: maxContextChars,
                context_chars: messageChars(workerContext),
                assignment_chars: messageText(assignmentMessage).length,
                total_chars: messageChars(messages),
                message_count: messages.length,
                dropped_rag_messages: baseMessages.filter(
                  (message) =>
                    message._getType() === "system" &&
                    isRagContextMessage(messageText(message)),
                ).length,
                omitted_prior_findings: answerMessages.length,
                verifier_note_count: verificationNotes.length,
              },
            });
            return { ...state, messages };
          })();
          const coverageEvidence: CoverageDocumentEvidence[] = [];
          const searchEvidence: CoverageSearchEvidence[] = [];
          const searchParseStatuses: CoverageSearchParseResult["status"][] = [];
          const childRuntime = runtimeForRemainingTime();
          const delegatedRuntime =
            assignment === undefined
              ? childRuntime
              : withCoverageEvidenceRuntime(
                  childRuntime,
                  assignment,
                  coverageEvidence,
                  searchEvidence,
                  searchParseStatuses,
                  (item) => emitHarnessStatus(formatCoverageSearchStatus(item)),
                  workerRefHandles,
                );
          const res = await runDelegation(
            t.target,
            `${t.id}-attempt-${(t.attempts ?? 0) + 1}`,
            delegateState,
            // Child config carries depth+1 and this node appended to the
            // ancestor chain. Built per delegation (not once before the loop)
            // because `withChildDelegationDepth` must not mutate the parent's
            // config — otherwise the depth would keep climbing across SIBLING
            // tasks and the effective limit would depend on how many ran first.
            withDelegateRuntime(
              withChildDelegationDepth(config, node.id),
              delegatedRuntime,
              cfg.streamDelegates !== false,
              t.target,
            ),
          );

          // Structured-after-tools: when configured, the report is NOT parsed
          // from the worker's marker-wrapped text. The worker reasoned/used
          // tools normally above; here we make one additional tool-less,
          // schema-enforced extraction call so the decision set can never be
          // lost to a dropped marker or a truncated repetition loop. Skipped for
          // discovery (owes no report) and when delegation failed. The result is
          // attached to the outcome and consumed by `incorporateOutcome`.
          let coverageReportOverride:
            | { report: CoverageReport }
            | { defect: string }
            | undefined;
          if (
            coverageConfig?.structuredReport === true &&
            assignment !== undefined &&
            assignment.mode !== "discovery" &&
            res.ok
          ) {
            const workerNode = nodeMap.get(t.target);
            const workerLlm = workerNode?.llm ?? runtime.appConfig.defaultLlm;
            if (workerLlm !== undefined) {
              const workerReplyMessages = baseMessagesToModelMessages(
                (Array.isArray(res.update.messages)
                  ? res.update.messages
                  : res.update.messages !== undefined
                    ? [res.update.messages]
                    : []) as BaseMessage[],
              );
              const extraction = await requestCoverageReport(
                delegatedRuntime,
                workerLlm,
                assignment,
                workerReplyMessages,
                buildCoverageReportExtractionSystemPrompt(assignment),
                COVERAGE_REPORT_EXTRACTION_MAX_TOKENS,
              );
              coverageReportOverride =
                extraction.report !== undefined
                  ? { report: extraction.report }
                  : { defect: extraction.defect ?? "structured_output_failed" };
            }
          }
          return {
            task: t,
            coverageEvidence,
            searchEvidence,
            searchParseStatuses,
            ...(coverageReportOverride !== undefined
              ? { coverageReportOverride }
              : {}),
            ...res,
          };
        }),
      );

      // --- Incorporate results (Req 4.3, 4.6) ---
      // One iteration per delegated step: a parallel batch saves wall-clock
      // time, not budget. Counting a batch as a single iteration would let a
      // planner evade the iteration limit by marking everything parallelizable.
      progress.iterations += outcomes.length;

      // #2: set when a just-completed worker finding contains cfg.stopSignal
      // (case-insensitive) — the loop then ends without another planner call.
      let stopSignalHit = false;
      const findingCountBeforeBatch = contextFindings.length;
      const coverageUpdatesBeforeBatch = coverageUpdates;
      const coverageRejectionsBeforeBatch = coverageReportRejections;

      for (const outcome of outcomes) {
        stopSignalHit = incorporateOutcome(ctx, outcome) || stopSignalHit;
      }

      // Release the lane reservations of this batch. Folding already applied
      // each report to the ledger; a task that produced none (failure,
      // rejected report) must still free its documents for a later lane.
      if (lanes > 1 && coverageLedger !== undefined) {
        for (const outcome of outcomes) {
          const released = assignmentForTask(outcome.task);
          if (released !== undefined)
            coverageLedger = releaseCoverageDocuments(
              coverageLedger,
              released.id,
            );
        }
        progress.coverage = coverageLedger;
      }
      if (terminalBudgetFailure) {
        runtime.onNodeDiagnostic?.(node.id, {
          level: "error",
          code: "harness_budget_limit",
          message:
            "Harness stopped immediately because a delegated worker exhausted the shared execution budget.",
          details: {
            iterations: progress.iterations,
            completed_tasks: progress.tasks.filter(
              (task) => task.status === "completed",
            ).length,
          },
        });
        return stop("budget-limit", progress, []);
      }
      if (coverageProvenanceFailure) {
        return stop("coverage-provenance-failure", progress, errors);
      }

      const newFindingCount = contextFindings.length - findingCountBeforeBatch;
      const newFindings = contextFindings.slice(findingCountBeforeBatch);
      const coverage = newFindings
        .map((finding) =>
          finding
            .split("\n")
            .find((line) => line.trim().toUpperCase().startsWith("ABGEDECKT:")),
        )
        .filter((line): line is string => line !== undefined)
        .join("; ");
      const citationCount = new Set(
        newFindings.flatMap((finding) => finding.match(/\[\d+\]/g) ?? []),
      ).size;

      let narratedProgress: string | null = null;
      let narratedResearchStatus: string | null = null;
      let hypothesisStatus:
        | import("./tools.js").ProgressHypothesisStatus
        | undefined;
      if (
        outcomes.some((outcome) => outcome.ok) &&
        cfg.progressNarrator !== undefined &&
        cfg.progressNarrator.enabled !== false
      ) {
        const narration = await narrateProgress(
          runtime,
          cfg.progressNarrator,
          {
            iteration: progress.iterations,
            totalIterations: cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            phase:
              outcomes.find((outcome) => outcome.ok)?.task
                .coverageAssignmentMode ?? "research",
            finding: newFindings.join("\n\n"),
            citationCount,
          },
          node.id,
        );
        if (narration !== null) {
          narratedProgress = narration.text;
          narratedResearchStatus = narration.researchStatus;
          hypothesisStatus = narration.hypothesisStatus;
          accumulatedCost += narration.cost;
        }
      }

      const coverageProgress = coverageUpdates - coverageUpdatesBeforeBatch;
      const coverageRejections =
        coverageReportRejections - coverageRejectionsBeforeBatch;
      const observedSearchPasses = outcomes
        .filter((outcome) => outcome.ok)
        .reduce((total, outcome) => total + outcome.searchEvidence.length, 0);
      const coverageModes = new Set<"summary" | "discovery" | "original">();
      for (const outcome of outcomes) {
        if (!outcome.ok) continue;
        const mode = outcome.task.coverageAssignmentMode;
        if (mode === "summary" || mode === "discovery" || mode === "original") {
          coverageModes.add(mode);
        }
      }
      if (plannerless && outcomes.some((outcome) => outcome.ok)) {
        // A rejected report keeps only its assignment open. A coverage commit
        // elsewhere in a parallel batch resets global no-progress detection,
        // so a bad sibling cannot terminate productive work.
        consecutiveStagnantIterations =
          coverageProgress > 0 ||
          (coverageRejections === 0 && newFindingCount > 0)
            ? 0
            : consecutiveStagnantIterations + 1;
      }

      // A missing condensed text finding does not mean that retrieval found
      // nothing relevant. Summary decisions, observed searches and promotions
      // are tracked in the coverage ledger rather than in contextFindings.
      // The deterministic sentence therefore reports the observed phase in plain
      // language; the narrator may replace it with a richer, still
      // evidence-bound one.
      const phaseSentence = describeResearchPhase({
        modes: Array.from(coverageModes),
        newFindingCount,
        citationCount,
        coverageProgress,
        observedSearchPasses,
        ...(plannerless
          ? { stagnantIterations: consecutiveStagnantIterations }
          : {}),
        ...(cfg.maxStagnantIterations !== undefined
          ? { maxStagnantIterations: cfg.maxStagnantIterations }
          : {}),
      });
      const taskResearchStatus = narratedResearchStatus ?? phaseSentence;
      for (const outcome of outcomes) {
        if (outcome.ok) outcome.task.researchStatus = taskResearchStatus;
      }
      // Progress is only claimed when a delegation actually succeeded. A batch
      // in which everything failed or was queued for retry must not surface as
      // research progress.
      if (outcomes.some((outcome) => outcome.ok)) {
        const coverageDetail =
          coverageLedger === undefined
            ? ""
            : ` — coverage: ${coverageSummary(coverageLedger)}`;
        const hypothesisDetail =
          hypothesisStatus === undefined
            ? ""
            : ` — hypotheses (this step): ${hypothesisStatus.active} active, ${hypothesisStatus.confirmed} confirmed, ${hypothesisStatus.rejected} rejected; ` +
              `detail [${hypothesisStatus.detailState.toLocaleUpperCase("de-DE")}]: ${compactStatusText(hypothesisStatus.detail, 180)}`;
        const coveredScope =
          coverage.length > 0 ? ` — ${compactStatusText(coverage, 220)}` : "";
        emitHarnessStatus(
          `Research progress: ${
            narratedProgress ??
            `Step ${progress.iterations}/${cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS}: ${phaseSentence}`
          }${hypothesisDetail}${coveredScope}${coverageDetail}`,
        );
      }
      // Deterministic coverage gauge for the debug trace: the EXACT number of
      // documents still owing work (open + summary-reviewed), derived from the
      // ledger after this batch — never from narration or model text, so the
      // "noch N offen" figure in the trace cannot drift from the queue state.
      if (coverageLedger !== undefined) {
        const openCount = coverageOpenCount(coverageLedger);
        const awaitingTriage = coverageLedger.documents.filter(
          (document) => document.status === "open",
        ).length;
        runtime.onNodeDiagnostic?.(node.id, {
          level: "info",
          code: "harness_coverage_gauge",
          message:
            `Coverage: noch ${openCount} von ${coverageLedger.total} offen ` +
            `(${awaitingTriage} warten auf Summary-Triage, ` +
            `${openCount - awaitingTriage} auf Originallektuere).`,
          details: {
            open: openCount,
            total: coverageLedger.total,
            awaiting_summary_triage: awaitingTriage,
            awaiting_original_review: openCount - awaitingTriage,
            phase: coverageLedger.phase,
            terminal: isCoverageTerminal(coverageLedger, coverageConfig),
            discovery_rounds: coverageLedger.discoveryRounds,
            overflow_refs: coverageLedger.overflowRefs.length,
          },
        });
      }

      // Emit status changes (Req 9.2)
      emitHarnessStatus(
        batch
          .map((t) => `Task ${formatTaskReference(t)} → ${t.status}`)
          .join("\n"),
      );

      // --- Accumulate cost (Req 6.1) ---
      progress.cost = accumulatedCost;
      // Narration runs after delegation, so its cost was not visible to the
      // pre-iteration limit check. Enforce maxCost again before any terminal
      // completion path can bypass the newly incurred narrator spend.
      if (cfg.maxCost !== undefined && progress.cost >= cfg.maxCost) {
        return stop("cost-limit", progress, errors);
      }

      // --- Check if all tasks are completed (Req 4.5) ---
      const allSettled = progress.tasks.every(
        (t) => t.status === "completed" || t.status === "failed",
      );
      if (allSettled) {
        // Plannerless: unless the worker just signalled completion, re-seed the
        // next research pass and keep looping — the limits (checkLimits at the
        // top) bound the run. This replaces the planner re-plan entirely.
        if (
          plannerless &&
          !stopSignalHit &&
          plannerlessTarget !== undefined &&
          (coverageLedger === undefined ||
            !isCoverageTerminal(coverageLedger, coverageConfig))
        ) {
          if (
            cfg.maxStagnantIterations !== undefined &&
            consecutiveStagnantIterations >= cfg.maxStagnantIterations
          ) {
            runtime.onNodeDiagnostic?.(node.id, {
              level: "warn",
              code: "harness_stagnation_limit",
              message:
                `Plannerless harness stopped after ${consecutiveStagnantIterations} ` +
                "consecutive completed passes without a unique finding." +
                (coverageReportRejections > 0
                  ? ` ${coverageReportRejections} coverage report(s) were refused by the gate; see harness_coverage_report_invalid.`
                  : ""),
              details: {
                stagnant_iterations: consecutiveStagnantIterations,
                unique_findings: contextFindings.length,
                coverage_report_rejections: coverageReportRejections,
              },
            });
            return stop("stagnation-limit", progress, errors);
          }
          const reseededTasks: Task[] = [];
          let firstReseedAssignment: CoverageAssignment | undefined;
          if (coverageConfig !== undefined) {
            for (let lane = 0; lane < lanes; lane++) {
              const assignment = issueCoverageAssignment();
              if (assignment === undefined) break;
              coverageAssignments.set(assignment.id, assignment);
              if (lanes > 1 && coverageLedger !== undefined)
                coverageLedger = reserveCoverageDocuments(
                  coverageLedger,
                  assignment,
                );
              if (firstReseedAssignment === undefined)
                firstReseedAssignment = assignment;
              plannerlessSeq += 1;
              reseededTasks.push({
                id: `t${plannerlessSeq}`,
                displayStep: plannerlessSeq,
                description: coverageTaskLabel(assignment, "Coverage"),
                target:
                  coverageTargetForAssignment(assignment) ?? plannerlessTarget,
                status: "pending",
                coverageAssignmentId: assignment.id,
                coverageAssignmentMode: assignment.mode,
                coverageRefs: assignment.documents.map(
                  (document) => document.ref,
                ),
                ...(lanes > 1 ? { parallelizable: true } : {}),
              });
            }
          } else {
            plannerlessSeq += 1;
            reseededTasks.push({
              id: `t${plannerlessSeq}`,
              displayStep: plannerlessSeq,
              description: `Research step ${plannerlessSeq}`,
              target: plannerlessTarget,
              status: "pending",
            });
          }
          currentCoverageAssignment = firstReseedAssignment;
          if (
            coverageLedger !== undefined &&
            firstReseedAssignment === undefined
          ) {
            // The queue still owes work it can no longer assign — typically a
            // discovery round whose bounded attempts are spent. Completeness
            // stays fail-closed, but the configured verifier must still judge
            // the findings: it sees discoveryRounds and the global
            // discoverySearches provenance. A rejection starts a bounded repair
            // cycle by resetting the current discovery attempt budget and can
            // additionally reopen explicitly named refs. Only an actual
            // verifier PASS upgrades this to "completed"; without a gate, or
            // with a rejecting one, the run stays partial.
            harnessPhase = "verification";
            const gate = await gateCompletion(ctx);
            if (gate.action === "stop") {
              return stop(gate.reason, progress, errors);
            }
            if (gate.action === "retry") {
              const replanned = await replanAfterVerification(ctx);
              if (replanned) continue;
              return stop("verification-failed", progress, errors);
            }
            return stop(verified ? "completed" : "exhausted", progress, errors);
          }
          progress.tasks.push(...reseededTasks);
          emitHarnessStatus(`Next research step (${plannerlessSeq}) …`);
          continue;
        }
        const anyCompleted = progress.tasks.some(
          (t) => t.status === "completed",
        );
        // Only a run that actually produced something is worth verifying; an
        // "exhausted" run has nothing for a reviewer to look at.
        if (anyCompleted) {
          harnessPhase = "verification";
          const gate = await gateCompletion(ctx);
          if (gate.action === "stop") {
            return stop(gate.reason, progress, errors);
          }
          if (gate.action === "retry") {
            // Re-plan with the reviewer's critique now in context, then continue.
            const replanned = await replanAfterVerification(ctx);
            if (replanned) continue;
            // The planner produced nothing actionable to fix the critique —
            // report the result as unverified rather than looping.
            return stop("verification-failed", progress, errors);
          }
        }
        return stop(anyCompleted ? "completed" : "exhausted", progress, errors);
      }

      // #2: deterministic stop — the worker signalled global completeness
      // (cfg.stopSignal). End now WITHOUT another planner re-plan call: mark the
      // remaining planned steps as not needed so the record stays coherent.
      if (stopSignalHit) {
        for (const t of progress.tasks) {
          if (t.status === "pending" || t.status === "in-progress") {
            t.status = "completed";
            t.result =
              t.result ??
              "(not needed — worker reported the research as complete)";
          }
        }
        emitHarnessStatus(
          `Stop signal detected ("${cfg.stopSignal}") — research complete, re-plan skipped.`,
        );
        // The stop signal says the WORKER considers itself done — the verifier
        // still gets the final say, otherwise a self-declared completion would
        // bypass the gate entirely.
        harnessPhase = "verification";
        const gate = await gateCompletion(ctx);
        if (gate.action === "stop") {
          return stop(gate.reason, progress, errors);
        }
        if (gate.action === "retry") {
          const replanned = await replanAfterVerification(ctx);
          if (replanned) continue;
          return stop("verification-failed", progress, errors);
        }
        return stop("completed", progress, errors);
      }

      // --- Re-plan (Req 4.4) — planner mode only. In plannerless mode the
      // allSettled branch above already re-seeded the next pass, so this LLM
      // re-plan never runs. ---
      if (!plannerless) {
        // Update model messages with latest context for re-plan. Drop the RAG
        // overview entirely on re-plan (#1) — the planner decides continue/stop
        // from priorProgress + condensed findings, so the map is redundant.
        const filteredMsgs = filterMessagesForPlanner(
          transformRagForPlanner(state.messages, true),
        );
        const updatedModelMessages = baseMessagesToModelMessages(filteredMsgs);
        if (plannerLlm === undefined) {
          // Unreachable: this branch only runs in planned mode, where the
          // guard at the top of the handler already ensured a planner LLM.
          throw new Error(
            `Agent harness "${node.id}": planner LLM missing (invariant violated).`,
          );
        }
        const replanResult = await plan(
          runtime,
          plannerLlm,
          updatedModelMessages,
          validTargets,
          progress,
          _testOverrides?.extractJson,
          { ...plannerOpts, budget: currentBudget() },
        );
        if (replanResult !== null) {
          const replanTasks = normalize(
            replanResult,
            validTargets,
            issuedTaskIds,
          );
          if (replanTasks.length > 0) {
            progress.tasks = mergeReplan(progress.tasks, replanTasks);
            // Advance the id counter so the NEXT re-plan cannot reuse these ids.
            issuedTaskIds += replanTasks.length;
            // Emit updated task list (Req 9.1)
            emitHarnessStatus(
              `Updated task list:\n${renderTaskList(progress.tasks)}`,
            );
          }
        }
      }
    }
  };
}
